/**
 * Vision-filter security boundary tests (synthetic world, exact distances).
 * Fixture geometry: SHIP sight 800, TOWER sight 900, CREEP sight 500,
 * DETSHIP detection 600, ward fixture sight 400.
 */

import { describe, expect, it } from 'vitest';
import type { Entity, SimState } from '@bships/core';
import {
  collectVisibleEntities,
  computeTeamVision,
  coveredBy,
  isEntityVisible,
  isProjectileVisible,
} from '../src/visibility.js';
import {
  addCreep,
  addProjectile,
  addShip,
  addStructure,
  addSummon,
  addWard,
  makePlayer,
  makeState,
  testRuleset,
} from './match-fixtures.js';

function visibleIds(state: SimState, team: 'south' | 'north'): Set<number> {
  const vision = computeTeamVision(state, testRuleset, team);
  return new Set(collectVisibleEntities(state, vision).map((e) => e.id));
}

describe('coveredBy', () => {
  it('is inclusive at the circle boundary', () => {
    const circles = [{ x: 0, y: 0, radius: 100 }];
    expect(coveredBy(circles, 100, 0)).toBe(true);
    expect(coveredBy(circles, 100.1, 0)).toBe(false);
    expect(coveredBy([], 0, 0)).toBe(false);
  });
});

describe('sight-radius fog', () => {
  it('shows enemy units inside friendly ship sight and hides them outside', () => {
    const state = makeState();
    addShip(state, 'south', 0, 0);
    const near = addShip(state, 'north', 700, 0);
    const far = addShip(state, 'north', 900, 0);

    const ids = visibleIds(state, 'south');
    expect(ids.has(near.id)).toBe(true);
    expect(ids.has(far.id)).toBe(false);
  });

  it('always includes own-team units regardless of distance', () => {
    const state = makeState();
    const a = addShip(state, 'south', 0, 0);
    const b = addCreep(state, 'south', 50000, 50000);
    const c = addSummon(state, 'south', -50000, 0);
    const d = addWard(state, 'south', 30000, 0);

    const ids = visibleIds(state, 'south');
    for (const e of [a, b, c, d]) expect(ids.has(e.id)).toBe(true);
  });

  it('always includes structures for both teams (documented v1 divergence)', () => {
    const state = makeState();
    const enemyHq = addStructure(state, 'north', 40000, 40000, { role: 'hq' });
    const neutralShop = addStructure(state, null, -40000, 0, { role: 'shop' });

    expect(visibleIds(state, 'south').has(enemyHq.id)).toBe(true);
    expect(visibleIds(state, 'south').has(neutralShop.id)).toBe(true);
    expect(visibleIds(state, 'north').has(neutralShop.id)).toBe(true);
  });

  it('uses friendly structures and creeps as sight sources', () => {
    const state = makeState();
    addStructure(state, 'south', 4000, 0); // TOWER sight 900
    addCreep(state, 'south', -4000, 0); // CREEP sight 500
    const byTower = addShip(state, 'north', 4400, 0);
    const byCreep = addShip(state, 'north', -3600, 0);
    const beyondCreep = addShip(state, 'north', -3400, 0);

    const ids = visibleIds(state, 'south');
    expect(ids.has(byTower.id)).toBe(true);
    expect(ids.has(byCreep.id)).toBe(true);
    expect(ids.has(beyondCreep.id)).toBe(false);
  });

  it('hides invisible enemy units even inside sight (sim vision flag rules)', () => {
    const state = makeState();
    addShip(state, 'south', 0, 0);
    const hidden = addShip(state, 'north', 500, 0, { vision: { south: false, north: true } });
    expect(visibleIds(state, 'south').has(hidden.id)).toBe(false);

    // Detected by the sim (vision flag true) -> included.
    hidden.vision = { south: true, north: true };
    expect(visibleIds(state, 'south').has(hidden.id)).toBe(true);
  });

  it('treats detection zones as sight sources while active', () => {
    const state = makeState(100);
    const enemy = addShip(state, 'north', 3200, 0);
    state.detectionZones.push({ team: 'south', x: 3000, y: 0, radius: 500, expiresAtTick: 200 });
    expect(visibleIds(state, 'south').has(enemy.id)).toBe(true);

    // Expired zone (expiresAtTick <= tick) grants nothing.
    state.detectionZones = [{ team: 'south', x: 3000, y: 0, radius: 500, expiresAtTick: 100 }];
    expect(visibleIds(state, 'south').has(enemy.id)).toBe(false);

    // Enemy team's own zone grants the viewer nothing.
    state.detectionZones = [{ team: 'north', x: 3000, y: 0, radius: 500, expiresAtTick: 200 }];
    expect(visibleIds(state, 'south').has(enemy.id)).toBe(false);
  });

  it('ignores expired and dead friendly entities as sight sources', () => {
    const state = makeState(100);
    const enemy = addShip(state, 'north', 3000, 0);

    const ward = addWard(state, 'south', 3100, 0, { expiresAtTick: 50 });
    expect(visibleIds(state, 'south').has(enemy.id)).toBe(false);
    ward.expiresAtTick = null;
    expect(visibleIds(state, 'south').has(enemy.id)).toBe(true);

    const deadShip = addShip(state, 'south', -3000, 0, { dead: true });
    const enemyNearDead = addShip(state, 'north', -3100, 0);
    const ids = visibleIds(state, 'south');
    expect(ids.has(enemyNearDead.id)).toBe(false);
    expect(ids.has(deadShip.id)).toBe(false);
  });
});

describe('enemy wards', () => {
  it('shows non-invisible enemy wards only inside sight', () => {
    const state = makeState();
    addShip(state, 'south', 0, 0);
    const near = addWard(state, 'north', 400, 0, { invisible: false });
    const far = addWard(state, 'north', 2000, 0, { invisible: false });

    const ids = visibleIds(state, 'south');
    expect(ids.has(near.id)).toBe(true);
    expect(ids.has(far.id)).toBe(false);
  });

  it('hides invisible enemy wards unless a detector covers them', () => {
    const state = makeState();
    addShip(state, 'south', 0, 0);
    const hidden = addWard(state, 'north', 400, 0, { invisible: true });
    expect(visibleIds(state, 'south').has(hidden.id)).toBe(false);

    // A friendly detector ward covering it reveals it.
    const detector = addWard(state, 'south', 300, 0, { detectionRadius: 600 });
    expect(visibleIds(state, 'south').has(hidden.id)).toBe(true);
    delete state.entities[detector.id];

    // A detection zone works too.
    state.detectionZones.push({ team: 'south', x: 400, y: 0, radius: 200, expiresAtTick: 999 });
    expect(visibleIds(state, 'south').has(hidden.id)).toBe(true);
    state.detectionZones = [];

    // A detecting ship hull (DETSHIP detection 600) works too.
    const detShip = addShip(state, 'south', 200, 0, { typeId: 'DETSHIP' });
    expect(visibleIds(state, 'south').has(hidden.id)).toBe(true);
    delete state.entities[detShip.id];
  });

  it('requires sight on top of detection (detector coverage alone leaks nothing)', () => {
    const state = makeState();
    // Friendly detector ward far from everything: sight 400, detection 600.
    addWard(state, 'south', 5000, 0, { detectionRadius: 600 });
    // Enemy invisible ward 500 away: inside detection, outside all sight.
    const hidden = addWard(state, 'north', 5500, 0, { invisible: true });
    const vision = computeTeamVision(state, testRuleset, 'south');
    expect(isEntityVisible(vision, hidden as Entity)).toBe(false);

    // Same distance but non-invisible: still hidden — it is simply fogged.
    const fogged = addWard(state, 'north', 4500, 0, { invisible: false });
    expect(isEntityVisible(vision, fogged as Entity)).toBe(false);
  });

  it('detects via the Goblin Scout Crew carrier item (mirrors specials)', () => {
    const state = makeState();
    const player = makePlayer(2, 'south');
    player.inventory[0] = { itemId: 'I00F', charges: null, readyAtTick: 0 };
    state.players[2] = player;
    addShip(state, 'south', 0, 0, { owner: 2 });
    const hidden = addWard(state, 'north', 700, 0, { invisible: true }); // inside 800 sight, 900 gem

    expect(visibleIds(state, 'south').has(hidden.id)).toBe(true);

    player.inventory[0] = null;
    expect(visibleIds(state, 'south').has(hidden.id)).toBe(false);
  });
});

describe('projectiles', () => {
  it('includes own-team projectiles anywhere and enemy ones only in sight', () => {
    const state = makeState();
    addShip(state, 'south', 0, 0);
    const own = addProjectile(state, 'south', 30000, 0);
    const enemyNear = addProjectile(state, 'north', 700, 0);
    const enemyFar = addProjectile(state, 'north', 2000, 0);

    const vision = computeTeamVision(state, testRuleset, 'south');
    expect(isProjectileVisible(vision, own)).toBe(true);
    expect(isProjectileVisible(vision, enemyNear)).toBe(true);
    expect(isProjectileVisible(vision, enemyFar)).toBe(false);
  });
});
