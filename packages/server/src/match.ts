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
 *   applyCommands, stepTick, tally K/D from death events and cumulative gold
 *   earned from bounty events, build + send the per-team vision-filtered
 *   payloads (snapshot.ts / visibility.ts).
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
  AiConfig,
  Command,
  MatchEndedMessage,
  PlayerConfig,
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
import { runAiTick } from './ai-runner.js';
import { buildTeamPayload, diffTeamPayloads, filterEventsForSeat } from './snapshot.js';
import type { TeamPayload } from './snapshot.js';
import { computeTeamVision } from './visibility.js';

export interface MatchSeat {
  slot: number;
  name: string;
}

/**
 * A computer-controlled captain seat. AI seats are NOT human seats: they are
 * never added to `seatSlots`, receive no snapshots, and take no
 * `enqueueCommand`. They DO get scoreboard lines (K/D/gold/level via
 * `statSlots` — owner ask: the per-player breakdown must cover every captain,
 * and a solo-vs-AI board with one row is useless), but stay out of ladder
 * ingest (rooms' onEnded drops stats rows with no human identity). They are
 * created as `control: 'computer'` PlayerConfigs with an AI config (so
 * `createMatch` seeds `state.aiMemory[slot]` via `initAiMemory`) and the
 * server AI runner thinks for them each cadence. `slot` must be a real player
 * slot (2-11); slots 0/1 are the AI empire (creep) owners and `createMatch`
 * rejects an AI config on them.
 */
export interface AiSeat {
  slot: number;
  ai: AiConfig;
}

export interface MatchRuntimeDeps {
  /** getClassicRuleset(), shared across rooms, treated as deeply immutable. */
  ruleset: Ruleset;
  /** Drawn by rooms at start (crypto random uint32). */
  seed: number;
  /** Human seats only (slots 2-6 / 7-11). */
  seats: MatchSeat[];
  /**
   * Computer-controlled captain seats (optional). Each is created as a
   * `control: 'computer'` player with an AI config so the deterministic core
   * brain drives it; they are not human seats (no snapshots, no input) but DO
   * get scoreboard lines (see AiSeat). Slots must be disjoint from `seats`
   * and from the AI empire slots 0/1 (createMatch enforces the latter).
   */
  aiSeats?: AiSeat[];
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
    /** Cumulative gold earned per seat slot (slot -> gold), tallied from bounty events. */
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
  const aiSeats = [...(deps.aiSeats ?? [])].sort((a, b) => a.slot - b.slot);
  // Human seats are 'user' players; AI seats are 'computer' players carrying an
  // AI config so createMatch seeds state.aiMemory[slot] via initAiMemory. Both
  // sets are sorted ascending and disjoint by construction (rooms picks them
  // from distinct open slots). createMatch rejects an AI config on slots 0/1.
  const playerConfigs: PlayerConfig[] = [
    ...seats.map((s) => ({ slot: s.slot, control: 'user' as const })),
    ...aiSeats.map((s) => ({ slot: s.slot, control: 'computer' as const, ai: s.ai })),
  ];
  const state = createMatch(ruleset, seed, playerConfigs);

  const seatSlots = new Set(seats.map((s) => s.slot));
  /**
   * Slots whose K/D/gold are tallied and shown on the scoreboard: humans AND
   * AI captains (the owner wants the per-player breakdown to cover the whole
   * match, and a solo-vs-AI board with only the human row is useless). The AI
   * empire creep-owner slots (0/1) are in neither set. Snapshot/input/
   * reconnect/ladder-identity semantics still key off `seatSlots` alone.
   */
  const statSlots = new Set([...seatSlots, ...aiSeats.map((s) => s.slot)]);
  /** Teams that have at least one seat, in fixed south-then-north order. */
  const seatedTeams: TeamId[] = (['south', 'north'] as const).filter((team) =>
    seats.some((s) => state.players[s.slot]?.team === team),
  );
  const seatsOfTeam = (team: TeamId): MatchSeat[] =>
    seats.filter((s) => state.players[s.slot]?.team === team);

  const connected = new Map<number, boolean>(seats.map((s) => [s.slot, true]));
  const kills = new Map<number, number>();
  const deaths = new Map<number, number>();
  /** Cumulative gold earned (bounty payouts), separate from the live balance. */
  const goldEarned = new Map<number, number>();

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
        goldEarned: goldEarned.get(seat.slot) ?? 0,
        connected: connected.get(seat.slot) ?? false,
      });
    }
    // AI captains get scoreboard lines too (kills/deaths/gold/level), WC3
    // "Computer" style — they stay out of seats/slotIdentity, so snapshots,
    // input, reconnect, and ladder ingest are unaffected (rooms' onEnded drops
    // stats rows with no human identity).
    for (const seat of aiSeats) {
      const player = state.players[seat.slot];
      if (!player) continue; // unreachable: createMatch created every AI seat
      stats.push({
        slot: seat.slot,
        name: `Computer ${seat.slot} (${seat.ai.difficulty})`,
        team: player.team,
        shipTypeId: player.shipTypeId,
        level: player.level,
        kills: kills.get(seat.slot) ?? 0,
        deaths: deaths.get(seat.slot) ?? 0,
        goldEarned: goldEarned.get(seat.slot) ?? 0,
        connected: true,
      });
    }
    return stats;
  }

  function youJsonOf(slot: number): string {
    return JSON.stringify(state.players[slot]);
  }

  function tallyStats(events: readonly SimEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'bounty') {
        if (statSlots.has(ev.player)) {
          goldEarned.set(ev.player, (goldEarned.get(ev.player) ?? 0) + ev.amount);
        }
        continue;
      }
      if (ev.type !== 'death' || ev.victimPlayer === null) continue;
      // Ship victims only (creeps also carry a non-null AI owner slot).
      if (!(ev.entityTypeId in ruleset.ships)) continue;
      if (statSlots.has(ev.victimPlayer)) {
        deaths.set(ev.victimPlayer, (deaths.get(ev.victimPlayer) ?? 0) + 1);
      }
      if (ev.killerPlayer !== null && statSlots.has(ev.killerPlayer)) {
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

      // This team's sight sources — the death-coordinate leak gate in
      // filterEventsForSeat needs them to drop out-of-sight enemy deaths
      // credited to this team (DoT/slow-projectile kills after a target fled).
      const vision = computeTeamVision(state, ruleset, team);

      const diff = prev ? diffTeamPayloads(prev, payload) : null;

      for (const seat of seatsOfTeam(team)) {
        if (connected.get(seat.slot) !== true) continue;
        const seatEvents = filterEventsForSeat(state, events, team, seat.slot, visibleIds, vision);
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
      // Per-room fault isolation: a throw in runAiTick/applyCommands/stepTick/
      // broadcastTick (a core edge case, an oversized-JSON RangeError, a snapshot
      // bug) must end ONLY this match — never escape the setTimeout callback and
      // crash the whole process, which would take down every other live room.
      try {
        runOneTick();
      } catch (err) {
        console.error(`[match] tick ${state.tick} threw — ending this match only:`, err);
        finish(null);
        return; // status is now 'ended'; scheduleNext would be a no-op anyway
      }
      steps += 1;
    }
    scheduleNext();
  }

  function runOneTick(): void {
    // AI thinks BEFORE human commands are drained: run the deterministic core
    // brain for every AI slot whose nextThinkTick is due this tick (the runner
    // mutates state.aiMemory in place — part of SimState, so the replay hash
    // stays honest). Its output is exactly what a human client would send and
    // flows through the SAME applyCommands path below. AI slots are disjoint
    // from human seats, so merging them into the same batch and stable-sorting
    // by slot keeps the per-tick order ascending-slot / FIFO-within-slot.
    const aiCommands = runAiTick(state, ruleset);

    // Drain this tick's queue: ascending slot, FIFO within slot (stable
    // sort), matching applyCommands' "sorted by player" contract. The
    // sorted batch is what we log — the log replays verbatim.
    const batch: { slot: number; command: Command }[] = aiCommands.map((command) => ({
      slot: command.player,
      command,
    }));
    for (const entry of pending) batch.push(entry);
    pending = [];
    batch.sort((a, b) => a.slot - b.slot);
    const commands = batch.map((b) => b.command);
    if (commands.length > 0) commandsByTick.set(state.tick, commands);

    applyCommands(state, ruleset, commands);
    const events = stepTick(state, ruleset);
    tallyStats(events);
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
    // Guarded: a throwing send (the very fault we may be recovering from) must
    // not stop the other seats' matchEnded nor abort onEnded teardown below.
    for (const seat of seats) {
      try {
        sendToSlot(seat.slot, msg);
      } catch (err) {
        console.error(`[match] matchEnded send to slot ${seat.slot} threw:`, err);
      }
    }
    // goldEarned: cumulative bounty payouts tallied from 'bounty' events (see
    // tallyStats), NOT the live spendable `gold` balance — a player who
    // spent everything still reports what they earned.
    onEnded({
      winnerTeam,
      stats,
      seed,
      rulesetId: ruleset.name,
      durationTicks: state.tick,
      goldEarned: new Map(goldEarned),
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
