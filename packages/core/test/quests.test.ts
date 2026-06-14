/**
 * Quest-systems tests (the three secondary chains deferred from the sim-core
 * audit): the Refinery value-upgrade chain, the Repair Buildings Mission, and
 * the Treasure Hunt. Driven against the REAL compiled Classic ruleset so the
 * reward amounts are the exact values the extractor pulled from war3map.j (no
 * fixture numbers) — each test buys/acts/completes and asserts the gold / XP /
 * lumber deltas, idempotence (nothing fires twice), and determinism.
 *
 * XP is granted via progression.grantXp; rather than mock progression (which
 * would lose the real curve), we read the emitted 'xpGained' events whose
 * `amount` equals the quest reward XP and whose `reason` tags the quest.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyEconomyCommand, stepEconomy } from '../src/sim/economy.js';
import { compileClassicRuleset, validateRuleset } from '../src/sim/ruleset.js';
import { createMatch, stepTick } from '../src/sim/sim.js';
import type { Ruleset, ShipEntity, SimEvent, SimState } from '../src/sim/types.js';

function loadJson<T>(name: string): T {
  const url = new URL(`../../../data/json/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

const ruleset: Ruleset = compileClassicRuleset({
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
});

const SOUTH = 2;
const NORTH = 7;

// Region centers (data/json/map-layout.json).
const AT = {
  Refinery: { x: -1088, y: -656 },
  SouthReward: { x: 0, y: -6560 },
  NorthReward: { x: -2032, y: 6384 },
  GoblinBombShop: { x: 3744, y: 1104 },
  AleFactory: { x: 4720, y: -2000 },
  North_Main: { x: -1152, y: 6160 }, // south team's treasure #8
  Elsewhere: { x: 0, y: 0 },
} as const;

function newMatch(seed = 1): SimState {
  return createMatch(ruleset, seed, [
    { slot: SOUTH, control: 'user' },
    { slot: NORTH, control: 'user' },
  ]);
}

function ship(state: SimState, slot: number): ShipEntity {
  const player = state.players[slot];
  if (!player || player.shipId === null) throw new Error(`no ship for ${slot}`);
  const e = state.entities[player.shipId];
  if (!e || e.kind !== 'ship') throw new Error(`entity ${player.shipId} is not a ship`);
  return e;
}

/** Set the player's hull type (the entity + the PlayerState mirror). */
function setHull(state: SimState, slot: number, typeId: string): void {
  const s = ship(state, slot);
  s.typeId = typeId;
  state.players[slot]!.shipTypeId = typeId;
}

function moveTo(state: SimState, slot: number, at: { x: number; y: number }): void {
  const s = ship(state, slot);
  s.x = at.x;
  s.y = at.y;
}

/** Place `itemId` directly into the player's inventory (the named slot). */
function give(state: SimState, slot: number, itemId: string, into: number): void {
  state.players[slot]!.inventory[into] = { itemId, charges: null, readyAtTick: 0 };
}

function inv(state: SimState, slot: number): (string | null)[] {
  return state.players[slot]!.inventory.map((i) => (i ? i.itemId : null));
}

function has(state: SimState, slot: number, itemId: string): boolean {
  return inv(state, slot).includes(itemId);
}

/** Run stepEconomy with income/timers parked so only the quest scan fires. */
function runEconomy(state: SimState): SimEvent[] {
  state.timers.nextIncomeTick = 1e9;
  state.timers.nextEmpireShareTick = 1e9;
  state.timers.nextGoldDumpTick = 1e9;
  state.events = [];
  stepEconomy(state, ruleset);
  const events = state.events;
  state.events = [];
  return events;
}

function xpGains(events: SimEvent[], reason: string): number[] {
  return events
    .filter((e): e is Extract<SimEvent, { type: 'xpGained' }> => e.type === 'xpGained' && e.reason === reason)
    .map((e) => e.amount);
}

describe('ruleset: quest systems compile + validate', () => {
  it('the compiled ruleset (with all three quest systems) is internally valid', () => {
    expect(validateRuleset(ruleset)).toEqual([]);
  });

  it('exposes the refinery membership item, swaps and reward routes', () => {
    const r = ruleset.questSystems.refinery;
    expect(r.membershipItemId).toBe('I02Q');
    expect(r.refineRegion).toBe('Refinery');
    // The nine raw->refined swaps (two captives collapse to one refined good).
    const byRaw = Object.fromEntries(r.refineSwaps.map((s) => [s.rawGoodId, s.refinedGoodId]));
    expect(byRaw['I00J']).toBe('I02V'); // Ale -> Beer
    expect(byRaw['I003']).toBe('I02S'); // Raw Wood -> Carpenter's Wood
    expect(byRaw['I014']).toBe('I02U'); // Captive -> Mutated Captive
    expect(byRaw['I015']).toBe('I02U');
    expect(r.refineSwaps).toHaveLength(9);
    // Refined cash-in is 1.5x the raw route gold for the same contract.
    const ale = r.rewardRoutes.find((x) => x.contractItemId === 'I00K');
    expect(ale).toMatchObject({ refinedGoodId: 'I02V', rewardGold: 300, rewardXp: 80, rewardLumber: 1 });
    const captiveSouth = r.rewardRoutes.find((x) => x.contractItemId === 'I013');
    expect(captiveSouth).toMatchObject({ team: 'south', rewardGold: 6750, rewardXp: 850, rewardLumber: 8 });
  });

  it('treasure contracts carry NO lumber threshold (refund-only group)', () => {
    for (const shop of Object.values(ruleset.shops)) {
      for (const entry of shop.items) {
        if (entry.itemId === 'I02H' || entry.itemId === 'I02I') {
          expect(entry.lumberCost, entry.itemId).toBe(0);
        }
      }
    }
  });

  it('the repair mission contract keeps its 18-lumber threshold', () => {
    const will = ruleset.shops['n00E'];
    expect(will?.items.find((i) => i.itemId === 'I01I')?.lumberCost).toBe(18);
  });
});

// ---------------------------------------------------------------------------
// Refinery
// ---------------------------------------------------------------------------

describe('refinery chain', () => {
  let state: SimState;
  beforeEach(() => {
    state = newMatch();
    setHull(state, SOUTH, 'H00D'); // Trade Boat
  });

  it('step 1: swaps a raw good for its refined good in place at the Refinery (needs the book)', () => {
    give(state, SOUTH, 'I02Q', 0); // Book of Formulas
    give(state, SOUTH, 'I00J', 1); // Barrel of Ale (raw)
    moveTo(state, SOUTH, AT.Refinery);
    const events = runEconomy(state);
    expect(inv(state, SOUTH)[1]).toBe('I02V'); // refined Beer in the freed slot
    expect(inv(state, SOUTH)[0]).toBe('I02Q'); // book kept
    expect(events.some((e) => e.type === 'questProgress' && e.stage === 'refined')).toBe(true);
  });

  it('step 1: no swap without the Book of Formulas', () => {
    give(state, SOUTH, 'I00J', 0);
    moveTo(state, SOUTH, AT.Refinery);
    runEconomy(state);
    expect(has(state, SOUTH, 'I00J')).toBe(true);
    expect(has(state, SOUTH, 'I02V')).toBe(false);
  });

  it('step 1: no swap outside the Refinery rect', () => {
    give(state, SOUTH, 'I02Q', 0);
    give(state, SOUTH, 'I00J', 1);
    moveTo(state, SOUTH, AT.Elsewhere);
    runEconomy(state);
    expect(has(state, SOUTH, 'I00J')).toBe(true);
    expect(has(state, SOUTH, 'I02V')).toBe(false);
  });

  it('step 2: cash-in pays 1.5x raw gold and consumes only the refined good', () => {
    // Ale refined route: contract I00K + refined I02V + book; 300g/80xp/1L.
    give(state, SOUTH, 'I00K', 0);
    give(state, SOUTH, 'I02V', 1);
    give(state, SOUTH, 'I02Q', 2);
    moveTo(state, SOUTH, AT.SouthReward);
    const goldBefore = state.players[SOUTH]!.gold;
    const lumberBefore = state.players[SOUTH]!.lumber;
    const events = runEconomy(state);
    expect(state.players[SOUTH]!.gold - goldBefore).toBe(300);
    expect(state.players[SOUTH]!.lumber - lumberBefore).toBe(1);
    expect(xpGains(events, 'refinery:I02V')).toEqual([80]);
    expect(has(state, SOUTH, 'I02V')).toBe(false); // refined good consumed
    expect(has(state, SOUTH, 'I00K')).toBe(true); // contract kept
    expect(has(state, SOUTH, 'I02Q')).toBe(true); // book kept
  });

  it('step 2: does not pay twice when parked in the reward zone', () => {
    give(state, SOUTH, 'I00K', 0);
    give(state, SOUTH, 'I02V', 1);
    give(state, SOUTH, 'I02Q', 2);
    moveTo(state, SOUTH, AT.SouthReward);
    const first = runEconomy(state);
    expect(state.players[SOUTH]!.gold).toBeGreaterThan(0);
    const goldAfterFirst = state.players[SOUTH]!.gold;
    const second = runEconomy(state); // still parked, but the refined good is gone
    expect(state.players[SOUTH]!.gold).toBe(goldAfterFirst);
    expect(first.some((e) => e.type === 'questProgress')).toBe(true);
    expect(second.some((e) => e.type === 'questProgress')).toBe(false);
  });

  it('team gating: a south player cannot cash in a north-only refined route', () => {
    // Books (I00U contract -> I02X) are north-only. South carries them: no pay.
    give(state, SOUTH, 'I00U', 0);
    give(state, SOUTH, 'I02X', 1);
    give(state, SOUTH, 'I02Q', 2);
    moveTo(state, SOUTH, AT.SouthReward);
    const goldBefore = state.players[SOUTH]!.gold;
    runEconomy(state);
    expect(state.players[SOUTH]!.gold).toBe(goldBefore);
    expect(has(state, SOUTH, 'I02X')).toBe(true);
  });

  it('a non-trade hull never refines', () => {
    setHull(state, SOUTH, 'H000'); // a combat hull, not in carrierMaxItems
    give(state, SOUTH, 'I02Q', 0);
    give(state, SOUTH, 'I00J', 1);
    moveTo(state, SOUTH, AT.Refinery);
    runEconomy(state);
    expect(has(state, SOUTH, 'I00J')).toBe(true);
    expect(has(state, SOUTH, 'I02V')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Repair Buildings Mission
// ---------------------------------------------------------------------------

describe('repair buildings mission', () => {
  let state: SimState;
  beforeEach(() => {
    state = newMatch();
    setHull(state, SOUTH, 'H00D');
  });

  it('step 1: grants the Goblin Mechanic token at the bomb shop (contract kept)', () => {
    give(state, SOUTH, 'I01I', 0); // Repair Buildings Mission contract
    moveTo(state, SOUTH, AT.GoblinBombShop);
    runEconomy(state);
    expect(has(state, SOUTH, 'I01J')).toBe(true); // Goblin Mechanic added
    expect(has(state, SOUTH, 'I01I')).toBe(true); // contract not consumed
  });

  it('step 1: does not grant a second token while already holding one', () => {
    give(state, SOUTH, 'I01I', 0);
    moveTo(state, SOUTH, AT.GoblinBombShop);
    runEconomy(state);
    const tokens1 = inv(state, SOUTH).filter((i) => i === 'I01J').length;
    runEconomy(state);
    const tokens2 = inv(state, SOUTH).filter((i) => i === 'I01J').length;
    expect(tokens1).toBe(1);
    expect(tokens2).toBe(1);
  });

  it('step 2: USING the token pays 700g / 300xp / 3L and consumes it', () => {
    give(state, SOUTH, 'I01J', 2); // Goblin Mechanic
    const goldBefore = state.players[SOUTH]!.gold;
    const lumberBefore = state.players[SOUTH]!.lumber;
    state.events = [];
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: SOUTH, slot: 2 });
    expect(state.players[SOUTH]!.gold - goldBefore).toBe(700);
    expect(state.players[SOUTH]!.lumber - lumberBefore).toBe(3);
    expect(xpGains(state.events, 'repairMission')).toEqual([300]);
    expect(has(state, SOUTH, 'I01J')).toBe(false); // token consumed
  });

  it('refinery variant: refine I01J -> I031, then USE I031 with the book pays 1050g', () => {
    give(state, SOUTH, 'I02Q', 0); // book
    give(state, SOUTH, 'I01J', 1); // mechanic
    moveTo(state, SOUTH, AT.Refinery);
    runEconomy(state);
    expect(has(state, SOUTH, 'I031')).toBe(true); // Goblin Engineer
    expect(has(state, SOUTH, 'I01J')).toBe(false);
    const engineerSlot = inv(state, SOUTH).indexOf('I031');
    const goldBefore = state.players[SOUTH]!.gold;
    state.events = [];
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: SOUTH, slot: engineerSlot });
    expect(state.players[SOUTH]!.gold - goldBefore).toBe(1050); // 1.5x 700
    expect(state.players[SOUTH]!.lumber).toBe(3);
    expect(xpGains(state.events, 'repairMission')).toEqual([300]);
    expect(has(state, SOUTH, 'I031')).toBe(false);
  });

  it('refinery variant: USING I031 without the book is rejected (no payout)', () => {
    give(state, SOUTH, 'I031', 0); // engineer, but no book carried
    const goldBefore = state.players[SOUTH]!.gold;
    state.events = [];
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: SOUTH, slot: 0 });
    expect(state.players[SOUTH]!.gold).toBe(goldBefore);
    expect(has(state, SOUTH, 'I031')).toBe(true); // not consumed
    expect(state.events.some((e) => e.type === 'commandRejected')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Treasure Hunt
// ---------------------------------------------------------------------------

describe('treasure hunt', () => {
  const TH = ruleset.questSystems.treasureHunts;
  const seedTick = TH.seedTick;

  function regionOf(team: 'south' | 'north', number: number): { x: number; y: number } {
    const name = TH.locationRegionsByNumber[team][String(number)]!;
    const r = ruleset.map.regions[name]!;
    return { x: r.centerX, y: r.centerY };
  }

  it('seeds both teams once at the seed tick from the match Rng (1..8)', () => {
    const state = newMatch(7);
    expect(state.treasureByTeam.south).toBeNull();
    state.tick = seedTick;
    runEconomy(state);
    const s = state.treasureByTeam.south;
    const n = state.treasureByTeam.north;
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThanOrEqual(8);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(8);
    // Idempotent: a second pass at the same tick does not re-seed/re-draw.
    const before = { ...state.treasureByTeam };
    runEconomy(state);
    expect(state.treasureByTeam).toEqual(before);
  });

  it('find: a registered H005 entering the active rect gains the Treasure and rerolls', () => {
    const state = newMatch(7);
    state.tick = seedTick;
    runEconomy(state); // seed
    const num = state.treasureByTeam.south!;
    setHull(state, SOUTH, 'H005'); // Trade Ship
    give(state, SOUTH, 'I02H', 0); // south contract
    moveTo(state, SOUTH, regionOf('south', num));
    const events = runEconomy(state);
    expect(has(state, SOUTH, 'I02G')).toBe(true); // Treasure added
    expect(events.some((e) => e.type === 'questProgress' && e.stage === 'found')).toBe(true);
    // The team number is rerolled (1..8) on pickup.
    expect(state.treasureByTeam.south).toBeGreaterThanOrEqual(1);
    expect(state.treasureByTeam.south).toBeLessThanOrEqual(8);
  });

  it('find: the WRONG rect (not the current number) yields nothing', () => {
    const state = newMatch(7);
    state.tick = seedTick;
    runEconomy(state);
    const num = state.treasureByTeam.south!;
    const wrong = num === 1 ? 2 : 1;
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I02H', 0);
    moveTo(state, SOUTH, regionOf('south', wrong));
    runEconomy(state);
    expect(has(state, SOUTH, 'I02G')).toBe(false);
  });

  it('find: a Trade Boat (H00D) cannot find treasure — H005 only', () => {
    const state = newMatch(7);
    state.tick = seedTick;
    runEconomy(state);
    const num = state.treasureByTeam.south!;
    setHull(state, SOUTH, 'H00D');
    give(state, SOUTH, 'I02H', 0);
    moveTo(state, SOUTH, regionOf('south', num));
    runEconomy(state);
    expect(has(state, SOUTH, 'I02G')).toBe(false);
  });

  it('return: cashing the Treasure pays 14000g / 2500xp and consumes BOTH treasure and contract', () => {
    const state = newMatch(7);
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I02H', 0); // contract
    give(state, SOUTH, 'I02G', 1); // treasure (granted earlier in real play)
    moveTo(state, SOUTH, AT.SouthReward);
    const goldBefore = state.players[SOUTH]!.gold;
    const events = runEconomy(state);
    expect(state.players[SOUTH]!.gold - goldBefore).toBe(14000);
    expect(xpGains(events, 'treasureHunt')).toEqual([2500]);
    expect(has(state, SOUTH, 'I02G')).toBe(false); // treasure consumed
    expect(has(state, SOUTH, 'I02H')).toBe(false); // contract consumed (unlike trade routes)
  });

  it('return: does not pay twice', () => {
    const state = newMatch(7);
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I02H', 0);
    give(state, SOUTH, 'I02G', 1);
    moveTo(state, SOUTH, AT.SouthReward);
    runEconomy(state);
    const goldAfter = state.players[SOUTH]!.gold;
    runEconomy(state);
    expect(state.players[SOUTH]!.gold).toBe(goldAfter);
  });

  it('the Treasure item is destroyed when dropped (perishable override)', () => {
    const state = newMatch(7);
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I02G', 0);
    const s = ship(state, SOUTH);
    applyEconomyCommand(state, ruleset, { type: 'dropItem', player: SOUTH, slot: 0, x: s.x, y: s.y });
    expect(has(state, SOUTH, 'I02G')).toBe(false);
    // No ground item materialized (perishable goods vanish on drop).
    expect(Object.values(state.groundItems).some((g) => g.itemId === 'I02G')).toBe(false);
  });

  it('treasure RNG replays bit-identically across two independent runs (same seed)', () => {
    function run(seed: number): { found: boolean; reroll: number | null } {
      const state = newMatch(seed);
      state.tick = seedTick;
      runEconomy(state);
      const num = state.treasureByTeam.south!;
      setHull(state, SOUTH, 'H005');
      give(state, SOUTH, 'I02H', 0);
      moveTo(state, SOUTH, regionOf('south', num));
      runEconomy(state);
      return { found: has(state, SOUTH, 'I02G'), reroll: state.treasureByTeam.south };
    }
    expect(run(12345)).toEqual(run(12345));
  });

  // --- refined branch: Treasure -> Golden Statue (I02G -> I030) -> 21000g ---

  it('refined: I030 (Golden Statue) is registered as a perishable quest good', () => {
    const statue = ruleset.equipment['I030'];
    expect(statue).toBeDefined();
    expect(statue!.perishable).toBe(true);
    expect(TH.refinedVariant.refinedTreasureId).toBe('I030');
    expect(TH.refinedVariant.membershipItemId).toBe('I02Q');
    expect(TH.refinedVariant.reward).toEqual({ rewardGold: 21000, rewardXp: 2500, rewardLumber: 0 });
  });

  it('refine: an H005 with the Treasure + the Book swaps I02G -> I030 at the Refinery', () => {
    const state = newMatch(7);
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I02G', 0); // treasure
    give(state, SOUTH, 'I02Q', 1); // book of formulas
    moveTo(state, SOUTH, AT.Refinery);
    const events = runEconomy(state);
    expect(has(state, SOUTH, 'I030')).toBe(true); // statue produced
    expect(has(state, SOUTH, 'I02G')).toBe(false); // treasure consumed by the swap
    expect(has(state, SOUTH, 'I02Q')).toBe(true); // book kept
    expect(
      events.some((e) => e.type === 'questProgress' && e.questId === 'treasureHunt' && e.stage === 'refined'),
    ).toBe(true);
  });

  it('refine: needs the Book — Treasure alone at the Refinery does not refine', () => {
    const state = newMatch(7);
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I02G', 0); // no book
    moveTo(state, SOUTH, AT.Refinery);
    runEconomy(state);
    expect(has(state, SOUTH, 'I030')).toBe(false);
    expect(has(state, SOUTH, 'I02G')).toBe(true);
  });

  it('refine: H005-only — a Trade Boat (H00D) cannot refine the Treasure', () => {
    const state = newMatch(7);
    setHull(state, SOUTH, 'H00D');
    give(state, SOUTH, 'I02G', 0);
    give(state, SOUTH, 'I02Q', 1);
    moveTo(state, SOUTH, AT.Refinery);
    runEconomy(state);
    expect(has(state, SOUTH, 'I030')).toBe(false);
    expect(has(state, SOUTH, 'I02G')).toBe(true);
  });

  it('refined return: contract + Golden Statue + Book pays 21000g and consumes the statue + contract (book kept)', () => {
    const state = newMatch(7);
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I02H', 0); // contract
    give(state, SOUTH, 'I030', 1); // golden statue (refined earlier)
    give(state, SOUTH, 'I02Q', 2); // book
    moveTo(state, SOUTH, AT.SouthReward);
    const goldBefore = state.players[SOUTH]!.gold;
    const events = runEconomy(state);
    expect(state.players[SOUTH]!.gold - goldBefore).toBe(21000); // 14000 * 1.5
    expect(xpGains(events, 'treasureHunt:refined')).toEqual([2500]);
    expect(has(state, SOUTH, 'I030')).toBe(false); // statue consumed
    expect(has(state, SOUTH, 'I02H')).toBe(false); // contract consumed
    expect(has(state, SOUTH, 'I02Q')).toBe(true); // book kept
  });

  it('refined return: the Book is required at cash-in — statue + contract alone pays nothing', () => {
    const state = newMatch(7);
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I02H', 0);
    give(state, SOUTH, 'I030', 1); // no book
    moveTo(state, SOUTH, AT.SouthReward);
    const goldBefore = state.players[SOUTH]!.gold;
    runEconomy(state);
    expect(state.players[SOUTH]!.gold).toBe(goldBefore);
    expect(has(state, SOUTH, 'I030')).toBe(true);
    expect(has(state, SOUTH, 'I02H')).toBe(true);
  });

  it('refined return: does not pay twice', () => {
    const state = newMatch(7);
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I02H', 0);
    give(state, SOUTH, 'I030', 1);
    give(state, SOUTH, 'I02Q', 2);
    moveTo(state, SOUTH, AT.SouthReward);
    runEconomy(state);
    const goldAfter = state.players[SOUTH]!.gold;
    runEconomy(state);
    expect(state.players[SOUTH]!.gold).toBe(goldAfter);
  });

  it('refined: the north team cashes its statue at the NorthReward rect for 21000g', () => {
    const state = newMatch(7);
    setHull(state, NORTH, 'H005');
    give(state, NORTH, 'I02I', 0); // north contract
    give(state, NORTH, 'I030', 1);
    give(state, NORTH, 'I02Q', 2);
    moveTo(state, NORTH, AT.NorthReward);
    const goldBefore = state.players[NORTH]!.gold;
    runEconomy(state);
    expect(state.players[NORTH]!.gold - goldBefore).toBe(21000);
    expect(has(state, NORTH, 'I030')).toBe(false);
    expect(has(state, NORTH, 'I02I')).toBe(false);
  });

  it('refined: the Golden Statue is destroyed when dropped (perishable override)', () => {
    const state = newMatch(7);
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I030', 0);
    const s = ship(state, SOUTH);
    applyEconomyCommand(state, ruleset, { type: 'dropItem', player: SOUTH, slot: 0, x: s.x, y: s.y });
    expect(has(state, SOUTH, 'I030')).toBe(false);
    expect(Object.values(state.groundItems).some((g) => g.itemId === 'I030')).toBe(false);
  });

  it('refined: full chain — find Treasure, refine to Statue, cash for 21000g', () => {
    const state = newMatch(7);
    state.tick = seedTick;
    runEconomy(state); // seed both teams
    const num = state.treasureByTeam.south!;
    setHull(state, SOUTH, 'H005');
    give(state, SOUTH, 'I02H', 0); // contract
    give(state, SOUTH, 'I02Q', 1); // book carried throughout
    // 1) find the raw Treasure at the active location
    moveTo(state, SOUTH, regionOf('south', num));
    runEconomy(state);
    expect(has(state, SOUTH, 'I02G')).toBe(true);
    // 2) refine I02G -> I030 at the Refinery
    moveTo(state, SOUTH, AT.Refinery);
    runEconomy(state);
    expect(has(state, SOUTH, 'I030')).toBe(true);
    expect(has(state, SOUTH, 'I02G')).toBe(false);
    // 3) cash the Statue at the own reward rect for the larger reward
    moveTo(state, SOUTH, AT.SouthReward);
    const goldBefore = state.players[SOUTH]!.gold;
    runEconomy(state);
    expect(state.players[SOUTH]!.gold - goldBefore).toBe(21000);
    expect(has(state, SOUTH, 'I030')).toBe(false);
    expect(has(state, SOUTH, 'I02H')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the canonical stepTick order
// ---------------------------------------------------------------------------

describe('quest systems through the full tick loop', () => {
  it('a refinery cash-in fires exactly once inside the canonical stepTick order', () => {
    const state = newMatch(3);
    setHull(state, SOUTH, 'H00D');
    give(state, SOUTH, 'I00K', 0);
    give(state, SOUTH, 'I02V', 1);
    give(state, SOUTH, 'I02Q', 2);
    // Park income so the only economic effect over the run is the quest scan.
    state.timers.nextIncomeTick = 1e9;
    state.timers.nextEmpireShareTick = 1e9;
    state.timers.nextGoldDumpTick = 1e9;
    const goldBefore = state.players[SOUTH]!.gold;
    const collected: SimEvent[] = [];
    for (let t = 0; t < 3; t++) {
      // Re-pin the ship inside the reward zone each tick (movement runs first
      // and would otherwise drift an idle ship's order).
      moveTo(state, SOUTH, AT.SouthReward);
      collected.push(...stepTick(state, ruleset));
    }
    expect(state.players[SOUTH]!.gold - goldBefore).toBe(300); // paid exactly once
    expect(
      collected.filter((e) => e.type === 'questProgress' && e.questId === 'refinery:I02V'),
    ).toHaveLength(1);
  });
});
