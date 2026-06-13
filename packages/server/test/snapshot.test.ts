/**
 * Snapshot payload building, keyframe/delta diffing and per-team event
 * filtering (synthetic world; real-ruleset integration is in match.test.ts).
 */

import { describe, expect, it } from 'vitest';
import type { SimEvent, SimState } from '@bships/core';
import {
  buildTeamPayload,
  diffTeamPayloads,
  filterEventsForSeat,
  mapStatuses,
  round1,
} from '../src/snapshot.js';
import {
  addShip,
  addStructure,
  addWard,
  makePlayer,
  makeState,
  testRuleset,
} from './match-fixtures.js';

describe('round1', () => {
  it('rounds to 0.1', () => {
    expect(round1(100.16)).toBe(100.2);
    expect(round1(-6912.04)).toBe(-6912);
    expect(round1(0.05)).toBe(0.1);
  });
});

describe('toSnapshotEntity via buildTeamPayload', () => {
  it('rounds x/y, keeps facing verbatim, reports wards as 1/1 hp', () => {
    const state = makeState();
    addShip(state, 'south', 100.16, -50.24, { facingRad: 1.2345678 });
    const ward = addWard(state, 'south', 10.06, 20.04);

    const payload = buildTeamPayload(state, testRuleset, 'south');
    const shipSnap = [...payload.entities.values()].find((e) => e.kind === 'ship');
    expect(shipSnap).toMatchObject({ x: 100.2, y: -50.2, facing: 1.2345678 });

    const wardSnap = payload.entities.get(ward.id);
    expect(wardSnap).toMatchObject({ x: 10.1, y: 20, hp: 1, maxHp: 1, kind: 'ward' });
  });

  it('maps statuses per SnapshotStatusKind and drops weaponBuff', () => {
    const tick = 100;
    const statuses = mapStatuses(
      [
        { kind: 'dot', buffId: 'B', dmgPerTick: 1, expiresAtTick: 200, nonLethal: false, sourcePlayer: null },
        { kind: 'hot', buffId: 'B', healPerTick: 1, expiresAtTick: 200 },
        { kind: 'weaponBuff', buffId: 'B', expiresAtTick: 200 },
        { kind: 'speedAura', moveSpeedPct: 0.1, sourceAbilityId: 'A' },
        { kind: 'slowed', moveSpeedPct: -0.1, expiresAtTick: 200 },
        { kind: 'stunned', expiresAtTick: 200 },
        { kind: 'goblinMine', sourcePlayer: 7, detonateAtTick: null },
      ],
      true,
      tick,
    );
    expect(statuses).toEqual(['burning', 'goblinMine', 'hasted', 'healing', 'slowed', 'stunned']);
  });

  it('drops expired statuses and dedupes kinds', () => {
    const statuses = mapStatuses(
      [
        { kind: 'dot', buffId: 'A', dmgPerTick: 1, expiresAtTick: 100, nonLethal: false, sourcePlayer: null },
        { kind: 'dot', buffId: 'B', dmgPerTick: 1, expiresAtTick: 200, nonLethal: false, sourcePlayer: null },
        { kind: 'dot', buffId: 'C', dmgPerTick: 1, expiresAtTick: 300, nonLethal: false, sourcePlayer: null },
        { kind: 'stunned', expiresAtTick: 100 },
      ],
      true,
      100,
    );
    expect(statuses).toEqual(['burning']);
  });

  it("sends 'invisible' only for own units; detected enemies get 'revealed'", () => {
    const state = makeState();
    addShip(state, 'south', 0, 0); // south sight source
    const sneak = addShip(state, 'north', 500, 0, {
      statuses: [{ kind: 'invisible', buffId: null, expiresAtTick: null, breaksOnAction: false }],
      vision: { south: true, north: true }, // detected by the sim
    });

    const southView = buildTeamPayload(state, testRuleset, 'south').entities.get(sneak.id);
    expect(southView?.statuses).toEqual(['revealed']);

    const northView = buildTeamPayload(state, testRuleset, 'north').entities.get(sneak.id);
    expect(northView?.statuses).toEqual(['invisible']);
  });

  it('marks own invisible wards, never enemy ones', () => {
    const state = makeState();
    addShip(state, 'south', 0, 0);
    const ownWard = addWard(state, 'south', 100, 0, { invisible: true });
    const enemyWard = addWard(state, 'north', 200, 0, { invisible: false });

    const payload = buildTeamPayload(state, testRuleset, 'south');
    expect(payload.entities.get(ownWard.id)?.statuses).toEqual(['invisible']);
    expect(payload.entities.get(enemyWard.id)?.statuses).toEqual([]);
  });

  it('includes structure role and finite shop stock', () => {
    const state = makeState();
    const shop = addStructure(state, null, 0, 0, {
      role: 'shop',
      shopStock: {
        I001: { stock: 2, nextRestockTick: 500 },
        I002: { stock: 0, nextRestockTick: 600 },
      },
    });
    const tower = addStructure(state, 'south', 100, 0);

    const payload = buildTeamPayload(state, testRuleset, 'south');
    const shopSnap = payload.entities.get(shop.id);
    expect(shopSnap?.role).toBe('shop');
    expect(shopSnap?.shopStock).toEqual({ I001: 2, I002: 0 });
    expect(shopSnap?.ownerSlot).toBeNull();

    const towerSnap = payload.entities.get(tower.id);
    expect(towerSnap?.role).toBe('tower');
    expect(towerSnap?.shopStock).toBeUndefined();
  });

  it('flags submerged ships only while submerged', () => {
    const state = makeState();
    const sub = addShip(state, 'south', 0, 0, { submerged: true });
    const surfaced = addShip(state, 'south', 100, 0);

    const payload = buildTeamPayload(state, testRuleset, 'south');
    expect(payload.entities.get(sub.id)?.submerged).toBe(true);
    expect('submerged' in (payload.entities.get(surfaced.id) ?? {})).toBe(false);
  });
});

describe('diffTeamPayloads', () => {
  function world(): { state: SimState; mover: ReturnType<typeof addShip> } {
    const state = makeState();
    addStructure(state, 'south', 0, 0);
    const mover = addShip(state, 'south', 100, 0);
    return { state, mover };
  }

  it('emits upserts only for changed entities', () => {
    const { state, mover } = world();
    const a = buildTeamPayload(state, testRuleset, 'south');
    mover.x = 150;
    const b = buildTeamPayload(state, testRuleset, 'south');

    const diff = diffTeamPayloads(a, b);
    expect(diff.upserts.map((e) => e.id)).toEqual([mover.id]);
    expect(diff.removed).toEqual([]);
  });

  it('emits nothing when nothing changed', () => {
    const { state } = world();
    const a = buildTeamPayload(state, testRuleset, 'south');
    const b = buildTeamPayload(state, testRuleset, 'south');
    const diff = diffTeamPayloads(a, b);
    expect(diff.upserts).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('sub-0.1-unit movement does not produce an upsert (rounded compare)', () => {
    const { state, mover } = world();
    mover.x = 100.0;
    const a = buildTeamPayload(state, testRuleset, 'south');
    mover.x = 100.04;
    const b = buildTeamPayload(state, testRuleset, 'south');
    expect(diffTeamPayloads(a, b).upserts).toEqual([]);
  });

  it('reports vision entry as upsert and vision exit as removed', () => {
    const state = makeState();
    addShip(state, 'south', 0, 0); // sight 800
    const enemy = addShip(state, 'north', 2000, 0);

    const fogged = buildTeamPayload(state, testRuleset, 'south');
    enemy.x = 500;
    const seen = buildTeamPayload(state, testRuleset, 'south');
    enemy.x = 2000;
    const foggedAgain = buildTeamPayload(state, testRuleset, 'south');

    expect(diffTeamPayloads(fogged, seen).upserts.map((e) => e.id)).toEqual([enemy.id]);
    expect(diffTeamPayloads(seen, foggedAgain).removed).toEqual([enemy.id]);
  });

  it('reports death as removed', () => {
    const { state, mover } = world();
    const a = buildTeamPayload(state, testRuleset, 'south');
    delete state.entities[mover.id]; // finalize deleted it
    const b = buildTeamPayload(state, testRuleset, 'south');
    expect(diffTeamPayloads(a, b).removed).toEqual([mover.id]);
  });
});

describe('filterEventsForSeat', () => {
  function eventState(): SimState {
    const state = makeState();
    state.players[0] = makePlayer(0, 'south');
    state.players[1] = makePlayer(1, 'north');
    state.players[2] = makePlayer(2, 'south');
    state.players[3] = makePlayer(3, 'south');
    state.players[7] = makePlayer(7, 'north');
    return state;
  }

  const none: ReadonlySet<number> = new Set();

  it('routes private events only to the owning seat', () => {
    const state = eventState();
    const events: SimEvent[] = [
      { type: 'purchase', tick: 5, player: 2, itemId: 'I001', shipTypeId: null, gold: 100 },
      { type: 'xpGained', tick: 5, player: 2, amount: 10, reason: 'kill' },
      { type: 'levelUp', tick: 5, player: 2, level: 2 },
      { type: 'bounty', tick: 5, player: 2, amount: 8, victimEntityId: 99 },
      { type: 'questProgress', tick: 5, player: 2, questId: 'Q', stage: 'pickup' },
      { type: 'itemUsed', tick: 5, player: 2, itemId: 'I001' },
      { type: 'refund', tick: 5, player: 2, itemId: 'I001', gold: 100, reason: 'stackRule' },
      { type: 'commandRejected', tick: 5, player: 2, commandType: 'move', reason: 'dead' },
      { type: 'proximityWarning', tick: 5, ownerPlayer: 2, wardEntityId: 1, intruderEntityId: 2 },
    ];
    expect(filterEventsForSeat(state, events, 'south', 2, none)).toHaveLength(events.length);
    // Same-team seat 3 sees none of them.
    expect(filterEventsForSeat(state, events, 'south', 3, none)).toHaveLength(0);
    expect(filterEventsForSeat(state, events, 'north', 7, none)).toHaveLength(0);
  });

  it('scopes research and respawn to the team, waves and match end globally', () => {
    const state = eventState();
    const events: SimEvent[] = [
      { type: 'researchStarted', tick: 5, team: 'south', upgradeId: 'R003', level: 1 },
      { type: 'researchComplete', tick: 5, team: 'north', upgradeId: 'R004', level: 1 },
      { type: 'respawn', tick: 5, player: 2, entityId: 50 },
      { type: 'waveSpawned', tick: 5, laneId: 'L', waveName: 'W', count: 3 },
      { type: 'matchEnded', tick: 5, winner: 'south' },
    ];
    const south = filterEventsForSeat(state, events, 'south', 3, none);
    expect(south.map((e) => e.type)).toEqual([
      'researchStarted',
      'respawn',
      'waveSpawned',
      'matchEnded',
    ]);
    const north = filterEventsForSeat(state, events, 'north', 7, none);
    expect(north.map((e) => e.type)).toEqual(['researchComplete', 'waveSpawned', 'matchEnded']);
  });

  it('gates spatial events on the visible set or an involved team player', () => {
    const state = eventState();
    const unseenDeath: SimEvent = {
      type: 'death',
      tick: 5,
      entityId: 60,
      entityTypeId: 'CREEP',
      victimPlayer: 1,
      killerPlayer: 1,
      x: 0,
      y: 0,
    };
    const seenHit: SimEvent = {
      type: 'hit',
      tick: 5,
      targetEntityId: 61,
      attackerPlayer: null,
      weaponId: null,
      amount: 10,
    };

    // Unseen all-north death: south gets nothing; north (own AI player) does.
    expect(filterEventsForSeat(state, [unseenDeath], 'south', 2, none)).toEqual([]);
    expect(filterEventsForSeat(state, [unseenDeath], 'north', 7, none)).toEqual([unseenDeath]);

    // Visible-set gate.
    const visible: ReadonlySet<number> = new Set([60, 61]);
    expect(filterEventsForSeat(state, [unseenDeath, seenHit], 'south', 2, visible)).toEqual([
      unseenDeath,
      seenHit,
    ]);
    expect(filterEventsForSeat(state, [seenHit], 'south', 2, none)).toEqual([]);

    // Involved team player: south killer makes the death visible to south.
    const killedBySouth: SimEvent = { ...unseenDeath, killerPlayer: 2 };
    expect(filterEventsForSeat(state, [killedBySouth], 'south', 3, none)).toEqual([killedBySouth]);

    // hit by a south player is reported to south.
    const southHit: SimEvent = { ...seenHit, type: 'hit', attackerPlayer: 2, targetEntityId: 62 };
    expect(filterEventsForSeat(state, [southHit], 'south', 3, none)).toEqual([southHit]);
    expect(filterEventsForSeat(state, [southHit], 'north', 7, none)).toEqual([]);

    // missileLaunched: owning team always, other team only if target visible.
    const missile: SimEvent = {
      type: 'missileLaunched',
      tick: 5,
      player: 7,
      warheadItemId: 'I00H',
      targetEntityId: 63,
    };
    expect(filterEventsForSeat(state, [missile], 'north', 7, none)).toEqual([missile]);
    expect(filterEventsForSeat(state, [missile], 'south', 2, none)).toEqual([]);
    expect(filterEventsForSeat(state, [missile], 'south', 2, new Set([63]))).toEqual([missile]);
  });
});
