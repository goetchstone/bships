/**
 * Match runtime integration tests against the real Classic ruleset, driven
 * with fake timers (the drift-corrected setTimeout chain reads the mocked
 * Date.now, so ticks advance deterministically with the clock).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommands, createMatch, hashState, stepTick } from '@bships/core';
import type {
  PublicPlayerStat,
  ServerMessage,
  SnapshotDeltaMessage,
  SnapshotEntity,
  SnapshotMessage,
  StructureEntity,
} from '@bships/core';
import { getClassicRuleset } from '../src/data.js';
import { createMatchRuntime } from '../src/match.js';
import type { MatchRuntime } from '../src/match.js';
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

function makeHarness(slots: number[] = [2, 7], seed = 0xc0ffee): Harness {
  const sent = new Map<number, ServerMessage[]>();
  const onEnded = vi.fn();
  const runtime = createMatchRuntime({
    ruleset,
    seed,
    seats: slots.map((slot) => ({ slot, name: `P${slot}` })),
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
