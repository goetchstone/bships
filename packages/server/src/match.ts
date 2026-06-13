/**
 * Authoritative match runtime: owns the sim loop for one room.
 *
 * - Setup: createMatch(ruleset, seed, seats as 'user' players). AI empire
 *   slots 0/1 and unseated human slots are created by createMatch as
 *   computer players and receive zero commands ever.
 * - Tick loop: drift-corrected setTimeout chain against an anchor startMs.
 *   On fire, step while state.tick < floor((now - startMs) / msPerTick),
 *   capped at MAX_CATCHUP_STEPS_PER_FIRE (logged when capped; the remainder
 *   catches up on subsequent fires without starving the event loop).
 * - Per tick: drain the queued commands (sorted ascending slot, FIFO within
 *   slot — matches applyCommands' "sorted by player" replay contract),
 *   applyCommands, stepTick, tally K/D from death events, build + send the
 *   per-team vision-filtered payloads (snapshot.ts / visibility.ts).
 * - Cadence: keyframe on start, on setConnected(true) and every
 *   KEYFRAME_INTERVAL_TICKS; snapshotDelta otherwise.
 * - Determinism: wall clock only decides WHEN ticks run. Sim state depends
 *   only on (ruleset, seed, per-tick command batches); the runtime keeps
 *   (seed, tick -> commands[]) in memory (`runtime.replay`) so tests can
 *   re-apply the log against a fresh createMatch and assert hashState
 *   equality. No Math.random / Date in anything feeding the sim.
 */

import { KEYFRAME_INTERVAL_TICKS, TICK_RATE, applyCommands, createMatch, stepTick } from '@bships/core';
import type {
  Command,
  MatchEndedMessage,
  PublicPlayerStat,
  Ruleset,
  ServerMessage,
  SimEvent,
  SimState,
  SnapshotDeltaMessage,
  SnapshotMessage,
  SnapshotYou,
  TeamId,
} from '@bships/core';
import { buildTeamPayload, diffTeamPayloads, filterEventsForSeat } from './snapshot.js';
import type { TeamPayload } from './snapshot.js';

export interface MatchSeat {
  slot: number;
  name: string;
}

export interface MatchRuntimeDeps {
  /** getClassicRuleset(), shared across rooms, treated as deeply immutable. */
  ruleset: Ruleset;
  /** Drawn by rooms at start (crypto random uint32). */
  seed: number;
  /** Human seats only (slots 2-6 / 7-11). */
  seats: MatchSeat[];
  sendToSlot(slot: number, msg: ServerMessage): void;
  onEnded(result: {
    winnerTeam: TeamId | null;
    stats: PublicPlayerStat[];
    /** Match RNG seed (uint32), for audit/replay correlation. */
    seed: number;
    /** Ruleset name for audit/replay. */
    rulesetId: string;
    /** Match length in sim ticks. */
    durationTicks: number;
    /** Gold earned per seat slot (slot -> gold); 0 when untracked (see finish). */
    goldEarned: Map<number, number>;
  }): void;
  /**
   * Wall-clock milliseconds per sim tick. Defaults to realtime
   * (1000 / TICK_RATE). Test mode only: 0 (or negative) = burst mode — run
   * the sim as fast as the event loop allows (MAX_CATCHUP_STEPS_PER_FIRE
   * ticks per timer fire, zero-delay rescheduling). Never affects sim
   * results, only WHEN ticks run (the determinism contract holds).
   */
  tickIntervalMs?: number;
}

/** Determinism artifacts kept for replay tests (see module doc). */
export interface MatchReplayLog {
  readonly seed: number;
  /** Only ticks with at least one command are present. */
  readonly commandsByTick: ReadonlyMap<number, readonly Command[]>;
}

export interface MatchRuntime {
  readonly status: 'running' | 'ended';
  start(): void;
  /** Room teardown; clears timers. Does NOT call onEnded. */
  stop(): void;
  enqueueCommand(slot: number, command: Command): void;
  setConnected(slot: number, connected: boolean): void;
  /** Replay artifacts for hashState equality tests. */
  readonly replay: MatchReplayLog;
  /** Live authoritative sim state — diagnostics/tests only, do not mutate. */
  getState(): SimState;
}

const MAX_CATCHUP_STEPS_PER_FIRE = 5;

export function createMatchRuntime(deps: MatchRuntimeDeps): MatchRuntime {
  const { ruleset, seed, sendToSlot, onEnded } = deps;
  const msPerTick = deps.tickIntervalMs ?? 1000 / TICK_RATE;
  /** Burst mode (tests): step as fast as the event loop allows. */
  const burst = msPerTick <= 0;

  const seats = [...deps.seats].sort((a, b) => a.slot - b.slot);
  const state = createMatch(
    ruleset,
    seed,
    seats.map((s) => ({ slot: s.slot, control: 'user' as const })),
  );

  const seatSlots = new Set(seats.map((s) => s.slot));
  /** Teams that have at least one seat, in fixed south-then-north order. */
  const seatedTeams: TeamId[] = (['south', 'north'] as const).filter((team) =>
    seats.some((s) => state.players[s.slot]?.team === team),
  );
  const seatsOfTeam = (team: TeamId): MatchSeat[] =>
    seats.filter((s) => state.players[s.slot]?.team === team);

  const connected = new Map<number, boolean>(seats.map((s) => [s.slot, true]));
  const kills = new Map<number, number>();
  const deaths = new Map<number, number>();

  let status: 'running' | 'ended' = 'running';
  let started = false;
  let startMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Commands received since the last tick, in arrival order. */
  let pending: { slot: number; command: Command }[] = [];
  const commandsByTick = new Map<number, Command[]>();

  /** Last broadcast payload per seated team (the delta diff base). */
  const lastPayload = new Map<TeamId, TeamPayload>();
  /** Last sent PlayerState JSON per seat (the `you`-changed compare). */
  const lastYouJson = new Map<number, string>();
  let lastStatsJson = '';

  // --- stats / private state -----------------------------------------------

  function buildStats(): PublicPlayerStat[] {
    const stats: PublicPlayerStat[] = [];
    for (const seat of seats) {
      const player = state.players[seat.slot];
      if (!player) continue; // unreachable: createMatch created every seat
      stats.push({
        slot: seat.slot,
        name: seat.name,
        team: player.team,
        shipTypeId: player.shipTypeId,
        level: player.level,
        kills: kills.get(seat.slot) ?? 0,
        deaths: deaths.get(seat.slot) ?? 0,
        connected: connected.get(seat.slot) ?? false,
      });
    }
    return stats;
  }

  function youJsonOf(slot: number): string {
    return JSON.stringify(state.players[slot]);
  }

  function tallyKillsDeaths(events: readonly SimEvent[]): void {
    for (const ev of events) {
      if (ev.type !== 'death' || ev.victimPlayer === null) continue;
      // Ship victims only (creeps also carry a non-null AI owner slot).
      if (!(ev.entityTypeId in ruleset.ships)) continue;
      if (seatSlots.has(ev.victimPlayer)) {
        deaths.set(ev.victimPlayer, (deaths.get(ev.victimPlayer) ?? 0) + 1);
      }
      if (ev.killerPlayer !== null && seatSlots.has(ev.killerPlayer)) {
        kills.set(ev.killerPlayer, (kills.get(ev.killerPlayer) ?? 0) + 1);
      }
    }
  }

  // --- snapshot sending -----------------------------------------------------

  function keyframeFor(
    slot: number,
    payload: TeamPayload,
    events: SimEvent[],
    stats: PublicPlayerStat[],
  ): SnapshotMessage {
    const youJson = youJsonOf(slot);
    lastYouJson.set(slot, youJson);
    return {
      type: 'snapshot',
      tick: payload.tick,
      you: JSON.parse(youJson) as SnapshotYou,
      entities: [...payload.entities.values()],
      projectiles: payload.projectiles,
      events,
      players: stats,
    };
  }

  /** Send the full keyframe to every connected seat; seeds all diff bases. */
  function broadcastKeyframes(): void {
    const stats = buildStats();
    lastStatsJson = JSON.stringify(stats);
    for (const team of seatedTeams) {
      const payload = buildTeamPayload(state, ruleset, team);
      lastPayload.set(team, payload);
      for (const seat of seatsOfTeam(team)) {
        if (connected.get(seat.slot) !== true) continue;
        sendToSlot(seat.slot, keyframeFor(seat.slot, payload, [], stats));
      }
    }
  }

  /** Build and send this tick's per-team payloads (keyframe or delta). */
  function broadcastTick(events: SimEvent[]): void {
    const stats = buildStats();
    const statsJson = JSON.stringify(stats);
    const statsChanged = statsJson !== lastStatsJson;
    const isKeyframe = state.tick % KEYFRAME_INTERVAL_TICKS === 0;

    for (const team of seatedTeams) {
      const payload = buildTeamPayload(state, ruleset, team);
      const prev = lastPayload.get(team);
      lastPayload.set(team, payload);

      // Union of previous and current visible ids: spatial events about an
      // entity that died (deleted before this payload) still reach teams
      // that saw it last tick.
      const visibleIds = new Set<number>(payload.entities.keys());
      if (prev) for (const id of prev.entities.keys()) visibleIds.add(id);

      const diff = prev ? diffTeamPayloads(prev, payload) : null;

      for (const seat of seatsOfTeam(team)) {
        if (connected.get(seat.slot) !== true) continue;
        const seatEvents = filterEventsForSeat(state, events, team, seat.slot, visibleIds);
        if (isKeyframe || diff === null) {
          sendToSlot(seat.slot, keyframeFor(seat.slot, payload, seatEvents, stats));
          continue;
        }
        const msg: SnapshotDeltaMessage = {
          type: 'snapshotDelta',
          tick: payload.tick,
          baseTick: payload.tick - 1,
          upserts: diff.upserts,
          removed: diff.removed,
          projectiles: payload.projectiles,
          events: seatEvents,
        };
        const youJson = youJsonOf(seat.slot);
        if (youJson !== lastYouJson.get(seat.slot)) {
          msg.you = JSON.parse(youJson) as SnapshotYou;
          lastYouJson.set(seat.slot, youJson);
        }
        if (statsChanged) msg.players = stats;
        sendToSlot(seat.slot, msg);
      }
    }

    if (statsChanged) lastStatsJson = statsJson;
  }

  // --- tick loop -------------------------------------------------------------

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext(): void {
    if (status !== 'running') return;
    const nextTickAt = startMs + (state.tick + 1) * msPerTick;
    timer = setTimeout(onTimerFire, burst ? 0 : Math.max(0, nextTickAt - Date.now()));
  }

  function onTimerFire(): void {
    timer = null;
    if (status !== 'running') return;
    // Burst mode: always run a full bundle of steps per fire (the 0-delay
    // reschedule yields to the event loop so I/O still drains). The cap warn
    // is realtime-only — in burst the cap IS the intended pace.
    const targetTick = burst
      ? state.tick + MAX_CATCHUP_STEPS_PER_FIRE
      : Math.floor((Date.now() - startMs) / msPerTick);
    let steps = 0;
    while (status === 'running' && state.tick < targetTick) {
      if (steps >= MAX_CATCHUP_STEPS_PER_FIRE) {
        if (!burst) {
          console.warn(
            `[match] catch-up capped at ${MAX_CATCHUP_STEPS_PER_FIRE} steps ` +
              `(tick ${state.tick}, target ${targetTick})`,
          );
        }
        break;
      }
      runOneTick();
      steps += 1;
    }
    scheduleNext();
  }

  function runOneTick(): void {
    // Drain this tick's queue: ascending slot, FIFO within slot (stable
    // sort), matching applyCommands' "sorted by player" contract. The
    // sorted batch is what we log — the log replays verbatim.
    const batch = pending;
    pending = [];
    batch.sort((a, b) => a.slot - b.slot);
    const commands = batch.map((b) => b.command);
    if (commands.length > 0) commandsByTick.set(state.tick, commands);

    applyCommands(state, ruleset, commands);
    const events = stepTick(state, ruleset);
    tallyKillsDeaths(events);
    broadcastTick(events);

    if (state.status.phase === 'ended') finish(state.status.winner);
  }

  /** Natural match end: final delta already sent by broadcastTick. */
  function finish(winnerTeam: TeamId | null): void {
    if (status === 'ended') return;
    status = 'ended';
    clearTimer();
    const stats = buildStats();
    const msg: MatchEndedMessage = { type: 'matchEnded', winnerTeam, stats };
    for (const seat of seats) sendToSlot(seat.slot, msg);
    // goldEarned is reported as 0 (untracked): the sim keeps only a live `gold`
    // BALANCE (decremented by purchases/upgrades, zeroed by `golddump`), not a
    // cumulative-earned tally. Reporting the final balance under a
    // "cumulative earned" label was both wrong (a player who spent everything
    // reads ~0) and trivially gamed, so we ship an honest 0 rather than a
    // misleading number. Adding a real tally would require a counter in the
    // deterministic core (out of scope here); see MatchParticipantIngest.
    const goldEarned = new Map<number, number>();
    for (const seat of seats) {
      goldEarned.set(seat.slot, 0);
    }
    onEnded({
      winnerTeam,
      stats,
      seed,
      rulesetId: ruleset.name,
      durationTicks: state.tick,
      goldEarned,
    });
  }

  // --- public surface --------------------------------------------------------

  function start(): void {
    if (started || status !== 'running') return;
    started = true;
    startMs = Date.now();
    broadcastKeyframes(); // tick-0 state; first delta will be tick 1/base 0
    scheduleNext();
  }

  function stop(): void {
    clearTimer();
    status = 'ended';
  }

  function enqueueCommand(slot: number, command: Command): void {
    if (status !== 'running') return;
    if (!seatSlots.has(slot)) return; // rooms never routes non-seats; drop
    if (command.player !== slot) {
      sendToSlot(slot, {
        type: 'error',
        code: 'invalidCommand',
        msg: `command.player ${command.player} does not match your slot ${slot}`,
      });
      return;
    }
    pending.push({ slot, command });
  }

  function setConnected(slot: number, isConnected: boolean): void {
    if (!seatSlots.has(slot)) return;
    connected.set(slot, isConnected);
    // The changed `connected` stat rides in the next delta's `players`.
    if (!isConnected || !started || status !== 'running') return;

    // Reconnect: full keyframe of the current tick so the client can resume
    // the delta chain (next delta's baseTick === this tick).
    const player = state.players[slot];
    if (!player) return;
    const payload = lastPayload.get(player.team) ?? buildTeamPayload(state, ruleset, player.team);
    lastPayload.set(player.team, payload);
    sendToSlot(slot, keyframeFor(slot, payload, [], buildStats()));
  }

  return {
    get status() {
      return status;
    },
    start,
    stop,
    enqueueCommand,
    setConnected,
    replay: { seed, commandsByTick },
    getState: () => state,
  };
}
