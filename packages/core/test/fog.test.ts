/**
 * Fog of war + cliffs line-of-sight (owner-reported 2026-07-09: "the AI seems
 * to see through fog of war" / "you shouldn't be able to see over the land —
 * they were mountains/cliffs in the original").
 *
 * Proves, on the REAL compiled ruleset + terrain:
 *  1. A long-range weapon cannot ACQUIRE a target the owning team does not
 *     see (weapon range 2500u > max sight 1800u — no sniping into the fog),
 *     and a friendly spotter near the target restores acquisition.
 *  2. Land blocks sight (cliffs): an enemy within sight RADIUS but across a
 *     land ridge is invisible to the team — and the AI's aggro/kill-commit
 *     scans ignore it.
 *  3. The same enemy at the same distance over open water IS visible.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileClassicRuleset } from '../src/sim/ruleset.js';
import { createMatch, stepTick } from '../src/sim/sim.js';
import { computeAiCommands } from '../src/sim/ai.js';
import { isVisibleToTeamFog, teamVisionOf } from '../src/sim/vision.js';
import { segmentCrossesLand } from '../src/sim/movement.js';
import { isWater } from '../src/sim/types.js';
import type { RawDataFiles, Ruleset, ShipEntity, SimState } from '../src/sim/types.js';

function loadJson<T>(name: string): T {
  const url = new URL(`../../../data/json/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

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
const SOUTH = 2;
const SOUTH_SPOTTER = 3;
const NORTH = 7;

function shipOf(state: SimState, slot: number): ShipEntity {
  const player = state.players[slot];
  if (!player || player.shipId === null) throw new Error(`no ship for slot ${slot}`);
  const ship = state.entities[player.shipId];
  if (!ship || ship.kind !== 'ship') throw new Error(`slot ${slot} entity is not a ship`);
  return ship;
}

/** The longest-ranged auto-fire item weapon (Sniper Crew, 2500u). Item
 *  weapons are keyed by item id in ruleset.weapons and auto-fire via the
 *  phoenixFire inventory scan. */
function sniperItemId(): { itemId: string; range: number } {
  let best: { itemId: string; range: number } | null = null;
  for (const [itemId, w] of Object.entries(ruleset.weapons)) {
    if (w.mechanic !== 'phoenixFire' || w.rangeUnits === null) continue;
    if (!w.targets.ships) continue;
    if (best === null || w.rangeUnits > best.range) best = { itemId, range: w.rangeUnits };
  }
  if (!best) throw new Error('no ranged auto-fire item weapons compiled');
  return best;
}

/** Find a water-cell pair: dist in [min,max], LOS blocked (or clear) as asked. */
function findPair(blocked: boolean, minD: number, maxD: number): { a: { x: number; y: number }; b: { x: number; y: number } } {
  const mask = ruleset.map.waterMask;
  const { cols, rows, cellSizeX, cellSizeY, bounds, cells } = mask;
  const world = (c: number, r: number) => ({
    x: bounds.minX + (c + 0.5) * cellSizeX,
    y: bounds.maxY - (r + 0.5) * cellSizeY,
  });
  for (let r = 2; r < rows - 2; r += 2) {
    for (let c = 2; c < cols - 2; c += 2) {
      if (cells[r * cols + c] !== 1) continue;
      const a = world(c, r);
      const reach = Math.ceil(maxD / cellSizeX) + 1;
      for (let dr = -reach; dr <= reach; dr += 2) {
        for (let dc = -reach; dc <= reach; dc += 2) {
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 2 || nc >= cols - 2 || nr < 2 || nr >= rows - 2) continue;
          if (cells[nr * cols + nc] !== 1) continue;
          const b = world(nc, nr);
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < minD || d > maxD) continue;
          if (segmentCrossesLand(mask, a.x, a.y, b.x, b.y) === blocked) return { a, b };
        }
      }
    }
  }
  throw new Error(`no ${blocked ? 'blocked' : 'clear'} pair in [${minD}, ${maxD}]`);
}

function makeState(): SimState {
  return createMatch(ruleset, 42, [
    { slot: SOUTH, control: 'user' },
    { slot: SOUTH_SPOTTER, control: 'user' },
    { slot: NORTH, control: 'user' },
  ]);
}

/** Park a ship at (x, y) with an idle order. */
function park(ship: ShipEntity, x: number, y: number): void {
  ship.x = x;
  ship.y = y;
  ship.order = { type: 'idle' };
}

const FAR_CORNER = { x: -5000, y: -7000 }; // out-of-the-way water for the spotter

describe('fog of war: no acquisition without team sight', () => {
  it('a 2500u sniper does NOT fire at an enemy 2000u away in the fog; a spotter restores it', () => {
    const sniper = sniperItemId();
    expect(sniper.range).toBeGreaterThanOrEqual(2000);

    const clear = findPair(false, 1900, 2100);
    const state = makeState();
    const me = shipOf(state, SOUTH);
    const spotter = shipOf(state, SOUTH_SPOTTER);
    const foe = shipOf(state, NORTH);
    park(me, clear.a.x, clear.a.y);
    park(foe, clear.b.x, clear.b.y);
    park(spotter, FAR_CORNER.x, FAR_CORNER.y); // far away: no spotting yet
    const player = state.players[SOUTH];
    if (!player) throw new Error('no south player');
    player.inventory[0] = { itemId: sniper.itemId, charges: null, readyAtTick: 0 };

    // Sanity: the foe is beyond every south sight radius but within weapon range.
    const dist = Math.hypot(me.x - foe.x, me.y - foe.y);
    expect(dist).toBeGreaterThan(1800);
    expect(dist).toBeLessThan(sniper.range);
    expect(isVisibleToTeamFog(state, ruleset, foe, 'south')).toBe(false);

    let hits = 0;
    for (let t = 0; t < 60; t++) {
      for (const ev of stepTick(state, ruleset)) {
        if (ev.type === 'hit' && ev.targetEntityId === foe.id) hits++;
      }
    }
    expect(hits).toBe(0); // no sniping into the fog

    // Sail the spotter next to the foe: the team now SEES it -> fire resumes.
    park(spotter, foe.x + 400, foe.y);
    expect(isVisibleToTeamFog(state, ruleset, foe, 'south')).toBe(true);
    for (let t = 0; t < 120 && hits === 0; t++) {
      for (const ev of stepTick(state, ruleset)) {
        if (ev.type === 'hit' && ev.targetEntityId === foe.id) hits++;
      }
    }
    expect(hits).toBeGreaterThan(0); // spotted -> the sniper fires
  });
});

describe('cliffs: land blocks line of sight', () => {
  it('an enemy across a land ridge is invisible even inside the sight radius', () => {
    const blocked = findPair(true, 500, 900);
    const state = makeState();
    const me = shipOf(state, SOUTH);
    const foe = shipOf(state, NORTH);
    park(me, blocked.a.x, blocked.a.y);
    park(foe, blocked.b.x, blocked.b.y);
    park(shipOf(state, SOUTH_SPOTTER), FAR_CORNER.x, FAR_CORNER.y);
    stepTick(state, ruleset); // refresh vision flags/memo tick

    const d = Math.hypot(me.x - foe.x, me.y - foe.y);
    expect(d).toBeLessThan(1100); // well inside a start ship's sight radius
    expect(isWater(ruleset.map.waterMask, foe.x, foe.y)).toBe(true);
    expect(isVisibleToTeamFog(state, ruleset, foe, 'south')).toBe(false); // cliffs block

    // Same distance over OPEN water at the clear pair -> visible.
    const clear = findPair(false, 500, 900);
    park(me, clear.a.x, clear.a.y);
    park(foe, clear.b.x, clear.b.y);
    stepTick(state, ruleset);
    expect(isVisibleToTeamFog(state, ruleset, foe, 'south')).toBe(true);
  });

  it('the AI aggro scan ignores a wounded enemy hiding behind the ridge', () => {
    const blocked = findPair(true, 500, 900);
    const state = createMatch(ruleset, 42, [
      { slot: SOUTH, control: 'computer', ai: { difficulty: 'hard' } },
      { slot: NORTH, control: 'user' },
    ]);
    const bot = shipOf(state, SOUTH);
    const foe = shipOf(state, NORTH);
    park(bot, blocked.a.x, blocked.a.y);
    park(foe, blocked.b.x, blocked.b.y);
    foe.hp = Math.floor(foe.maxHp * 0.2); // juicy kill-commit bait
    stepTick(state, ruleset);

    const mem = state.aiMemory[SOUTH];
    if (!mem) throw new Error('no ai memory for the bot');
    mem.nextThinkTick = state.tick; // force a think now
    const commands = computeAiCommands(state, ruleset, SOUTH, mem);
    // The bot must not target the ship it cannot see (attackTarget on foe.id).
    const targeted = commands.some((c) => c.type === 'attackTarget' && c.targetId === foe.id);
    expect(targeted).toBe(false);

    // Vision-model cross-check: south team sight does not cover the foe.
    expect(teamVisionOf(state, ruleset, 'south').sight.length).toBeGreaterThan(0);
    expect(isVisibleToTeamFog(state, ruleset, foe, 'south')).toBe(false);
  });
});
