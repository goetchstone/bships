/** Adversarial audit pins: compiled Classic specs vs data ground truth. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/sim/specials.js', () => ({
  breakInvisibilityOnAction: vi.fn(),
}));

import { stepCombat, applyDamage } from '../src/sim/combat.js';
import { compileClassicRuleset } from '../src/sim/ruleset.js';
import { allocEntityId } from '../src/sim/types.js';
import type {
  ItemInstance,
  PlayerState,
  RawDataFiles,
  Ruleset,
  ShipEntity,
  SimState,
  StructureEntity,
  CreepEntity,
  TeamId,
} from '../src/sim/types.js';

function loadJson<T>(name: string): T {
  const url = new URL(`../../../data/json/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}
const raw: RawDataFiles = {
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
const rs: Ruleset = compileClassicRuleset(raw);

function makeState(seed = 12345): SimState {
  return {
    tick: 0,
    rngState: seed,
    nextEntityId: 1,
    status: { phase: 'playing' },
    enabledModes: [],
    players: {},
    teams: {
      south: { id: 'south', aiPlayerSlot: 0, upgrades: {}, research: null },
      north: { id: 'north', aiPlayerSlot: 1, upgrades: {}, research: null },
    },
    entities: {},
    projectiles: {},
    groundItems: {},
    detectionZones: [],
    pendingDeaths: [],
    events: [],
    timers: {
      nextWaveTick: {},
      nextIncomeTick: 0,
      empireSharePeriodTicks: 0,
      nextEmpireShareTick: 0,
      nextGoldDumpTick: 0,
      streetMerchantSpawnTick: null,
    },
  };
}

function addPlayer(state: SimState, slot: number, team: TeamId, shipTypeId = 'H000'): PlayerState {
  const player: PlayerState = {
    slot, team, control: 'user', gold: 0, lumber: 0, xp: 0, level: 1,
    unspentSkillPoints: 0, heroSkillLevels: {}, shipTypeId, shipId: null,
    inventory: [null, null, null, null, null, null], cooldownGroups: {},
    missileReadyAtTick: 0, respawnAtTick: null, goldDumpEnabled: false,
  };
  state.players[slot] = player;
  return player;
}

function addShip(state: SimState, player: PlayerState, x: number, y: number): ShipEntity {
  const spec = rs.ships[player.shipTypeId];
  if (!spec) throw new Error(`no ship spec ${player.shipTypeId}`);
  const id = allocEntityId(state);
  const ship: ShipEntity = {
    id, typeId: spec.typeId, x, y, facingRad: 0, dead: false, kind: 'ship',
    owner: player.slot, team: player.team, hp: spec.maxHp, maxHp: spec.maxHp,
    order: { type: 'idle' }, statuses: [], vision: { south: true, north: true },
    attackReadyAtTick: 0, casting: null, pausedUntilTick: 0,
    invulnerableUntilTick: 0, submerged: false,
  };
  state.entities[id] = ship;
  player.shipId = id;
  return ship;
}

function addStructure(state: SimState, typeId: string, owner: number | null, team: TeamId | null, x: number, y: number): StructureEntity {
  const spec = rs.unitTypes[typeId];
  if (!spec) throw new Error(`no unit type ${typeId}`);
  const id = allocEntityId(state);
  const s: StructureEntity = {
    id, typeId, x, y, facingRad: 0, dead: false, kind: 'structure', owner, team,
    instanceKey: `${typeId}@${x},${y}`, role: 'other', hp: spec.maxHp,
    maxHp: spec.maxHp, statuses: [], attackReadyAtTick: 0, shopStock: null,
  };
  state.entities[id] = s;
  return s;
}

function addCreep(state: SimState, typeId: string, owner: number, team: TeamId, x: number, y: number): CreepEntity {
  const spec = rs.unitTypes[typeId];
  if (!spec) throw new Error(`no unit type ${typeId}`);
  const id = allocEntityId(state);
  const c: CreepEntity = {
    id, typeId, x, y, facingRad: 0, dead: false, kind: 'creep', owner, team,
    hp: spec.maxHp, maxHp: spec.maxHp, order: { type: 'hold' }, statuses: [],
    vision: { south: true, north: true }, attackReadyAtTick: 0, laneId: 'l', waypointIndex: 0,
  };
  state.entities[id] = c;
  return c;
}

function item(itemId: string): ItemInstance {
  return { itemId, charges: null, readyAtTick: 0 };
}

function runTicks(state: SimState, n: number): void {
  for (let i = 0; i < n; i++) {
    stepCombat(state, rs);
    state.tick += 1;
  }
}

describe('audit: compiled weapon specs vs weapons.json', () => {
  const cases: Array<[string, Partial<Record<string, unknown>>]> = [
    ['I001', { damage: 20, cooldownTicks: 30, rangeUnits: 700, projectileSpeedPerTick: 45, homing: false, targets: { ships: true, structures: true, heroOnly: false } }],
    ['I002', { damage: 3, cooldownTicks: 10, rangeUnits: 1600, projectileSpeedPerTick: 65, homing: false, targets: { ships: true, structures: false, heroOnly: false } }],
    ['I005', { damage: 30, cooldownTicks: 20, rangeUnits: 700, projectileSpeedPerTick: 45, homing: false, buffId: 'BHca', buffDurationTicks: 1, targets: { ships: true, structures: false, heroOnly: false } }],
    ['I00P', { damage: 270, cooldownTicks: 46, rangeUnits: 730, projectileSpeedPerTick: 45, homing: true, targets: { ships: false, structures: true, heroOnly: false } }],
    ['I00Y', { damage: 15, cooldownTicks: 1, rangeUnits: 600, projectileSpeedPerTick: 150, homing: false, targets: { ships: true, structures: true, heroOnly: false } }],
    ['I01Z', { damage: 30, cooldownTicks: 1, rangeUnits: 450, projectileSpeedPerTick: 80, homing: true, targets: { ships: true, structures: true, heroOnly: false } }],
    ['I02F', { damage: 115, cooldownTicks: 44, rangeUnits: 2500, projectileSpeedPerTick: 80, homing: false, targets: { ships: true, structures: false, heroOnly: true } }],
    ['I02N', { damage: 500, cooldownTicks: 450, rangeUnits: 900, projectileSpeedPerTick: 50, homing: true, castTimeTicks: 0, targets: { ships: true, structures: false, heroOnly: false } }],
    ['I026', { damage: 3000, cooldownTicks: 900, rangeUnits: 1200, projectileSpeedPerTick: 37.5, homing: true, castTimeTicks: 70, targets: { ships: false, structures: true, heroOnly: false } }],
    ['I01O', { damage: 50, cooldownTicks: 40, rangeUnits: null, aoeRadius: 200, projectileSpeedPerTick: 10, targets: { ships: false, structures: true, heroOnly: false } }],
    ['I027', { damage: 40, cooldownTicks: 60, rangeUnits: 700, homing: false, buffId: 'BNab', buffDurationTicks: 400, dot: { dmgPerTick: 1, durationTicks: 400, buffId: 'BNab', nonLethal: true } }],
    ['I01Y', { damage: 2000, cooldownTicks: 100, rangeUnits: 1500, homing: false, buffId: 'B016', buffDurationTicks: 80, dot: { dmgPerTick: 5, durationTicks: 80, buffId: 'B016', nonLethal: true } }],
  ];
  for (const [id, expected] of cases) {
    it(`weapon ${id}`, () => {
      const w = rs.weapons[id];
      expect(w, `${id} missing from compiled weapons`).toBeDefined();
      for (const [k, v] of Object.entries(expected)) {
        expect({ [k]: (w as unknown as Record<string, unknown>)[k] }).toEqual({ [k]: v });
      }
    });
  }

  it('damage typing: PF/stormBolt = spells/magic, kaboom = physical noTypeMult', () => {
    expect(rs.weapons['I01Z']?.attackType).toBe('spells');
    expect(rs.weapons['I01Z']?.damageType).toBe('magic');
    expect(rs.weapons['I01O']?.damageType).toBe('physical');
    expect(rs.weapons['I01O']?.noTypeMult).toBe(true);
    expect(rs.weapons['I02N']?.damageType).toBe('magic');
  });

  it('quantization: only I00H/I00G diverge from a tick multiple (accepted, SEMANTICS conventions)', () => {
    // I00H 0.12 s -> 2 ticks (+20% DPS) and I00G 0.33 s -> 7 ticks (-5.7%):
    // the two documented cooldown-quantization divergences.
    expect(rs.weapons['I00H']?.cooldownTicks).toBe(2);
    expect(rs.weapons['I00G']?.cooldownTicks).toBe(7);
    // Exact tick multiples stay exact.
    expect(rs.weapons['I000']?.cooldownTicks).toBe(11); // 0.55 s
    expect(rs.weapons['I00Z']?.cooldownTicks).toBe(6); // 0.30 s
    expect(rs.weapons['I01D']?.cooldownTicks).toBe(14); // 0.70 s
  });
});

describe('audit: Vulcan effective DPS probe', () => {
  it('~600 dps raw vs fortified structure (spells x1.0)', () => {
    const state = makeState();
    const { } = {};
    const p = addPlayer(state, 2, 'south');
    const ship = addShip(state, p, 0, 0);
    ship.hp = 1e9;
    ship.maxHp = 1e9; // survive the target structure's native attack
    p.inventory[0] = item('I01Z');
    const tgt = addStructure(state, 'n000', 1, 'north', 100, 0);
    tgt.hp = 1e9;
    tgt.maxHp = 1e9;
    console.log('n000 defenseType =', rs.unitTypes['n000']?.defenseType, 'spells multiplier =', rs.attackTypeVsDefense['spells'][rs.unitTypes['n000']!.defenseType]);
    runTicks(state, 201);
    let total = 0;
    let hits = 0;
    for (const e of state.events) {
      if (e.type === 'hit' && e.targetEntityId === tgt.id) {
        total += e.amount;
        hits++;
      }
    }
    // 201 ticks = 10.05 s; first impact lands at tick 1 (flight time).
    const dps = total / 10.05;
    console.log('Vulcan: hits =', hits, 'total =', total, 'dps =', dps.toFixed(1));
    expect(dps).toBeGreaterThan(570);
    expect(dps).toBeLessThan(630);
  });

  it('Vulcan vs hero ship gets spells x0.7', () => {
    const state = makeState();
    const p = addPlayer(state, 2, 'south');
    addShip(state, p, 0, 0);
    p.inventory[0] = item('I01Z');
    const e = addPlayer(state, 7, 'north', 'H006');
    const eShip = addShip(state, e, 100, 0);
    const hpBefore = eShip.hp;
    runTicks(state, 2); // launch tick 0, impact tick 1
    // The hero strength regen (+0.05 HP/s = 0.0025/tick) ticks once after
    // the impact, so the observed loss is 21 minus one regen step.
    const regen = rs.ships['H006']?.hpRegenPerTick ?? 0;
    expect(regen).toBeCloseTo(0.0025, 12);
    expect(hpBefore - eShip.hp).toBeCloseTo(30 * 0.7 - regen, 10);
  });
});

describe('audit: target-class filters', () => {
  it('Catapult (structures only) never fires at ships', () => {
    const state = makeState();
    const p = addPlayer(state, 2, 'south');
    addShip(state, p, 0, 0);
    p.inventory[0] = item('I00P');
    addPlayer(state, 7, 'north', 'H006');
    addShip(state, state.players[7]!, 200, 0);
    runTicks(state, 60);
    expect(state.events.filter((e) => e.type === 'hit').length).toBe(0);
    expect(Object.keys(state.projectiles).length).toBe(0);
  });

  it('Sniper (hero only) ignores creeps and structures, hits ships', () => {
    const state = makeState();
    const p = addPlayer(state, 2, 'south');
    addShip(state, p, 0, 0);
    p.inventory[0] = item('I02F');
    addCreep(state, 'h00B', 1, 'north', 300, 0);
    addStructure(state, 'n004', 1, 'north', 400, 0);
    runTicks(state, 50);
    expect(state.events.filter((e) => e.type === 'hit' && e.weaponId === 'I02F').length).toBe(0);
    const e = addPlayer(state, 7, 'north', 'H006');
    const eShip = addShip(state, e, 500, 0);
    runTicks(state, 60);
    const hits = state.events.filter(
      (ev) => ev.type === 'hit' && ev.weaponId === 'I02F' && ev.targetEntityId === eShip.id,
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it('friendly fire is dropped, enemy fire is not', () => {
    const state = makeState();
    const a = addPlayer(state, 2, 'south');
    const shipA = addShip(state, a, 0, 0);
    addPlayer(state, 3, 'south');
    addPlayer(state, 7, 'north');
    applyDamage(state, rs, shipA.id, {
      amount: 100, attackType: 'spells', damageType: 'magic', noTypeMult: false,
      nonLethal: false, sourcePlayer: 3, sourceEntityId: null, weaponId: 'I01Z',
    });
    expect(shipA.hp).toBe(shipA.maxHp); // ally damage dropped
    applyDamage(state, rs, shipA.id, {
      amount: 100, attackType: 'spells', damageType: 'magic', noTypeMult: false,
      nonLethal: false, sourcePlayer: 7, sourceEntityId: null, weaponId: 'I01Z',
    });
    expect(shipA.maxHp - shipA.hp).toBeCloseTo(70, 10); // spells x0.7 vs hero
  });
});

describe('audit: armor formula', () => {
  it('physical vs H000 (-1.7 armor) amplifies by 2 - 0.94^1.7', () => {
    const state = makeState();
    const p = addPlayer(state, 7, 'north', 'H000');
    const ship = addShip(state, p, 0, 0);
    console.log('H000 armor =', rs.ships['H000']?.armor);
    applyDamage(state, rs, ship.id, {
      amount: 100, attackType: 'normal', damageType: 'physical', noTypeMult: true,
      nonLethal: false, sourcePlayer: 0, sourceEntityId: null, weaponId: null,
    });
    const expected = 100 * (2 - Math.pow(0.94, 1.7));
    expect(ship.maxHp - ship.hp).toBeCloseTo(expected, 6);
  });
});
