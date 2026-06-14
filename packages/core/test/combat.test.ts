/**
 * Combat module tests. Fixtures are hand-built (other modules' skeletons
 * still throw) but every named balance number is the REAL value from
 * data/json: Acid Bomber I027 (40 dmg / 3 s CD / 700 range / 20 dmg/s DoT
 * for 20 s via BNab), Boulder I010, Sniper I02F, Small Missile warhead I01O
 * (50 dmg / 200 AoE / structures only / no type mult), Underwater Launch
 * I026 (3000 dmg / 3.5 s cast), Captain's Cannon A01Y (40/…/200, 25 s CD,
 * 900 range), Gold Hull I00A (30% AIsr), tower n004 (20+10d2), lane h00B
 * (9+2d8), R001/R005 curves, H000 hero math (225 HP / −1.7 armor).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sim/specials.js', () => ({
  breakInvisibilityOnAction: vi.fn(),
}));

import { Rng } from '../src/index.js';
import {
  applyCombatCommand,
  applyDamage,
  applyHeal,
  castStormBolt,
  dPow,
  stepCombat,
} from '../src/sim/combat.js';
import { breakInvisibilityOnAction } from '../src/sim/specials.js';
import { allocEntityId } from '../src/sim/types.js';
import type {
  CreepEntity,
  DamageInstance,
  DefenseType,
  EquipmentSpec,
  ItemInstance,
  PlayerState,
  Ruleset,
  ShipEntity,
  ShipSpec,
  SimState,
  StructureEntity,
  TargetFilter,
  TeamId,
  UnitTypeSpec,
  WeaponSpec,
} from '../src/sim/types.js';

const breakSpy = vi.mocked(breakInvisibilityOnAction);

// ---------------------------------------------------------------------------
// Ruleset fixture (real data values)
// ---------------------------------------------------------------------------

const filt = (ships: boolean, structures: boolean, heroOnly = false): TargetFilter => ({
  ships,
  structures,
  heroOnly,
});

function defRow(overrides: Partial<Record<DefenseType, number>>): Record<DefenseType, number> {
  return {
    unarmored: 1,
    light: 1,
    medium: 1,
    heavy: 1,
    fortified: 1,
    hero: 1,
    divine: 0.05,
    normal: 1,
    ...overrides,
  };
}

function wpn(
  spec: Partial<WeaponSpec> & Pick<WeaponSpec, 'id' | 'name' | 'mechanic' | 'damage' | 'cooldownTicks'>,
): WeaponSpec {
  return {
    abilityId: null,
    gold: null,
    rangeUnits: null,
    aoeRadius: null,
    projectileSpeedPerTick: null,
    homing: false,
    targets: filt(true, false),
    attackType: 'spells',
    damageType: 'magic',
    noTypeMult: false,
    dot: null,
    buffId: null,
    buffDurationTicks: 0,
    castTimeTicks: 0,
    cooldownGroup: null,
    ...spec,
  };
}

function shipSpec(
  spec: Partial<ShipSpec> & Pick<ShipSpec, 'typeId' | 'maxHp' | 'armor' | 'defenseType'>,
): ShipSpec {
  return {
    name: spec.typeId ?? 'ship',
    gold: 200,
    rawHp: spec.maxHp - 25,
    rawArmor: spec.armor + 1.7,
    moveSpeed: 170,
    turnRateRadPerTick: 0.333,
    collisionRadius: 10,
    inventorySlots: 6,
    isSub: false,
    abilityIds: [],
    // 0 keeps exact-damage assertions clean; spec regen is covered via H00A.
    hpRegenPerTick: 0,
    bounty: { base: 79, dice: 1, sides: 1 },
    sightRadius: 1200,
    detectionRadius: null,
    nativeAttackRangeUnits: null,
    ...spec,
  };
}

function unitType(
  spec: Partial<UnitTypeSpec> & Pick<UnitTypeSpec, 'typeId' | 'maxHp' | 'armor' | 'defenseType'>,
): UnitTypeSpec {
  return {
    name: spec.typeId ?? 'unit',
    attack: null,
    moveSpeed: 0,
    turnRateRadPerTick: 0.333,
    collisionRadius: 48,
    isStructure: true,
    level: 1,
    bounty: { base: 0, dice: 0, sides: 0 },
    hpRegenPerTick: 0,
    sightRadius: 900,
    detectionRadius: null,
    permanentlyInvisible: false,
    invulnerable: false,
    ...spec,
  };
}

function equip(id: string, passives: EquipmentSpec['passives']): EquipmentSpec {
  return {
    id,
    name: id,
    category: 'hull',
    gold: 100,
    passives,
    active: null,
    charges: null,
    perishable: false,
    cooldownGroup: null,
  };
}

function makeRuleset(): Ruleset {
  return {
    name: 'combat-test',
    tickRate: 20,
    constants: {
      startingGold: 750,
      minMoveSpeed: 150,
      maxMoveSpeed: 400,
      turnRateCapRadPerTick: 0.3333,
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
    attackTypeVsDefense: {
      normal: defRow({ medium: 1.5, fortified: 0.7 }),
      pierce: defRow({ unarmored: 1.5, light: 2, medium: 0.75, fortified: 0.35, hero: 0.5 }),
      siege: defRow({ unarmored: 1.5, medium: 0.5, fortified: 1.5, hero: 0.5 }),
      magic: defRow({ light: 1.25, medium: 0.75, heavy: 2, fortified: 0.35, hero: 0.5 }),
      chaos: defRow({}),
      spells: defRow({ hero: 0.7 }),
      hero: defRow({ fortified: 0.5 }),
    },
    weapons: {
      // Acid Bomber: 40 dmg / 3 s / 700 range / 900 speed / non-homing /
      // BNab DoT 20 dmg/s for 20 s (nonLethal).
      I027: wpn({
        id: 'I027',
        name: 'Acid Bomber',
        mechanic: 'phoenixFire',
        gold: 3250,
        damage: 40,
        cooldownTicks: 60,
        rangeUnits: 700,
        projectileSpeedPerTick: 45,
        homing: false,
        dot: { dmgPerTick: 1, durationTicks: 400, buffId: 'BNab', nonLethal: true },
        buffId: 'BNab',
        buffDurationTicks: 400,
      }),
      // Arrow Cannon: 7 dmg / 0.55 s / 625 range / 1000 speed / homing.
      I000: wpn({
        id: 'I000',
        name: 'Arrow Cannon',
        mechanic: 'phoenixFire',
        gold: 160,
        damage: 7,
        cooldownTicks: 11,
        rangeUnits: 625,
        projectileSpeedPerTick: 50,
        homing: true,
        buffId: 'Bpxf',
        buffDurationTicks: 1,
      }),
      // Boulder Cannon: 100 dmg / 2 s / 900 range / 1100 speed / non-homing.
      I010: wpn({
        id: 'I010',
        name: 'Boulder Cannon',
        mechanic: 'phoenixFire',
        gold: 1450,
        damage: 100,
        cooldownTicks: 40,
        rangeUnits: 900,
        projectileSpeedPerTick: 55,
        homing: false,
      }),
      // Sniper Crew: 115 dmg / 2.2 s / 2500 range / enemy HERO ships only.
      I02F: wpn({
        id: 'I02F',
        name: 'Sniper Crew',
        mechanic: 'phoenixFire',
        gold: 5100,
        damage: 115,
        cooldownTicks: 44,
        rangeUnits: 2500,
        projectileSpeedPerTick: 80,
        homing: false,
        targets: filt(true, false, true),
      }),
      // Small Missile warhead: 50 dmg / 200 AoE / structures only / physical
      // with NO attack-vs-defense multiplier (Kaboom).
      I01O: wpn({
        id: 'I01O',
        name: 'Small Missile',
        mechanic: 'kaboomMissile',
        gold: 40,
        damage: 50,
        cooldownTicks: 40,
        aoeRadius: 200,
        projectileSpeedPerTick: 10,
        homing: true,
        targets: filt(false, true),
        attackType: 'siege',
        damageType: 'physical',
        noTypeMult: true,
      }),
      // Underwater Launch: 3000 dmg / 45 s / 1200 range / 750 speed /
      // structures only / 3.5 s wind-up.
      I026: wpn({
        id: 'I026',
        name: 'Underwater Launch',
        mechanic: 'stormBolt',
        gold: 8950,
        damage: 3000,
        cooldownTicks: 900,
        rangeUnits: 1200,
        projectileSpeedPerTick: 37.5,
        homing: true,
        targets: filt(false, true),
        buffId: 'B01D',
        buffDurationTicks: 1,
        castTimeTicks: 70,
      }),
      // Captain's Cannon rank weapons: 40/…/200 dmg, 25 s CD, 900 range.
      'A01Y:1': wpn({
        id: 'A01Y:1',
        name: "Captain's Cannon 1",
        mechanic: 'stormBolt',
        damage: 40,
        cooldownTicks: 500,
        rangeUnits: 900,
        projectileSpeedPerTick: 50,
        homing: true,
        buffId: 'B01D',
        buffDurationTicks: 1,
      }),
      'A01Y:3': wpn({
        id: 'A01Y:3',
        name: "Captain's Cannon 3",
        mechanic: 'stormBolt',
        damage: 104,
        cooldownTicks: 500,
        rangeUnits: 900,
        projectileSpeedPerTick: 50,
        homing: true,
        buffId: 'B01D',
        buffDurationTicks: 1,
      }),
    },
    equipment: {
      // Gold Hull: 30% AIsr reduction, +9 armor. Stone Hull: 10%, +3.
      I00A: equip('I00A', {
        maxHpBonus: 500,
        damageReductionPct: 0.3,
        armorBonus: 9,
        moveSpeedPct: -0.2,
        hpRegenPerTick: 0,
      }),
      I009: equip('I009', {
        maxHpBonus: 100,
        damageReductionPct: 0.1,
        armorBonus: 3,
        moveSpeedPct: -0.05,
        hpRegenPerTick: 0,
      }),
      // Repair Crew 2 HP/s; Kraken shell 20 HP/s + 20% reduction.
      I017: equip('I017', {
        maxHpBonus: 0,
        damageReductionPct: 0,
        armorBonus: 0,
        moveSpeedPct: 0,
        hpRegenPerTick: 0.1,
      }),
      I01X: equip('I01X', {
        maxHpBonus: 0,
        damageReductionPct: 0.2,
        armorBonus: 6,
        moveSpeedPct: 0.3,
        hpRegenPerTick: 1,
      }),
    },
    abilities: {
      A01Y: {
        abilityId: 'A01Y',
        name: "Captain's Cannon",
        kind: 'heroSkill',
        mechanic: 'stormBoltWeapon',
        specialKey: null,
        skill: { abilityId: 'A01Y', ranks: 6, levelsPerRank: 2, minHeroLevel: 1 },
        magnitudePerRank: [40, 72, 104, 136, 168, 200],
        durationTicksPerRank: null,
        cooldownTicks: 500,
        rangeUnits: 900,
        weaponId: 'A01Y',
      },
      // Onboard Mechanics Crew (Arll): HP/s per rank.
      A009: {
        abilityId: 'A009',
        name: 'Onboard Mechanics Crew',
        kind: 'heroSkill',
        mechanic: 'mechanicsRegen',
        specialKey: null,
        skill: { abilityId: 'A009', ranks: 6, levelsPerRank: 2, minHeroLevel: 1 },
        magnitudePerRank: [1, 2, 3, 4, 5, 6],
        durationTicksPerRank: null,
        cooldownTicks: null,
        rangeUnits: null,
        weaponId: null,
      },
      A000: {
        abilityId: 'A000',
        name: 'Basic Cannons',
        kind: 'heroSkill',
        mechanic: 'phoenixFireWeapon',
        specialKey: null,
        skill: { abilityId: 'A000', ranks: 4, levelsPerRank: 2, minHeroLevel: 1 },
        magnitudePerRank: [20, 40, 60, 80],
        durationTicksPerRank: null,
        cooldownTicks: null,
        rangeUnits: 700,
        weaponId: 'I001',
      },
    },
    ships: {
      // H000 starter: 200 raw HP + 25 str = 225; armor 0 − 1.7 = −1.7; hero.
      H000: shipSpec({
        typeId: 'H000',
        maxHp: 225,
        armor: -1.7,
        defenseType: 'hero',
        abilityIds: ['A01Y', 'A009', 'A000'],
      }),
      // H003: 600 + 25 = 625; armor 2 − 1.7 = 0.3.
      H003: shipSpec({ typeId: 'H003', maxHp: 625, armor: 0.3, defenseType: 'hero' }),
      // H00V submarine: 2000 + 25 = 2025; armor 5 − 1.7 = 3.3; FORT defense.
      H00V: shipSpec({
        typeId: 'H00V',
        maxHp: 2025,
        armor: 3.3,
        defenseType: 'fortified',
        isSub: true,
      }),
      // H00A Royal Ship: real uhpr 5.0 HP/s = 0.25/tick base regen.
      H00A: shipSpec({
        typeId: 'H00A',
        maxHp: 9825,
        armor: 5.3,
        defenseType: 'hero',
        hpRegenPerTick: 0.25,
      }),
    },
    unitTypes: {
      // Main Harbor HQ.
      n000: unitType({ typeId: 'n000', maxHp: 20000, armor: 5, defenseType: 'fortified' }),
      // Cannon Tower: 20+10d2 artillery (siege provisional), R001 upgradeable.
      n004: unitType({
        typeId: 'n004',
        maxHp: 6500,
        armor: 5,
        defenseType: 'fortified',
        collisionRadius: 72,
        attack: {
          damageBase: 20,
          damageDice: 10,
          damageSides: 2,
          cooldownTicks: 20,
          rangeUnits: 800,
          attackType: 'siege',
          projectileSpeedPerTick: null,
          targets: filt(true, true),
          upgradeIds: ['R001'],
        },
      }),
      // Imperial lane Battle Ship: 9+2d8 (pierce provisional), R005 dice.
      h00B: unitType({
        typeId: 'h00B',
        maxHp: 400,
        armor: 0,
        defenseType: 'heavy',
        isStructure: false,
        moveSpeed: 200,
        collisionRadius: 20,
        attack: {
          damageBase: 9,
          damageDice: 2,
          damageSides: 8,
          cooldownTicks: 30,
          rangeUnits: 600,
          attackType: 'pierce',
          projectileSpeedPerTick: null,
          targets: filt(true, true),
          upgradeIds: ['R005'],
        },
      }),
      // H003's vestigial Hpal attack (~3 dmg, range 1000).
      H003: unitType({
        typeId: 'H003',
        maxHp: 625,
        armor: 0.3,
        defenseType: 'hero',
        isStructure: false,
        moveSpeed: 230,
        collisionRadius: 12,
        attack: {
          damageBase: 3,
          damageDice: 1,
          damageSides: 1,
          cooldownTicks: 30,
          rangeUnits: 1000,
          attackType: 'hero',
          projectileSpeedPerTick: null,
          targets: filt(true, true),
          upgradeIds: [],
        },
      }),
    },
    upgrades: {
      R001: {
        id: 'R001',
        name: 'Tower Damage',
        maxLevel: 10,
        goldCostPerLevel: [325, 325, 325, 325, 325, 325, 325, 325, 325, 325],
        researchTicks: 3600,
        appliesToUnitTypes: ['n004'],
        effect: { kind: 'flatAttackDamage', perLevel: [40, 10, 10, 10, 10, 10, 10, 10, 10, 10] },
      },
      R005: {
        id: 'R005',
        name: 'Ship Cannons',
        maxLevel: 10,
        goldCostPerLevel: [600, 600, 600, 600, 600, 600, 600, 600, 600, 600],
        researchTicks: 900,
        appliesToUnitTypes: ['h00I', 'h00B', 'h00H', 'h00E', 'h00F', 'h00G'],
        effect: { kind: 'bonusAttackDice', perLevel: [1, 8, 8, 8, 8, 8, 8, 8, 8, 8] },
      },
    },
    shops: {},
    stackRules: [],
    subRules: {
      surfacedTypeId: 'H00V',
      submergedTypeId: 'H00W',
      torpedoItemIds: ['I02N', 'I02O', 'I02P', 'I026'],
      maxTorpedoBaysPerSub: 1,
      bannedItemIds: ['I00C', 'I00D', 'I00E', 'I01H'],
      diveAbilityId: 'A04C',
      diveCooldownTicks: 100,
    },
    missiles: {
      castAbilityId: 'A032',
      lumberItemId: 'I01N',
      throttleTicks: 40,
      warheads: { I01O: { dummyTypeId: 'h00N', weaponId: 'I01O' } },
      targeting: 'randomEnemyLeadPlayerStructure',
      buggfixPeriodTicks: 400,
      buggfixSouthOnly: true,
    },
    suicideQuests: [],
    contracts: {
      lumberCosts: {},
      lumberRefunds: {},
      tradeRoutes: [],
      captainReward: {
        pieceItemId: 'I00R',
        piecesRequired: 5,
        tokenItemId: 'I00U',
        shipTypeId: 'H00J',
        rewardGold: 200,
        rewardXp: 80,
        rewardLumber: 1,
      },
    },
    xp: {
      xpToLevel: [0, 0, 200, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400],
      killXpByVictimLevel: [0, 25, 40, 60, 85, 115, 150],
      heroKillXpByVictimLevel: [0, 100, 120, 160, 220, 300],
      heroKillXpPerLevelAbove: 100,
      shareRadius: 1200,
      summonFactor: 0.5,
      heroLevelCap: 12,
      skillPointsPerLevel: 1,
    },
    respawn: { perLevelSeconds: 2, baseSeconds: 5, randMaxSeconds: 3, invulnerableTicks: 100 },
    income: {
      intervalTicks: 20,
      byHumanCount: { 1: { perHumanSlot: 1, toTeamAi: 1 } },
      requiresNorthHqAlive: true,
      empireShareMinTicks: 1200,
      empireShareMaxTicks: 2400,
      goldDumpPeriodTicks: 1200,
      streetMerchant: {
        rollAtTick: 0,
        spawnAtTick: 0,
        rollMin: 1,
        rollMax: 100,
        threshold: 50,
        merchantTypeId: 'n00X',
      },
    },
    map: {
      bounds: { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 },
      regions: {},
      structures: [],
      playerStarts: {},
      startingShipTypeId: 'H000',
      lanes: [],
      waves: [],
      respawnRegionByTeam: { south: 'rs', north: 'rn' },
      repairBays: [],
      subTeleports: [],
      tempItemRegion: 'tmp',
      streetMerchantRegions: { south: 'ms', north: 'mn' },
    },
  };
}

const ruleset = makeRuleset();

// ---------------------------------------------------------------------------
// State fixture helpers
// ---------------------------------------------------------------------------

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
    slot,
    team,
    control: 'user',
    gold: 0,
    lumber: 0,
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    heroSkillLevels: {},
    shipTypeId,
    shipId: null,
    inventory: [null, null, null, null, null, null],
    cooldownGroups: {},
    missileReadyAtTick: 0,
    respawnAtTick: null,
    goldDumpEnabled: false,
  };
  state.players[slot] = player;
  return player;
}

function addShip(state: SimState, player: PlayerState, x: number, y: number): ShipEntity {
  const spec = ruleset.ships[player.shipTypeId];
  if (!spec) throw new Error(`no ship spec ${player.shipTypeId}`);
  const id = allocEntityId(state);
  const ship: ShipEntity = {
    id,
    typeId: spec.typeId,
    x,
    y,
    facingRad: 0,
    dead: false,
    kind: 'ship',
    owner: player.slot,
    team: player.team,
    hp: spec.maxHp,
    maxHp: spec.maxHp,
    order: { type: 'idle' },
    statuses: [],
    vision: { south: true, north: true },
    attackReadyAtTick: 0,
    casting: null,
    pausedUntilTick: 0,
    invulnerableUntilTick: 0,
    submerged: false,
  };
  state.entities[id] = ship;
  player.shipId = id;
  return ship;
}

function spawnPlayerShip(
  state: SimState,
  slot: number,
  team: TeamId,
  x: number,
  y: number,
  shipTypeId = 'H000',
): { player: PlayerState; ship: ShipEntity } {
  const player = addPlayer(state, slot, team, shipTypeId);
  const ship = addShip(state, player, x, y);
  return { player, ship };
}

function addStructure(
  state: SimState,
  typeId: string,
  owner: number | null,
  team: TeamId | null,
  x: number,
  y: number,
  role: StructureEntity['role'] = 'other',
): StructureEntity {
  const spec = ruleset.unitTypes[typeId];
  if (!spec) throw new Error(`no unit type ${typeId}`);
  const id = allocEntityId(state);
  const s: StructureEntity = {
    id,
    typeId,
    x,
    y,
    facingRad: 0,
    dead: false,
    kind: 'structure',
    owner,
    team,
    instanceKey: `${typeId}@${x},${y}`,
    role,
    hp: spec.maxHp,
    maxHp: spec.maxHp,
    statuses: [],
    attackReadyAtTick: 0,
    shopStock: null,
  };
  state.entities[id] = s;
  return s;
}

function addCreep(
  state: SimState,
  typeId: string,
  owner: number,
  team: TeamId,
  x: number,
  y: number,
): CreepEntity {
  const spec = ruleset.unitTypes[typeId];
  if (!spec) throw new Error(`no unit type ${typeId}`);
  const id = allocEntityId(state);
  const c: CreepEntity = {
    id,
    typeId,
    x,
    y,
    facingRad: 0,
    dead: false,
    kind: 'creep',
    owner,
    team,
    hp: spec.maxHp,
    maxHp: spec.maxHp,
    order: { type: 'attackMove', x, y },
    statuses: [],
    vision: { south: true, north: true },
    attackReadyAtTick: 0,
    laneId: 'lane',
    waypointIndex: 0,
  };
  state.entities[id] = c;
  return c;
}

function item(itemId: string): ItemInstance {
  return { itemId, charges: null, readyAtTick: 0 };
}

function dmg(partial: Partial<DamageInstance> & { amount: number }): DamageInstance {
  return {
    attackType: 'spells',
    damageType: 'magic',
    noTypeMult: false,
    nonLethal: false,
    sourcePlayer: null,
    sourceEntityId: null,
    weaponId: null,
    ...partial,
  };
}

/** Run n stepCombat calls, advancing state.tick after each (sim finalize). */
function runTicks(state: SimState, n: number): void {
  for (let i = 0; i < n; i++) {
    stepCombat(state, ruleset);
    state.tick += 1;
  }
}

function rejections(state: SimState): string[] {
  return state.events.flatMap((e) => (e.type === 'commandRejected' ? [e.reason] : []));
}

const NEG_ARMOR_AMP = 2 - Math.pow(0.94, 1.7); // H000 effective armor −1.7

beforeEach(() => {
  breakSpy.mockClear();
});

// ---------------------------------------------------------------------------
// dPow
// ---------------------------------------------------------------------------

describe('dPow', () => {
  it('matches Math.pow for the armor-amplification domain', () => {
    for (let i = 0; i <= 100; i++) {
      const x = i * 0.1;
      expect(Math.abs(dPow(0.94, x) - Math.pow(0.94, x))).toBeLessThan(1e-9);
    }
    expect(dPow(2, 10)).toBeCloseTo(1024, 6);
    expect(dPow(0.94, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Damage pipeline
// ---------------------------------------------------------------------------

describe('applyDamage pipeline', () => {
  it('spells deal x0.70 vs hero defense (item cannons vs small ships)', () => {
    const state = makeState();
    const { ship } = spawnPlayerShip(state, 7, 'north', 0, 0);
    applyDamage(state, ruleset, ship.id, dmg({ amount: 100, sourcePlayer: 2 }));
    addPlayer(state, 2, 'south');
    expect(ship.hp).toBeCloseTo(225 - 70, 9);
    const hit = state.events.find((e) => e.type === 'hit');
    expect(hit && hit.type === 'hit' && hit.amount).toBeCloseTo(70, 9);
  });

  it('Gold Hull AIsr cuts spell damage 30% after the type multiplier', () => {
    const state = makeState();
    const { player, ship } = spawnPlayerShip(state, 7, 'north', 0, 0);
    player.inventory[0] = item('I00A');
    applyDamage(state, ruleset, ship.id, dmg({ amount: 100 }));
    expect(225 - ship.hp).toBeCloseTo(100 * 0.7 * 0.7, 9); // 49
  });

  it('hull reductions never stack — best single reduction wins', () => {
    const state = makeState();
    const { player, ship } = spawnPlayerShip(state, 7, 'north', 0, 0);
    player.inventory[0] = item('I009'); // 10%
    player.inventory[1] = item('I00A'); // 30%
    applyDamage(state, ruleset, ship.id, dmg({ amount: 100 }));
    expect(225 - ship.hp).toBeCloseTo(49, 9);
  });

  it('magic damage ignores armor VALUE entirely (sub: fort defense, armor 3.3)', () => {
    const state = makeState();
    const { ship } = spawnPlayerShip(state, 7, 'north', 0, 0, 'H00V');
    applyDamage(state, ruleset, ship.id, dmg({ amount: 100 }));
    expect(2025 - ship.hp).toBeCloseTo(100, 9); // spells vs fort = 1.0, armor ignored
  });

  it('physical damage vs negative armor is amplified by 2 - 0.94^(-armor)', () => {
    const state = makeState();
    const { ship } = spawnPlayerShip(state, 7, 'north', 0, 0); // armor −1.7
    applyDamage(
      state,
      ruleset,
      ship.id,
      dmg({ amount: 100, attackType: 'normal', damageType: 'physical' }),
    );
    expect(225 - ship.hp).toBeCloseTo(100 * NEG_ARMOR_AMP, 6); // ~110
  });

  it('physical damage vs positive armor uses (armor*0.06)/(1+armor*0.06), item armor counts', () => {
    const state = makeState();
    const { player, ship } = spawnPlayerShip(state, 7, 'north', 0, 0);
    player.inventory[0] = item('I00A'); // +9 armor -> effective 7.3
    applyDamage(
      state,
      ruleset,
      ship.id,
      dmg({ amount: 100, attackType: 'normal', damageType: 'physical' }),
    );
    const reduction = (7.3 * 0.06) / (1 + 7.3 * 0.06);
    expect(225 - ship.hp).toBeCloseTo(100 * (1 - reduction), 6);
  });

  it('kaboom (noTypeMult) skips the type multiplier but armor value applies', () => {
    const state = makeState();
    const hq = addStructure(state, 'n000', 1, 'north', 0, 0, 'hq');
    applyDamage(
      state,
      ruleset,
      hq.id,
      dmg({ amount: 50, attackType: 'siege', damageType: 'physical', noTypeMult: true }),
    );
    const armorRed = (5 * 0.06) / (1 + 5 * 0.06);
    expect(20000 - hq.hp).toBeCloseTo(50 * (1 - armorRed), 6); // 38.46, NOT x1.5 siege-vs-fort
  });

  it("'true' damage is applied verbatim (suicide bombs)", () => {
    const state = makeState();
    const hq = addStructure(state, 'n000', 1, 'north', 0, 0, 'hq');
    applyDamage(state, ruleset, hq.id, dmg({ amount: 4000, damageType: 'true' }));
    expect(hq.hp).toBe(16000);
  });

  it('invulnerable / paused / shielded targets take nothing', () => {
    const state = makeState();
    const { ship } = spawnPlayerShip(state, 7, 'north', 0, 0);
    ship.invulnerableUntilTick = 10;
    applyDamage(state, ruleset, ship.id, dmg({ amount: 100 }));
    expect(ship.hp).toBe(225);
    expect(state.events).toHaveLength(0);
    ship.invulnerableUntilTick = 0;
    ship.pausedUntilTick = 10;
    applyDamage(state, ruleset, ship.id, dmg({ amount: 100 }));
    expect(ship.hp).toBe(225);
    ship.pausedUntilTick = 0;
    ship.statuses.push({ kind: 'shielded', expiresAtTick: 10 });
    applyDamage(state, ruleset, ship.id, dmg({ amount: 100 }));
    expect(ship.hp).toBe(225);
    state.tick = 10; // everything expired now
    applyDamage(state, ruleset, ship.id, dmg({ amount: 100 }));
    expect(ship.hp).toBeCloseTo(155, 9);
  });

  it('ally damage is dropped when friendlyFire is false (Dont_Attack_Friends)', () => {
    const state = makeState();
    addPlayer(state, 3, 'south');
    const { ship } = spawnPlayerShip(state, 2, 'south', 0, 0);
    applyDamage(state, ruleset, ship.id, dmg({ amount: 100, sourcePlayer: 3 }));
    expect(ship.hp).toBe(225);
    expect(state.events).toHaveLength(0);
    addPlayer(state, 7, 'north');
    applyDamage(state, ruleset, ship.id, dmg({ amount: 100, sourcePlayer: 7 }));
    expect(ship.hp).toBeCloseTo(155, 9);
  });

  it('flags death exactly once and pushes a PendingDeath with killer credit', () => {
    const state = makeState();
    addPlayer(state, 7, 'north');
    const { ship } = spawnPlayerShip(state, 2, 'south', 0, 0);
    applyDamage(
      state,
      ruleset,
      ship.id,
      dmg({ amount: 9999, damageType: 'true', sourcePlayer: 7, sourceEntityId: 42, weaponId: 'I010' }),
    );
    expect(ship.dead).toBe(true);
    expect(state.pendingDeaths).toEqual([
      { entityId: ship.id, victimPlayer: 2, killerPlayer: 7, killerEntityId: 42, scripted: false },
    ]);
    expect(state.events.filter((e) => e.type === 'death')).toHaveLength(1);
    applyDamage(state, ruleset, ship.id, dmg({ amount: 9999, damageType: 'true' })); // no-op on dead
    expect(state.pendingDeaths).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Phoenix Fire
// ---------------------------------------------------------------------------

describe('phoenix fire', () => {
  it('fires at a uniformly rolled candidate (ascending-id list) and sets the instance cooldown', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I027');
    const b = spawnPlayerShip(state, 7, 'north', 300, 0).ship;
    const c = spawnPlayerShip(state, 8, 'north', 300, 60).ship;
    const expectedIdx = Rng.fromState(state.rngState).int(0, 1);
    stepCombat(state, ruleset);
    const projectiles = Object.values(state.projectiles);
    expect(projectiles).toHaveLength(1);
    expect(projectiles[0]?.intendedTargetId).toBe([b.id, c.id][expectedIdx]);
    expect(projectiles[0]?.homingTargetId).toBeNull(); // Acid is non-homing
    expect(player.inventory[0]?.readyAtTick).toBe(60); // 3 s cooldown
    expect(breakSpy).not.toHaveBeenCalled(); // PF is passive: never breaks invis
  });

  it('Acid Bomber BNab buff gates retargeting for 20 s, then re-fires (empty list keeps it ready)', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I027');
    const b = spawnPlayerShip(state, 7, 'north', 300, 0).ship;
    const c = spawnPlayerShip(state, 8, 'north', 300, 60).ship;
    const spawned: { target: number | null; tick: number }[] = [];
    let maxSeen = 0;
    for (let t = 0; t <= 500; t++) {
      stepCombat(state, ruleset);
      for (const key of Object.keys(state.projectiles).map(Number)) {
        if (key > maxSeen) {
          maxSeen = key;
          spawned.push({
            target: state.projectiles[key]?.intendedTargetId ?? null,
            tick: state.tick,
          });
        }
      }
      // While both targets carry BNab the weapon stays ready and draws no RNG.
      if (state.tick === 200) {
        expect(player.inventory[0]?.readyAtTick).toBe(120);
        const rngBefore = state.rngState;
        stepCombat(state, ruleset);
        expect(state.rngState).toBe(rngBefore);
        expect(Object.keys(state.projectiles)).toHaveLength(0);
      }
      // Just before the re-fire: both victims are DoT-clamped at 1 HP, alive.
      if (state.tick === 405) {
        expect(b.hp).toBe(1);
        expect(c.hp).toBe(1);
        expect(b.dead).toBe(false);
        expect(c.dead).toBe(false);
      }
      state.tick += 1;
    }
    expect(spawned).toHaveLength(4);
    const first = spawned[0]?.target;
    const other = first === b.id ? c.id : b.id;
    expect(spawned[1]?.target).toBe(other); // gated off the first victim
    expect(spawned[1]?.tick).toBe(60);
    expect(spawned[2]?.target).toBe(first); // re-fires when the 400-tick buff expires
    expect(spawned[2]?.tick).toBe(406); // shot 1 landed tick 6 -> BNab gone at 406
    expect(spawned[3]?.target).toBe(other); // second victim ungates at 66 + 400
    expect(spawned[3]?.tick).toBe(466);
    // The re-fire DIRECT hits kill the 1-HP victims (only the DoT is
    // non-lethal) — every death was dealt by the ship, never by a DoT tick.
    for (const death of state.pendingDeaths) {
      expect(death.killerEntityId).not.toBeNull();
    }
  });

  it('does not fire beyond rangeUnits and does not consume the cooldown', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I027'); // range 700
    spawnPlayerShip(state, 7, 'north', 700.1, 0);
    const rngBefore = state.rngState;
    stepCombat(state, ruleset);
    expect(Object.keys(state.projectiles)).toHaveLength(0);
    expect(player.inventory[0]?.readyAtTick).toBe(0);
    expect(state.rngState).toBe(rngBefore);
  });

  it('excludes targets not visible to the owner team', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I027');
    const enemy = spawnPlayerShip(state, 7, 'north', 300, 0).ship;
    enemy.vision.south = false;
    const rngBefore = state.rngState;
    stepCombat(state, ruleset);
    expect(Object.keys(state.projectiles)).toHaveLength(0);
    expect(state.rngState).toBe(rngBefore);
  });

  it('sniper (heroOnly) ignores creeps and structures', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I02F');
    addCreep(state, 'h00B', 1, 'north', 200, 0);
    addStructure(state, 'n004', 1, 'north', 300, 0, 'tower');
    const heroShip = spawnPlayerShip(state, 7, 'north', 400, 0).ship;
    // suppress the creep's own attack for isolation
    const creep = Object.values(state.entities).find((e) => e?.kind === 'creep');
    if (creep && creep.kind === 'creep') creep.order = { type: 'move', x: 0, y: 0 };
    stepCombat(state, ruleset);
    const projectiles = Object.values(state.projectiles).filter((p) => p?.weaponId === 'I02F');
    expect(projectiles).toHaveLength(1);
    expect(projectiles[0]?.intendedTargetId).toBe(heroShip.id);
  });

  it('every carried instance runs its own cooldown (two Acid Bombers fire the same tick)', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I027');
    player.inventory[1] = item('I027');
    spawnPlayerShip(state, 7, 'north', 300, 0);
    stepCombat(state, ruleset);
    expect(Object.keys(state.projectiles)).toHaveLength(2);
    expect(player.inventory[0]?.readyAtTick).toBe(60);
    expect(player.inventory[1]?.readyAtTick).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Projectile flight: non-homing whiff, homing lock
// ---------------------------------------------------------------------------

describe('projectiles', () => {
  it('non-homing shot whiffs if the target moved off the launch point', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I010'); // Boulder: non-homing, speed 55/tick
    const enemy = spawnPlayerShip(state, 7, 'north', 500, 0).ship;
    stepCombat(state, ruleset); // launch at (500, 0)
    state.tick += 1;
    enemy.x = 500;
    enemy.y = 100; // > collisionRadius 10 from impact point
    runTicks(state, 12);
    expect(Object.keys(state.projectiles)).toHaveLength(0);
    expect(enemy.hp).toBe(225); // whiffed
  });

  it('non-homing shot hits when the collision circle covers the impact point', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I010');
    const enemy = spawnPlayerShip(state, 7, 'north', 500, 0).ship;
    runTicks(state, 12);
    expect(225 - enemy.hp).toBeCloseTo(100 * 0.7, 9); // spells vs hero
  });

  it('homing shot re-homes onto a moving target and still hits after it goes invisible', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I000'); // Arrow Cannon: homing
    const enemy = spawnPlayerShip(state, 7, 'north', 600, 0).ship;
    stepCombat(state, ruleset); // launch
    state.tick += 1;
    enemy.x = 600;
    enemy.y = 300; // run away
    enemy.vision.south = false; // went invisible post-launch
    runTicks(state, 30);
    expect(Object.keys(state.projectiles)).toHaveLength(0);
    expect(225 - enemy.hp).toBeCloseTo(7 * 0.7, 9);
  });

  it('homing shot fizzles if the target dies mid-flight', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I000');
    const enemy = spawnPlayerShip(state, 7, 'north', 600, 0).ship;
    stepCombat(state, ruleset);
    state.tick += 1;
    expect(Object.keys(state.projectiles)).toHaveLength(1);
    enemy.dead = true;
    const hitsBefore = state.events.filter((e) => e.type === 'hit').length;
    runTicks(state, 30);
    expect(Object.keys(state.projectiles)).toHaveLength(0);
    expect(state.events.filter((e) => e.type === 'hit')).toHaveLength(hitsBefore);
  });
});

// ---------------------------------------------------------------------------
// Storm Bolt (Captain's Cannon, torpedoes)
// ---------------------------------------------------------------------------

describe('storm bolt', () => {
  function cannonState(): {
    state: SimState;
    player: PlayerState;
    ship: ShipEntity;
    enemy: ShipEntity;
  } {
    const state = makeState();
    const { player, ship } = spawnPlayerShip(state, 2, 'south', 0, 0);
    const enemy = spawnPlayerShip(state, 7, 'north', 400, 0).ship;
    return { state, player, ship, enemy };
  }

  it('rejects an unlearned hero-skill cast', () => {
    const { state, enemy } = cannonState();
    applyCombatCommand(state, ruleset, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A01Y',
      targetId: enemy.id,
    });
    expect(rejections(state)).toEqual(['skillNotLearned']);
    expect(Object.keys(state.projectiles)).toHaveLength(0);
  });

  it('rejects phoenixFireWeapon casts (PF is passive)', () => {
    const { state, enemy } = cannonState();
    applyCombatCommand(state, ruleset, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A000',
      targetId: enemy.id,
    });
    expect(rejections(state)).toEqual(['passiveWeapon']);
  });

  it("learned rank fires the rank's weapon, sets the per-skill cooldown, breaks invis", () => {
    const { state, player, ship, enemy } = cannonState();
    player.heroSkillLevels['A01Y'] = 1;
    applyCombatCommand(state, ruleset, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A01Y',
      targetId: enemy.id,
    });
    const projectiles = Object.values(state.projectiles);
    expect(projectiles).toHaveLength(1);
    expect(projectiles[0]?.weaponId).toBe('A01Y:1');
    expect(projectiles[0]?.payload.amount).toBe(40);
    expect(projectiles[0]?.homingTargetId).toBe(enemy.id);
    expect(player.cooldownGroups['A01Y']).toBe(500); // 25 s
    expect(breakSpy).toHaveBeenCalledWith(state, ship.id);
    // immediate re-cast: on cooldown, nothing consumed
    applyCombatCommand(state, ruleset, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A01Y',
      targetId: enemy.id,
    });
    expect(rejections(state)).toEqual(['onCooldown']);
    expect(Object.keys(state.projectiles)).toHaveLength(1);
    // rank 3 resolves the rank-3 weapon (104 dmg)
    player.heroSkillLevels['A01Y'] = 3;
    player.cooldownGroups['A01Y'] = 0;
    applyCombatCommand(state, ruleset, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A01Y',
      targetId: enemy.id,
    });
    const second = Object.values(state.projectiles).find((p) => p?.weaponId === 'A01Y:3');
    expect(second?.payload.amount).toBe(104);
  });

  it('homing bolt cannot miss: impact applies the spell pipeline (x0.70 vs hero)', () => {
    const { state, player, enemy } = cannonState();
    player.heroSkillLevels['A01Y'] = 1;
    applyCombatCommand(state, ruleset, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A01Y',
      targetId: enemy.id,
    });
    runTicks(state, 12);
    expect(225 - enemy.hp).toBeCloseTo(40 * 0.7, 9);
  });

  it('returns false WITHOUT consuming anything on out-of-range', () => {
    const { state, player, enemy } = cannonState();
    player.heroSkillLevels['A01Y'] = 1;
    enemy.x = 1000; // > 900
    applyCombatCommand(state, ruleset, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A01Y',
      targetId: enemy.id,
    });
    expect(rejections(state)).toEqual(['outOfRange']);
    expect(player.cooldownGroups['A01Y']).toBeUndefined();
    expect(Object.keys(state.projectiles)).toHaveLength(0);
  });

  it('requires the target to be visible at cast', () => {
    const { state, ship, enemy } = cannonState();
    enemy.vision.south = false;
    const ok = castStormBolt(state, ruleset, ship.id, 'A01Y:1', enemy.id);
    expect(ok).toBe(false);
    expect(rejections(state)).toEqual(['targetNotVisible']);
  });

  it('I026 wind-up: 3.5 s casting state, launch on completion, fizzle if target died', () => {
    const state = makeState();
    const { ship } = spawnPlayerShip(state, 2, 'south', 0, 0, 'H00V');
    const hq = addStructure(state, 'n000', 1, 'north', 1000, 0, 'hq');
    const ok = castStormBolt(state, ruleset, ship.id, 'I026', hq.id);
    expect(ok).toBe(true);
    expect(ship.casting).toEqual({
      abilityOrItemId: 'I026',
      slot: null,
      targetId: hq.id,
      x: null,
      y: null,
      completesAtTick: 70,
    });
    expect(Object.keys(state.projectiles)).toHaveLength(0);
    runTicks(state, 70); // ticks 0..69: still winding up
    expect(Object.keys(state.projectiles)).toHaveLength(0);
    expect(ship.casting).not.toBeNull();
    runTicks(state, 1); // tick 70: launch
    expect(ship.casting).toBeNull();
    expect(Object.keys(state.projectiles)).toHaveLength(1);
    runTicks(state, 40); // 1000 units at 37.5/tick
    expect(20000 - hq.hp).toBeCloseTo(3000, 9); // spells vs fort 1.0, armor ignored

    // fizzle variant: target dies during the wind-up
    const state2 = makeState();
    const sub2 = spawnPlayerShip(state2, 2, 'south', 0, 0, 'H00V').ship;
    const hq2 = addStructure(state2, 'n000', 1, 'north', 1000, 0, 'hq');
    expect(castStormBolt(state2, ruleset, sub2.id, 'I026', hq2.id)).toBe(true);
    hq2.dead = true;
    runTicks(state2, 71);
    expect(sub2.casting).toBeNull();
    expect(Object.keys(state2.projectiles)).toHaveLength(0);
  });

  it('bolt fizzles if the target dies mid-flight', () => {
    const { state, player, enemy } = cannonState();
    player.heroSkillLevels['A01Y'] = 1;
    applyCombatCommand(state, ruleset, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A01Y',
      targetId: enemy.id,
    });
    enemy.dead = true;
    runTicks(state, 12);
    expect(Object.keys(state.projectiles)).toHaveLength(0);
    expect(state.events.filter((e) => e.type === 'hit')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Kaboom warheads (missile dummies spawned by specials)
// ---------------------------------------------------------------------------

describe('kaboom missiles', () => {
  function launchWarhead(state: SimState, targetId: number): number {
    const id = allocEntityId(state);
    state.projectiles[id] = {
      id,
      ownerPlayer: 2,
      team: 'south',
      sourceEntityId: null,
      weaponId: 'I01O',
      mechanic: 'kaboomMissile',
      x: -100,
      y: 0,
      speedPerTick: 10,
      homingTargetId: targetId,
      targetX: 0,
      targetY: 0,
      intendedTargetId: targetId,
      payload: { amount: 50, attackType: 'siege', damageType: 'physical', noTypeMult: true },
    };
    return id;
  }

  it('splashes 200 AoE with the structures-only filter, armor value applies', () => {
    const state = makeState();
    addPlayer(state, 2, 'south');
    const hq = addStructure(state, 'n000', 1, 'north', 0, 0, 'hq');
    const tower = addStructure(state, 'n004', 1, 'north', 150, 0, 'tower');
    const bystander = spawnPlayerShip(state, 7, 'north', 100, 0).ship;
    tower.attackReadyAtTick = 100000; // keep the tower quiet
    launchWarhead(state, hq.id);
    runTicks(state, 12);
    const expected = 50 * (1 - (5 * 0.06) / (1 + 5 * 0.06)); // 38.46 each
    expect(20000 - hq.hp).toBeCloseTo(expected, 6);
    expect(6500 - tower.hp).toBeCloseTo(expected, 6);
    expect(bystander.hp).toBe(225); // ships filtered out of the blast
    expect(Object.keys(state.projectiles)).toHaveLength(0);
  });

  it('fizzles when the homing structure target dies in flight (no splash)', () => {
    const state = makeState();
    addPlayer(state, 2, 'south');
    const hq = addStructure(state, 'n000', 1, 'north', 0, 0, 'hq');
    const tower = addStructure(state, 'n004', 1, 'north', 150, 0, 'tower');
    tower.attackReadyAtTick = 100000;
    launchWarhead(state, hq.id);
    hq.dead = true;
    runTicks(state, 12);
    expect(Object.keys(state.projectiles)).toHaveLength(0);
    expect(tower.hp).toBe(6500);
  });
});

// ---------------------------------------------------------------------------
// Native attacks
// ---------------------------------------------------------------------------

describe('native attacks', () => {
  it('tower auto-acquires the nearest enemy and rolls 20+10d2 at launch', () => {
    const state = makeState();
    addPlayer(state, 1, 'north');
    const tower = addStructure(state, 'n004', 1, 'north', 0, 0, 'tower');
    const near = spawnPlayerShip(state, 2, 'south', 400, 0).ship;
    const far = spawnPlayerShip(state, 3, 'south', 600, 0).ship;
    const rng = Rng.fromState(state.rngState);
    let roll = 20;
    for (let i = 0; i < 10; i++) roll += rng.int(1, 2);
    const expected = roll * 0.5 * NEG_ARMOR_AMP; // siege vs hero x0.5, armor −1.7
    stepCombat(state, ruleset);
    expect(225 - near.hp).toBeCloseTo(expected, 6);
    expect(far.hp).toBe(225);
    expect(tower.attackReadyAtTick).toBe(20);
  });

  it('R001 adds flat damage (level 2 = +50) read from team upgrades', () => {
    const state = makeState();
    addPlayer(state, 1, 'north');
    state.teams.north.upgrades['R001'] = 2;
    addStructure(state, 'n004', 1, 'north', 0, 0, 'tower');
    const target = spawnPlayerShip(state, 2, 'south', 400, 0).ship;
    const rng = Rng.fromState(state.rngState);
    let roll = 20 + 50;
    for (let i = 0; i < 10; i++) roll += rng.int(1, 2);
    stepCombat(state, ruleset);
    expect(225 - target.hp).toBeCloseTo(roll * 0.5 * NEG_ARMOR_AMP, 6);
  });

  it('R005 adds bonus dice (level 2 = +9d) rolled per-die with the unit sides', () => {
    const state = makeState();
    addPlayer(state, 1, 'north');
    state.teams.north.upgrades['R005'] = 2;
    addCreep(state, 'h00B', 1, 'north', 0, 0);
    const target = spawnPlayerShip(state, 2, 'south', 400, 0).ship;
    const rng = Rng.fromState(state.rngState);
    let roll = 9;
    for (let i = 0; i < 2 + 9; i++) roll += rng.int(1, 8);
    stepCombat(state, ruleset);
    expect(225 - target.hp).toBeCloseTo(roll * 0.5 * NEG_ARMOR_AMP, 6); // pierce vs hero x0.5
  });

  it("a 'move' order suppresses auto-acquire; attackTarget on an ally never fires", () => {
    const state = makeState();
    addPlayer(state, 1, 'north');
    const creep = addCreep(state, 'h00B', 1, 'north', 0, 0);
    const enemy = spawnPlayerShip(state, 2, 'south', 400, 0).ship;
    const ally = spawnPlayerShip(state, 7, 'north', 300, 0).ship;
    creep.order = { type: 'move', x: 500, y: 0 };
    const rngBefore = state.rngState;
    stepCombat(state, ruleset);
    expect(enemy.hp).toBe(225);
    expect(state.rngState).toBe(rngBefore);
    state.tick += 1;
    creep.order = { type: 'attackTarget', targetId: ally.id };
    stepCombat(state, ruleset);
    expect(ally.hp).toBe(225);
    expect(state.rngState).toBe(rngBefore);
  });

  it("ship's vestigial attack fires (3+1d1) and breaks invisibility on attack execution", () => {
    const state = makeState();
    const { ship } = spawnPlayerShip(state, 2, 'south', 0, 0, 'H003');
    const enemy = spawnPlayerShip(state, 7, 'north', 500, 0).ship;
    stepCombat(state, ruleset);
    expect(225 - enemy.hp).toBeCloseTo(4 * NEG_ARMOR_AMP, 6); // hero vs hero x1.0
    expect(breakSpy).toHaveBeenCalledWith(state, ship.id);
  });
});

// ---------------------------------------------------------------------------
// Regen / DoT / HoT
// ---------------------------------------------------------------------------

describe('regen and statuses', () => {
  it('sums ship spec + repair crew + Kraken + mechanics-skill regen, capped at maxHp', () => {
    const state = makeState();
    const { player, ship } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I017'); // 2 HP/s = 0.1/tick
    player.inventory[1] = item('I01X'); // 20 HP/s = 1.0/tick
    player.heroSkillLevels['A009'] = 2; // 2 HP/s = 0.1/tick
    ship.hp = 100;
    stepCombat(state, ruleset);
    expect(ship.hp).toBeCloseTo(100 + 0.1 + 1 + 0.1, 12);
    ship.hp = 224.9;
    stepCombat(state, ruleset);
    expect(ship.hp).toBe(225); // capped

    // ship-spec base regen (Royal Ship uhpr 5.0 = 0.25/tick)
    const state2 = makeState();
    const royal = spawnPlayerShip(state2, 3, 'south', 0, 0, 'H00A').ship;
    royal.hp = 100;
    stepCombat(state2, ruleset);
    expect(royal.hp).toBe(100.25);
  });

  it('PF buff DoT is non-lethal: clamps at exactly 1 HP', () => {
    const state = makeState();
    addPlayer(state, 2, 'south'); // enemy of the north creep
    const creep = addCreep(state, 'h00B', 1, 'north', 0, 0);
    creep.hp = 3;
    creep.statuses.push({
      kind: 'dot',
      buffId: 'BNab',
      dmgPerTick: 1,
      expiresAtTick: 1000,
      nonLethal: true,
      sourcePlayer: 2,
    });
    runTicks(state, 10);
    expect(creep.hp).toBe(1);
    expect(creep.dead).toBe(false);
  });

  it('a lethal DoT kills and credits the source player', () => {
    const state = makeState();
    addPlayer(state, 2, 'south');
    const creep = addCreep(state, 'h00B', 1, 'north', 0, 0);
    creep.hp = 3;
    creep.statuses.push({
      kind: 'dot',
      buffId: 'B016',
      dmgPerTick: 5,
      expiresAtTick: 1000,
      nonLethal: false,
      sourcePlayer: 2,
    });
    runTicks(state, 1);
    expect(creep.dead).toBe(true);
    expect(state.pendingDeaths[0]?.killerPlayer).toBe(2);
    expect(state.pendingDeaths[0]?.victimPlayer).toBe(1);
  });

  it("'hot' statuses heal per tick and expire; weaponBuff expires too", () => {
    const state = makeState();
    const creep = addCreep(state, 'h00B', 1, 'north', 0, 0);
    creep.hp = 100;
    creep.statuses.push({ kind: 'hot', buffId: 'B00G', healPerTick: 2, expiresAtTick: 3 });
    creep.statuses.push({ kind: 'weaponBuff', buffId: 'BNab', expiresAtTick: 2 });
    runTicks(state, 5);
    expect(creep.hp).toBe(106); // 3 ticks x 2 HP, then removed
    expect(creep.statuses).toHaveLength(0);
  });

  it('expired timed statuses of every kind are garbage-collected (no unbounded growth)', () => {
    const state = makeState();
    const creep = addCreep(state, 'h00B', 1, 'north', 0, 0);
    creep.statuses.push(
      { kind: 'ensnared', expiresAtTick: 2 },
      { kind: 'stunned', expiresAtTick: 2 },
      { kind: 'silenced', expiresAtTick: 2 },
      { kind: 'slowed', moveSpeedPct: -0.5, expiresAtTick: 2 },
      { kind: 'shielded', expiresAtTick: 2 },
      // Untimed kinds are never collected here.
      { kind: 'speedAura', moveSpeedPct: 0.1, sourceAbilityId: 'R004' },
    );
    runTicks(state, 5);
    expect(creep.statuses).toEqual([
      { kind: 'speedAura', moveSpeedPct: 0.1, sourceAbilityId: 'R004' },
    ]);
  });

  it('DoT impact refreshes (replaces) the same buff instead of stacking', () => {
    const state = makeState();
    const { player } = spawnPlayerShip(state, 2, 'south', 0, 0);
    player.inventory[0] = item('I027');
    player.inventory[1] = item('I027'); // second instance re-hits the same lone target
    const enemy = spawnPlayerShip(state, 7, 'north', 300, 0).ship;
    runTicks(state, 10); // both projectiles land on the only candidate
    const dots = enemy.statuses.filter((s) => s.kind === 'dot');
    expect(dots).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyHeal
// ---------------------------------------------------------------------------

describe('applyHeal', () => {
  it('clamps at maxHp and ignores dead targets', () => {
    const state = makeState();
    const { ship } = spawnPlayerShip(state, 2, 'south', 0, 0);
    ship.hp = 100;
    applyHeal(state, ship.id, 50);
    expect(ship.hp).toBe(150);
    applyHeal(state, ship.id, 99999);
    expect(ship.hp).toBe(225);
    ship.dead = true;
    ship.hp = 0;
    applyHeal(state, ship.id, 50);
    expect(ship.hp).toBe(0);
  });
});
