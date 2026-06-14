/**
 * Match runtime integration tests against the real Classic ruleset, driven
 * with fake timers (the drift-corrected setTimeout chain reads the mocked
 * Date.now, so ticks advance deterministically with the clock).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommands, createMatch, hashState, stepTick } from '@bships/core';
import type {
  AiMemory,
  Command,
  PublicPlayerStat,
  Ruleset,
  ServerMessage,
  SimState,
  SnapshotDeltaMessage,
  SnapshotEntity,
  SnapshotMessage,
  StructureEntity,
} from '@bships/core';

// The core AI brain (`computeAiCommands`) is owned by the ai-brain module and
// may be unimplemented while this suite runs, so we replace it with a
// DETERMINISTIC fixture brain: it threads the real per-slot PRNG state via the
// real `seedAiRng`/`commitAiRng`, advances its own `nextThinkTick`, and emits
// real Commands. This stands alone yet still exercises the full match.ts ↔
// ai-runner wiring and the AI-memory-in-SimState replay-determinism contract
// (the fixture is a pure function of (state, slot, memory), so two runs from
// the same seed + AI configs reproduce identical aiMemory mutations AND
// commands). Every other core export stays real.
vi.mock('@bships/core', async (importActual) => {
  const actual = await importActual<typeof import('@bships/core')>();
  const computeAiCommands = (
    state: SimState,
    _ruleset: Ruleset,
    slot: number,
    memory: AiMemory,
  ): Command[] => {
    // Cadence: advance nextThinkTick exactly as the real brain must.
    memory.nextThinkTick = state.tick + actual.thinkIntervalTicks(memory.difficulty);
    const player = state.players[slot];
    if (player === undefined || player.shipId === null) return [];
    // Draw a deterministic waypoint offset from the brain-private PRNG so the
    // memory's aiRngState advances on a real, replayable channel.
    const rng = actual.seedAiRng(memory);
    const dx = rng.int(-200, 200);
    const dy = rng.int(-200, 200);
    actual.commitAiRng(memory, rng);
    const start = state.players[slot];
    const team = start?.team;
    // Push toward the enemy HQ direction (north HQ +y, south HQ -y) with jitter.
    const targetY = team === 'south' ? 6000 + dy : -6000 + dy;
    return [{ type: 'attackMove', player: slot, x: dx, y: targetY }];
  };
  return { ...actual, computeAiCommands };
});

import { getClassicRuleset } from '../src/data.js';
import { createMatchRuntime } from '../src/match.js';
import type { AiSeat, MatchRuntime } from '../src/match.js';
import { buildTeamPayload } from '../src/snapshot.js';

const ruleset = getClassicRuleset();

interface Harness {
  runtime: MatchRuntime;
  sent: Map<number, ServerMessage[]>;
  onEnded: ReturnType<typeof vi.fn>;
  messages(slot: number): ServerMessage[];
  snapshots(slot: number): (SnapshotMessage | SnapshotDeltaMessage)[];
}

const liveRuntimes: MatchRuntime[] = [];

function makeHarness(slots: number[] = [2, 7], seed = 0xc0ffee, aiSeats: AiSeat[] = []): Harness {
  const sent = new Map<number, ServerMessage[]>();
  const onEnded = vi.fn();
  const runtime = createMatchRuntime({
    ruleset,
    seed,
    seats: slots.map((slot) => ({ slot, name: `P${slot}` })),
    ...(aiSeats.length > 0 ? { aiSeats } : {}),
    sendToSlot: (slot, msg) => {
      const list = sent.get(slot) ?? [];
      // Clone through JSON like the real wire would — freezes references.
      list.push(JSON.parse(JSON.stringify(msg)) as ServerMessage);
      sent.set(slot, list);
    },
    onEnded,
  });
  liveRuntimes.push(runtime);
  return {
    runtime,
    sent,
    onEnded,
    messages: (slot) => sent.get(slot) ?? [],
    snapshots: (slot) =>
      (sent.get(slot) ?? []).filter(
        (m): m is SnapshotMessage | SnapshotDeltaMessage =>
          m.type === 'snapshot' || m.type === 'snapshotDelta',
      ),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  while (liveRuntimes.length > 0) liveRuntimes.pop()?.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('start keyframe', () => {
  it('sends a tick-0 keyframe to every seat with private you and full structures', () => {
    const h = makeHarness([2, 7]);
    h.runtime.start();

    for (const slot of [2, 7]) {
      const msgs = h.messages(slot);
      expect(msgs).toHaveLength(1);
      const snap = msgs[0] as SnapshotMessage;
      expect(snap.type).toBe('snapshot');
      expect(snap.tick).toBe(0);
      expect(snap.you.slot).toBe(slot);
      expect(snap.you.gold).toBe(ruleset.constants.startingGold);
      expect(snap.events).toEqual([]);
      expect(snap.entities.filter((e) => e.kind === 'structure')).toHaveLength(
        ruleset.map.structures.length,
      );
      // Own ship present...
      expect(snap.entities.some((e) => e.kind === 'ship' && e.ownerSlot === slot)).toBe(true);
      // ...enemy ship absent (spawns are far outside any sight source).
      const enemySlot = slot === 2 ? 7 : 2;
      expect(snap.entities.some((e) => e.kind === 'ship' && e.ownerSlot === enemySlot)).toBe(false);
      // Scoreboard for both seats.
      expect(snap.players.map((p: PublicPlayerStat) => p.slot)).toEqual([2, 7]);
      expect(snap.players.every((p: PublicPlayerStat) => p.connected)).toBe(true);
    }
  });
});

describe('tick loop and cadence', () => {
  it('chains deltas tick by tick and keyframes every KEYFRAME_INTERVAL_TICKS', () => {
    const h = makeHarness();
    h.runtime.start();
    vi.advanceTimersByTime(1000); // 20 ticks

    const snaps = h.snapshots(2);
    expect(snaps.map((m) => m.tick)).toEqual([...Array(21).keys()]); // 0..20
    for (const msg of snaps) {
      if (msg.tick % 20 === 0) {
        expect(msg.type).toBe('snapshot');
      } else {
        expect(msg.type).toBe('snapshotDelta');
        expect((msg as SnapshotDeltaMessage).baseTick).toBe(msg.tick - 1);
      }
    }
  });

  it('catches up after a stall, capped per timer fire', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeHarness();
    h.runtime.start();
    vi.advanceTimersByTime(50); // tick 1 normally
    expect(h.runtime.getState().tick).toBe(1);

    // Simulate a 400 ms event-loop stall: jump the wall clock, then let the
    // pending timer fire. The loop must cap at 5 steps on that fire and
    // catch up on the immediate (0-delay) re-fire without skipping a tick.
    vi.setSystemTime(Date.now() + 400);
    vi.advanceTimersByTime(50);
    expect(h.runtime.getState().tick).toBe(6); // 1 + the 5-step cap
    expect(warn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1); // the 0-delay catch-up fire
    expect(h.runtime.getState().tick).toBe(10); // floor((50+400+50)/50)
    const snaps = h.snapshots(2);
    expect(snaps.map((m) => m.tick)).toEqual([...Array(11).keys()]); // 0..10, none skipped
  });
});

describe('commands', () => {
  it('rejects commands whose player does not match the sender slot', () => {
    const h = makeHarness();
    h.runtime.start();
    h.runtime.enqueueCommand(2, { type: 'stop', player: 7 });
    vi.advanceTimersByTime(50);

    const errors = h.messages(2).filter((m) => m.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'invalidCommand' });
    expect(h.runtime.replay.commandsByTick.size).toBe(0);
  });

  it('silently drops commands from non-seat slots', () => {
    const h = makeHarness();
    h.runtime.start();
    h.runtime.enqueueCommand(3, { type: 'stop', player: 3 });
    h.runtime.enqueueCommand(0, { type: 'stop', player: 0 });
    vi.advanceTimersByTime(50);

    expect(h.sent.get(3)).toBeUndefined();
    expect(h.sent.get(0)).toBeUndefined();
    expect(h.runtime.replay.commandsByTick.size).toBe(0);
  });

  it('applies queued commands on the next tick and logs them for replay', () => {
    const h = makeHarness();
    h.runtime.start();
    const start = ruleset.map.playerStarts[2];
    if (!start) throw new Error('slot 2 start missing');
    h.runtime.enqueueCommand(2, { type: 'move', player: 2, x: start.x, y: start.y + 500 });
    vi.advanceTimersByTime(50);

    expect(h.runtime.replay.commandsByTick.get(0)).toEqual([
      { type: 'move', player: 2, x: start.x, y: start.y + 500 },
    ]);
    const state = h.runtime.getState();
    const player = state.players[2];
    const ship = player?.shipId !== null && player ? state.entities[player.shipId] : undefined;
    expect(ship && ship.kind === 'ship' ? ship.order : null).toEqual({
      type: 'move',
      x: start.x,
      y: start.y + 500,
    });

    // The moving ship shows up as a delta upsert within a few ticks.
    vi.advanceTimersByTime(450);
    const upsertIds = h
      .snapshots(2)
      .filter((m): m is SnapshotDeltaMessage => m.type === 'snapshotDelta')
      .flatMap((m) => m.upserts.map((e) => e.id));
    expect(player && upsertIds.includes(player.shipId ?? -1)).toBe(true);
  });

  it('orders each tick batch ascending slot, FIFO within slot', () => {
    const h = makeHarness([2, 7]);
    h.runtime.start();
    h.runtime.enqueueCommand(7, { type: 'stop', player: 7 });
    h.runtime.enqueueCommand(2, { type: 'holdPosition', player: 2 });
    h.runtime.enqueueCommand(2, { type: 'stop', player: 2 });
    vi.advanceTimersByTime(50);

    expect(h.runtime.replay.commandsByTick.get(0)?.map((c) => [c.player, c.type])).toEqual([
      [2, 'holdPosition'],
      [2, 'stop'],
      [7, 'stop'],
    ]);
  });
});

describe('private state and scoreboard cadence', () => {
  it('includes you in a delta only when the PlayerState changed', () => {
    const h = makeHarness();
    h.runtime.start();
    h.runtime.enqueueCommand(2, { type: 'setGoldDump', player: 2, enabled: true });
    vi.advanceTimersByTime(100); // ticks 1 and 2

    const [d1, d2] = h
      .snapshots(2)
      .filter((m): m is SnapshotDeltaMessage => m.type === 'snapshotDelta');
    expect(d1?.you?.goldDumpEnabled).toBe(true);
    expect(d2?.you).toBeUndefined();
  });

  it('omits players from deltas while stats are unchanged', () => {
    const h = makeHarness();
    h.runtime.start();
    vi.advanceTimersByTime(950);
    const deltas = h
      .snapshots(2)
      .filter((m): m is SnapshotDeltaMessage => m.type === 'snapshotDelta');
    expect(deltas.length).toBe(19);
    expect(deltas.every((d) => d.players === undefined)).toBe(true);
  });
});

describe('vision boundary over live play', () => {
  it('never sends a seat any enemy unit while the teams are apart', () => {
    const h = makeHarness();
    h.runtime.start();
    vi.advanceTimersByTime(2000); // 40 ticks: creep waves may have spawned

    for (const [slot, team] of [
      [2, 'south'],
      [7, 'north'],
    ] as const) {
      const seen: SnapshotEntity[] = [];
      for (const msg of h.snapshots(slot)) {
        if (msg.type === 'snapshot') seen.push(...msg.entities);
        else seen.push(...msg.upserts);
      }
      for (const e of seen) {
        if (e.kind === 'structure') continue; // public map knowledge
        expect(e.team).toBe(team);
      }
    }
  });
});

describe('reconnect', () => {
  it('sends a fresh keyframe on setConnected(true) and resumes the delta chain', () => {
    const h = makeHarness();
    h.runtime.start();
    vi.advanceTimersByTime(150); // ticks 1-3

    h.runtime.setConnected(2, false);
    const countWhileGone = h.messages(2).length;
    vi.advanceTimersByTime(100); // ticks 4-5 — nothing sent to slot 2
    expect(h.messages(2).length).toBe(countWhileGone);

    h.runtime.setConnected(2, true);
    const reconnectKeyframe = h.messages(2).at(-1) as SnapshotMessage;
    expect(reconnectKeyframe.type).toBe('snapshot');
    expect(reconnectKeyframe.tick).toBe(h.runtime.getState().tick);

    vi.advanceTimersByTime(50);
    const next = h.snapshots(2).at(-1) as SnapshotDeltaMessage;
    expect(next.type).toBe('snapshotDelta');
    expect(next.baseTick).toBe(reconnectKeyframe.tick);
  });

  it('reports the connected flag change to the other seats via players', () => {
    const h = makeHarness();
    h.runtime.start();
    vi.advanceTimersByTime(100);

    h.runtime.setConnected(2, false);
    vi.advanceTimersByTime(50);
    const last = h.snapshots(7).at(-1) as SnapshotDeltaMessage;
    expect(last.players?.find((p) => p.slot === 2)?.connected).toBe(false);
  });
});

describe('delta chain integrity', () => {
  it('reconstructing keyframe+deltas reproduces the current team payload', () => {
    const h = makeHarness();
    h.runtime.start();
    const start = ruleset.map.playerStarts[2];
    if (!start) throw new Error('slot 2 start missing');
    h.runtime.enqueueCommand(2, { type: 'move', player: 2, x: start.x + 400, y: start.y + 400 });
    vi.advanceTimersByTime(1700); // 34 ticks: crosses the tick-20 keyframe

    const view = new Map<number, string>();
    for (const msg of h.snapshots(2)) {
      if (msg.type === 'snapshot') {
        view.clear();
        for (const e of msg.entities) view.set(e.id, JSON.stringify(e));
      } else {
        for (const e of msg.upserts) view.set(e.id, JSON.stringify(e));
        for (const id of msg.removed) view.delete(id);
      }
    }

    const expected = buildTeamPayload(h.runtime.getState(), ruleset, 'south');
    expect(h.runtime.getState().tick).toBe(34);
    expect([...view.keys()].sort((a, b) => a - b)).toEqual([...expected.entities.keys()]);
    for (const [id, json] of view) expect(json).toBe(expected.entityJson.get(id));
  });
});

describe('match end', () => {
  it('ends the match when an HQ dies: final delta, matchEnded, onEnded', () => {
    const h = makeHarness();
    h.runtime.start();
    vi.advanceTimersByTime(100);

    const state = h.runtime.getState();
    const northHq = Object.values(state.entities).find(
      (e): e is StructureEntity => e.kind === 'structure' && e.role === 'hq' && e.team === 'north',
    );
    if (!northHq) throw new Error('north HQ not found');
    northHq.hp = 0;
    northHq.dead = true;

    vi.advanceTimersByTime(50);

    for (const slot of [2, 7]) {
      const msgs = h.messages(slot);
      const ended = msgs.at(-1);
      expect(ended).toMatchObject({ type: 'matchEnded', winnerTeam: 'south' });
      const finalDelta = msgs.at(-2) as SnapshotDeltaMessage;
      expect(finalDelta.type).toBe('snapshotDelta');
      expect(finalDelta.events.some((e) => e.type === 'matchEnded')).toBe(true);
      expect(finalDelta.removed).toContain(northHq.id);
    }
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.onEnded.mock.calls[0]?.[0]).toMatchObject({ winnerTeam: 'south' });
    expect(h.runtime.status).toBe('ended');

    // The loop is stopped: no further messages.
    const counts = [h.messages(2).length, h.messages(7).length];
    vi.advanceTimersByTime(500);
    expect([h.messages(2).length, h.messages(7).length]).toEqual(counts);
  });

  it('stop() halts the loop without onEnded', () => {
    const h = makeHarness();
    h.runtime.start();
    vi.advanceTimersByTime(100);
    h.runtime.stop();
    const count = h.messages(2).length;
    vi.advanceTimersByTime(500);
    expect(h.messages(2).length).toBe(count);
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.runtime.status).toBe('ended');
  });
});

describe('per-room fault isolation', () => {
  it('a throw inside the tick loop ends ONLY that match — it does not escape the timer', () => {
    // Reproduces the security finding: a send (or any runOneTick step) that
    // throws must end this match cleanly, never propagate out of onTimerFire's
    // setTimeout callback (which would crash the whole process / all rooms).
    const onEnded = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let throwOnNextSend = false;
    const runtime = createMatchRuntime({
      ruleset,
      seed: 0xc0ffee,
      seats: [
        { slot: 2, name: 'P2' },
        { slot: 7, name: 'P7' },
      ],
      sendToSlot: (_slot, msg) => {
        if (throwOnNextSend && msg.type === 'snapshotDelta') {
          throw new Error('simulated tick-loop fault');
        }
      },
      onEnded,
    });
    liveRuntimes.push(runtime);

    runtime.start();
    vi.advanceTimersByTime(100); // a few healthy ticks
    expect(runtime.status).toBe('running');

    // Arm the fault and let the next timer fire. advanceTimersByTime must NOT
    // throw — the runtime swallows the fault internally.
    throwOnNextSend = true;
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();

    // The match ended cleanly (onEnded fired, status flipped) and the loop is
    // stopped: no further timers run.
    expect(runtime.status).toBe('ended');
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(runtime.status).toBe('ended');
  });

  it('one room throwing does not stop a concurrent healthy room from advancing', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let breakRoomA = false;
    const roomA = createMatchRuntime({
      ruleset,
      seed: 0xa,
      seats: [
        { slot: 2, name: 'A2' },
        { slot: 7, name: 'A7' },
      ],
      sendToSlot: (_slot, msg) => {
        if (breakRoomA && msg.type === 'snapshotDelta') throw new Error('room A fault');
      },
      onEnded: vi.fn(),
    });
    let roomBTicks = 0;
    const roomB = createMatchRuntime({
      ruleset,
      seed: 0xb,
      seats: [
        { slot: 2, name: 'B2' },
        { slot: 7, name: 'B7' },
      ],
      sendToSlot: (slot, msg) => {
        if (slot === 2 && msg.type === 'snapshotDelta') roomBTicks += 1;
      },
      onEnded: vi.fn(),
    });
    liveRuntimes.push(roomA, roomB);

    roomA.start();
    roomB.start();
    vi.advanceTimersByTime(100);
    const bBefore = roomBTicks;

    breakRoomA = true;
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();

    expect(roomA.status).toBe('ended'); // A died
    expect(roomB.status).toBe('running'); // B is unaffected
    expect(roomBTicks).toBeGreaterThan(bBefore); // B kept advancing
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('determinism', () => {
  it('replaying (seed, tick->commands) into a fresh createMatch matches hashState', () => {
    const seed = 0xdecade;
    const h = makeHarness([2, 7], seed);
    h.runtime.start();

    const start2 = ruleset.map.playerStarts[2];
    const start7 = ruleset.map.playerStarts[7];
    if (!start2 || !start7) throw new Error('starts missing');

    h.runtime.enqueueCommand(2, { type: 'move', player: 2, x: start2.x + 600, y: start2.y });
    vi.advanceTimersByTime(250);
    h.runtime.enqueueCommand(7, { type: 'attackMove', player: 7, x: start7.x, y: start7.y - 800 });
    h.runtime.enqueueCommand(2, { type: 'setGoldDump', player: 2, enabled: true });
    vi.advanceTimersByTime(500);
    h.runtime.enqueueCommand(2, { type: 'stop', player: 2 });
    h.runtime.enqueueCommand(7, { type: 'fireMissile', player: 7 }); // rejected (no warhead)
    vi.advanceTimersByTime(1750); // 50 ticks total
    h.runtime.stop();

    const live = h.runtime.getState();
    expect(live.tick).toBe(50);
    expect(h.runtime.replay.seed).toBe(seed);

    const replayed = createMatch(ruleset, seed, [
      { slot: 2, control: 'user' },
      { slot: 7, control: 'user' },
    ]);
    for (let tick = 0; tick < live.tick; tick++) {
      const commands = h.runtime.replay.commandsByTick.get(tick) ?? [];
      applyCommands(replayed, ruleset, [...commands]);
      stepTick(replayed, ruleset);
    }
    expect(hashState(replayed)).toBe(hashState(live));
  });
});

describe('AI players', () => {
  it('seeds aiMemory only for AI seats and runs the brain on its cadence', () => {
    // One human south (slot 2), one AI north (slot 7, normal => every 10 ticks).
    const h = makeHarness([2], 0xa1, [{ slot: 7, ai: { difficulty: 'normal' } }]);
    h.runtime.start();

    const state = h.runtime.getState();
    // createMatch seeded aiMemory for the AI seat only.
    expect(Object.keys(state.aiMemory)).toEqual(['7']);
    expect(state.players[7]?.control).toBe('computer');
    expect(state.players[2]?.control).toBe('user');

    vi.advanceTimersByTime(1000); // 20 ticks: the normal bot thinks at 0 and 10

    // The AI issued commands that were logged in the replay stream.
    const aiCommands: Command[] = [];
    for (const cmds of h.runtime.replay.commandsByTick.values()) {
      for (const c of cmds) if (c.player === 7) aiCommands.push(c);
    }
    expect(aiCommands.length).toBeGreaterThanOrEqual(2);
    expect(aiCommands.every((c) => c.type === 'attackMove')).toBe(true);
    // nextThinkTick advanced by the brain (10-tick cadence): due again at 20.
    expect(h.runtime.getState().aiMemory[7]?.nextThinkTick).toBe(20);
  });

  it('keeps the AI seat out of seatSlots: no snapshots, no scoreboard line', () => {
    const h = makeHarness([2], 0xa2, [{ slot: 7, ai: { difficulty: 'normal' } }]);
    h.runtime.start();
    vi.advanceTimersByTime(200);

    // The AI slot receives nothing.
    expect(h.sent.get(7)).toBeUndefined();
    // The scoreboard only lists the human seat (AI is not a participant).
    const snap = h.messages(2)[0] as SnapshotMessage;
    expect(snap.players.map((p) => p.slot)).toEqual([2]);
  });

  it('merges AI commands into the per-tick batch ascending-slot / FIFO', () => {
    // AI on both teams (slots 2 and 7) — both think at tick 0.
    const h = makeHarness([], 0xa3, [
      { slot: 7, ai: { difficulty: 'normal' } },
      { slot: 2, ai: { difficulty: 'normal' } },
    ]);
    h.runtime.start();
    vi.advanceTimersByTime(50); // tick 1 — commands queued at tick 0

    const tick0 = h.runtime.replay.commandsByTick.get(0);
    expect(tick0?.map((c) => c.player)).toEqual([2, 7]); // ascending slot
  });

  it('ends on enemy HQ death with the AI team as winner', () => {
    // Human south vs AI north; sink the south HQ so north (AI) wins.
    const h = makeHarness([2], 0xa4, [{ slot: 7, ai: { difficulty: 'normal' } }]);
    h.runtime.start();
    vi.advanceTimersByTime(200);

    const state = h.runtime.getState();
    const southHq = Object.values(state.entities).find(
      (e): e is StructureEntity => e.kind === 'structure' && e.role === 'hq' && e.team === 'south',
    );
    if (!southHq) throw new Error('south HQ not found');
    southHq.hp = 0;
    southHq.dead = true;

    vi.advanceTimersByTime(50);
    expect(h.runtime.status).toBe('ended');
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.onEnded.mock.calls[0]?.[0]).toMatchObject({ winnerTeam: 'north' });
    // Only the human seat got a matchEnded (AI seat is not a recipient).
    expect((h.messages(2).at(-1) as ServerMessage).type).toBe('matchEnded');
    expect(h.sent.get(7)).toBeUndefined();
  });

  it('replays bit-identically with AI on both teams (hashState equality)', () => {
    // Drive an AI-only match (no human input at all), then re-run a second
    // runtime from the SAME seed + AI configs. The fixture brain is a pure
    // function of (state, slot, memory), so the AI command stream AND the
    // aiMemory mutations reproduce exactly — final hashState must match.
    const seed = 0xa1de;
    const aiSeats: AiSeat[] = [
      { slot: 2, ai: { difficulty: 'hard' } },
      { slot: 7, ai: { difficulty: 'easy' } },
    ];

    const run = (): { live: SimState; log: ReadonlyMap<number, readonly Command[]> } => {
      const h = makeHarness([], seed, aiSeats);
      h.runtime.start();
      vi.advanceTimersByTime(2500); // 50 ticks of pure-AI play
      h.runtime.stop();
      return { live: h.runtime.getState(), log: h.runtime.replay.commandsByTick };
    };

    const a = run();
    const b = run();
    expect(a.live.tick).toBe(50);
    expect(b.live.tick).toBe(50);
    // Identical command streams produced by the deterministic brain.
    expect([...a.log.entries()]).toEqual([...b.log.entries()]);
    // Identical final state (includes aiMemory, which hashState digests) — the
    // bit-identical-replay property the determinism mandate requires for AI.
    expect(hashState(a.live)).toBe(hashState(b.live));
  });

  it('a single human can play solo: an AI-only enemy team is a valid match', () => {
    const h = makeHarness([2], 0x5010, [{ slot: 7, ai: { difficulty: 'normal' } }]);
    h.runtime.start();
    vi.advanceTimersByTime(500);
    // The match is live and ticking with one human + one AI.
    expect(h.runtime.status).toBe('running');
    expect(h.runtime.getState().tick).toBe(10);
    // Human keyframe + deltas were sent.
    expect(h.snapshots(2).length).toBeGreaterThan(1);
  });
});
