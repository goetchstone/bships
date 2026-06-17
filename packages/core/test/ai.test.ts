/**
 * Deterministic AI brain (sim/ai.ts) tests.
 *
 * Fixtures use the REAL compiled Classic ruleset + createMatch (the core is
 * IO-free; the test harness does the file IO, exactly like integration.test.ts
 * and ruleset.test.ts). We assert the behavior spec (docs/AI.md §6) and — most
 * importantly — the determinism contract: a given (seed, slot, fixture) yields
 * identical Command[] and identical memory.aiRngState across two runs, and a
 * full match driven by AI on BOTH teams replays bit-identically (hashState).
 *
 * The server's ai-runner.ts is a thin loop (server-owned, may be unimplemented
 * here); we reproduce its documented contract locally (`driveAiMatch`) so these
 * tests stand alone: for each AI slot in ascending order, call
 * `computeAiCommands` when `state.tick >= memory.nextThinkTick`, BEFORE
 * applyCommands, and feed the returned commands into the same per-tick batch.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AI_TUNING,
  computeAiCommands,
  deriveAiSeed,
  initAiMemory,
  thinkIntervalTicks,
} from '../src/sim/ai.js';
import { compileClassicRuleset } from '../src/sim/ruleset.js';
import { applyCommands, createMatch, hashState, stepTick } from '../src/sim/sim.js';
import type {
  AiDifficulty,
  AiMemory,
  AiRole,
  Command,
  PlayerConfig,
  RawDataFiles,
  Ruleset,
  ShipEntity,
  SimEvent,
  SimState,
  StructureEntity,
} from '../src/sim/types.js';
import { sortedNumericKeys } from '../src/sim/types.js';

// ---------------------------------------------------------------------------
// Real-data fixtures
// ---------------------------------------------------------------------------

function loadJson<T>(name: string): T {
  const url = new URL(`../../../data/json/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

function loadRaw(): RawDataFiles {
  return {
    weapons: loadJson('weapons.json'),
    equipment: loadJson('equipment.json'),
    ships: loadJson('ships.json'),
    upgradeCurves: loadJson('upgrade-curves.json'),
    scriptRules: loadJson('script-rules.json'),
    mapLayout: loadJson('map-layout.json'),
    units: loadJson('units.json'),
    abilities: loadJson('abilities.json'),
    items: loadJson('items.json'),
    buffs: loadJson('buffs.json'),
    strings: loadJson('strings.json'),
  };
}

let ruleset: Ruleset;
beforeAll(() => {
  ruleset = compileClassicRuleset(loadRaw());
});

const SOUTH_SLOT = 2;
const NORTH_SLOT = 7;
const BASIC_CANNON = 'I001';
const SOUTH_WEAPON_SHOP_KEY = 'n001_0022'; // sells I001 on the south side

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One AI slot config for the test helpers (optional role -> default captain). */
type AiSlotCfg = { slot: number; difficulty: AiDifficulty; role?: AiRole };

/** Create a match with the given slots driven by the AI brain. */
function makeAiMatch(seed: number, configs: AiSlotCfg[]): SimState {
  const playerConfigs: PlayerConfig[] = configs.map((c) => ({
    slot: c.slot,
    control: 'computer',
    ai: { difficulty: c.difficulty, role: c.role },
  }));
  return createMatch(ruleset, seed, playerConfigs);
}

/** Every human-playable slot (excludes the two empire AI lane-owner slots). */
function allAiConfigs(difficulty: AiDifficulty): { slot: number; difficulty: AiDifficulty }[] {
  const empireSouth = ruleset.map.lanes.find((l) => l.team === 'south')!.creepOwner;
  const empireNorth = ruleset.map.lanes.find((l) => l.team === 'north')!.creepOwner;
  return sortedNumericKeys(ruleset.map.playerStarts)
    .filter((slot) => slot !== empireSouth && slot !== empireNorth)
    .map((slot) => ({ slot, difficulty }));
}

function memoryOf(state: SimState, slot: number): AiMemory {
  const m = state.aiMemory[slot];
  if (!m) throw new Error(`no aiMemory for slot ${slot}`);
  return m;
}

function shipOf(state: SimState, slot: number): ShipEntity {
  const player = state.players[slot];
  if (!player || player.shipId === null) throw new Error(`slot ${slot} has no ship`);
  const e = state.entities[player.shipId];
  if (!e || e.kind !== 'ship') throw new Error(`slot ${slot} entity is not a ship`);
  return e;
}

function findStructure(state: SimState, instanceKey: string): StructureEntity {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (e && e.kind === 'structure' && e.instanceKey === instanceKey) return e;
  }
  throw new Error(`structure ${instanceKey} not placed`);
}

/** First living structure of a team + role (towers carry no instanceKey). */
function findFirstStructure(
  state: SimState,
  team: 'south' | 'north',
  role: StructureEntity['role'],
): StructureEntity {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (e && e.kind === 'structure' && !e.dead && e.team === team && e.role === role) return e;
  }
  throw new Error(`no ${team} ${role} structure`);
}

/** Run a single think for a slot at the current tick (server-runner contract). */
function think(state: SimState, slot: number): Command[] {
  return computeAiCommands(state, ruleset, slot, memoryOf(state, slot));
}

/**
 * Local mirror of the server ai-runner loop: each tick, for every AI slot in
 * ascending order whose nextThinkTick is due, call the brain BEFORE
 * applyCommands and merge its commands into the tick batch (ascending slot).
 */
function driveAiMatch(seed: number, configs: AiSlotCfg[], ticks: number) {
  const state = makeAiMatch(seed, configs);
  const captured: Command[][] = [];
  const questEvents: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    const batch: Command[] = [];
    for (const slot of sortedNumericKeys(state.aiMemory)) {
      const mem = state.aiMemory[slot];
      if (!mem) continue;
      if (state.tick >= mem.nextThinkTick) {
        batch.push(...computeAiCommands(state, ruleset, slot, mem));
      }
    }
    captured.push(batch);
    applyCommands(state, ruleset, batch);
    // stepTick returns + clears the per-tick event buffer; collect questProgress
    // so all-AI quest-firing can be asserted (events are derived, not replayed).
    for (const e of stepTick(state, ruleset)) {
      if (e.type === 'questProgress') questEvents.push(e);
    }
  }
  return { state, hash: hashState(state), captured, questEvents };
}

/** Replay a captured command stream onto a fresh match (no brain calls). */
function replayCommands(
  seed: number,
  configs: AiSlotCfg[],
  captured: Command[][],
): SimState {
  const state = makeAiMatch(seed, configs);
  for (const batch of captured) {
    applyCommands(state, ruleset, batch);
    stepTick(state, ruleset);
  }
  return state;
}

/**
 * Hash of the world state EXCLUDING aiMemory. A pure command-stream replay
 * (no brain calls) cannot reproduce the brain's private memory (nextThinkTick,
 * aiRngState, ...) — that lives only in the driven run — but it MUST reproduce
 * every entity/player/team field bit-identically. Re-driving the brain instead
 * reproduces the FULL hash (see the determinism spec).
 */
function worldHash(state: SimState): string {
  const clone = JSON.parse(JSON.stringify(state)) as SimState;
  clone.aiMemory = {};
  return hashState(clone);
}

// ---------------------------------------------------------------------------
// Seeding / cadence
// ---------------------------------------------------------------------------

describe('AI seeding + cadence', () => {
  it('deriveAiSeed is stable and diverges per slot', () => {
    expect(deriveAiSeed(42, SOUTH_SLOT)).toBe(deriveAiSeed(42, SOUTH_SLOT));
    expect(deriveAiSeed(42, SOUTH_SLOT)).not.toBe(deriveAiSeed(42, NORTH_SLOT));
    expect(deriveAiSeed(42, SOUTH_SLOT)).not.toBe(deriveAiSeed(43, SOUTH_SLOT));
  });

  it('initAiMemory wires the private PRNG from the derived seed', () => {
    const mem = initAiMemory(SOUTH_SLOT, 42, { difficulty: 'normal' });
    expect(mem.aiRngState).toBe(deriveAiSeed(42, SOUTH_SLOT));
    expect(mem.initialSeed).toBe(deriveAiSeed(42, SOUTH_SLOT));
    expect(mem.stance).toBe('push');
    expect(mem.nextThinkTick).toBe(0);
  });

  it('advances nextThinkTick by the difficulty cadence on every think', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
    think(state, SOUTH_SLOT);
    expect(memoryOf(state, SOUTH_SLOT).nextThinkTick).toBe(thinkIntervalTicks('normal'));
  });

  it('difficulty changes the cadence (easy slower than hard)', () => {
    const easy = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'easy' }]);
    const hard = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    think(easy, SOUTH_SLOT);
    think(hard, SOUTH_SLOT);
    expect(memoryOf(easy, SOUTH_SLOT).nextThinkTick).toBe(AI_TUNING.easy.thinkIntervalTicks);
    expect(memoryOf(hard, SOUTH_SLOT).nextThinkTick).toBe(AI_TUNING.hard.thinkIntervalTicks);
    expect(AI_TUNING.easy.thinkIntervalTicks).toBeGreaterThan(AI_TUNING.hard.thinkIntervalTicks);
  });

  it('a too-early think (tick < nextThinkTick) is a no-op (cadence + RNG untouched)', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
    const mem = memoryOf(state, SOUTH_SLOT);
    think(state, SOUTH_SLOT); // first think advances nextThinkTick past tick 0
    const savedRng = mem.aiRngState;
    const savedNext = mem.nextThinkTick;
    expect(savedNext).toBeGreaterThan(0);
    const cmds = think(state, SOUTH_SLOT); // still tick 0 < nextThinkTick
    expect(cmds).toEqual([]);
    expect(mem.aiRngState).toBe(savedRng);
    expect(mem.nextThinkTick).toBe(savedNext);
  });
});

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

describe('AI economy', () => {
  it('opening buy is a Basic Cannon (I001) from the south weapon shop when affordable + in range', () => {
    // hard difficulty: economyEfficiency 1.0 => always makes the ideal buy.
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    const shop = findStructure(state, SOUTH_WEAPON_SHOP_KEY);
    const ship = shipOf(state, SOUTH_SLOT);
    // Park the ship inside the shop's interact radius.
    const spec = ruleset.shops[shop.typeId]!;
    ship.x = shop.x;
    ship.y = shop.y + spec.interactRadius - 10;
    // Start ship already carries one I001 (start item); selling I001 is not the
    // opening — make the bot need it by clearing inventory so it buys a cannon.
    const player = state.players[SOUTH_SLOT]!;
    player.inventory = [null, null, null, null, null, null];
    player.gold = 1000; // comfortably above reserve + cannon price
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds).toContainEqual({
      type: 'buyItem',
      player: SOUTH_SLOT,
      shopId: shop.id,
      itemId: BASIC_CANNON,
    });
  });

  it('moves toward the shop (does not buy) when out of interact range', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    const shop = findStructure(state, SOUTH_WEAPON_SHOP_KEY);
    const ship = shipOf(state, SOUTH_SLOT);
    // Far from the shop.
    ship.x = shop.x + 3000;
    ship.y = shop.y;
    const player = state.players[SOUTH_SLOT]!;
    player.inventory = [null, null, null, null, null, null];
    player.gold = 1000;
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds.some((c) => c.type === 'buyItem')).toBe(false);
    const move = cmds.find((c) => c.type === 'move');
    expect(move).toBeDefined();
    if (move && move.type === 'move') {
      // The move heads back toward the shop (smaller x than the ship's).
      expect(move.x).toBeLessThan(ship.x);
    }
  });

  it('does not spend below the reserve (normal keeps reserveGold on hand)', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
    const shop = findStructure(state, SOUTH_WEAPON_SHOP_KEY);
    const ship = shipOf(state, SOUTH_SLOT);
    const spec = ruleset.shops[shop.typeId]!;
    ship.x = shop.x;
    ship.y = shop.y + spec.interactRadius - 10;
    const player = state.players[SOUTH_SLOT]!;
    player.inventory = [null, null, null, null, null, null];
    // Below reserve (100) + cannon (200): only 150 gold => cannot afford a buy
    // that keeps the reserve.
    player.gold = 150;
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds.some((c) => c.type === 'buyItem')).toBe(false);
  });

  it('every item the bot ever buys is sold by at least one shop (no un-buyable ladder rung)', () => {
    // Regression for the I007 wedge: a ladder rung no shop carries can never be
    // bought and (walking the ladder in order) freezes every later rung. Drive
    // a long AI-only match and assert every buyItem the brain emitted targets a
    // shop that actually sells that item.
    const { captured } = driveAiMatch(0x1234, [
      { slot: SOUTH_SLOT, difficulty: 'hard' },
      { slot: NORTH_SLOT, difficulty: 'hard' },
    ], 4000);
    const sellsItem = (itemId: string): boolean =>
      Object.values(ruleset.shops).some((s) => s.items.some((i) => i.itemId === itemId));
    let buys = 0;
    for (const batch of captured) {
      for (const c of batch) {
        if (c.type !== 'buyItem') continue;
        buys += 1;
        expect(sellsItem(c.itemId), `no shop sells ${c.itemId}`).toBe(true);
      }
    }
    expect(buys).toBeGreaterThan(0);
  }, 30000);

  it('economy climbs the BALANCE ladder past the opening: inventory grows beyond 2 items', () => {
    // Regression for the economy lockout / ladder wedge: over a bot-vs-bot match
    // the south bot must accumulate MORE than its opening cannon + first hull
    // (the old bots froze at exactly 2 items and banked all their gold).
    // PREMISE SHIFT (creep hold-at-tower fix): creeps now hold + grind at the
    // frontmost enemy tower instead of ghosting to the HQ, so the battlefield —
    // and the bot's bounty/survival economy that rides on it — plays out on a
    // later clock. At seed 0x1234 hard-vs-hard it now reaches 3 items by ~tick
    // 1610 and a Bronze/Gold hull by ~tick 4185 (was ~1315 / ~2350); 6000 ticks
    // clears both with margin. The milestones themselves are unchanged.
    const { state } = driveAiMatch(0x1234, [
      { slot: SOUTH_SLOT, difficulty: 'hard' },
      { slot: NORTH_SLOT, difficulty: 'hard' },
    ], 6000);
    const inv = state.players[SOUTH_SLOT]!.inventory.filter((i) => i !== null);
    expect(inv.length).toBeGreaterThan(2);
    // And it climbed a hull beyond the cheapest Stone Hull (drop-then-upgrade
    // through the one-per-ship stack cap actually works).
    const hulls = inv.map((i) => i!.itemId).filter((id) => ['I016', 'I00A'].includes(id));
    expect(hulls.length).toBeGreaterThan(0);
  }, 30000);

  it('skips an out-of-stock ladder rung instead of re-issuing a doomed buy', () => {
    // Regression for the shop-stuck infinite loop: the bot wanted the Gold Hull
    // (I00A, stockMax 1) at a shop that was out of stock and re-issued the same
    // rejected buy forever, never upgrading and never pushing. With the stock
    // skip it must NOT emit a buy for an out-of-stock rung; it falls through to
    // the next thing (a cheaper rung, or — ladder exhausted — the push).
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    const shop = findStructure(state, SOUTH_WEAPON_SHOP_KEY);
    // Sanity: this shop is the one selling the contested limited-stock items in
    // a real match; here we force a stock-0 record on whatever it sells with a
    // stock cap, dock the ship, and give it the lower hull tiers so I00A is next.
    const ship = shipOf(state, SOUTH_SLOT);
    const spec = ruleset.shops[shop.typeId]!;
    ship.x = shop.x;
    ship.y = shop.y + spec.interactRadius - 10;
    const player = state.players[SOUTH_SLOT]!;
    player.gold = 100000;
    // Own everything up to (but not including) the Gold Hull so I00A is the next
    // rung; then zero its stock at every shop that sells it.
    player.inventory = [
      { itemId: 'I001', charges: null, readyAtTick: 0 },
      { itemId: 'I016', charges: null, readyAtTick: 0 }, // Bronze Hull (so next is Gold)
      { itemId: 'I008', charges: null, readyAtTick: 0 },
      { itemId: 'I00B', charges: null, readyAtTick: 0 },
      null,
      null,
    ];
    for (const id of sortedNumericKeys(state.entities)) {
      const e = state.entities[id];
      if (!e || e.kind !== 'structure' || !e.shopStock) continue;
      const ss = ruleset.shops[e.typeId];
      if (ss?.items.some((i) => i.itemId === 'I00A')) {
        e.shopStock['I00A'] = { stock: 0, nextRestockTick: 1e9 };
      }
    }
    // Force the economy branch (economyEfficiency draw) by maxing it: hard = 1.0.
    const cmds = think(state, SOUTH_SLOT);
    // Must NOT try to buy the out-of-stock Gold Hull (and must not drop a hull
    // for an upgrade it cannot complete).
    expect(cmds.some((c) => c.type === 'buyItem' && c.itemId === 'I00A')).toBe(false);
  });

  it('researches a team upgrade once it owns the top hull and banks a surplus', () => {
    // Empire research: the lowest-slot living team bot, holding the top hull and
    // plenty of gold, issues a research command for a team upgrade (R000-R005).
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    const player = state.players[SOUTH_SLOT]!;
    player.gold = 50000; // well above the surplus reserve
    player.inventory = [
      { itemId: 'I001', charges: null, readyAtTick: 0 },
      { itemId: 'I00A', charges: null, readyAtTick: 0 }, // top hull owned
      { itemId: 'I008', charges: null, readyAtTick: 0 },
      { itemId: 'I00B', charges: null, readyAtTick: 0 },
      null,
      null,
    ];
    const cmds = think(state, SOUTH_SLOT);
    const research = cmds.find((c) => c.type === 'research');
    expect(research).toBeDefined();
    if (research && research.type === 'research') {
      const spec = ruleset.upgrades[research.upgradeId];
      expect(spec?.researchable).toBe(true);
    }
  });

  it('does NOT research before owning the top hull (combat power comes first)', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    const player = state.players[SOUTH_SLOT]!;
    player.gold = 50000;
    player.inventory = [
      { itemId: 'I001', charges: null, readyAtTick: 0 },
      { itemId: 'I016', charges: null, readyAtTick: 0 }, // only Bronze hull
      null,
      null,
      null,
      null,
    ];
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds.some((c) => c.type === 'research')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Push / targeting toward the enemy HQ
// ---------------------------------------------------------------------------

describe('AI push + targeting', () => {
  it('south bot attack-moves toward the NORTH HQ (far +y)', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    // Give it a cannon + full inventory so the economy branch is satisfied and
    // it proceeds straight to the push branch.
    const player = state.players[SOUTH_SLOT]!;
    player.gold = 0; // nothing to spend
    const cmds = think(state, SOUTH_SLOT);
    const am = cmds.find((c) => c.type === 'attackMove');
    expect(am).toBeDefined();
    if (am && am.type === 'attackMove') {
      const ship = shipOf(state, SOUTH_SLOT);
      // North HQ is at far +y; the order must be northward of the ship.
      expect(am.y).toBeGreaterThan(ship.y);
      expect(am.y).toBeGreaterThan(0);
    }
  });

  it('north bot attack-moves toward the SOUTH HQ (far -y)', () => {
    const state = makeAiMatch(42, [{ slot: NORTH_SLOT, difficulty: 'hard' }]);
    const player = state.players[NORTH_SLOT]!;
    player.gold = 0;
    const cmds = think(state, NORTH_SLOT);
    const am = cmds.find((c) => c.type === 'attackMove');
    expect(am).toBeDefined();
    if (am && am.type === 'attackMove') {
      const ship = shipOf(state, NORTH_SLOT);
      expect(am.y).toBeLessThan(ship.y);
      expect(am.y).toBeLessThan(0);
    }
  });

  it('SIEGE: with no mobile enemy in range, a south bot near a north tower aims AT that tower', () => {
    // Without a deliberate siege fallback the bot only aims at the distant HQ
    // point and chips structures incidentally — an all-AI match never resolves.
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    const player = state.players[SOUTH_SLOT]!;
    player.gold = 0; // skip the economy branch -> straight to push/siege
    // A north (enemy) tower the south bot can siege.
    const tower = findFirstStructure(state, 'north', 'tower');
    // Park the south ship just inside siege range of that tower, with no enemy
    // ships/creeps anywhere (a fresh match at tick 0 has none on the field).
    const ship = shipOf(state, SOUTH_SLOT);
    ship.x = tower.x + 300;
    ship.y = tower.y - 300;
    const cmds = think(state, SOUTH_SLOT);
    const am = cmds.find((c) => c.type === 'attackMove');
    expect(am).toBeDefined();
    if (am && am.type === 'attackMove') {
      // The waypoint should be AT the tower (within a tight band), not the
      // distant HQ — proof the bot is sieging the structure, not ghosting past.
      expect(Math.hypot(am.x! - tower.x, am.y! - tower.y)).toBeLessThan(50);
    }
  });

  it('SIEGE works at EASY difficulty too (every match must be able to end)', () => {
    const state = makeAiMatch(7, [{ slot: SOUTH_SLOT, difficulty: 'easy' }]);
    const player = state.players[SOUTH_SLOT]!;
    player.gold = 0;
    const tower = findFirstStructure(state, 'north', 'tower');
    const ship = shipOf(state, SOUTH_SLOT);
    ship.x = tower.x + 300;
    ship.y = tower.y - 300;
    // Easy may take several thinks (low microQuality), but the siege fallback
    // runs on BOTH the micro and non-micro paths, so the bot eventually aims at
    // the tower regardless of the draw.
    let aimedAtTower = false;
    for (let i = 0; i < 20 && !aimedAtTower; i++) {
      const cmds = think(state, SOUTH_SLOT);
      const am = cmds.find((c) => c.type === 'attackMove');
      if (am && am.type === 'attackMove' && Math.hypot(am.x! - tower.x, am.y! - tower.y) < 50) {
        aimedAtTower = true;
      }
      // Advance enough ticks past the cadence gate for the next think.
      state.tick = memoryOf(state, SOUTH_SLOT).nextThinkTick;
    }
    expect(aimedAtTower).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Survival / retreat
// ---------------------------------------------------------------------------

describe('AI survival', () => {
  it('retreats toward own base when hp/maxHp falls below retreatHpFraction', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
    const player = state.players[SOUTH_SLOT]!;
    player.gold = 0;
    const ship = shipOf(state, SOUTH_SLOT);
    // Drive it up toward the enemy first, then wound it below 30%.
    ship.x = 0;
    ship.y = 1000;
    ship.hp = Math.floor(ship.maxHp * 0.2);
    const cmds = think(state, SOUTH_SLOT);
    expect(memoryOf(state, SOUTH_SLOT).stance).toBe('retreat');
    const move = cmds.find((c) => c.type === 'move');
    expect(move).toBeDefined();
    if (move && move.type === 'move') {
      // South base is far -y: retreat order is southward of the ship.
      expect(move.y).toBeLessThan(ship.y);
    }
    // Should not be issuing an attack-move while retreating.
    expect(cmds.some((c) => c.type === 'attackMove')).toBe(false);
  });

  it('retreats toward the repair-bay STATION (where the engine heals), not the HQ', () => {
    // Regression: routing retreat to the HQ point left the bot relying on the
    // glacial passive regen; it must aim at the repair-bay station region whose
    // full-heal makes the recover band reachable.
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
    state.players[SOUTH_SLOT]!.gold = 0;
    const ship = shipOf(state, SOUTH_SLOT);
    ship.x = 0;
    ship.y = 1000;
    ship.hp = Math.floor(ship.maxHp * 0.2);
    const cmds = think(state, SOUTH_SLOT);
    const move = cmds.find((c) => c.type === 'move');
    expect(move).toBeDefined();
    const bay = ruleset.map.repairBays.find((b) => b.team === 'south')!;
    const station = ruleset.map.regions[bay.stationRegion]!;
    if (move && move.type === 'move') {
      // The retreat order targets the station centre (not the HQ at -896,-6912).
      expect(move.x).toBeCloseTo(station.centerX, 0);
      expect(move.y).toBeCloseTo(station.centerY, 0);
    }
  });

  it('force-flips out of retreat after the bounded timeout even if not fully healed', () => {
    // Regression for the permanent-retreat trap: a bot that cannot heal must
    // re-engage after a bounded spell rather than idling at base forever.
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    state.players[SOUTH_SLOT]!.gold = 0;
    const ship = shipOf(state, SOUTH_SLOT);
    const mem = memoryOf(state, SOUTH_SLOT);
    ship.hp = Math.floor(ship.maxHp * 0.1);
    think(state, SOUTH_SLOT);
    expect(mem.stance).toBe('retreat');
    const retreatStart = mem.retreatSinceTick;
    // Keep it wounded and advance the clock past the timeout; stance flips back.
    state.tick = retreatStart + 1000; // > RETREAT_MAX_TICKS (900)
    mem.nextThinkTick = state.tick;
    ship.hp = Math.floor(ship.maxHp * 0.1); // still below retreat threshold
    think(state, SOUTH_SLOT);
    expect(mem.stance).toBe('push');
  });

  it('uses a carried repair wood while retreating', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
    const player = state.players[SOUTH_SLOT]!;
    player.gold = 0;
    player.inventory = [
      { itemId: 'I00C', charges: null, readyAtTick: 0 }, // Weak Repair Wood (instantHeal)
      null,
      null,
      null,
      null,
      null,
    ];
    const ship = shipOf(state, SOUTH_SLOT);
    ship.hp = Math.floor(ship.maxHp * 0.1);
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds).toContainEqual({ type: 'useItem', player: SOUTH_SLOT, slot: 0 });
  });

  it('hysteresis: stays in retreat between the retreat and recover bands', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
    const player = state.players[SOUTH_SLOT]!;
    player.gold = 0;
    const ship = shipOf(state, SOUTH_SLOT);
    const mem = memoryOf(state, SOUTH_SLOT);
    // Trigger retreat.
    ship.hp = Math.floor(ship.maxHp * 0.2);
    think(state, SOUTH_SLOT);
    expect(mem.stance).toBe('retreat');
    // Heal partway (above retreat 0.30 but below the recover band): still
    // retreats. Normal recover band = retreatHpFraction(0.30) +
    // RETREAT_HYSTERESIS_BAND(0.20) = 0.50, so 0.40 is squarely between.
    mem.nextThinkTick = state.tick; // allow another think this tick
    ship.hp = Math.floor(ship.maxHp * 0.4);
    think(state, SOUTH_SLOT);
    expect(mem.stance).toBe('retreat');
    // Heal fully above the recover band: back to push.
    mem.nextThinkTick = state.tick;
    ship.hp = ship.maxHp;
    think(state, SOUTH_SLOT);
    expect(mem.stance).toBe('push');
  });

  it('emits no orders while dead / awaiting respawn', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
    const player = state.players[SOUTH_SLOT]!;
    player.shipId = null;
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds).toEqual([]);
    // Cadence still advanced (the runner gates on it).
    expect(memoryOf(state, SOUTH_SLOT).nextThinkTick).toBe(thinkIntervalTicks('normal'));
  });
});

// ---------------------------------------------------------------------------
// Stuck breaking
// ---------------------------------------------------------------------------

describe('AI stuck breaking', () => {
  it('re-routes after consecutive no-progress thinks', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    const player = state.players[SOUTH_SLOT]!;
    player.gold = 0;
    const ship = shipOf(state, SOUTH_SLOT);
    ship.x = 0;
    ship.y = 0;
    // First think establishes the progress anchor + a normal push order.
    const first = think(state, SOUTH_SLOT);
    const firstAm = first.find((c) => c.type === 'attackMove');
    expect(firstAm).toBeDefined();
    // Now keep the ship pinned (no movement) across enough thinks to trip the
    // stuck threshold; the detour order must diverge from the straight push.
    let detourSeen = false;
    let lastAm: Command | undefined;
    for (let i = 0; i < 6; i++) {
      const mem = memoryOf(state, SOUTH_SLOT);
      mem.nextThinkTick = state.tick; // permit a think every loop
      const cmds = think(state, SOUTH_SLOT);
      const am = cmds.find((c) => c.type === 'attackMove');
      if (am && firstAm && am.type === 'attackMove' && firstAm.type === 'attackMove') {
        // A detour pushes laterally — x moves far off the straight corridor.
        if (Math.abs(am.x - firstAm.x) > 100) detourSeen = true;
        lastAm = am;
      }
    }
    expect(detourSeen).toBe(true);
    expect(lastAm).toBeDefined();
  });

  it('a ship advancing at full speed is NOT flagged stuck (epsilon scales with cadence)', () => {
    // Regression for the mis-calibrated fixed 64-unit epsilon: at hard cadence
    // (5 ticks) the start ship only covers ~42 units/think, so a fixed epsilon
    // flagged a flat-out ship as stuck every think and forced constant detours.
    // Simulate genuine full-speed progress by advancing the ship the expected
    // per-think distance between thinks; no detour must ever fire.
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'hard' }]);
    state.players[SOUTH_SLOT]!.gold = 0; // skip economy -> straight to push
    const ship = shipOf(state, SOUTH_SLOT);
    const shipSpec = ruleset.ships[ship.typeId]!;
    const perThink = (shipSpec.moveSpeed / ruleset.tickRate) * thinkIntervalTicks('hard');
    ship.x = 0;
    ship.y = 0;
    const first = think(state, SOUTH_SLOT);
    const firstAm = first.find((c) => c.type === 'attackMove');
    expect(firstAm).toBeDefined();
    let detourSeen = false;
    for (let i = 0; i < 10; i++) {
      // Advance the ship a full think's worth of travel toward +y (its push dir).
      ship.y += perThink;
      const mem = memoryOf(state, SOUTH_SLOT);
      mem.nextThinkTick = state.tick;
      const cmds = think(state, SOUTH_SLOT);
      const am = cmds.find((c) => c.type === 'attackMove');
      if (am && am.type === 'attackMove' && firstAm && firstAm.type === 'attackMove') {
        // A detour would push laterally off the corridor (large x swing).
        if (Math.abs(am.x - firstAm.x) > 100) detourSeen = true;
      }
      expect(mem.stuckCount).toBeLessThan(3); // never crosses the threshold
    }
    expect(detourSeen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism (the binding contract)
// ---------------------------------------------------------------------------

describe('AI determinism', () => {
  it('same (seed, slot, fixture) yields identical Command[] and aiRngState across two runs', () => {
    const buildAndThink = () => {
      const state = makeAiMatch(99, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
      // Wound + position so multiple branches (RNG draws) are exercised.
      const ship = shipOf(state, SOUTH_SLOT);
      ship.x = 100;
      ship.y = 500;
      const cmds = think(state, SOUTH_SLOT);
      return { cmds, mem: { ...memoryOf(state, SOUTH_SLOT) } };
    };
    const a = buildAndThink();
    const b = buildAndThink();
    expect(a.cmds).toEqual(b.cmds);
    expect(a.mem.aiRngState).toBe(b.mem.aiRngState);
    expect(a.mem).toEqual(b.mem);
  });

  it('commits the RNG exactly once per think (advances on a normal think)', () => {
    const state = makeAiMatch(99, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
    const mem = memoryOf(state, SOUTH_SLOT);
    const before = mem.aiRngState;
    think(state, SOUTH_SLOT);
    // A live push think draws at least once (economy/micro/stuck gates).
    expect(mem.aiRngState).not.toBe(before);
  });

  it('a full match with AI on BOTH teams replays bit-identically (hashState)', () => {
    const configs = [
      { slot: SOUTH_SLOT, difficulty: 'normal' as const },
      { slot: NORTH_SLOT, difficulty: 'hard' as const },
    ];
    const TICKS = 1500;
    const run = driveAiMatch(7, configs, TICKS);
    // Re-driving the brain from scratch reproduces the FULL hash bit-for-bit
    // (the strict replay contract: same seed + same brain => same SimState).
    const rerun = driveAiMatch(7, configs, TICKS);
    expect(rerun.hash).toBe(run.hash);
    // Re-applying ONLY the captured command stream (no brain) reproduces the
    // entire world (entities/players/teams) — everything but the brain's
    // private aiMemory, which exists only in a driven run.
    const replayed = replayCommands(7, configs, run.captured);
    expect(worldHash(replayed)).toBe(worldHash(run.state));
    // The AI actually did something (issued commands during the match).
    expect(run.captured.some((batch) => batch.length > 0)).toBe(true);
  });

  it('a different seed diverges (the AI stream depends on the seed)', () => {
    const configs = [
      { slot: SOUTH_SLOT, difficulty: 'normal' as const },
      { slot: NORTH_SLOT, difficulty: 'normal' as const },
    ];
    const a = driveAiMatch(7, configs, 800);
    const b = driveAiMatch(8, configs, 800);
    expect(a.hash).not.toBe(b.hash);
  });

  it('adding AI players does not shift the sim-mechanic RNG draw order', () => {
    // createMatch with vs without AI must keep the SAME rngState at t0 (the AI
    // seeding deliberately does not consume state.rngState — replay contract).
    const withAi = makeAiMatch(123, [{ slot: SOUTH_SLOT, difficulty: 'normal' }]);
    const withoutAi = createMatch(ruleset, 123, [{ slot: SOUTH_SLOT, control: 'user' }]);
    expect(withAi.rngState).toBe(withoutAi.rngState);
  });
});

// ---------------------------------------------------------------------------
// Match resolvability (the critical solo-vs-AI fix: the AI must be able to win)
// ---------------------------------------------------------------------------

describe('AI siege resolves the match', () => {
  it('a full all-AI match deliberately SIEGES enemy structures (a tower is destroyed or heavily damaged)', () => {
    // Before the siege fix, an all-AI match only chipped enemy structures
    // incidentally (Phoenix-Fire auto-fire during a brawl) and never resolved —
    // both HQs sat at ~99% after 40k ticks. The siege fallback (pickSiegeTarget)
    // steers a front-line ship onto the frontmost enemy tower/HQ so its carried
    // weapons fire at the STRUCTURE deliberately. Towers sit at the front and
    // take this fire first, so deliberate siege shows up as real tower attrition
    // well before an HQ kill. We assert the most-damaged enemy tower has lost a
    // large chunk of HP (or died) — the load-bearing, fast, deterministic signal
    // that the bots siege. (A full HQ kill is slow + seed-variable in symmetric
    // all-AI play; a real solo match with a human pushing one side resolves.)
    const configs = allAiConfigs('hard');
    const { state } = driveAiMatch(12345, configs, 16000);
    const towers = Object.values(state.entities).filter(
      (e): e is StructureEntity => e !== undefined && e.kind === 'structure' && e.role === 'tower',
    );
    expect(towers.length).toBeGreaterThan(0);
    const mostDamaged = Math.max(...towers.map((t) => (t.dead ? t.maxHp : t.maxHp - t.hp)));
    // Deliberate siege removes thousands of tower HP; a comfortable floor that
    // incidental chip alone would not reach.
    expect(mostDamaged).toBeGreaterThan(2000);
  }, 60000);
});

// ---------------------------------------------------------------------------
// Trader role (docs/AI.md "Trader quests"): the OPTIONAL quest-runner bot. We
// assert the trade loop (buy carrier -> buy contract -> pickup -> deliver),
// that it never runs the combat brain, and — critically — that adding a trader
// preserves the bit-identical replay contract AND makes the faithful quest
// chains fire in an all-AI match (the whole point of the role).
// ---------------------------------------------------------------------------

describe('AI trader role', () => {
  const SOUTH_HQ_KEY = 'n000_0020'; // sells the carrier hulls (H00D/H005)
  const SOUTH_TRADE_MASTER_KEY = 'n00E_0021'; // Will — sells the south trade contracts
  const TRADE_BOAT = 'H00D';
  const TRADE_SHIP = 'H005';
  const ALE_CONTRACT = 'I00K'; // free route, no lumber threshold -> first pick
  const ALE_GOODS = 'I00J';

  /** Set the player's hull type (entity + the PlayerState mirror). */
  function setHull(state: SimState, slot: number, typeId: string): void {
    const s = shipOf(state, slot);
    s.typeId = typeId;
    state.players[slot]!.shipTypeId = typeId;
  }

  it('initAiMemory defaults role to captain; the trader role is carried into memory', () => {
    expect(initAiMemory(SOUTH_SLOT, 1, { difficulty: 'normal' }).role).toBe('captain');
    expect(initAiMemory(SOUTH_SLOT, 1, { difficulty: 'normal', role: 'trader' }).role).toBe('trader');
  });

  it('buys a Trade Boat (H00D) at the team HQ when it lacks a carrier and can afford it', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal', role: 'trader' }]);
    const hq = findStructure(state, SOUTH_HQ_KEY);
    const ship = shipOf(state, SOUTH_SLOT);
    const spec = ruleset.shops[hq.typeId]!;
    ship.x = hq.x;
    ship.y = hq.y + spec.interactRadius - 10;
    state.players[SOUTH_SLOT]!.gold = 1000;
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds).toContainEqual({
      type: 'buyShip',
      player: SOUTH_SLOT,
      shopId: hq.id,
      shipTypeId: TRADE_BOAT,
    });
  });

  it('sails to the HQ (no buy) when out of interact range', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal', role: 'trader' }]);
    const hq = findStructure(state, SOUTH_HQ_KEY);
    const ship = shipOf(state, SOUTH_SLOT);
    ship.x = hq.x + 3000;
    ship.y = hq.y;
    state.players[SOUTH_SLOT]!.gold = 1000;
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds.some((c) => c.type === 'buyShip')).toBe(false);
    const move = cmds.find((c) => c.type === 'move');
    expect(move).toBeDefined();
    if (move && move.type === 'move') expect(move.x).toBeLessThan(ship.x); // heads back to the HQ
  });

  it('idles at the HQ (no buy) until income funds the Trade Boat', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal', role: 'trader' }]);
    const hq = findStructure(state, SOUTH_HQ_KEY);
    const ship = shipOf(state, SOUTH_SLOT);
    const spec = ruleset.shops[hq.typeId]!;
    ship.x = hq.x;
    ship.y = hq.y + spec.interactRadius - 10;
    state.players[SOUTH_SLOT]!.gold = 200; // below the 300g Trade Boat price
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds.some((c) => c.type === 'buyShip')).toBe(false);
  });

  it('buys the Ale trade contract at the team Trade Master once it has a carrier', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal', role: 'trader' }]);
    setHull(state, SOUTH_SLOT, TRADE_BOAT);
    const tm = findStructure(state, SOUTH_TRADE_MASTER_KEY);
    const ship = shipOf(state, SOUTH_SLOT);
    const spec = ruleset.shops[tm.typeId]!;
    ship.x = tm.x;
    ship.y = tm.y + spec.interactRadius - 10;
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds).toContainEqual({
      type: 'buyItem',
      player: SOUTH_SLOT,
      shopId: tm.id,
      itemId: ALE_CONTRACT,
    });
  });

  it('sails to the pickup region (AleFactory) while holding the contract but no goods', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal', role: 'trader' }]);
    setHull(state, SOUTH_SLOT, TRADE_BOAT);
    state.players[SOUTH_SLOT]!.inventory[1] = { itemId: ALE_CONTRACT, charges: null, readyAtTick: 0 };
    const ship = shipOf(state, SOUTH_SLOT);
    ship.x = 0;
    ship.y = -6000;
    const pickup = ruleset.map.regions['AleFactory']!;
    const cmds = think(state, SOUTH_SLOT);
    const move = cmds.find((c) => c.type === 'move');
    expect(move).toBeDefined();
    if (move && move.type === 'move') {
      expect(move.x).toBeCloseTo(pickup.centerX, 0);
      expect(move.y).toBeCloseTo(pickup.centerY, 0);
    }
    // A trader never attack-moves (it is unarmed and avoids the combat brain).
    expect(cmds.some((c) => c.type === 'attackMove')).toBe(false);
  });

  it('sails to its own reward region (SouthReward) while holding contract + goods', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal', role: 'trader' }]);
    setHull(state, SOUTH_SLOT, TRADE_BOAT);
    const player = state.players[SOUTH_SLOT]!;
    player.inventory[1] = { itemId: ALE_CONTRACT, charges: null, readyAtTick: 0 };
    player.inventory[2] = { itemId: ALE_GOODS, charges: null, readyAtTick: 0 };
    const ship = shipOf(state, SOUTH_SLOT);
    const pickup = ruleset.map.regions['AleFactory']!;
    ship.x = pickup.centerX;
    ship.y = pickup.centerY;
    const reward = ruleset.map.regions['SouthReward']!;
    const cmds = think(state, SOUTH_SLOT);
    const move = cmds.find((c) => c.type === 'move');
    expect(move).toBeDefined();
    if (move && move.type === 'move') {
      expect(move.x).toBeCloseTo(reward.centerX, 0);
      expect(move.y).toBeCloseTo(reward.centerY, 0);
    }
  });

  it('upgrades H00D -> H005 at the HQ once it can afford the Trade Ship', () => {
    const state = makeAiMatch(42, [{ slot: SOUTH_SLOT, difficulty: 'normal', role: 'trader' }]);
    setHull(state, SOUTH_SLOT, TRADE_BOAT);
    const hq = findStructure(state, SOUTH_HQ_KEY);
    const ship = shipOf(state, SOUTH_SLOT);
    const spec = ruleset.shops[hq.typeId]!;
    ship.x = hq.x;
    ship.y = hq.y + spec.interactRadius - 10;
    state.players[SOUTH_SLOT]!.gold = 6000; // >= the 4525g Trade Ship price
    const cmds = think(state, SOUTH_SLOT);
    expect(cmds).toContainEqual({
      type: 'buyShip',
      player: SOUTH_SLOT,
      shopId: hq.id,
      shipTypeId: TRADE_SHIP,
    });
  });

  it('emits ONLY trade actions (never the combat brain attackMove/research/siege)', () => {
    const run = driveAiMatch(
      7,
      [
        { slot: SOUTH_SLOT, difficulty: 'normal', role: 'trader' },
        { slot: NORTH_SLOT, difficulty: 'hard' },
      ],
      2500,
    );
    for (const batch of run.captured) {
      for (const c of batch) {
        if (c.player !== SOUTH_SLOT) continue;
        expect(['move', 'buyItem', 'buyShip']).toContain(c.type);
      }
    }
  }, 30000);

  it('a full all-AI match WITH A TRADER fires questProgress (trade deliveries)', () => {
    // The combat brain alone fires zero quests in an all-AI match (the deferred
    // decision in docs/AI.md); the trader closes at least one trade route
    // (pickup -> own reward zone -> payout), so questProgress events appear.
    const run = driveAiMatch(
      7,
      [
        { slot: SOUTH_SLOT, difficulty: 'normal', role: 'trader' },
        { slot: NORTH_SLOT, difficulty: 'hard' },
      ],
      3000,
    );
    expect(run.questEvents.some((e) => e.type === 'questProgress' && e.stage === 'delivered')).toBe(
      true,
    );
  }, 30000);

  it('a full match WITH A TRADER on both teams replays bit-identically (hashState)', () => {
    const configs: AiSlotCfg[] = [
      { slot: SOUTH_SLOT, difficulty: 'normal', role: 'trader' },
      { slot: 3, difficulty: 'hard' },
      { slot: NORTH_SLOT, difficulty: 'hard' },
    ];
    const TICKS = 2500;
    const run = driveAiMatch(7, configs, TICKS);
    // Re-driving the brain reproduces the FULL hash (the trader's AiMemory too).
    const rerun = driveAiMatch(7, configs, TICKS);
    expect(rerun.hash).toBe(run.hash);
    // Re-applying ONLY the captured commands (buyShip/buyItem/move) reproduces
    // the whole world (entities/players/teams) minus the brain's private memory.
    const replayed = replayCommands(7, configs, run.captured);
    expect(worldHash(replayed)).toBe(worldHash(run.state));
    expect(run.captured.some((b) => b.length > 0)).toBe(true);
    // And the trader actually completed quests during the determinism run.
    expect(run.questEvents.some((e) => e.type === 'questProgress' && e.stage === 'delivered')).toBe(
      true,
    );
  }, 30000);
});
