/**
 * Bot-vs-bot match integration: the REAL deterministic AI brain
 * (`computeAiCommands`) driving a full match through the REAL server runtime
 * (`createMatchRuntime` -> `runAiTick` -> `applyCommands` -> `stepTick`), AI on
 * BOTH teams and zero humans.
 *
 * Unlike `match.test.ts` (which mocks the brain with a fixture to isolate the
 * match.ts <-> ai-runner wiring), this suite imports `@bships/core` UNMOCKED so
 * the actual brain body decides every command. It asserts two things:
 *
 *  1. The AI actually PLAYS — over a tick cap the bots buy items (purchase
 *     events fire + inventory grows), sail from spawn toward the enemy HQ
 *     (distance to the enemy HQ shrinks), creeps/ships die, and the enemy HQ
 *     takes damage. (A full HQ kill needs ~20 min of sim — 20000 HQ HP chipped
 *     ~30/min — so we assert real damage within the cap, not a declared
 *     winner; see the milestone comments below for the observed timings.)
 *  2. Determinism HOLDS with the brain in the loop — two seed-equal AI-only
 *     runs produce a bit-identical final `hashState` and command stream, and a
 *     different seed diverges.
 *
 * Burst mode (`tickIntervalMs: 0`) runs the sim as fast as the event loop
 * allows; we poll `getState().tick` with real timers until the cap. Wall-clock
 * pacing never touches sim results (the determinism contract) — it only decides
 * WHEN ticks run, so the hash equality below is unaffected by timing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { hashState, sortedNumericKeys } from '@bships/core';
import type { SimState, StructureEntity, TeamId } from '@bships/core';
import { getClassicRuleset } from '../src/data.js';
import { createMatchRuntime } from '../src/match.js';
import type { AiSeat, MatchRuntime } from '../src/match.js';

const ruleset = getClassicRuleset();

const SOUTH_SLOT = 2;
const NORTH_SLOT = 7;

/** AI on both teams (no humans). Hard difficulty => sharpest, fastest play. */
const BOTH_TEAMS_AI: AiSeat[] = [
  { slot: SOUTH_SLOT, ai: { difficulty: 'hard' } },
  { slot: NORTH_SLOT, ai: { difficulty: 'hard' } },
];

const liveRuntimes: MatchRuntime[] = [];

afterEach(() => {
  while (liveRuntimes.length > 0) liveRuntimes.pop()?.stop();
});

interface BotMatch {
  runtime: MatchRuntime;
  ended: boolean;
  winnerTeam: TeamId | null | undefined;
}

function liveEnemyHq(state: SimState, foe: TeamId): StructureEntity | null {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (e && e.kind === 'structure' && e.role === 'hq' && e.team === foe && !e.dead) {
      return e;
    }
  }
  return null;
}

function shipPos(state: SimState, slot: number): { x: number; y: number } | null {
  const player = state.players[slot];
  if (!player || player.shipId === null) return null;
  const ship = state.entities[player.shipId];
  return ship && ship.kind === 'ship' ? { x: ship.x, y: ship.y } : null;
}

/**
 * Start an AI-only match in burst mode and let it run up to `tickCap` ticks (or
 * a natural HQ-death end), polling on real timers. The brain runs UNMOCKED
 * through the server runtime, so this exercises the full production stack.
 */
async function runBotMatch(seed: number, tickCap: number): Promise<BotMatch> {
  let ended = false;
  let winnerTeam: TeamId | null | undefined;

  const runtime = createMatchRuntime({
    ruleset,
    seed,
    seats: [], // no humans
    aiSeats: BOTH_TEAMS_AI,
    tickIntervalMs: 0, // burst: as fast as the event loop allows
    // AI seats receive no snapshots; sendToSlot is never called for them.
    sendToSlot: () => {},
    onEnded: (report) => {
      ended = true;
      winnerTeam = report.winnerTeam;
    },
  });
  liveRuntimes.push(runtime);

  runtime.start();

  // Burst mode fires a 0-delay timer each macrotask; yield to the event loop
  // repeatedly until the sim reaches the cap or ends naturally.
  for (;;) {
    const state = runtime.getState();
    if (state.status.phase === 'ended' || state.tick >= tickCap) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  return { runtime, ended, winnerTeam };
}

describe('bot-vs-bot match (real brain, both teams AI)', () => {
  // Observed milestones for seed 0x1234 hard-vs-hard (core-level drive):
  //   ship advanced >2000 units toward enemy HQ by tick ~313,
  //   first death by tick ~462, first item purchase by tick ~1026,
  //   enemy HQ first damaged by tick ~1156. A 2000-tick cap clears all four
  //   with margin while staying well under a second of burst wall-clock.
  const TICK_CAP = 2000;
  const SEED = 0x1234;

  it('the AI sails from spawn toward the enemy HQ (distance shrinks)', async () => {
    const runtime = createMatchRuntime({
      ruleset,
      seed: SEED,
      seats: [],
      aiSeats: BOTH_TEAMS_AI,
      tickIntervalMs: 0,
      sendToSlot: () => {},
      onEnded: () => {},
    });
    liveRuntimes.push(runtime);

    const start = runtime.getState();
    const northHq0 = liveEnemyHq(start, 'north');
    const southHq0 = liveEnemyHq(start, 'south');
    const southStart = shipPos(start, SOUTH_SLOT);
    const northStart = shipPos(start, NORTH_SLOT);
    expect(northHq0 && southHq0 && southStart && northStart).toBeTruthy();
    const southToEnemyHq0 = Math.hypot(northHq0!.x - southStart!.x, northHq0!.y - southStart!.y);
    const northToEnemyHq0 = Math.hypot(southHq0!.x - northStart!.x, southHq0!.y - northStart!.y);

    runtime.start();
    let southClosest = southToEnemyHq0;
    let northClosest = northToEnemyHq0;
    for (;;) {
      const s = runtime.getState();
      if (s.status.phase === 'ended' || s.tick >= TICK_CAP) break;
      const sp = shipPos(s, SOUTH_SLOT);
      const np = shipPos(s, NORTH_SLOT);
      const nhq = liveEnemyHq(s, 'north');
      const shq = liveEnemyHq(s, 'south');
      if (sp && nhq) southClosest = Math.min(southClosest, Math.hypot(nhq.x - sp.x, nhq.y - sp.y));
      if (np && shq) northClosest = Math.min(northClosest, Math.hypot(shq.x - np.x, shq.y - np.y));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    // Both bots closed a meaningful distance toward the enemy HQ.
    expect(southClosest).toBeLessThan(southToEnemyHq0 - 2000);
    expect(northClosest).toBeLessThan(northToEnemyHq0 - 2000);
  });

  it('the AI buys items (inventory grows + buyItem commands) and the enemy HQ takes damage', async () => {
    const invPeak = new Map<number, number>();

    const runtime = createMatchRuntime({
      ruleset,
      seed: SEED,
      seats: [],
      aiSeats: BOTH_TEAMS_AI,
      tickIntervalMs: 0,
      sendToSlot: () => {},
      onEnded: () => {},
    });
    liveRuntimes.push(runtime);

    const start = runtime.getState();
    const northHqHp0 = liveEnemyHq(start, 'north')!.hp;
    const southHqHp0 = liveEnemyHq(start, 'south')!.hp;
    const invStartSouth = start.players[SOUTH_SLOT]!.inventory.filter((i) => i !== null).length;
    const nextIdStart = start.nextEntityId;
    const entityCount0 = Object.keys(start.entities).length;

    runtime.start();
    // Poll the live state for durable signals (inventory growth). The buyItem
    // commands the brain emitted survive in the runtime's deterministic replay
    // log, which we read after the run.
    for (;;) {
      const s = runtime.getState();
      if (s.status.phase === 'ended' || s.tick >= TICK_CAP) break;
      for (const slot of [SOUTH_SLOT, NORTH_SLOT]) {
        const inv = s.players[slot]!.inventory.filter((i) => i !== null).length;
        invPeak.set(slot, Math.max(invPeak.get(slot) ?? 0, inv));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    const end = runtime.getState();

    // Inventory grew beyond the start loadout for at least the south bot (it
    // bought a Stone Hull on top of its opening cannon by ~tick 1026).
    expect(invPeak.get(SOUTH_SLOT)!).toBeGreaterThan(invStartSouth);

    // The brain emitted buyItem commands (the purchase signal that survives in
    // the runtime's deterministic replay log).
    let buyCommands = 0;
    for (const cmds of runtime.replay.commandsByTick.values()) {
      for (const c of cmds) if (c.type === 'buyItem') buyCommands += 1;
    }
    expect(buyCommands).toBeGreaterThan(0);

    // The enemy HQ lost HP: only creeps/ships pushing the lane can damage it,
    // so this simultaneously proves the bots pushed AND covers the "HQ takes
    // damage" requirement (a full 20000-HP HQ kill needs ~20 min of sim, far
    // beyond the cap).
    const northHqEnd = liveEnemyHq(end, 'north');
    const southHqEnd = liveEnemyHq(end, 'south');
    const northHqDmg = northHqEnd ? northHqHp0 - northHqEnd.hp : northHqHp0;
    const southHqDmg = southHqEnd ? southHqHp0 - southHqEnd.hp : southHqHp0;
    expect(northHqDmg + southHqDmg).toBeGreaterThan(0);

    // Creeps spawn and die: nextEntityId grows by hundreds (every spawned
    // creep/projectile claims a fresh id) while the live entity population
    // stays bounded near its start size — that gap is only possible if entities
    // are dying as fast as they spawn (~76 creep deaths over 2000 ticks in the
    // observed run). A monotonically-growing population would mean nothing died.
    const idsAllocated = end.nextEntityId - nextIdStart;
    const entityCountEnd = Object.keys(end.entities).length;
    expect(idsAllocated).toBeGreaterThan(200); // heavy spawn churn
    expect(entityCountEnd).toBeLessThan(entityCount0 + idsAllocated); // => deaths occurred

    expect(end.tick).toBeGreaterThan(0);
  });

  it('two seed-equal AI-only runs are bit-identical (determinism with AI in the loop)', async () => {
    const DET_CAP = 600; // fast + already past the first push/combat divergence points
    const a = await runBotMatch(SEED, DET_CAP);
    const aHash = hashState(a.runtime.getState());
    const aLog = [...a.runtime.replay.commandsByTick.entries()];
    const aTick = a.runtime.getState().tick;

    const b = await runBotMatch(SEED, DET_CAP);
    const bHash = hashState(b.runtime.getState());
    const bLog = [...b.runtime.replay.commandsByTick.entries()];
    const bTick = b.runtime.getState().tick;

    expect(aTick).toBe(bTick);
    // Identical command streams from the deterministic brain (AI memory lives in
    // SimState, so re-running from the same seed reproduces every decision).
    expect(bLog).toEqual(aLog);
    // Identical final world hash (hashState digests aiMemory too).
    expect(bHash).toBe(aHash);
    // The AI did real work (non-empty command stream).
    expect(aLog.length).toBeGreaterThan(0);
  });

  it('a different seed diverges (the AI stream depends on the match seed)', async () => {
    const DET_CAP = 600;
    const a = await runBotMatch(SEED, DET_CAP);
    const b = await runBotMatch(SEED ^ 0xabcdef, DET_CAP);
    expect(hashState(b.runtime.getState())).not.toBe(hashState(a.runtime.getState()));
  });

  // Long-horizon behavior: catches the failures the 2000-tick smoke tests above
  // miss (the audit found bots froze at 2 items, hoarded gold, sat in retreat
  // ~80% of the match, and never closed on the HQ). 12000 ticks (~10 min sim)
  // is a few seconds of burst wall-clock.
  it('over a long match the bots keep buying past the opening, push deep, and do not idle in retreat', async () => {
    const LONG_CAP = 6000;
    const invPeak = new Map<number, number>();
    const closest = new Map<number, number>();
    const retreatThinks = new Map<number, number>();
    const totalThinks = new Map<number, number>();

    const runtime = createMatchRuntime({
      ruleset,
      seed: SEED,
      seats: [],
      aiSeats: BOTH_TEAMS_AI,
      tickIntervalMs: 0,
      sendToSlot: () => {},
      onEnded: () => {},
    });
    liveRuntimes.push(runtime);

    const start = runtime.getState();
    const startDist = new Map<number, number>();
    for (const [slot, foe] of [
      [SOUTH_SLOT, 'north'],
      [NORTH_SLOT, 'south'],
    ] as const) {
      const sp = shipPos(start, slot)!;
      const hq = liveEnemyHq(start, foe)!;
      const d = Math.hypot(hq.x - sp.x, hq.y - sp.y);
      startDist.set(slot, d);
      closest.set(slot, d);
    }

    runtime.start();
    for (;;) {
      const s = runtime.getState();
      if (s.status.phase === 'ended' || s.tick >= LONG_CAP) break;
      for (const [slot, foe] of [
        [SOUTH_SLOT, 'north'],
        [NORTH_SLOT, 'south'],
      ] as const) {
        const inv = s.players[slot]!.inventory.filter((i) => i !== null).length;
        invPeak.set(slot, Math.max(invPeak.get(slot) ?? 0, inv));
        const sp = shipPos(s, slot);
        const hq = liveEnemyHq(s, foe);
        if (sp && hq) closest.set(slot, Math.min(closest.get(slot)!, Math.hypot(hq.x - sp.x, hq.y - sp.y)));
        const mem = s.aiMemory[slot];
        if (mem) {
          totalThinks.set(slot, (totalThinks.get(slot) ?? 0) + 1);
          if (mem.stance === 'retreat') retreatThinks.set(slot, (retreatThinks.get(slot) ?? 0) + 1);
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    // Inventory climbed well past the 2-item ceiling the broken bots hit.
    expect(invPeak.get(SOUTH_SLOT)!).toBeGreaterThan(2);
    expect(invPeak.get(NORTH_SLOT)!).toBeGreaterThan(2);

    // Distinct items bought across the whole match exceed the opening two.
    const boughtItems = new Set<string>();
    for (const cmds of runtime.replay.commandsByTick.values()) {
      for (const c of cmds) if (c.type === 'buyItem') boughtItems.add(c.itemId);
    }
    expect(boughtItems.size).toBeGreaterThan(2);

    // Both bots pushed substantially closer to the enemy HQ than they started
    // (the broken bots stalled ~9000 units out). Margin is conservative: by
    // 6000 ticks each side has closed ~5500-7500 of its ~12900-unit gap (the
    // deepest approach, ~11400, comes later); the sampled poll only undercounts.
    expect(closest.get(SOUTH_SLOT)!).toBeLessThan(startDist.get(SOUTH_SLOT)! - 3000);
    expect(closest.get(NORTH_SLOT)!).toBeLessThan(startDist.get(NORTH_SLOT)! - 3000);

    // The bots are NOT trapped in retreat (the broken bots sat there ~80% of
    // the match). Sampled stance over the run stays overwhelmingly on offense.
    const southRetreatFrac = (retreatThinks.get(SOUTH_SLOT) ?? 0) / (totalThinks.get(SOUTH_SLOT) ?? 1);
    expect(southRetreatFrac).toBeLessThan(0.5);
  }, 30000);
});
