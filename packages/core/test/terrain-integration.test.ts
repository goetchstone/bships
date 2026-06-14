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
    // ~61% of the 384x512 grid is water; the rest is the landmass the lanes cut.
    const water = ruleset.map.waterMask.cells.reduce((n, c) => n + c, 0);
    const total = ruleset.map.waterMask.cells.length;
    expect(water / total).toBeGreaterThan(0.4);
    expect(water / total).toBeLessThan(0.9);
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

    // Straight north from the south spawn runs into the central landmass (the
    // coast sits ~800u ahead). The target is deep inland and mid-map (far from
    // any base, so the nav field stays out of it) — a pure coast-stall case.
    const target = { x: spawnX, y: spawnY + 4000 };
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
    expect(ship.y).toBeLessThan(target.y - 1000); // did not reach the land target
    // It did advance toward the coast (left the dock), then stopped there.
    expect(ship.y).toBeGreaterThan(spawnY);
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

    for (let t = 0; t < 4000; t++) {
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
  }, 30000);
});
