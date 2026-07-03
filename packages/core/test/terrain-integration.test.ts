/**
 * Terrain / land-collision integration (docs/TERRAIN.md). Unlike
 * integration.test.ts (which omits terrain on purpose, so its mask is the
 * open-sea stub), this suite compiles the REAL Classic ruleset WITH
 * data/json/terrain.json loaded — the same mask the server runs — and drives
 * the canonical applyCommands/stepTick loop to assert the three map-fidelity
 * behaviors at the integration level:
 *
 *  1. Every player spawns ON navigable water (the mask rule places the harbor
 *     docks correctly; a spawn on land would freeze the ship instantly).
 *  2. A ship ordered straight onto a landmass STOPS at the coast — it never
 *     crosses into a land cell, and it stalls short of the (unreachable) land
 *     target instead of phasing through (the "pathing" land funnel).
 *  3. Players still move freely on water: a ship ordered to a reachable water
 *     point along the lane makes real forward progress (the nav field +
 *     coast-slide carry it around the landmass, not just up against the nearest
 *     coast). This guards against the resolver over-clamping legal water moves.
 *
 * The run stays bit-identical across replays of the same seed (the mask is
 * static data on the immutable Ruleset; the nav field is too).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileClassicRuleset } from '../src/sim/ruleset.js';
import { applyCommands, createMatch, hashState, stepTick } from '../src/sim/sim.js';
import { isWater } from '../src/sim/types.js';
import { computeAiCommands } from '../src/sim/ai.js';
import { sortedNumericKeys } from '../src/sim/types.js';
import type {
  Command,
  CreepEntity,
  PlayerConfig,
  RawDataFiles,
  Ruleset,
  ShipEntity,
  SimState,
  StructureEntity,
} from '../src/sim/types.js';

function loadJson<T>(name: string): T {
  const url = new URL(`../../../data/json/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

/** Real data files INCLUDING terrain.json (the live mask, not the stub). */
function loadRawWithTerrain(): RawDataFiles {
  return {
    weapons: loadJson('weapons.json'),
    equipment: loadJson('equipment.json'),
    ships: loadJson('ships.json'),
    upgradeCurves: loadJson('upgrade-curves.json'),
    scriptRules: loadJson('script-rules.json'),
    mapLayout: loadJson('map-layout.json'),
    gameplayConstants: loadJson('gameplay-constants.json'),
    terrain: loadJson('terrain.json'),
    units: loadJson('units.json'),
    abilities: loadJson('abilities.json'),
    items: loadJson('items.json'),
    buffs: loadJson('buffs.json'),
    strings: loadJson('strings.json'),
  };
}

const ruleset: Ruleset = compileClassicRuleset(loadRawWithTerrain());
const SOUTH_PLAYER = 2;

function shipOf(state: SimState, slot: number): ShipEntity {
  const player = state.players[slot];
  if (!player || player.shipId === null) throw new Error(`no ship for slot ${slot}`);
  const ship = state.entities[player.shipId];
  if (!ship || ship.kind !== 'ship') throw new Error(`entity for slot ${slot} is not a ship`);
  return ship;
}

describe('terrain integration (real water mask)', () => {
  it('compiles a real mask (not the open-sea stub) and per-team nav fields', () => {
    expect(ruleset.map.waterMask.cells.length).toBeGreaterThan(0);
    // The mask is the embedded minimap classified by the owner's CONFIRMED colour
    // key — SAILABLE WATER = NON-BLUE (yellow deep + green shallow + pink passable),
    // LAND = only the blue-dominant ridge pixels — per tile, cropped to the 81x113
    // PLAYABLE tilepoint grid (the unplayable border removed; the WEST bound extended
    // 3 cells west of the camera bounds so the Goblin Potion Dealer shop sits off the
    // grid edge — see docs/TERRAIN.md WEST-BOUND EXTENSION), PLUS only MINIMAL 1-cell
    // connectivity necks (so every shop + dock/spawn reaches the sea and the two
    // bases stay water-connected) PLUS the two owner-approved carved WEST
    // sail-around island moats: each is a closed 1-cell water ring (24-cell cycle)
    // around a 25-cell land core with EXACTLY ONE entrance. After the west-bound
    // extension BOTH west shops sit ON their island LAND core (Goblin at grid col 3,
    // Lumber Mill at grid col 6) — true sail-around islands you loop around through a
    // single narrow entrance. Water fraction is the NON-BLUE classification + necks +
    // moats ~0.66 (here 0.656), the faithful ~half-water silhouette — NOT the prior
    // too-dry ~0.29 yellow-only trace.
    const water = ruleset.map.waterMask.cells.reduce((n, c) => n + c, 0);
    const total = ruleset.map.waterMask.cells.length;
    expect(total).toBe(81 * 113);
    // ~0.66: the NON-BLUE colour-key classification (sailable water = yellow deep
    // + green shallow + pink passable; LAND = only the blue-dominant ridge pixels)
    // + minimal necks + the two west moats. Over the playable crop this reads
    // honestly higher than the ~0.535 measured over the WHOLE minimap content box,
    // because the playable rectangle excludes the land-heavy outer borders. Stays
    // inside [0.55, 0.70]; NOT the prior too-dry ~0.29 yellow-only trace.
    expect(water / total).toBeGreaterThan(0.55);
    expect(water / total).toBeLessThan(0.7);
    // Nav fields are populated (a real flood from each base goal).
    expect(ruleset.map.navByTeam.south.dist.length).toBe(total);
    expect(ruleset.map.navByTeam.north.dist.length).toBe(total);
  });

  it('every player spawns on navigable water', () => {
    for (const [slotStr, start] of Object.entries(ruleset.map.playerStarts)) {
      expect(isWater(ruleset.map.waterMask, start.x, start.y)).toBe(true);
      void slotStr;
    }
  });

  it('a ship ordered onto land stops at the coast (never crosses a land cell)', () => {
    const state = createMatch(ruleset, 1, [{ slot: SOUTH_PLAYER, control: 'user' }]);
    const ship = shipOf(state, SOUTH_PLAYER);
    const mask = ruleset.map.waterMask;
    const spawnX = ship.x;
    const spawnY = ship.y;
    expect(isWater(mask, spawnX, spawnY)).toBe(true);

    // The west-central landmass is solid land. This target sits deep inside it
    // (a 3-cell radius of land around it, far from any base so the nav field
    // stays out of it) — a pure coast-stall case: the ship must stop at the coast,
    // never crossing a land cell, and stall well short of the inland target.
    const target = { x: -3584, y: -2048 };
    expect(isWater(mask, target.x, target.y)).toBe(false); // target is on land

    applyCommands(state, ruleset, [
      { type: 'move', player: SOUTH_PLAYER, x: target.x, y: target.y },
    ]);

    let everOnLand = false;
    for (let t = 0; t < 400; t++) {
      stepTick(state, ruleset);
      if (!isWater(mask, ship.x, ship.y)) everOnLand = true;
    }

    // Never entered a land cell, and stalled well short of the inland target.
    expect(everOnLand).toBe(false);
    expect(isWater(mask, ship.x, ship.y)).toBe(true);
    // Did not reach the land target (stopped at the coast short of it).
    expect(Math.hypot(ship.x - target.x, ship.y - target.y)).toBeGreaterThan(1000);
    // It did move off the dock toward the target before stopping at the coast.
    expect(Math.hypot(ship.x - spawnX, ship.y - spawnY)).toBeGreaterThan(50);
  });

  it('a ship ordered toward the enemy base follows the lane and makes forward progress', () => {
    const state = createMatch(ruleset, 1, [{ slot: SOUTH_PLAYER, control: 'user' }]);
    const ship = shipOf(state, SOUTH_PLAYER);
    const mask = ruleset.map.waterMask;
    const spawnX = ship.x;
    const spawnY = ship.y;

    // Order toward the north base (the push goal) — a long haul that engages the
    // lane nav field. The ship should travel a long way from its spawn down the
    // winding water lane, always staying on water.
    const goal = ruleset.map.navByTeam.south;
    applyCommands(state, ruleset, [
      { type: 'move', player: SOUTH_PLAYER, x: goal.goalX, y: goal.goalY },
    ]);

    let everOnLand = false;
    let maxTravel = 0;
    for (let t = 0; t < 1500; t++) {
      stepTick(state, ruleset);
      if (!isWater(mask, ship.x, ship.y)) everOnLand = true;
      maxTravel = Math.max(maxTravel, Math.hypot(ship.x - spawnX, ship.y - spawnY));
    }

    expect(everOnLand).toBe(false); // stayed on the water lane the whole way
    // Followed the lane far from the dock (observed >9000u up the west lane) —
    // far more than the ~800u to the nearest coast, proving it rounded the land.
    expect(maxTravel).toBeGreaterThan(3000);
  });

  it('replays bit-identically with the real mask + nav fields (determinism)', () => {
    function run(): string {
      const state = createMatch(ruleset, 1234, [{ slot: SOUTH_PLAYER, control: 'user' }]);
      applyCommands(state, ruleset, [
        { type: 'attackMove', player: SOUTH_PLAYER, x: ruleset.map.navByTeam.south.goalX, y: ruleset.map.navByTeam.south.goalY },
      ]);
      for (let t = 0; t < 800; t++) stepTick(state, ruleset);
      return hashState(state);
    }
    expect(run()).toBe(run());
  });

  // Guards the creep hold-at-tower fix (docs/TERRAIN.md §4 creep-ai + movement
  // honouring the hold-gate order). On the REAL mask, lane creeps must close to
  // within native attack range of a reachable frontmost enemy tower and HOLD
  // there fighting it — NOT ghost along the nav field straight to the enemy HQ.
  // This is the production code path the stub-mask unit tests in creeps.test.ts
  // cannot exercise (the stub returns null nav steps so movement always obeys
  // the order straight-line); before the fix, movement steered creeps to the HQ
  // regardless of the hold-gate order and no tower was ever engaged. AI on both
  // teams so every lane spawns creeps.
  it('lane creeps hold at a reachable enemy tower and grind it (not ghost to the HQ)', () => {
    const configs: PlayerConfig[] = [];
    for (let slot = 2; slot <= 11; slot++) {
      configs.push({ slot, control: 'computer', ai: { difficulty: 'normal' } });
    }
    const state = createMatch(ruleset, 0x1234, configs);

    const towerMaxHp = new Map<number, number>();
    for (const id of sortedNumericKeys(state.entities)) {
      const e = state.entities[id];
      if (e && e.kind === 'structure' && e.role === 'tower') towerMaxHp.set(e.id, e.maxHp);
    }
    expect(towerMaxHp.size).toBeGreaterThan(0);

    const damagedTowers = new Set<number>();
    // Was any living enemy creep ever within its native attack range of a living
    // enemy tower while advancing toward it (i.e. holding/fighting it)?
    let creepHeldAtTower = false;
    const creepRange = (c: CreepEntity): number =>
      ruleset.unitTypes[c.typeId]?.attack?.rangeUnits ?? 0;

    // Longer window than the original 4000: opposing waves now CLASH mid-lane
    // first (movement.ts halts an attack-moving creep while an enemy is in its
    // arc), so a creep only reaches the enemy tower once its lane's front breaks
    // through — the AI captains pushing a lane tip it. 9000 ticks clears both the
    // hold-at-tower contact and the resulting tower chip with margin.
    for (let t = 0; t < 9000; t++) {
      const batch: Command[] = [];
      for (const slot of sortedNumericKeys(state.aiMemory)) {
        const mem = state.aiMemory[slot];
        if (mem && state.tick >= mem.nextThinkTick) {
          batch.push(...computeAiCommands(state, ruleset, slot, mem));
        }
      }
      applyCommands(state, ruleset, batch);
      stepTick(state, ruleset);

      // Tower chip (regen heals it back, so accumulate "ever damaged").
      for (const id of sortedNumericKeys(state.entities)) {
        const e = state.entities[id];
        if (e && e.kind === 'structure' && e.role === 'tower') {
          const max = towerMaxHp.get(e.id);
          if (max !== undefined && e.hp < max) damagedTowers.add(e.id);
        }
      }

      if (!creepHeldAtTower) {
        const creeps: CreepEntity[] = [];
        const towers: StructureEntity[] = [];
        for (const id of sortedNumericKeys(state.entities)) {
          const e = state.entities[id];
          if (!e || e.dead) continue;
          if (e.kind === 'creep') creeps.push(e);
          else if (e.kind === 'structure' && e.role === 'tower') towers.push(e);
        }
        outer: for (const c of creeps) {
          const range = creepRange(c);
          if (range <= 0) continue;
          for (const tower of towers) {
            if (tower.team === c.team) continue; // enemy towers only
            if (Math.hypot(tower.x - c.x, tower.y - c.y) <= range) {
              creepHeldAtTower = true;
              break outer;
            }
          }
        }
      }
    }

    // A creep reached attack range of an enemy tower (held + fought it) ...
    expect(creepHeldAtTower).toBe(true);
    // ... and that engagement chipped at least one enemy tower's HP.
    expect(damagedTowers.size).toBeGreaterThan(0);
  });

  // Guards the core pathfinding fix (B) on the REAL mask for an ARBITRARY,
  // NON-base destination: AleFactory sits on the far EAST edge (x≈4720), NOT
  // near either team's base goal. Before the fix a ship ordered there got pure
  // straight-line steering (the base-proximity gate excluded it) and stalled on
  // the central/east coast — the owner's "ships hang up on land". With the wider
  // field eligibility + the trader-destination fields (map.navToRegion), the
  // ship must round the central landmass and arrive, never crossing a land cell.
  // This is the exact leg the trader's outbound run depends on, isolated from
  // combat/respawn so it is fast + deterministic.
  it('a ship ordered to a far non-base destination (AleFactory) rounds the land and arrives', () => {
    const state = createMatch(ruleset, 1, [{ slot: SOUTH_PLAYER, control: 'user' }]);
    const ship = shipOf(state, SOUTH_PLAYER);
    const mask = ruleset.map.waterMask;
    const ale = ruleset.map.regions['AleFactory']!;
    const spawnX = ship.x;
    const spawnY = ship.y;

    applyCommands(state, ruleset, [
      { type: 'move', player: SOUTH_PLAYER, x: ale.centerX, y: ale.centerY },
    ]);

    let everOnLand = false;
    let minDist = Infinity;
    for (let t = 0; t < 2500; t++) {
      // Re-issue periodically in case the field hands off to idle at the coast
      // edge of the (land) region center — a real ship would keep nudging in.
      if (t % 200 === 0 && ship.order.type === 'idle') {
        applyCommands(state, ruleset, [
          { type: 'move', player: SOUTH_PLAYER, x: ale.centerX, y: ale.centerY },
        ]);
      }
      stepTick(state, ruleset);
      if (!isWater(mask, ship.x, ship.y)) everOnLand = true;
      minDist = Math.min(minDist, Math.hypot(ship.x - ale.centerX, ship.y - ale.centerY));
    }

    expect(everOnLand).toBe(false); // stayed on water the whole way around
    // Arrived right next to the (land) region center — far closer than the
    // ~5000u straight-line distance the old coast-stall left it at.
    expect(minDist).toBeLessThan(500);
    // And it genuinely travelled across the map (not a short hop).
    expect(Math.hypot(ship.x - spawnX, ship.y - spawnY)).toBeGreaterThan(3000);
  });

  // Guards the AI TRADER fix (C) end-to-end on the REAL mask: a SEATED trader
  // (role auto-assigned by the server; here set explicitly) must buy a carrier +
  // contract, sail OUT to AleFactory rounding the land, then back to SouthReward
  // and DELIVER (questProgress 'delivered'). The unarmed trader is repeatedly
  // sunk by lane creeps crossing the contested centre and respawns, so a full
  // haul takes several minutes — the budget is generous. Both slots are traders
  // so neither runs the combat brain (isolates the trade loop from a captain's
  // push), and both teams are seated. The stub-mask ai.test.ts proves the trade
  // LOGIC on open sea; only this real-mask run proves the land ROUTING that the
  // owner reported broken ("could not get to the repair station").
  //
  // The trader now routes robustly: with per-POI nav fields painted to every
  // shop/repair dock AND the land-aware steering in laneNavGoal (a ship rides the
  // field gradient whenever the straight segment to its order crosses land,
  // instead of beelining into the coast), a seated trader delivers in 10/10
  // sampled seeds (was ~2/10 when it wedged in concave water pockets). This run
  // guards that end-to-end land routing on the real mask.
  it('a seated trader completes a full haul around the land (real mask, questProgress delivered)', () => {
    const state = createMatch(ruleset, 0x7ade, [
      { slot: SOUTH_PLAYER, control: 'computer', ai: { difficulty: 'normal', role: 'trader' } },
      { slot: 7, control: 'computer', ai: { difficulty: 'normal', role: 'trader' } },
    ]);
    expect(state.aiMemory[SOUTH_PLAYER]?.role).toBe('trader');

    const ale = ruleset.map.regions['AleFactory']!;
    let reachedAle = false;
    let delivered = false;
    for (let t = 0; t < 16000 && !delivered; t++) {
      const batch: Command[] = [];
      for (const slot of sortedNumericKeys(state.aiMemory)) {
        const mem = state.aiMemory[slot];
        if (mem && state.tick >= mem.nextThinkTick) {
          batch.push(...computeAiCommands(state, ruleset, slot, mem));
        }
      }
      applyCommands(state, ruleset, batch);
      const events = stepTick(state, ruleset);

      const sid = state.players[SOUTH_PLAYER]?.shipId ?? null;
      const sh = sid === null ? null : state.entities[sid];
      if (sh && sh.kind === 'ship' && Math.hypot(sh.x - ale.centerX, sh.y - ale.centerY) < 500) {
        reachedAle = true;
      }
      for (const e of events) {
        if (e.type === 'questProgress' && e.stage === 'delivered' && e.player === SOUTH_PLAYER) {
          delivered = true;
        }
      }
    }

    expect(reachedAle).toBe(true); // the trader rounded the land to the far pickup corner
    expect(delivered).toBe(true); // and brought the goods back to the reward zone
  }, 60000);
});
