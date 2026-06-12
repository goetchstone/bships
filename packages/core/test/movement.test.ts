import { describe, expect, it } from 'vitest';
import { dist } from '../src/math.js';
import {
  applyMovementCommand,
  effectiveMoveSpeed,
  stepMovement,
} from '../src/sim/movement.js';
import type {
  AttackType,
  CreepEntity,
  DefenseType,
  Entity,
  EquipmentSpec,
  ItemInstance,
  PlayerState,
  Ruleset,
  ShipEntity,
  ShipSpec,
  SimState,
  StructureEntity,
  TeamId,
  UnitTypeSpec,
  WardEntity,
} from '../src/sim/types.js';

// ---------------------------------------------------------------------------
// Fixtures. Movement reads only: ruleset.tickRate, constants.{minMoveSpeed,
// maxMoveSpeed, turnRateCapRadPerTick}, ships, unitTypes, equipment
// (passives.moveSpeedPct), map.bounds. Those carry REAL extracted data;
// every other Ruleset field is an inert stub. Sources:
// - ships.json / units.json: H000 umvs 170 umvr 1.0 ucol 5; H005 280/0.75/5;
//   H00W 100/0.3/10; h00B 220/ucol 15 (hdes base, no umvr override).
// - equipment.json: I01T +200%, I007 +10%, I008 +25%, I009 -5%, I00A -20%,
//   I01X +30%.
// - SEMANTICS §3: engine clamps 150/400; turn cap 0.20 rad per 0.03 s frame.
// - map-layout.json playableArea: -5536/-8192 .. 5312/6656.
// ---------------------------------------------------------------------------

const TICK_RATE = 20;
/** 0.20 rad per 0.03 s engine frame, compiled to rad per 0.05 s tick. */
const TURN_CAP = 0.2 * (0.05 / 0.03);

const ATTACK_TYPES: AttackType[] = ['normal', 'pierce', 'siege', 'magic', 'chaos', 'spells', 'hero'];
const DEFENSE_TYPES: DefenseType[] = [
  'unarmored',
  'light',
  'medium',
  'heavy',
  'fortified',
  'hero',
  'divine',
  'normal',
];

function stubTypeTable(): Record<AttackType, Record<DefenseType, number>> {
  const table = {} as Record<AttackType, Record<DefenseType, number>>;
  for (const a of ATTACK_TYPES) {
    const row = {} as Record<DefenseType, number>;
    for (const d of DEFENSE_TYPES) row[d] = 1;
    table[a] = row;
  }
  return table;
}

function makeShipSpec(
  typeId: string,
  moveSpeed: number,
  umvr: number,
  collisionRadius: number,
  inventorySlots: number,
): ShipSpec {
  return {
    typeId,
    name: typeId,
    gold: 0,
    rawHp: 0,
    rawArmor: 0,
    maxHp: 0,
    armor: 0,
    defenseType: 'hero',
    moveSpeed,
    turnRateRadPerTick: Math.min(umvr, 0.2) * (0.05 / 0.03),
    collisionRadius,
    inventorySlots,
    isSub: false,
    abilityIds: [],
    hpRegenPerTick: 0,
    bounty: { base: 0, dice: 0, sides: 0 },
    sightRadius: 0,
    detectionRadius: null,
    nativeAttackRangeUnits: null,
  };
}

function makeUnitTypeSpec(
  typeId: string,
  moveSpeed: number,
  turnRateRadPerTick: number,
  collisionRadius: number,
  opts: { isStructure?: boolean; attackRange?: number } = {},
): UnitTypeSpec {
  return {
    typeId,
    name: typeId,
    maxHp: 0,
    armor: 0,
    defenseType: 'normal',
    attack:
      opts.attackRange === undefined
        ? null
        : {
            damageBase: 0,
            damageDice: 0,
            damageSides: 0,
            cooldownTicks: 1,
            rangeUnits: opts.attackRange,
            attackType: 'pierce',
            projectileSpeedPerTick: null,
            targets: { ships: true, structures: false, heroOnly: false },
            upgradeIds: [],
          },
    moveSpeed,
    turnRateRadPerTick,
    collisionRadius,
    isStructure: opts.isStructure ?? false,
    level: 0,
    bounty: { base: 0, dice: 0, sides: 0 },
    hpRegenPerTick: 0,
    sightRadius: 0,
    detectionRadius: null,
    permanentlyInvisible: false,
    invulnerable: false,
  };
}

function makeEquipment(id: string, category: EquipmentSpec['category'], gold: number, moveSpeedPct: number): EquipmentSpec {
  return {
    id,
    name: id,
    category,
    gold,
    passives: { maxHpBonus: 0, damageReductionPct: 0, armorBonus: 0, moveSpeedPct, hpRegenPerTick: 0 },
    active: null,
    charges: null,
    perishable: false,
    cooldownGroup: null,
  };
}

function fixtureRuleset(): Ruleset {
  return {
    name: 'movement-test',
    tickRate: TICK_RATE,
    constants: {
      startingGold: 0,
      minMoveSpeed: 150,
      maxMoveSpeed: 400,
      turnRateCapRadPerTick: TURN_CAP,
      armorFactorPerPoint: 0.06,
      negativeArmorBase: 0.94,
      heroStrHpBonus: 25,
      heroAgiArmorPerPoint: 0.3,
      heroArmorBaseOffset: -2,
      heroStrRegenPerSecond: 0.05,
      missileExplodeOnDeathDoubling: false,
      sellbackRate: 0,
      friendlyFire: false,
      pfDotNonLethal: true,
    },
    attackTypeVsDefense: stubTypeTable(),
    weapons: {},
    equipment: {
      // Real moveSpeedPct values from equipment.json.
      I007: makeEquipment('I007', 'sail', 100, 0.1), // Light Sail
      I008: makeEquipment('I008', 'sail', 610, 0.25), // Great Sail
      I01T: makeEquipment('I01T', 'sail', 5425, 2.0), // Outboard Propeller
      I009: makeEquipment('I009', 'hull', 200, -0.05), // Stone Hull
      I00A: makeEquipment('I00A', 'hull', 2500, -0.2), // Gold Hull
      I01X: makeEquipment('I01X', 'hull', 6600, 0.3), // Kraken shell
    },
    abilities: {},
    ships: {
      // Real umvs/umvr/ucol/slots from ships.json + units.json.
      H000: makeShipSpec('H000', 170, 1.0, 5, 6), // starter Battle Ship
      H005: makeShipSpec('H005', 280, 0.75, 5, 4), // Merchant Boat
      H00W: makeShipSpec('H00W', 100, 0.3, 10, 6), // submerged Submarine
    },
    unitTypes: {
      // h00B Imperial lane ship: umvs 220, ucol 15 (units.json); hdes base
      // umvr not overridden -> compiled at the engine cap.
      h00B: makeUnitTypeSpec('h00B', 220, TURN_CAP, 15),
      // SYNTHETIC fixtures (math-path coverage only, not balance claims):
      // a turner below the engine cap, an attack-ranged chaser (lane SLK
      // attack data is an extraction follow-up), an immobile unit, and a
      // structure body (footprint radii not extracted).
      testSlowTurner: makeUnitTypeSpec('testSlowTurner', 220, 0.1, 15),
      testRangedCreep: makeUnitTypeSpec('testRangedCreep', 220, TURN_CAP, 15, { attackRange: 600 }),
      testImmobile: makeUnitTypeSpec('testImmobile', 0, TURN_CAP, 15),
      testTower: makeUnitTypeSpec('testTower', 0, 0, 30, { isStructure: true }),
    },
    upgrades: {},
    shops: {},
    stackRules: [],
    subRules: {
      surfacedTypeId: 'H00V',
      submergedTypeId: 'H00W',
      torpedoItemIds: [],
      maxTorpedoBaysPerSub: 1,
      bannedItemIds: [],
      diveAbilityId: 'A04C',
      diveCooldownTicks: 100,
    },
    missiles: {
      castAbilityId: '',
      lumberItemId: '',
      throttleTicks: 0,
      warheads: {},
      targeting: 'randomEnemyLeadPlayerStructure',
      buggfixPeriodTicks: 0,
      buggfixSouthOnly: true,
    },
    suicideQuests: [],
    contracts: {
      lumberCosts: {},
      lumberRefunds: {},
      tradeRoutes: [],
      captainReward: {
        pieceItemId: '',
        piecesRequired: 0,
        tokenItemId: '',
        rewardGold: 0,
        rewardXp: 0,
        rewardLumber: 0,
      },
    },
    xp: {
      xpToLevel: [],
      killXpByVictimLevel: [],
      heroKillXpByVictimLevel: [],
      heroKillXpPerLevelAbove: 0,
      shareRadius: 0,
      summonFactor: 0,
      heroLevelCap: 12,
      skillPointsPerLevel: 1,
    },
    respawn: { perLevelSeconds: 0, baseSeconds: 0, randMaxSeconds: 0, invulnerableTicks: 0 },
    income: {
      intervalTicks: 1,
      byHumanCount: {},
      requiresNorthHqAlive: true,
      empireShareMinTicks: 1,
      empireShareMaxTicks: 1,
      goldDumpPeriodTicks: 1,
      streetMerchant: {
        rollAtTick: 0,
        spawnAtTick: 0,
        rollMin: 0,
        rollMax: 0,
        threshold: 0,
        merchantTypeId: '',
      },
    },
    map: {
      // Real playable area from map-layout.json.
      bounds: { minX: -5536, minY: -8192, maxX: 5312, maxY: 6656 },
      regions: {},
      structures: [],
      playerStarts: {},
      startingShipTypeId: 'H000',
      lanes: [],
      waves: [],
      respawnRegionByTeam: { south: '', north: '' },
      repairBays: [],
      subTeleports: [],
      tempItemRegion: '',
      streetMerchantRegions: { south: '', north: '' },
    },
  };
}

function makePlayer(slot: number, team: TeamId, shipId: number | null, itemIds: string[] = []): PlayerState {
  const inventory: (ItemInstance | null)[] = [null, null, null, null, null, null];
  itemIds.forEach((itemId, i) => {
    inventory[i] = { itemId, charges: null, readyAtTick: 0 };
  });
  return {
    slot,
    team,
    control: 'user',
    gold: 0,
    lumber: 0,
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    heroSkillLevels: {},
    shipTypeId: 'H000',
    shipId,
    inventory,
    cooldownGroups: {},
    missileReadyAtTick: 0,
    respawnAtTick: null,
    goldDumpEnabled: false,
  };
}

function makeShip(id: number, owner: number, team: TeamId, typeId: string, x: number, y: number): ShipEntity {
  return {
    kind: 'ship',
    id,
    typeId,
    x,
    y,
    facingRad: 0,
    dead: false,
    owner,
    team,
    hp: 100,
    maxHp: 100,
    order: { type: 'idle' },
    statuses: [],
    vision: { south: true, north: true },
    attackReadyAtTick: 0,
    casting: null,
    pausedUntilTick: 0,
    invulnerableUntilTick: 0,
    submerged: false,
  };
}

function makeCreep(id: number, owner: number, team: TeamId, typeId: string, x: number, y: number): CreepEntity {
  return {
    kind: 'creep',
    id,
    typeId,
    x,
    y,
    facingRad: 0,
    dead: false,
    owner,
    team,
    hp: 100,
    maxHp: 100,
    order: { type: 'idle' },
    statuses: [],
    vision: { south: true, north: true },
    attackReadyAtTick: 0,
    laneId: 'lane',
    waypointIndex: 0,
  };
}

function makeStructure(id: number, typeId: string, x: number, y: number): StructureEntity {
  return {
    kind: 'structure',
    id,
    typeId,
    x,
    y,
    facingRad: 0,
    dead: false,
    owner: null,
    team: null,
    instanceKey: `${typeId}_${id}`,
    role: 'tower',
    hp: 100,
    maxHp: 100,
    statuses: [],
    attackReadyAtTick: 0,
    shopStock: null,
  };
}

function makeWard(id: number, owner: number, team: TeamId, x: number, y: number): WardEntity {
  return {
    kind: 'ward',
    id,
    typeId: 'ohwd',
    x,
    y,
    facingRad: 0,
    dead: false,
    owner,
    team,
    expiresAtTick: null,
    sightRadius: 1,
    detectionRadius: null,
    invisible: true,
    invulnerable: true,
  };
}

function makeState(entities: Entity[], players: PlayerState[] = []): SimState {
  const entityRecord: Record<number, Entity> = {};
  let maxId = 0;
  for (const e of entities) {
    entityRecord[e.id] = e;
    if (e.id > maxId) maxId = e.id;
  }
  const playerRecord: Record<number, PlayerState> = {};
  for (const p of players) playerRecord[p.slot] = p;
  return {
    tick: 0,
    rngState: 1187,
    nextEntityId: maxId + 1,
    status: { phase: 'playing' },
    enabledModes: [],
    players: playerRecord,
    teams: {
      south: { id: 'south', aiPlayerSlot: 0, upgrades: {}, research: null },
      north: { id: 'north', aiPlayerSlot: 1, upgrades: {}, research: null },
    },
    entities: entityRecord,
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

/** Step a single-focus state n times (tick does not advance — sim finalize owns tick++). */
function stepN(state: SimState, ruleset: Ruleset, n: number): void {
  for (let i = 0; i < n; i++) stepMovement(state, ruleset);
}

// ---------------------------------------------------------------------------
// applyMovementCommand
// ---------------------------------------------------------------------------

describe('applyMovementCommand', () => {
  const ruleset = fixtureRuleset();

  it('sets move / stop / hold / attackMove orders on the owning player boat', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);

    applyMovementCommand(state, ruleset, { type: 'move', player: 2, x: 100, y: -50 });
    expect(ship.order).toEqual({ type: 'move', x: 100, y: -50 });

    applyMovementCommand(state, ruleset, { type: 'stop', player: 2 });
    expect(ship.order).toEqual({ type: 'idle' });

    applyMovementCommand(state, ruleset, { type: 'holdPosition', player: 2 });
    expect(ship.order).toEqual({ type: 'hold' });

    applyMovementCommand(state, ruleset, { type: 'attackMove', player: 2, x: -10, y: 20 });
    expect(ship.order).toEqual({ type: 'attackMove', x: -10, y: 20 });
    expect(state.events).toEqual([]);
  });

  it('accepts attackTarget on an existing target visible to the player team', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const enemy = makeShip(11, 7, 'north', 'H000', 500, 0);
    enemy.vision = { south: true, north: true };
    const state = makeState([ship, enemy], [makePlayer(2, 'south', 10)]);

    applyMovementCommand(state, ruleset, { type: 'attackTarget', player: 2, targetId: 11 });
    expect(ship.order).toEqual({ type: 'attackTarget', targetId: 11 });
    expect(state.events).toEqual([]);
  });

  it('rejects attackTarget when the target does not exist or is dead', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const corpse = makeShip(11, 7, 'north', 'H000', 500, 0);
    corpse.dead = true;
    const state = makeState([ship, corpse], [makePlayer(2, 'south', 10)]);

    applyMovementCommand(state, ruleset, { type: 'attackTarget', player: 2, targetId: 999 });
    applyMovementCommand(state, ruleset, { type: 'attackTarget', player: 2, targetId: 11 });

    expect(ship.order).toEqual({ type: 'idle' });
    expect(state.events).toHaveLength(2);
    for (const ev of state.events) {
      expect(ev).toMatchObject({ type: 'commandRejected', player: 2, commandType: 'attackTarget' });
    }
  });

  it('rejects attackTarget when the target is not visible to the player team', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const hidden = makeShip(11, 7, 'north', 'H000', 500, 0);
    hidden.vision = { south: false, north: true };
    const state = makeState([ship, hidden], [makePlayer(2, 'south', 10)]);

    applyMovementCommand(state, ruleset, { type: 'attackTarget', player: 2, targetId: 11 });
    expect(ship.order).toEqual({ type: 'idle' });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ type: 'commandRejected', commandType: 'attackTarget' });

    // Same command once specials reveals the target to south: accepted.
    hidden.vision.south = true;
    applyMovementCommand(state, ruleset, { type: 'attackTarget', player: 2, targetId: 11 });
    expect(ship.order).toEqual({ type: 'attackTarget', targetId: 11 });
  });

  it('ignores commands while the ship is dead, paused, or the player has no ship', () => {
    const deadShip = makeShip(10, 2, 'south', 'H000', 0, 0);
    deadShip.dead = true;
    const pausedShip = makeShip(11, 3, 'south', 'H000', 0, 0);
    pausedShip.pausedUntilTick = 50; // repair bay until tick 50, state.tick = 0
    const state = makeState(
      [deadShip, pausedShip],
      [makePlayer(2, 'south', 10), makePlayer(3, 'south', 11), makePlayer(4, 'south', null)],
    );

    applyMovementCommand(state, ruleset, { type: 'move', player: 2, x: 100, y: 0 });
    applyMovementCommand(state, ruleset, { type: 'move', player: 3, x: 100, y: 0 });
    applyMovementCommand(state, ruleset, { type: 'move', player: 4, x: 100, y: 0 });

    expect(deadShip.order).toEqual({ type: 'idle' });
    expect(pausedShip.order).toEqual({ type: 'idle' });
    expect(state.events).toEqual([]); // ignored, not rejected
  });

  it('accepts commands again once the repair-bay pause has expired', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.pausedUntilTick = 5;
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);
    state.tick = 5; // pausedUntilTick > tick is false

    applyMovementCommand(state, ruleset, { type: 'move', player: 2, x: 100, y: 0 });
    expect(ship.order).toEqual({ type: 'move', x: 100, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// effectiveMoveSpeed — real data values (ships.json / equipment.json)
// ---------------------------------------------------------------------------

describe('effectiveMoveSpeed', () => {
  const ruleset = fixtureRuleset();

  it('returns the base speed with an empty inventory (H000 = 170)', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);
    expect(effectiveMoveSpeed(state, ruleset, ship)).toBe(170);
  });

  it('clamps an Outboard Propeller stack at the 400 engine cap (170 x 3.0 = 510)', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const state = makeState([ship], [makePlayer(2, 'south', 10, ['I01T'])]);
    expect(effectiveMoveSpeed(state, ruleset, ship)).toBe(400);
  });

  it('applies Light Sail +10% (170 -> 187)', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const state = makeState([ship], [makePlayer(2, 'south', 10, ['I007'])]);
    expect(effectiveMoveSpeed(state, ruleset, ship)).toBeCloseTo(187, 9);
  });

  it('sums hull penalty and sail bonus additively (Gold Hull -20% + Great Sail +25%)', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const state = makeState([ship], [makePlayer(2, 'south', 10, ['I00A', 'I008'])]);
    expect(effectiveMoveSpeed(state, ruleset, ship)).toBeCloseTo(170 * 1.05, 9);
  });

  it('adds speedAura and slowed status pcts into the same additive bucket', () => {
    const aura = makeShip(10, 2, 'south', 'H005', 0, 0);
    aura.statuses.push({ kind: 'speedAura', moveSpeedPct: 0.1, sourceAbilityId: 'A00X' });
    const slowed = makeShip(11, 3, 'south', 'H005', 0, 0);
    slowed.statuses.push({ kind: 'slowed', moveSpeedPct: -0.3, expiresAtTick: 100 });
    const state = makeState([aura, slowed], [makePlayer(2, 'south', 10), makePlayer(3, 'south', 11)]);

    expect(effectiveMoveSpeed(state, ruleset, aura)).toBeCloseTo(280 * 1.1, 9);
    expect(effectiveMoveSpeed(state, ruleset, slowed)).toBeCloseTo(280 * 0.7, 9);
  });

  it('aura on top of Propeller still clamps at 400', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.statuses.push({ kind: 'speedAura', moveSpeedPct: 0.1, sourceAbilityId: 'A00X' });
    const state = makeState([ship], [makePlayer(2, 'south', 10, ['I01T'])]);
    expect(effectiveMoveSpeed(state, ruleset, ship)).toBe(400);
  });

  it('ignores an expired slowed status', () => {
    const ship = makeShip(10, 2, 'south', 'H005', 0, 0);
    ship.statuses.push({ kind: 'slowed', moveSpeedPct: -0.3, expiresAtTick: 5 });
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);
    state.tick = 5; // expiresAtTick > tick is false -> inactive
    expect(effectiveMoveSpeed(state, ruleset, ship)).toBe(280);
  });

  it('floors heavy slows at the 150 engine minimum', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.statuses.push({ kind: 'slowed', moveSpeedPct: -0.9, expiresAtTick: 100 });
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);
    expect(effectiveMoveSpeed(state, ruleset, ship)).toBe(150); // 17 -> 150
  });

  it('clamps the submerged Submarine base 100 up to the 150 engine minimum', () => {
    // H00W umvs = 100 < default min clamp 150 — preserved engine quirk
    // (SEMANTICS §3; hinges on the absent war3mapMisc.txt, flagged open).
    const sub = makeShip(10, 2, 'south', 'H00W', 0, 0);
    const state = makeState([sub], [makePlayer(2, 'south', 10)]);
    expect(effectiveMoveSpeed(state, ruleset, sub)).toBe(150);
  });

  it('ensnared pins speed to 0 regardless of sails', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.statuses.push({ kind: 'ensnared', expiresAtTick: 100 });
    const state = makeState([ship], [makePlayer(2, 'south', 10, ['I01T'])]);
    expect(effectiveMoveSpeed(state, ruleset, ship)).toBe(0);
  });

  it('does not apply player inventory passives to creeps (h00B stays 220)', () => {
    const creep = makeCreep(10, 0, 'south', 'h00B', 0, 0);
    // The AI empire player owning the creep carries a Propeller — must not leak.
    const state = makeState([creep], [makePlayer(0, 'south', null, ['I01T'])]);
    expect(effectiveMoveSpeed(state, ruleset, creep)).toBe(220);
  });

  it('keeps 0-speed and unknown-type units immobile (min clamp must not mobilize)', () => {
    const immobile = makeCreep(10, 0, 'south', 'testImmobile', 0, 0);
    const unknown = makeCreep(11, 0, 'south', 'NOPE', 0, 0);
    const state = makeState([immobile, unknown]);
    expect(effectiveMoveSpeed(state, ruleset, immobile)).toBe(0);
    expect(effectiveMoveSpeed(state, ruleset, unknown)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Kinematics
// ---------------------------------------------------------------------------

describe('stepMovement kinematics', () => {
  const ruleset = fixtureRuleset();

  it('advances effSpeed/tickRate along the current facing when aligned', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.order = { type: 'move', x: 1000, y: 0 }; // due east, facing already 0
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);

    stepMovement(state, ruleset);
    expect(ship.x).toBeCloseTo(170 / TICK_RATE, 3); // 8.5 (dCos(0) ~ 1 - 4e-6)
    expect(ship.y).toBe(0); // dSin(0) is exactly 0
    expect(ship.facingRad).toBe(0);
    expect(ship.order.type).toBe('move');
  });

  it('snaps onto the order point on arrival and goes idle', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.order = { type: 'move', x: 10, y: 0 };
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);

    stepN(state, ruleset, 2); // step 8.5/tick: tick 1 -> ~8.5, tick 2 arrives
    expect(ship.x).toBe(10);
    expect(ship.y).toBe(0);
    expect(ship.order).toEqual({ type: 'idle' });
  });

  it('attackMove arrival also resolves to idle', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.order = { type: 'attackMove', x: 5, y: 0 };
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);
    stepMovement(state, ruleset);
    expect(ship.x).toBe(5);
    expect(ship.order).toEqual({ type: 'idle' });
  });

  it('pivots in place at the turn cap on a 180-degree reversal, then moves', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0); // facing east
    ship.order = { type: 'move', x: -1000, y: 0 }; // target due west
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);

    // Tick 1: rotates by exactly the cap, translates nothing (|err| > 90 deg).
    stepMovement(state, ruleset);
    expect(ship.facingRad).toBe(-TURN_CAP);
    expect(ship.x).toBe(0);
    expect(ship.y).toBe(0);

    // Ticks 2-4: still pivoting (heading error stays > 90 deg).
    stepN(state, ruleset, 3);
    expect(ship.facingRad).toBeCloseTo(-4 * TURN_CAP, 12);
    expect(ship.x).toBe(0);
    expect(ship.y).toBe(0);

    // Tick 5: error crosses 90 deg — translation starts.
    stepMovement(state, ruleset);
    expect(ship.x).not.toBe(0);

    // Eventually converges onto a westward course.
    stepN(state, ruleset, 25);
    expect(ship.x).toBeLessThan(-50);
  });

  it('moves and turns in the same tick when heading error is within 90 degrees', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0); // facing east
    ship.order = { type: 'move', x: 0, y: 1000 }; // due north: error exactly 90 deg
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);

    stepMovement(state, ruleset);
    expect(ship.facingRad).toBeCloseTo(TURN_CAP, 12); // rotated by the cap
    expect(ship.x).toBeGreaterThan(0); // translated along the NEW facing
    expect(ship.y).toBeGreaterThan(0);
  });

  it('respects a per-type turn rate below the engine cap', () => {
    const creep = makeCreep(10, 0, 'south', 'testSlowTurner', 0, 0);
    creep.order = { type: 'move', x: -1000, y: 0 };
    const state = makeState([creep]);
    stepMovement(state, ruleset);
    expect(creep.facingRad).toBe(-0.1); // min(0.1, cap) = 0.1
  });

  it('attackTarget chases to contact distance and keeps the order', () => {
    const attacker = makeShip(10, 2, 'south', 'H000', 0, 0);
    const target = makeShip(11, 7, 'north', 'H000', 12, 0);
    attacker.order = { type: 'attackTarget', targetId: 11 };
    const state = makeState([attacker, target], [makePlayer(2, 'south', 10), makePlayer(7, 'north', 11)]);

    // stop distance = ucol 5 + ucol 5 = 10; gap is 2 -> advance only 2.
    stepMovement(state, ruleset);
    expect(attacker.x).toBeCloseTo(2, 3);

    stepN(state, ruleset, 3);
    expect(dist(attacker.x, attacker.y, target.x, target.y)).toBeCloseTo(10, 3);
    expect(attacker.order).toEqual({ type: 'attackTarget', targetId: 11 });
  });

  it('attackTarget chase stops at native attack range when the type has attack data', () => {
    const chaser = makeCreep(10, 0, 'south', 'testRangedCreep', 0, 0);
    const target = makeShip(11, 7, 'north', 'H000', 700, 0);
    chaser.order = { type: 'attackTarget', targetId: 11 };
    const state = makeState([chaser, target], [makePlayer(7, 'north', 11)]);

    stepN(state, ruleset, 20);
    expect(dist(chaser.x, chaser.y, target.x, target.y)).toBeCloseTo(600, 2);
    expect(chaser.order).toEqual({ type: 'attackTarget', targetId: 11 });
  });

  it('a ship chase stops at its vestigial native-attack range (ua1r) instead of ramming', () => {
    const spec = ruleset.ships['H000'];
    if (spec) spec.nativeAttackRangeUnits = 1000; // Hpal ua1r (units.json)
    const attacker = makeShip(10, 2, 'south', 'H000', 0, 0);
    const target = makeShip(11, 7, 'north', 'H000', 1500, 0);
    attacker.order = { type: 'attackTarget', targetId: 11 };
    const state = makeState([attacker, target], [makePlayer(2, 'south', 10), makePlayer(7, 'north', 11)]);

    stepN(state, ruleset, 80);
    expect(dist(attacker.x, attacker.y, target.x, target.y)).toBeCloseTo(1000, 2);
    expect(attacker.order).toEqual({ type: 'attackTarget', targetId: 11 });
  });

  it('drops the chase order to idle when the target dies', () => {
    const attacker = makeShip(10, 2, 'south', 'H000', 0, 0);
    const target = makeShip(11, 7, 'north', 'H000', 500, 0);
    attacker.order = { type: 'attackTarget', targetId: 11 };
    const state = makeState([attacker, target], [makePlayer(2, 'south', 10), makePlayer(7, 'north', 11)]);

    target.dead = true;
    stepMovement(state, ruleset);
    expect(attacker.order).toEqual({ type: 'idle' });
  });

  it('hold and idle orders never move or rotate the unit', () => {
    const holder = makeShip(10, 2, 'south', 'H000', 30, 40);
    holder.order = { type: 'hold' };
    holder.facingRad = 1.25;
    const idler = makeShip(11, 3, 'south', 'H000', -30, -40);
    const state = makeState([holder, idler], [makePlayer(2, 'south', 10), makePlayer(3, 'south', 11)]);

    stepN(state, ruleset, 5);
    expect([holder.x, holder.y, holder.facingRad]).toEqual([30, 40, 1.25]);
    expect([idler.x, idler.y, idler.facingRad]).toEqual([-30, -40, 0]);
  });
});

// ---------------------------------------------------------------------------
// Skip conditions (paused / stunned / casting / dead)
// ---------------------------------------------------------------------------

describe('movement locks', () => {
  const ruleset = fixtureRuleset();

  it('a paused ship neither moves nor rotates despite a pending order', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.order = { type: 'move', x: 1000, y: 0 };
    ship.pausedUntilTick = 100;
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);

    stepN(state, ruleset, 10);
    expect([ship.x, ship.y, ship.facingRad]).toEqual([0, 0, 0]);
    expect(ship.order).toEqual({ type: 'move', x: 1000, y: 0 }); // order preserved
  });

  it('a paused ship resumes movement once the pause expires', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.order = { type: 'move', x: 1000, y: 0 };
    ship.pausedUntilTick = 1;
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);

    stepMovement(state, ruleset); // tick 0: 1 > 0 -> locked
    expect(ship.x).toBe(0);
    state.tick = 1; // 1 > 1 is false -> free
    stepMovement(state, ruleset);
    expect(ship.x).toBeGreaterThan(0);
  });

  it('stunned and casting units are frozen; expired stuns release', () => {
    const stunned = makeShip(10, 2, 'south', 'H000', 0, 0);
    stunned.order = { type: 'move', x: 1000, y: 0 };
    stunned.statuses.push({ kind: 'stunned', expiresAtTick: 3 });
    const casting = makeShip(11, 3, 'south', 'H000', 0, 200);
    casting.order = { type: 'move', x: 1000, y: 200 };
    casting.casting = {
      abilityOrItemId: 'I026',
      slot: 0,
      targetId: null,
      x: null,
      y: null,
      completesAtTick: 70,
    };
    const state = makeState([stunned, casting], [makePlayer(2, 'south', 10), makePlayer(3, 'south', 11)]);

    stepMovement(state, ruleset);
    expect(stunned.x).toBe(0);
    expect(casting.x).toBe(0);

    state.tick = 3; // stun expiry reached -> released; cast still in progress
    stepMovement(state, ruleset);
    expect(stunned.x).toBeGreaterThan(0);
    expect(casting.x).toBe(0);
  });

  it('dead entities are skipped entirely', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.order = { type: 'move', x: 1000, y: 0 };
    ship.dead = true;
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);
    stepMovement(state, ruleset);
    expect(ship.x).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Collision pushout + map bounds
// ---------------------------------------------------------------------------

describe('collision and bounds', () => {
  const ruleset = fixtureRuleset();

  it('splits the overlap equally between two mobile ships', () => {
    const a = makeShip(10, 2, 'south', 'H000', 0, 0);
    const b = makeShip(11, 3, 'south', 'H000', 6, 0);
    const state = makeState([a, b], [makePlayer(2, 'south', 10), makePlayer(3, 'south', 11)]);

    // radii 5+5, centers 6 apart -> overlap 4, half each (exact arithmetic).
    stepMovement(state, ruleset);
    expect(a.x).toBe(-2);
    expect(b.x).toBe(8);
    expect(a.y).toBe(0);
    expect(b.y).toBe(0);
  });

  it('separates coincident centers deterministically along +x by id order', () => {
    const a = makeShip(10, 2, 'south', 'H000', 100, 100);
    const b = makeShip(11, 3, 'south', 'H000', 100, 100);
    const state = makeState([a, b], [makePlayer(2, 'south', 10), makePlayer(3, 'south', 11)]);

    stepMovement(state, ruleset);
    expect(a.x).toBe(95); // lower id pushed -x
    expect(b.x).toBe(105); // higher id pushed +x
  });

  it('an immobile (paused) ship absorbs no pushout — the mobile one takes it all', () => {
    const mobile = makeShip(10, 2, 'south', 'H000', 0, 0);
    const paused = makeShip(11, 3, 'south', 'H000', 6, 0);
    paused.pausedUntilTick = 100;
    const state = makeState([mobile, paused], [makePlayer(2, 'south', 10), makePlayer(3, 'south', 11)]);

    stepMovement(state, ruleset);
    expect(mobile.x).toBe(-4); // full overlap of 4
    expect(paused.x).toBe(6);
  });

  it('structures are immovable obstacles', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const tower = makeStructure(11, 'testTower', 30, 0); // fixture radius 30
    const state = makeState([ship, tower], [makePlayer(2, 'south', 10)]);

    // overlap = (5 + 30) - 30 = 5, all on the ship, pushed away from the tower.
    stepMovement(state, ruleset);
    expect(ship.x).toBe(-5);
    expect(tower.x).toBe(30);
  });

  it('wards never collide', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const ward = makeWard(11, 2, 'south', 0, 0);
    const state = makeState([ship, ward], [makePlayer(2, 'south', 10)]);
    stepMovement(state, ruleset);
    expect([ship.x, ship.y]).toEqual([0, 0]);
    expect([ward.x, ward.y]).toEqual([0, 0]);
  });

  it('dead bodies do not push', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    const corpse = makeShip(11, 3, 'south', 'H000', 4, 0);
    corpse.dead = true;
    const state = makeState([ship, corpse], [makePlayer(2, 'south', 10), makePlayer(3, 'south', 11)]);
    stepMovement(state, ruleset);
    expect(ship.x).toBe(0);
  });

  it('clamps movement to the playable map bounds', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 5310, 0);
    ship.order = { type: 'move', x: 6000, y: 0 }; // beyond maxX 5312
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);
    stepMovement(state, ruleset);
    expect(ship.x).toBe(5312);
  });

  it('clamps pushout displacement to the bounds as well', () => {
    const a = makeShip(10, 2, 'south', 'H000', 5307, 0);
    const b = makeShip(11, 3, 'south', 'H000', 5312, 0); // on the east edge
    const state = makeState([a, b], [makePlayer(2, 'south', 10), makePlayer(3, 'south', 11)]);
    stepMovement(state, ruleset);
    expect(a.x).toBe(5304.5);
    expect(b.x).toBe(5312); // 5314.5 clamped back to maxX
  });
});

// ---------------------------------------------------------------------------
// Determinism & mutation discipline
// ---------------------------------------------------------------------------

describe('determinism and ownership', () => {
  const ruleset = fixtureRuleset();

  function busyState(): SimState {
    const a = makeShip(10, 2, 'south', 'H000', 0, 0);
    a.order = { type: 'move', x: 300, y: 120 };
    const b = makeShip(11, 7, 'north', 'H005', 40, 5);
    b.order = { type: 'attackTarget', targetId: 10 };
    const c = makeCreep(12, 0, 'south', 'h00B', 35, -3);
    c.order = { type: 'move', x: -200, y: -200 };
    const tower = makeStructure(13, 'testTower', 60, 10);
    return makeState(
      [a, b, c, tower],
      [makePlayer(2, 'south', 10, ['I008']), makePlayer(7, 'north', 11)],
    );
  }

  it('replays bit-identically on a structural clone (overlapping pushout chain)', () => {
    const s1 = busyState();
    const s2 = JSON.parse(JSON.stringify(s1)) as SimState;
    for (let i = 0; i < 50; i++) {
      stepMovement(s1, ruleset);
      stepMovement(s2, ruleset);
    }
    expect(JSON.stringify(s1.entities)).toBe(JSON.stringify(s2.entities));
  });

  it('draws no RNG and emits no events while stepping', () => {
    const state = busyState();
    const rngBefore = state.rngState;
    stepN(state, ruleset, 20);
    expect(state.rngState).toBe(rngBefore); // adding a draw is replay-breaking
    expect(state.events).toEqual([]);
  });

  it('never touches hp, statuses, gold, or inventory', () => {
    const state = busyState();
    const ship = state.entities[10] as ShipEntity;
    ship.statuses.push({ kind: 'slowed', moveSpeedPct: -0.3, expiresAtTick: 9 });
    const player = state.players[2];
    const snapshot = JSON.stringify({
      hp: ship.hp,
      maxHp: ship.maxHp,
      statuses: ship.statuses,
      gold: player?.gold,
      lumber: player?.lumber,
      inventory: player?.inventory,
    });

    stepN(state, ruleset, 20);
    expect(
      JSON.stringify({
        hp: ship.hp,
        maxHp: ship.maxHp,
        statuses: ship.statuses,
        gold: player?.gold,
        lumber: player?.lumber,
        inventory: player?.inventory,
      }),
    ).toBe(snapshot);
  });

  it('invisibility statuses survive move orders (move/stop never break invis)', () => {
    const ship = makeShip(10, 2, 'south', 'H000', 0, 0);
    ship.statuses.push({ kind: 'invisible', buffId: 'BIv1', expiresAtTick: 200, breaksOnAction: true });
    ship.order = { type: 'move', x: 500, y: 0 };
    const state = makeState([ship], [makePlayer(2, 'south', 10)]);

    applyMovementCommand(state, ruleset, { type: 'move', player: 2, x: 600, y: 0 });
    stepN(state, ruleset, 5);
    applyMovementCommand(state, ruleset, { type: 'stop', player: 2 });
    expect(ship.statuses).toEqual([
      { kind: 'invisible', buffId: 'BIv1', expiresAtTick: 200, breaksOnAction: true },
    ]);
  });
});
