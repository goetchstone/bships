/**
 * Economy module tests. Cross-module surfaces (combat/specials/progression)
 * are mocked — their skeletons throw and other implementers run
 * concurrently — so these tests pin economy's own behavior only.
 *
 * Balance numbers are the REAL Classic values from data/json (weapons.json
 * gold prices, equipment.json effects, script-rules.json §2 stack rules,
 * map-layout.json income tables). Values that the contract does not name
 * (region rects, fixture hull-skill magnitudes, n00R hp) are fixture-only.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/sim/combat.js', () => ({
  applyCombatCommand: vi.fn(),
  applyDamage: vi.fn(),
  applyHeal: vi.fn(),
  castStormBolt: vi.fn(() => true),
  stepCombat: vi.fn(),
}));
vi.mock('../src/sim/specials.js', () => ({
  applyEquipmentActive: vi.fn(() => true),
  applySpecialsCommand: vi.fn(),
  breakInvisibilityOnAction: vi.fn(),
  recomputeVisibility: vi.fn(),
  stepSpecials: vi.fn(),
}));
vi.mock('../src/sim/progression.js', () => ({
  applyProgressionCommand: vi.fn(),
  grantXp: vi.fn(),
  stepProgression: vi.fn(),
}));

import { applyHeal, castStormBolt } from '../src/sim/combat.js';
import { applyEquipmentActive, breakInvisibilityOnAction } from '../src/sim/specials.js';
import { grantXp } from '../src/sim/progression.js';
import {
  applyEconomyCommand,
  buildShopStock,
  enforceItemRules,
  recomputeShipStats,
  stepEconomy,
} from '../src/sim/economy.js';
import { Rng } from '../src/rng.js';
import type {
  AttackType,
  DefenseType,
  EquipmentPassives,
  EquipmentSpec,
  PlayerState,
  RegionRect,
  Ruleset,
  ShipEntity,
  ShipSpec,
  SimEvent,
  SimState,
  StructureEntity,
  TeamId,
  WeaponSpec,
} from '../src/sim/types.js';

// ---------------------------------------------------------------------------
// Ruleset fixture (Classic values from data/json)
// ---------------------------------------------------------------------------

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

function flatTypeTable(): Record<AttackType, Record<DefenseType, number>> {
  const table = {} as Record<AttackType, Record<DefenseType, number>>;
  for (const attack of ATTACK_TYPES) {
    const row = {} as Record<DefenseType, number>;
    for (const defense of DEFENSE_TYPES) row[defense] = 1;
    table[attack] = row;
  }
  return table;
}

function weapon(id: string, gold: number | null, over: Partial<WeaponSpec> = {}): WeaponSpec {
  return {
    id,
    name: id,
    abilityId: null,
    mechanic: 'phoenixFire',
    gold,
    damage: 0,
    cooldownTicks: 30,
    rangeUnits: 700,
    aoeRadius: null,
    projectileSpeedPerTick: null,
    homing: true,
    targets: { ships: true, structures: false, heroOnly: false },
    attackType: 'spells',
    damageType: 'magic',
    noTypeMult: false,
    dot: null,
    buffId: null,
    buffDurationTicks: 0,
    castTimeTicks: 0,
    cooldownGroup: null,
    ...over,
  };
}

function passives(over: Partial<EquipmentPassives> = {}): EquipmentPassives {
  return {
    maxHpBonus: 0,
    damageReductionPct: 0,
    armorBonus: 0,
    moveSpeedPct: 0,
    hpRegenPerTick: 0,
    ...over,
  };
}

function equip(
  id: string,
  category: EquipmentSpec['category'],
  gold: number | null,
  over: Partial<EquipmentSpec> = {},
): EquipmentSpec {
  return {
    id,
    name: id,
    category,
    gold,
    passives: null,
    active: null,
    charges: null,
    perishable: false,
    cooldownGroup: null,
    ...over,
  };
}

function shipSpec(
  typeId: string,
  gold: number,
  rawHp: number,
  inventorySlots: number,
  over: Partial<ShipSpec> = {},
): ShipSpec {
  return {
    typeId,
    name: typeId,
    gold,
    rawHp,
    rawArmor: 0,
    maxHp: rawHp + 25, // hero math: uhpm + 25*str (str 1)
    armor: -1.7,
    defenseType: 'hero',
    moveSpeed: 170,
    turnRateRadPerTick: 0.333,
    collisionRadius: 10,
    inventorySlots,
    isSub: false,
    abilityIds: [],
    hpRegenPerTick: 0,
    bounty: { base: 79, dice: 1, sides: 1 },
    sightRadius: 1400,
    detectionRadius: null,
    nativeAttackRangeUnits: null,
    ...over,
  };
}

function region(name: string, minX: number, minY: number, maxX: number, maxY: number): RegionRect {
  return { name, minX, minY, maxX, maxY, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 };
}

function makeRuleset(): Ruleset {
  return {
    name: 'classic-test-fixture',
    tickRate: 20,
    constants: {
      startingGold: 200,
      minMoveSpeed: 150,
      maxMoveSpeed: 400,
      turnRateCapRadPerTick: 0.333,
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
    attackTypeVsDefense: flatTypeTable(),
    weapons: {
      I001: weapon('I001', 200, { damage: 20, targets: { ships: true, structures: true, heroOnly: false } }),
      I01O: weapon('I01O', 40, { mechanic: 'kaboomMissile', damage: 50 }),
      I01Y: weapon('I01Y', 18640, { damage: 2000 }),
      I01Z: weapon('I01Z', 19750, { damage: 30 }),
      I02F: weapon('I02F', 5100, { damage: 115, targets: { ships: true, structures: false, heroOnly: true } }),
      I02M: weapon('I02M', 6955, { damage: 157, targets: { ships: true, structures: false, heroOnly: true } }),
      I02N: weapon('I02N', 3325, { mechanic: 'stormBolt', damage: 500, cooldownTicks: 450 }),
      I02O: weapon('I02O', 6750, { mechanic: 'stormBolt', damage: 1000, cooldownTicks: 900 }),
      I02P: weapon('I02P', 16875, { mechanic: 'stormBolt', damage: 2500, cooldownTicks: 900 }),
      I026: weapon('I026', 8950, { mechanic: 'stormBolt', damage: 3000, cooldownTicks: 900, castTimeTicks: 70 }),
    },
    equipment: {
      I009: equip('I009', 'hull', 200, {
        passives: passives({ maxHpBonus: 100, damageReductionPct: 0.1, armorBonus: 3, moveSpeedPct: -0.05 }),
      }),
      I016: equip('I016', 'hull', 1100, {
        passives: passives({ maxHpBonus: 250, damageReductionPct: 0.2, armorBonus: 6, moveSpeedPct: -0.1 }),
      }),
      I00A: equip('I00A', 'hull', 2500, {
        passives: passives({ maxHpBonus: 500, damageReductionPct: 0.3, armorBonus: 9, moveSpeedPct: -0.2 }),
      }),
      I01X: equip('I01X', 'hull', 6600, {
        passives: passives({ hpRegenPerTick: 1, damageReductionPct: 0.2, armorBonus: 6, moveSpeedPct: 0.3 }),
      }),
      I007: equip('I007', 'sail', 100, { passives: passives({ moveSpeedPct: 0.1 }) }),
      I008: equip('I008', 'sail', 610, { passives: passives({ moveSpeedPct: 0.25 }) }),
      I017: equip('I017', 'repair', 145, { passives: passives({ hpRegenPerTick: 0.1 }) }),
      I00B: equip('I00B', 'repair', 720, { passives: passives({ hpRegenPerTick: 0.5 }) }),
      I00C: equip('I00C', 'repair', 175, {
        active: { kind: 'instantHeal', amount: 300, cooldownTicks: 900 },
      }),
      I00D: equip('I00D', 'repair', 765, {
        active: { kind: 'instantHeal', amount: 1500, cooldownTicks: 1600 },
      }),
      I00T: equip('I00T', 'repair', 1250, {
        charges: 1,
        perishable: true,
        active: { kind: 'rejuvenation', totalHeal: 20000, durationTicks: 400, rangeUnits: 100, buffId: 'B00G' },
      }),
      I01J: equip('I01J', 'repair', 2, {
        charges: 1,
        perishable: true,
        active: { kind: 'rejuvenation', totalHeal: 2500, durationTicks: 400, rangeUnits: 100, buffId: 'B00G' },
      }),
      I01K: equip('I01K', 'utility', 1600, {
        active: { kind: 'invisibility', durationTicks: 200, cooldownTicks: 1400, buffId: 'B00I' },
      }),
      I021: equip('I021', 'utility', 400, {
        charges: 1,
        cooldownGroup: 'Aeye',
        active: { kind: 'summonWard', wardTypeId: 'wardSentry', durationTicks: 10800, cooldownTicks: 0 },
      }),
      I01E: equip('I01E', 'utility', 1000),
      texp: equip('texp', 'consumable', null, { charges: 1, active: { kind: 'xpTome', xp: 200 } }),
    },
    abilities: {
      A007: {
        abilityId: 'A007',
        name: 'Enforced Hull',
        kind: 'heroSkill',
        mechanic: 'hullHp',
        specialKey: null,
        skill: { abilityId: 'A007', ranks: 6, levelsPerRank: 2, minHeroLevel: 0 },
        // Fixture magnitudes (mechanism test only; real curve is compiler-owned).
        magnitudePerRank: [100, 200, 300, 400, 500, 600],
        durationTicksPerRank: null,
        cooldownTicks: null,
        rangeUnits: null,
        weaponId: null,
      },
    },
    ships: {
      H000: shipSpec('H000', 200, 200, 6, { abilityIds: ['A007'] }),
      H001: shipSpec('H001', 1000, 750, 6, { detectionRadius: 1200 }),
      H003: shipSpec('H003', 1000, 600, 6),
      H00V: shipSpec('H00V', 6000, 2000, 6, { isSub: true }),
      H00W: shipSpec('H00W', 8500, 1000, 6, { isSub: true }),
      H00D: shipSpec('H00D', 300, 75, 3),
    },
    unitTypes: {
      n00R: {
        typeId: 'n00R',
        name: 'Street Merchant',
        maxHp: 1500, // fixture-only (uhpm not overridden in map data)
        armor: 5,
        defenseType: 'fortified',
        attack: null,
        moveSpeed: 0,
        turnRateRadPerTick: 0,
        collisionRadius: 72,
        isStructure: true,
        level: 1,
        bounty: { base: 0, dice: 0, sides: 0 },
        hpRegenPerTick: 0,
        sightRadius: 900,
        detectionRadius: null,
        permanentlyInvisible: false,
        invulnerable: false,
      },
    },
    upgrades: {},
    shops: {
      n001: {
        structureTypeId: 'n001',
        interactRadius: 400,
        items: [
          { itemId: 'I001', gold: 200, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I009', gold: 200, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I016', gold: 1100, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I00A', gold: 2500, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I01X', gold: 6600, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I008', gold: 610, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I017', gold: 145, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I00C', gold: 175, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I01Y', gold: 18640, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I01Z', gold: 19750, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I02F', gold: 5100, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I02M', gold: 6955, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I02N', gold: 3325, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I02O', gold: 6750, lumberCost: 0, stockMax: null, restockTicks: null },
          { itemId: 'I00T', gold: 1250, lumberCost: 0, stockMax: 1, restockTicks: 24000 },
          { itemId: 'I00S', gold: 0, lumberCost: 4, stockMax: null, restockTicks: null },
          { itemId: 'I01E', gold: 1000, lumberCost: 0, stockMax: null, restockTicks: null },
        ],
        ships: [],
      },
      n002: {
        structureTypeId: 'n002',
        interactRadius: 400,
        items: [],
        ships: [
          { shipTypeId: 'H003', gold: 1000, lumberCost: 0 },
          { shipTypeId: 'H001', gold: 1000, lumberCost: 0 },
          { shipTypeId: 'H00D', gold: 300, lumberCost: 0 },
          { shipTypeId: 'H00V', gold: 6000, lumberCost: 0 },
        ],
      },
      n00R: {
        structureTypeId: 'n00R',
        interactRadius: 400,
        items: [{ itemId: 'I021', gold: 400, lumberCost: 0, stockMax: 1, restockTicks: 600 }],
        ships: [],
      },
    },
    stackRules: [
      { id: 'hull', itemIds: ['I009', 'I016', 'I00A'], maxPerShip: 1, bannedOnShipTypes: ['H001'], exclusiveWithRuleIds: [], onlyInModes: null },
      { id: 'sail', itemIds: ['I008', 'I01A', 'I01U', 'I01V', 'I01T'], maxPerShip: 1, bannedOnShipTypes: [], exclusiveWithRuleIds: [], onlyInModes: null },
      { id: 'repair', itemIds: ['I017', 'I00B', 'I011', 'I01W'], maxPerShip: 1, bannedOnShipTypes: [], exclusiveWithRuleIds: [], onlyInModes: null },
      { id: 'kraken', itemIds: ['I01X'], maxPerShip: 1, bannedOnShipTypes: [], exclusiveWithRuleIds: ['hull', 'sail', 'repair'], onlyInModes: null },
      { id: 'nuke', itemIds: ['I01Y'], maxPerShip: 1, bannedOnShipTypes: [], exclusiveWithRuleIds: [], onlyInModes: null },
      { id: 'vulcan', itemIds: ['I01Z'], maxPerShip: 1, bannedOnShipTypes: [], exclusiveWithRuleIds: [], onlyInModes: null },
      { id: 'sniper', itemIds: ['I02F', 'I02M'], maxPerShip: 1, bannedOnShipTypes: [], exclusiveWithRuleIds: [], onlyInModes: ['OnlySailors'] },
      { id: 'torpedo', itemIds: ['I02N', 'I02O', 'I02P', 'I026'], maxPerShip: 1, bannedOnShipTypes: [], exclusiveWithRuleIds: [], onlyInModes: null },
    ],
    subRules: {
      surfacedTypeId: 'H00V',
      submergedTypeId: 'H00W',
      torpedoItemIds: ['I02N', 'I02O', 'I02P', 'I026'],
      maxTorpedoBaysPerSub: 1,
      // SubAcquiredItems BLACKLIST: repair woods + repair crews + Kraken
      // (war3map.j 9353-9404; matches the real compiled bannedItemIds).
      bannedItemIds: ['I00B', 'I00C', 'I00D', 'I00E', 'I011', 'I017', 'I01H', 'I01W', 'I01X'],
      diveAbilityId: 'A04C',
      diveCooldownTicks: 100,
    },
    missiles: {
      castAbilityId: 'A032',
      lumberItemId: 'I01N',
      throttleTicks: 40,
      warheads: {
        I01O: { dummyTypeId: 'h00N', weaponId: 'I01O' },
      },
      targeting: 'randomEnemyLeadPlayerStructure',
      buggfixPeriodTicks: 400,
      buggfixSouthOnly: true,
    },
    suicideQuests: [],
    contracts: {
      lumberCosts: { I00S: 4, I00W: 10, I00M: 10, I01I: 18, I00Q: 25 },
      lumberRefunds: { I00U: 25, I013: 50, I012: 50, I01E: 80, I02I: 80, I02H: 80 },
      tradeRoutes: [
        {
          contractItemId: 'I00K',
          goodsItemId: 'I00J',
          goodsName: 'Barrel of Ale',
          pickupRegion: 'AleFactory',
          team: null,
          carrierMaxItems: { H00D: 3, H005: 4 },
          deliverRegionByTeam: { south: 'SouthReward', north: 'AleFactory' },
          rewardGold: 200,
          rewardXp: 80,
          rewardLumber: 1,
          rewardBlockOrder: 0,
        },
      ],
      captainReward: {
        pieceItemId: 'I01N',
        piecesRequired: 5,
        tokenItemId: 'I01R',
        shipTypeId: 'H00J',
        rewardGold: 200,
        rewardXp: 80,
        rewardLumber: 1,
      },
    },
    questSystems: {
      refinery: {
        membershipItemId: 'I02Q',
        refineRegion: 'Refinery',
        rewardRegionByTeam: { south: 'SouthReward', north: 'NorthReward' },
        carrierMaxItems: { H00D: 3, H005: 4 },
        refineSwaps: [{ rawGoodId: 'I00J', refinedGoodId: 'I02V' }],
        rewardRoutes: [
          { contractItemId: 'I00K', refinedGoodId: 'I02V', team: null, rewardGold: 300, rewardXp: 80, rewardLumber: 1 },
        ],
        superbombSwaps: [],
      },
      repairMission: {
        contractItemId: 'I01I',
        lumberThreshold: 18,
        tokenRegion: 'GoblinBombShop',
        tokenItemId: 'I01J',
        carrierMaxItems: { H00D: 3, H005: 4 },
        reward: { rewardGold: 700, rewardXp: 300, rewardLumber: 3 },
        refinedVariant: {
          membershipItemId: 'I02Q',
          refineRegion: 'Refinery',
          refinedTokenId: 'I031',
          reward: { rewardGold: 1050, rewardXp: 300, rewardLumber: 3 },
        },
      },
      treasureHunts: {
        contractByTeam: { south: 'I02H', north: 'I02I' },
        treasureItemId: 'I02G',
        carrierShipType: 'H005',
        pickupMaxCarriedItems: 4,
        locationCount: 8,
        seedTick: 7,
        locationRegionsByNumber: {
          south: { '1': 'AleFactory', '2': 'AleFactory', '3': 'AleFactory', '4': 'AleFactory', '5': 'AleFactory', '6': 'AleFactory', '7': 'AleFactory', '8': 'AleFactory' },
          north: { '1': 'AleFactory', '2': 'AleFactory', '3': 'AleFactory', '4': 'AleFactory', '5': 'AleFactory', '6': 'AleFactory', '7': 'AleFactory', '8': 'AleFactory' },
        },
        rewardRegionByTeam: { south: 'SouthReward', north: 'NorthReward' },
        reward: { rewardGold: 14000, rewardXp: 2500, rewardLumber: 0 },
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
      byHumanCount: {
        1: { perHumanSlot: 5, toTeamAi: 5 },
        2: { perHumanSlot: 5, toTeamAi: 0 },
        3: { perHumanSlot: 3, toTeamAi: 1 },
        4: { perHumanSlot: 2, toTeamAi: 2 },
        5: { perHumanSlot: 2, toTeamAi: 0 },
      },
      requiresNorthHqAlive: true,
      empireShareMinTicks: 1200,
      empireShareMaxTicks: 2400,
      goldDumpPeriodTicks: 300,
      streetMerchant: {
        rollAtTick: 100,
        spawnAtTick: 140,
        rollMin: 1,
        rollMax: 12,
        threshold: 9,
        merchantTypeId: 'n00R',
      },
    },
    map: {
      bounds: { minX: -10000, minY: -10000, maxX: 10000, maxY: 10000 },
      regions: {
        AleFactory: region('AleFactory', 2000, 2000, 2400, 2400),
        SouthReward: region('SouthReward', -3000, -3000, -2600, -2600),
        StreetMerchantSouth: region('StreetMerchantSouth', -1000, -1000, -800, -800),
        StreetMerchantNorth: region('StreetMerchantNorth', 800, 800, 1000, 1000),
      },
      structures: [
        { typeId: 'n001', instanceKey: 'n001_0001', owner: null, x: 0, y: 0, facingDeg: 270, role: 'shop', shopSide: 'south' },
        { typeId: 'n002', instanceKey: 'n002_0002', owner: null, x: 200, y: 0, facingDeg: 270, role: 'shop', shopSide: null },
        { typeId: 'n000', instanceKey: 'n000_0018', owner: 1, x: 0, y: 5000, facingDeg: 270, role: 'hq', shopSide: null },
        { typeId: 'n000', instanceKey: 'n000_0020', owner: 0, x: 0, y: -5000, facingDeg: 270, role: 'hq', shopSide: null },
      ],
      playerStarts: {},
      startingShipTypeId: 'H000',
      lanes: [],
      waves: [],
      respawnRegionByTeam: { south: 'SouthReward', north: 'AleFactory' },
      repairBays: [],
      subTeleports: [],
      tempItemRegion: 'AleFactory',
      streetMerchantRegions: { south: 'StreetMerchantSouth', north: 'StreetMerchantNorth' },
    },
  };
}

// ---------------------------------------------------------------------------
// State fixture
// ---------------------------------------------------------------------------

function makePlayer(slot: number, team: TeamId, control: 'user' | 'computer'): PlayerState {
  return {
    slot,
    team,
    control,
    gold: 0,
    lumber: 0,
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    heroSkillLevels: {},
    shipTypeId: 'H000',
    shipId: null,
    inventory: [null, null, null, null, null, null],
    cooldownGroups: {},
    missileReadyAtTick: 0,
    respawnAtTick: null,
    goldDumpEnabled: false,
  };
}

function makeShipEntity(
  id: number,
  owner: number,
  team: TeamId,
  typeId: string,
  maxHp: number,
  x: number,
  y: number,
): ShipEntity {
  return {
    id,
    typeId,
    kind: 'ship',
    owner,
    team,
    x,
    y,
    facingRad: 0,
    dead: false,
    hp: maxHp,
    maxHp,
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

function makeStructure(
  id: number,
  typeId: string,
  instanceKey: string,
  role: StructureEntity['role'],
  team: TeamId | null,
  owner: number | null,
  x: number,
  y: number,
): StructureEntity {
  return {
    id,
    typeId,
    kind: 'structure',
    owner,
    team,
    instanceKey,
    role,
    x,
    y,
    facingRad: 0,
    dead: false,
    hp: 20000,
    maxHp: 20000,
    statuses: [],
    attackReadyAtTick: 0,
    shopStock: null,
  };
}

const SHOP_ID = 1;
const SHIPYARD_ID = 2;
const NORTH_HQ_ID = 3;
const SOUTH_HQ_ID = 4;
const SHIP_ID = 10;

/**
 * 12 players: slots 0/1 = AI empires; south human slots 2-6 (2,3 occupied),
 * north human slots 7-11 (7,8,9 occupied). Player 2 owns ship H000 #10 at
 * (100, 0) — inside interactRadius 400 of both shops.
 */
function makeState(): SimState {
  const players: Record<number, PlayerState> = {
    0: makePlayer(0, 'south', 'computer'),
    1: makePlayer(1, 'north', 'computer'),
    2: makePlayer(2, 'south', 'user'),
    3: makePlayer(3, 'south', 'user'),
    4: makePlayer(4, 'south', 'computer'),
    5: makePlayer(5, 'south', 'computer'),
    6: makePlayer(6, 'south', 'computer'),
    7: makePlayer(7, 'north', 'user'),
    8: makePlayer(8, 'north', 'user'),
    9: makePlayer(9, 'north', 'user'),
    10: makePlayer(10, 'north', 'computer'),
    11: makePlayer(11, 'north', 'computer'),
  };
  const ship = makeShipEntity(SHIP_ID, 2, 'south', 'H000', 225, 100, 0);
  players[2]!.shipId = SHIP_ID;
  return {
    tick: 0,
    rngState: 42,
    nextEntityId: 100,
    status: { phase: 'playing' },
    enabledModes: [],
    players,
    teams: {
      south: { id: 'south', aiPlayerSlot: 0, upgrades: {}, research: null },
      north: { id: 'north', aiPlayerSlot: 1, upgrades: {}, research: null },
    },
    entities: {
      [SHOP_ID]: makeStructure(SHOP_ID, 'n001', 'n001_0001', 'shop', null, null, 0, 0),
      [SHIPYARD_ID]: makeStructure(SHIPYARD_ID, 'n002', 'n002_0002', 'shop', null, null, 200, 0),
      [NORTH_HQ_ID]: makeStructure(NORTH_HQ_ID, 'n000', 'n000_0018', 'hq', 'north', 1, 0, 5000),
      [SOUTH_HQ_ID]: makeStructure(SOUTH_HQ_ID, 'n000', 'n000_0020', 'hq', 'south', 0, 0, -5000),
      [SHIP_ID]: ship,
    },
    projectiles: {},
    groundItems: {},
    detectionZones: [],
    treasureByTeam: { south: null, north: null },
    pendingDeaths: [],
    events: [],
    timers: {
      nextWaveTick: {},
      nextIncomeTick: 20,
      empireSharePeriodTicks: 1400,
      nextEmpireShareTick: 1400,
      nextGoldDumpTick: 300,
      streetMerchantSpawnTick: null,
    },
  };
}

function shipOf(state: SimState, slot: number): ShipEntity {
  const player = state.players[slot]!;
  const entity = state.entities[player.shipId!]!;
  if (entity.kind !== 'ship') throw new Error('not a ship');
  return entity;
}

function give(state: SimState, slot: number, itemId: string, invSlot: number, charges: number | null = null): void {
  state.players[slot]!.inventory[invSlot] = { itemId, charges, readyAtTick: 0 };
}

/** Swap player 2 onto a different hull type (entity + player records). */
function setShipType(state: SimState, slot: number, typeId: string, maxHp: number): void {
  const player = state.players[slot]!;
  player.shipTypeId = typeId;
  const ship = shipOf(state, slot);
  ship.typeId = typeId;
  ship.maxHp = maxHp;
  ship.hp = maxHp;
}

function eventsOfType<T extends SimEvent['type']>(state: SimState, type: T): Extract<SimEvent, { type: T }>[] {
  return state.events.filter((e) => e.type === type) as Extract<SimEvent, { type: T }>[];
}

function findRollSeed(success: boolean): number {
  for (let seed = 1; seed < 10000; seed++) {
    const roll = Rng.fromState(seed).int(1, 12);
    if (roll > 9 === success) return seed;
  }
  throw new Error('no seed found');
}

let state: SimState;
let ruleset: Ruleset;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(castStormBolt).mockReturnValue(true);
  state = makeState();
  ruleset = makeRuleset();
});

// ---------------------------------------------------------------------------
// buyItem
// ---------------------------------------------------------------------------

describe('buyItem', () => {
  it('charges gold, fills the first free slot, emits purchase', () => {
    state.players[2]!.gold = 500;
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I001' });
    expect(state.players[2]!.gold).toBe(300);
    expect(state.players[2]!.inventory[0]).toEqual({ itemId: 'I001', charges: null, readyAtTick: 0 });
    expect(eventsOfType(state, 'purchase')).toEqual([
      { type: 'purchase', tick: 0, player: 2, itemId: 'I001', shipTypeId: null, gold: 200 },
    ]);
  });

  it('rejects beyond the shop interact radius (Aneu 400)', () => {
    state.players[2]!.gold = 500;
    shipOf(state, 2).x = 401; // dist 401 > 400 from shop at origin
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I001' });
    expect(state.players[2]!.gold).toBe(500);
    expect(state.players[2]!.inventory[0]).toBeNull();
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('outOfRange');
  });

  it('rejects enemy-side shop purchases (Items_Not_Buyable)', () => {
    const enemyShip = makeShipEntity(11, 7, 'north', 'H000', 225, 50, 0);
    state.entities[11] = enemyShip;
    state.players[7]!.shipId = 11;
    state.players[7]!.gold = 500;
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 7, shopId: SHOP_ID, itemId: 'I001' });
    expect(state.players[7]!.gold).toBe(500);
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('enemyShop');
  });

  it('rejects without enough gold and mutates nothing', () => {
    state.players[2]!.gold = 199;
    const before = JSON.stringify({ ...state, events: [] });
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I001' });
    expect(JSON.stringify({ ...state, events: [] })).toBe(before);
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('notEnoughGold');
  });

  it('rejects with a full inventory', () => {
    state.players[2]!.gold = 500;
    for (let i = 0; i < 6; i++) give(state, 2, 'I00C', i);
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I001' });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('inventoryFull');
  });

  it('rejects items the shop does not sell', () => {
    state.players[2]!.gold = 99999;
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I02P' });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('notSoldHere');
  });

  it('tracks stock: second purchase rejected until restock', () => {
    state.players[2]!.gold = 5000;
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I00T' });
    const shop = state.entities[SHOP_ID]!;
    if (shop.kind !== 'structure') throw new Error('not a structure');
    expect(shop.shopStock?.['I00T']).toEqual({ stock: 0, nextRestockTick: 24000 });
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I00T' });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('outOfStock');
    expect(state.players[2]!.gold).toBe(3750);

    // GrandMaster Craftsman restocks after 1200 s = 24000 ticks.
    state.tick = 24000;
    state.timers.nextIncomeTick = 99999;
    state.timers.nextEmpireShareTick = 99999;
    state.timers.nextGoldDumpTick = 99999;
    stepEconomy(state, ruleset);
    expect(shop.shopStock?.['I00T']).toEqual({ stock: 1, nextRestockTick: 48000 });
  });

  it('gates contract items on lumber WITHOUT consuming it (I00S needs 4)', () => {
    state.players[2]!.gold = 100;
    state.players[2]!.lumber = 3;
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I00S' });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('notEnoughLumber');
    expect(state.players[2]!.inventory[0]).toBeNull();

    state.players[2]!.lumber = 4;
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I00S' });
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I00S');
    expect(state.players[2]!.lumber).toBe(4); // threshold only, never deducted
  });

  it('never credits lumber on contract purchases (refunds only return the engine ilum charge)', () => {
    state.players[2]!.gold = 1000;
    state.players[2]!.lumber = 80;
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I01E' });
    expect(state.players[2]!.gold).toBe(0);
    expect(state.players[2]!.lumber).toBe(80); // unchanged — no minting
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I01E');
  });
});

// ---------------------------------------------------------------------------
// sellItem (Classic: no sell-back)
// ---------------------------------------------------------------------------

describe('sellItem', () => {
  it('is rejected while sellbackRate is 0 (no shop carries Asid)', () => {
    give(state, 2, 'I001', 0);
    applyEconomyCommand(state, ruleset, { type: 'sellItem', player: 2, slot: 0 });
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I001');
    expect(state.players[2]!.gold).toBe(0);
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('noSellback');
  });

  it('pays floor(price * rate) when a Balanced ruleset enables it', () => {
    ruleset.constants.sellbackRate = 0.5;
    give(state, 2, 'I001', 0);
    applyEconomyCommand(state, ruleset, { type: 'sellItem', player: 2, slot: 0 });
    expect(state.players[2]!.inventory[0]).toBeNull();
    expect(state.players[2]!.gold).toBe(100);
    expect(eventsOfType(state, 'refund')[0]).toMatchObject({ itemId: 'I001', gold: 100, reason: 'sellback' });
  });
});

// ---------------------------------------------------------------------------
// Stack & class rules (script-rules.json §2)
// ---------------------------------------------------------------------------

describe('enforceItemRules', () => {
  it('refunds a second hull at FULL price (ihtp == igol)', () => {
    state.players[2]!.gold = 1100;
    give(state, 2, 'I009', 0);
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I016' });
    // Charged 1100, then the violating Bronze Hull refunds 1100.
    expect(state.players[2]!.gold).toBe(1100);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I009');
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(eventsOfType(state, 'refund')[0]).toMatchObject({
      itemId: 'I016',
      gold: 1100,
      reason: 'stackCap:hull',
    });
  });

  it('bans hulls on H001 (Only_One_Hull banned ship)', () => {
    setShipType(state, 2, 'H001', 775);
    give(state, 2, 'I009', 0);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[0]).toBeNull();
    expect(state.players[2]!.gold).toBe(200);
    expect(eventsOfType(state, 'refund')[0]?.reason).toBe('banned:hull');
  });

  it('allows ONE sail on submarines (Only_One_Sail has no ship-type ban)', () => {
    setShipType(state, 2, 'H00V', 2025);
    give(state, 2, 'I008', 0);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I008');
    expect(state.players[2]!.gold).toBe(0);

    // The DUPLICATE is still refunded (1-per-ship cap).
    give(state, 2, 'I008', 1);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I008');
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(state.players[2]!.gold).toBe(610);
  });

  it('Kraken is exclusive with hull/sail/repair (later slot loses)', () => {
    state.players[2]!.gold = 0;
    give(state, 2, 'I009', 0);
    give(state, 2, 'I01X', 1);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I009');
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(state.players[2]!.gold).toBe(6600);
    expect(eventsOfType(state, 'refund')[0]?.reason).toBe('exclusive:kraken');

    // Reverse order: the hull arrives second and is the violation.
    state.events.length = 0;
    state.players[2]!.gold = 0;
    state.players[2]!.inventory = [null, null, null, null, null, null];
    give(state, 2, 'I01X', 0);
    give(state, 2, 'I009', 1);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I01X');
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(state.players[2]!.gold).toBe(200);
    expect(eventsOfType(state, 'refund')[0]?.reason).toBe('exclusive:hull');
  });

  it('caps Nuclear Strike at 1 (refund 18640)', () => {
    give(state, 2, 'I01Y', 0);
    give(state, 2, 'I01Y', 1);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(state.players[2]!.gold).toBe(18640);
  });

  it('caps Vulcan Cannon at 1 (refund 19750)', () => {
    give(state, 2, 'I01Z', 0);
    give(state, 2, 'I01Z', 1);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(state.players[2]!.gold).toBe(19750);
  });

  it('does NOT cap snipers outside OnlySailors mode', () => {
    give(state, 2, 'I02F', 0);
    give(state, 2, 'I02M', 1);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I02F');
    expect(state.players[2]!.inventory[1]?.itemId).toBe('I02M');
    expect(state.players[2]!.gold).toBe(0);
  });

  it('caps snipers at 1 while the OnlySailors mode is enabled', () => {
    state.enabledModes = ['OnlySailors'];
    give(state, 2, 'I02F', 0);
    give(state, 2, 'I02M', 1);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I02F');
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(state.players[2]!.gold).toBe(6955);
    expect(eventsOfType(state, 'refund')[0]?.reason).toBe('stackCap:sniper');
  });

  it('refunds the JUST-ACQUIRED item even when it landed in a lower slot', () => {
    // Gold Hull carried in slot 1, slot 0 free: a Stone Hull purchase fills
    // slot 0 — the original triggers refund GetManipulatedItem() (the new
    // Stone Hull), never the previously-carried Gold Hull.
    state.players[2]!.gold = 200;
    give(state, 2, 'I00A', 1);
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I009' });
    expect(state.players[2]!.inventory[0]).toBeNull();
    expect(state.players[2]!.inventory[1]?.itemId).toBe('I00A');
    expect(state.players[2]!.gold).toBe(200); // charged 200, refunded 200
    expect(eventsOfType(state, 'refund')[0]).toMatchObject({
      itemId: 'I009',
      gold: 200,
      reason: 'stackCap:hull',
    });
  });

  it('torpedoes are sub-only (refund 3325 on a surface ship)', () => {
    give(state, 2, 'I02N', 0);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[0]).toBeNull();
    expect(state.players[2]!.gold).toBe(3325);
    expect(eventsOfType(state, 'refund')[0]?.reason).toBe('torpedoSubOnly');
  });

  it('caps torpedo bays at 1 across all four ids on a sub', () => {
    setShipType(state, 2, 'H00V', 2025);
    give(state, 2, 'I02N', 0);
    give(state, 2, 'I02O', 1);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I02N');
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(state.players[2]!.gold).toBe(6750);
    expect(eventsOfType(state, 'refund')[0]?.reason).toBe('torpedoCap');
  });

  it('sub blacklist: cannons KEPT, repair woods/crews and Kraken refunded', () => {
    // war3map.j 9353-9404 — SubAcquiredItems refunds exactly the nine
    // repair/Kraken items; ordinary weapons stay (a sub cannot self-repair).
    setShipType(state, 2, 'H00V', 2025);
    give(state, 2, 'I001', 0); // Basic Cannon — NOT on the blacklist
    give(state, 2, 'I00C', 1); // repair wood — banned
    give(state, 2, 'I017', 2); // Repair Crew — banned
    give(state, 2, 'I01X', 3); // Kraken — banned
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I001');
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(state.players[2]!.inventory[2]).toBeNull();
    expect(state.players[2]!.inventory[3]).toBeNull();
    expect(state.players[2]!.gold).toBe(175 + 145 + 6600);
    expect(eventsOfType(state, 'refund').map((e) => e.reason)).toEqual([
      'subBanned',
      'subBanned',
      'subBanned',
    ]);
  });

  it('refunds items in slots beyond the hull inventory size', () => {
    setShipType(state, 2, 'H00D', 100); // Trade Boat: 3 slots
    give(state, 2, 'I001', 5);
    enforceItemRules(state, ruleset, 2);
    expect(state.players[2]!.inventory[5]).toBeNull();
    expect(state.players[2]!.gold).toBe(200);
    expect(eventsOfType(state, 'refund')[0]?.reason).toBe('noInventorySlot');
  });
});

// ---------------------------------------------------------------------------
// maxHp recompute
// ---------------------------------------------------------------------------

describe('recomputeShipStats', () => {
  it('adds hull HP bonuses on purchase (Stone Hull +100)', () => {
    state.players[2]!.gold = 200;
    applyEconomyCommand(state, ruleset, { type: 'buyItem', player: 2, shopId: SHOP_ID, itemId: 'I009' });
    expect(shipOf(state, 2).maxHp).toBe(325); // 200 + 25 hero + 100 hull
  });

  it('clamps hp when the hull is dropped', () => {
    give(state, 2, 'I009', 0);
    enforceItemRules(state, ruleset, 2);
    const ship = shipOf(state, 2);
    ship.hp = 325;
    applyEconomyCommand(state, ruleset, { type: 'dropItem', player: 2, slot: 0, x: 150, y: 0 });
    expect(ship.maxHp).toBe(225);
    expect(ship.hp).toBe(225);
  });

  it('applies hullHp hero-skill ranks (progression reuses this path)', () => {
    state.players[2]!.heroSkillLevels['A007'] = 2;
    recomputeShipStats(state, ruleset, 2);
    expect(shipOf(state, 2).maxHp).toBe(425); // 225 + rank-2 magnitude 200
  });
});

// ---------------------------------------------------------------------------
// useItem
// ---------------------------------------------------------------------------

describe('useItem', () => {
  it('instant heal routes to combat.applyHeal and starts the cooldown', () => {
    give(state, 2, 'I00C', 0);
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: 2, slot: 0 });
    expect(applyHeal).toHaveBeenCalledWith(state, SHIP_ID, 300);
    expect(state.players[2]!.inventory[0]?.readyAtTick).toBe(900); // 45 s
    expect(eventsOfType(state, 'itemUsed')[0]).toMatchObject({ player: 2, itemId: 'I00C' });
    expect(breakInvisibilityOnAction).toHaveBeenCalledWith(state, SHIP_ID);
  });

  it('rejects while the item cooldown is running', () => {
    give(state, 2, 'I00C', 0);
    state.players[2]!.inventory[0]!.readyAtTick = 50;
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: 2, slot: 0 });
    expect(applyHeal).not.toHaveBeenCalled();
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('itemOnCooldown');
  });

  it('rejects while the item cooldown GROUP is running (icid Aeye)', () => {
    give(state, 2, 'I021', 0, 1);
    state.players[2]!.cooldownGroups['Aeye'] = 50;
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: 2, slot: 0, x: 100, y: 100 });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('groupOnCooldown');
    expect(state.players[2]!.inventory[0]?.charges).toBe(1);
  });

  it('xp tomes route to progression.grantXp and consume the charge', () => {
    give(state, 2, 'texp', 0, 1);
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: 2, slot: 0 });
    expect(grantXp).toHaveBeenCalledWith(state, ruleset, 2, 200, 'tome');
    expect(state.players[2]!.inventory[0]).toBeNull();
  });

  it('storm-bolt torpedoes consume nothing when castStormBolt returns false', () => {
    setShipType(state, 2, 'H00V', 2025);
    give(state, 2, 'I02N', 0);
    vi.mocked(castStormBolt).mockReturnValue(false);
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: 2, slot: 0, targetId: 99 });
    expect(castStormBolt).toHaveBeenCalledWith(state, ruleset, SHIP_ID, 'I02N', 99);
    expect(state.players[2]!.inventory[0]?.readyAtTick).toBe(0);
    expect(eventsOfType(state, 'itemUsed')).toHaveLength(0);
  });

  it('storm-bolt torpedoes start their cooldown on success (22.5 s)', () => {
    setShipType(state, 2, 'H00V', 2025);
    give(state, 2, 'I02N', 0);
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: 2, slot: 0, targetId: 99 });
    expect(state.players[2]!.inventory[0]?.readyAtTick).toBe(450);
    expect(eventsOfType(state, 'itemUsed')[0]?.itemId).toBe('I02N');
  });

  it('rejects a storm-bolt item without a target', () => {
    setShipType(state, 2, 'H00V', 2025);
    give(state, 2, 'I02N', 0);
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: 2, slot: 0 });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('needsTarget');
  });

  it('rejects passive Phoenix-Fire cannons', () => {
    give(state, 2, 'I001', 0);
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: 2, slot: 0 });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('notActivatable');
  });

  it('routes utility actives through specials.applyEquipmentActive', () => {
    give(state, 2, 'I01K', 0);
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: 2, slot: 0 });
    expect(applyEquipmentActive).toHaveBeenCalledWith(
      state,
      ruleset,
      2,
      ruleset.equipment['I01K']!.active,
      undefined,
      undefined,
      undefined,
    );
    expect(state.players[2]!.inventory[0]?.readyAtTick).toBe(1400); // 70 s
    // The invisibility item's own activation must not break its fresh smoke.
    expect(breakInvisibilityOnAction).not.toHaveBeenCalled();
  });

  it('consumes nothing when specials rejects the active (validate-then-mutate)', () => {
    vi.mocked(applyEquipmentActive).mockReturnValueOnce(false);
    give(state, 2, 'I01K', 0);
    applyEconomyCommand(state, ruleset, { type: 'useItem', player: 2, slot: 0 });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('invalidTarget');
    expect(state.players[2]!.inventory[0]?.readyAtTick).toBe(0);
    expect(eventsOfType(state, 'itemUsed')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dropItem / pickupItem
// ---------------------------------------------------------------------------

describe('dropItem & pickupItem', () => {
  it('drops to a ground item with the shared id counter', () => {
    give(state, 2, 'I001', 0);
    applyEconomyCommand(state, ruleset, { type: 'dropItem', player: 2, slot: 0, x: 150, y: 60 });
    expect(state.players[2]!.inventory[0]).toBeNull();
    expect(state.groundItems[100]).toEqual({
      id: 100,
      itemId: 'I001',
      x: 150,
      y: 60,
      charges: null,
      readyAtTick: 0,
    });
    expect(state.nextEntityId).toBe(101);
  });

  it('rejects a drop point beyond reach (no cross-map item teleports)', () => {
    give(state, 2, 'I001', 0);
    applyEconomyCommand(state, ruleset, { type: 'dropItem', player: 2, slot: 0, x: 5000, y: 5000 });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('outOfRange');
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I001');
    expect(Object.keys(state.groundItems)).toHaveLength(0);
  });

  it('destroys perishable trade goods on drop (Goblin Mechanic)', () => {
    give(state, 2, 'I01J', 0, 1);
    applyEconomyCommand(state, ruleset, { type: 'dropItem', player: 2, slot: 0, x: 150, y: 60 });
    expect(state.players[2]!.inventory[0]).toBeNull();
    expect(Object.keys(state.groundItems)).toHaveLength(0);
  });

  it('picks a ground item into the first free slot', () => {
    state.groundItems[50] = { id: 50, itemId: 'I00C', x: 110, y: 0, charges: null, readyAtTick: 0 };
    applyEconomyCommand(state, ruleset, { type: 'pickupItem', player: 2, groundItemId: 50 });
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I00C');
    expect(state.groundItems[50]).toBeUndefined();
  });

  it('rejects pickup of an item beyond reach (no map-wide vacuuming)', () => {
    state.groundItems[50] = { id: 50, itemId: 'I00C', x: 5000, y: 5000, charges: null, readyAtTick: 0 };
    applyEconomyCommand(state, ruleset, { type: 'pickupItem', player: 2, groundItemId: 50 });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('outOfRange');
    expect(state.players[2]!.inventory[0]).toBeNull();
    expect(state.groundItems[50]).toBeDefined();
  });

  it('cooldowns survive a drop/re-pick cycle (no cooldown laundering)', () => {
    give(state, 2, 'I00C', 0);
    state.players[2]!.inventory[0]!.readyAtTick = 900;
    applyEconomyCommand(state, ruleset, { type: 'dropItem', player: 2, slot: 0, x: 120, y: 0 });
    expect(state.groundItems[100]?.readyAtTick).toBe(900);
    applyEconomyCommand(state, ruleset, { type: 'pickupItem', player: 2, groundItemId: 100 });
    expect(state.players[2]!.inventory[0]).toEqual({ itemId: 'I00C', charges: null, readyAtTick: 900 });
  });

  it('rejects pickup with a full inventory', () => {
    for (let i = 0; i < 6; i++) give(state, 2, 'I00C', i);
    state.groundItems[50] = { id: 50, itemId: 'I001', x: 110, y: 0, charges: null, readyAtTick: 0 };
    applyEconomyCommand(state, ruleset, { type: 'pickupItem', player: 2, groundItemId: 50 });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('inventoryFull');
    expect(state.groundItems[50]).toBeDefined();
  });

  it('refunds rule-violating pickups in gold (second Nuke from the ground)', () => {
    give(state, 2, 'I01Y', 0);
    state.groundItems[50] = { id: 50, itemId: 'I01Y', x: 110, y: 0, charges: null, readyAtTick: 0 };
    applyEconomyCommand(state, ruleset, { type: 'pickupItem', player: 2, groundItemId: 50 });
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(state.players[2]!.gold).toBe(18640);
    expect(state.groundItems[50]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buyShip
// ---------------------------------------------------------------------------

describe('buyShip', () => {
  it('swaps the hull in place, charges gold, restores full hp', () => {
    state.players[2]!.gold = 1200;
    applyEconomyCommand(state, ruleset, { type: 'buyShip', player: 2, shopId: SHIPYARD_ID, shipTypeId: 'H003' });
    const ship = shipOf(state, 2);
    expect(state.players[2]!.gold).toBe(200);
    expect(state.players[2]!.shipTypeId).toBe('H003');
    expect(ship.typeId).toBe('H003');
    expect(ship.id).toBe(SHIP_ID); // same entity id across Change_Ship
    expect(ship.maxHp).toBe(625);
    expect(ship.hp).toBe(625);
    expect(eventsOfType(state, 'purchase')[0]).toMatchObject({ shipTypeId: 'H003', itemId: null, gold: 1000 });
  });

  it('inventory transfers across the swap and excess slots refund', () => {
    state.players[2]!.gold = 300;
    give(state, 2, 'I00C', 0);
    give(state, 2, 'I001', 5);
    applyEconomyCommand(state, ruleset, { type: 'buyShip', player: 2, shopId: SHIPYARD_ID, shipTypeId: 'H00D' });
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I00C'); // kept (3 slots)
    expect(state.players[2]!.inventory[5]).toBeNull(); // beyond slot 3 -> refunded
    expect(state.players[2]!.gold).toBe(200);
    expect(eventsOfType(state, 'refund')[0]).toMatchObject({ itemId: 'I001', gold: 200, reason: 'noInventorySlot' });
  });

  it('buying a submarine refunds blacklisted cargo and keeps weapons', () => {
    state.players[2]!.gold = 6000;
    give(state, 2, 'I001', 0); // cannon — subs may carry it
    give(state, 2, 'I00C', 1); // repair wood — sub blacklist
    applyEconomyCommand(state, ruleset, { type: 'buyShip', player: 2, shopId: SHIPYARD_ID, shipTypeId: 'H00V' });
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I001');
    expect(state.players[2]!.inventory[1]).toBeNull();
    expect(state.players[2]!.gold).toBe(175); // 6000 - 6000 + 175 wood refund
    expect(shipOf(state, 2).maxHp).toBe(2025);
  });

  it('strips the permanent dive ghost on a hull purchase (no immortal invisibility)', () => {
    setShipType(state, 2, 'H00W', 1025);
    const ship = shipOf(state, 2);
    ship.submerged = true;
    ship.statuses.push({ kind: 'invisible', buffId: null, expiresAtTick: null, breaksOnAction: false });
    state.players[2]!.gold = 1000;
    applyEconomyCommand(state, ruleset, { type: 'buyShip', player: 2, shopId: SHIPYARD_ID, shipTypeId: 'H003' });
    expect(ship.typeId).toBe('H003');
    expect(ship.submerged).toBe(false);
    expect(ship.statuses.some((s) => s.kind === 'invisible')).toBe(false);
  });

  it('rejects ships the shop does not sell', () => {
    state.players[2]!.gold = 99999;
    applyEconomyCommand(state, ruleset, { type: 'buyShip', player: 2, shopId: SHIPYARD_ID, shipTypeId: 'H000' });
    expect(eventsOfType(state, 'commandRejected')[0]?.reason).toBe('notSoldHere');
    expect(state.players[2]!.shipTypeId).toBe('H000');
  });
});

// ---------------------------------------------------------------------------
// setGoldDump
// ---------------------------------------------------------------------------

describe('setGoldDump', () => {
  it('toggles the opt-in flag', () => {
    applyEconomyCommand(state, ruleset, { type: 'setGoldDump', player: 2, enabled: true });
    expect(state.players[2]!.goldDumpEnabled).toBe(true);
    applyEconomyCommand(state, ruleset, { type: 'setGoldDump', player: 2, enabled: false });
    expect(state.players[2]!.goldDumpEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stepEconomy: income
// ---------------------------------------------------------------------------

describe('income', () => {
  it('pays the byHumanCount row to ALL five slots regardless of occupancy', () => {
    state.tick = 20;
    stepEconomy(state, ruleset);
    // South: 2 occupied human slots -> {perHumanSlot 5, toTeamAi 0}.
    for (const slot of [2, 3, 4, 5, 6]) expect(state.players[slot]!.gold).toBe(5);
    expect(state.players[0]!.gold).toBe(0);
    // North: 3 occupied human slots -> {perHumanSlot 3, toTeamAi 1}.
    for (const slot of [7, 8, 9, 10, 11]) expect(state.players[slot]!.gold).toBe(3);
    expect(state.players[1]!.gold).toBe(1);
    expect(state.timers.nextIncomeTick).toBe(40);
  });

  it('does not pay before the interval elapses', () => {
    state.tick = 19;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.gold).toBe(0);
    expect(state.timers.nextIncomeTick).toBe(20);
  });

  it('north HQ death stops BOTH teams’ income (preserved bug)', () => {
    state.entities[NORTH_HQ_ID]!.dead = true;
    state.tick = 20;
    stepEconomy(state, ruleset);
    for (const slot of [2, 3, 7, 8]) expect(state.players[slot]!.gold).toBe(0);
    expect(state.players[1]!.gold).toBe(0);
  });

  it('south HQ death stops NOTHING (only the north HQ is checked)', () => {
    state.entities[SOUTH_HQ_ID]!.dead = true;
    state.tick = 20;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.gold).toBe(5);
    expect(state.players[7]!.gold).toBe(3);
  });

  it('gates per-team on the OWN HQ when requiresNorthHqAlive is false', () => {
    ruleset.income.requiresNorthHqAlive = false;
    state.entities[SOUTH_HQ_ID]!.dead = true;
    state.tick = 20;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.gold).toBe(0); // south gated on dead south HQ
    expect(state.players[7]!.gold).toBe(3); // north unaffected
  });
});

// ---------------------------------------------------------------------------
// stepEconomy: empire share, gold dump
// ---------------------------------------------------------------------------

describe('empire gold share', () => {
  it('pays each non-AI slot floor(aiGold / humanCount) and zeroes the AI', () => {
    state.tick = 1400;
    state.timers.nextIncomeTick = 99999;
    state.players[0]!.gold = 1003;
    stepEconomy(state, ruleset);
    // South humanCount 2: share = floor(1003 / 2) = 501 to each of 5 slots.
    for (const slot of [2, 3, 4, 5, 6]) expect(state.players[slot]!.gold).toBe(501);
    expect(state.players[0]!.gold).toBe(0); // remainder destroyed, verbatim
    expect(state.timers.nextEmpireShareTick).toBe(1400 + 1400);
  });

  it('skips teams whose AI holds no gold', () => {
    state.tick = 1400;
    state.timers.nextIncomeTick = 99999;
    stepEconomy(state, ruleset);
    for (const slot of [2, 7]) expect(state.players[slot]!.gold).toBe(0);
  });
});

describe('gold dump', () => {
  it('transfers opted-in players’ full gold to the team AI', () => {
    state.tick = 300;
    state.timers.nextIncomeTick = 99999;
    state.players[2]!.gold = 777;
    state.players[2]!.goldDumpEnabled = true;
    state.players[3]!.gold = 500; // not opted in
    stepEconomy(state, ruleset);
    expect(state.players[0]!.gold).toBe(777);
    expect(state.players[2]!.gold).toBe(0);
    expect(state.players[3]!.gold).toBe(500);
    expect(state.timers.nextGoldDumpTick).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// stepEconomy: street merchant
// ---------------------------------------------------------------------------

describe('street merchant', () => {
  it('rolls rollInt(1,12) at rollAtTick and spawns both merchants when > 9', () => {
    state.rngState = findRollSeed(true);
    state.tick = 100;
    state.timers.nextIncomeTick = 99999;
    stepEconomy(state, ruleset);
    expect(state.timers.streetMerchantSpawnTick).toBe(140);
    expect(state.rngState).not.toBe(findRollSeed(true)); // one draw consumed

    state.tick = 140;
    stepEconomy(state, ruleset);
    expect(state.timers.streetMerchantSpawnTick).toBeNull();
    const merchants = Object.values(state.entities).filter((e) => e.typeId === 'n00R');
    expect(merchants).toHaveLength(2);
    const south = merchants.find((e) => e.x === -900 && e.y === -900);
    const north = merchants.find((e) => e.x === 900 && e.y === 900);
    expect(south).toBeDefined();
    expect(north).toBeDefined();
    if (south?.kind !== 'structure') throw new Error('not a structure');
    expect(south.role).toBe('shop');
    expect(south.shopStock).toEqual({ I021: { stock: 1, nextRestockTick: 0 } });
  });

  it('does not spawn when the roll is <= 9', () => {
    state.rngState = findRollSeed(false);
    state.tick = 100;
    state.timers.nextIncomeTick = 99999;
    stepEconomy(state, ruleset);
    expect(state.timers.streetMerchantSpawnTick).toBeNull();
    state.tick = 140;
    stepEconomy(state, ruleset);
    expect(Object.values(state.entities).filter((e) => e.typeId === 'n00R')).toHaveLength(0);
  });

  it('skips the roll when createMatch pre-scheduled the spawn', () => {
    const rngBefore = (state.rngState = findRollSeed(true));
    state.timers.streetMerchantSpawnTick = 140;
    state.tick = 100;
    state.timers.nextIncomeTick = 99999;
    stepEconomy(state, ruleset);
    expect(state.rngState).toBe(rngBefore); // no double draw
    expect(state.timers.streetMerchantSpawnTick).toBe(140);
  });
});

// ---------------------------------------------------------------------------
// stepEconomy: contracts & trade routes
// ---------------------------------------------------------------------------

describe('contracts', () => {
  it('adds the goods item in the pickup region, once, to a contract-carrying trade hull', () => {
    setShipType(state, 2, 'H00D', 100); // Trade Boat (3 slots, <3 items gate)
    give(state, 2, 'I00K', 0); // Ale contract carried
    const ship = shipOf(state, 2);
    ship.x = 2200;
    ship.y = 2200; // inside AleFactory
    state.timers.nextIncomeTick = 99999;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.inventory[1]?.itemId).toBe('I00J');
    expect(eventsOfType(state, 'questProgress')[0]).toMatchObject({ questId: 'trade:I00J', stage: 'pickup' });
    state.events.length = 0;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.inventory.filter((i) => i?.itemId === 'I00J')).toHaveLength(1);
    expect(eventsOfType(state, 'questProgress')).toHaveLength(0);
  });

  it('no goods without the contract item / on an ineligible hull / at 3+ carried items', () => {
    setShipType(state, 2, 'H00D', 100);
    const ship = shipOf(state, 2);
    ship.x = 2200;
    ship.y = 2200;
    state.timers.nextIncomeTick = 99999;
    // No contract carried.
    stepEconomy(state, ruleset);
    expect(state.players[2]!.inventory.some((i) => i?.itemId === 'I00J')).toBe(false);
    // Contract carried but UnitInventoryCount >= 3.
    give(state, 2, 'I00K', 0);
    give(state, 2, 'I00C', 1);
    give(state, 2, 'I00C', 2);
    stepEconomy(state, ruleset);
    expect(state.players[2]!.inventory.some((i) => i?.itemId === 'I00J')).toBe(false);
    // Contract carried on a non-trade hull (H000 not in carrierMaxItems).
    setShipType(state, 2, 'H000', 225);
    state.players[2]!.inventory = [null, null, null, null, null, null];
    give(state, 2, 'I00K', 0);
    stepEconomy(state, ruleset);
    expect(state.players[2]!.inventory.some((i) => i?.itemId === 'I00J')).toBe(false);
  });

  it('pays gold + xp + lumber at the OWN reward zone, removes goods, keeps the contract', () => {
    setShipType(state, 2, 'H00D', 100);
    give(state, 2, 'I00K', 0);
    give(state, 2, 'I00J', 1);
    const ship = shipOf(state, 2);
    ship.x = -2800;
    ship.y = -2800; // inside SouthReward (the south deliver zone)
    state.timers.nextIncomeTick = 99999;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I00K'); // contract kept
    expect(state.players[2]!.inventory[1]).toBeNull(); // goods consumed
    expect(state.players[2]!.gold).toBe(200);
    expect(state.players[2]!.lumber).toBe(1);
    expect(grantXp).toHaveBeenCalledWith(state, ruleset, 2, 80, 'contract:I00J');
    expect(eventsOfType(state, 'questProgress')[0]).toMatchObject({ questId: 'trade:I00J', stage: 'delivered' });
  });

  it('does not pay at the ENEMY team reward zone or without the contract', () => {
    setShipType(state, 2, 'H00D', 100);
    give(state, 2, 'I00K', 0);
    give(state, 2, 'I00J', 1);
    const ship = shipOf(state, 2);
    ship.x = 2200;
    ship.y = 2200; // AleFactory = the NORTH deliver zone in this fixture
    state.timers.nextIncomeTick = 99999;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.gold).toBe(0);
    // Goods without contract at the own zone: nothing.
    state.players[2]!.inventory = [null, null, null, null, null, null];
    give(state, 2, 'I00J', 0);
    ship.x = -2800;
    ship.y = -2800;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.gold).toBe(0);
    expect(state.players[2]!.inventory[0]?.itemId).toBe('I00J');
  });

  it('Captain (H00J) Reward consumes exactly 5 wood pieces, keeps the token, pays 200g/80xp/1 lumber', () => {
    // Trig_*_Captain_Rewards gate GetUnitTypeId == 'H00J' (The Captain).
    setShipType(state, 2, 'H00J', 100);
    for (let i = 0; i < 5; i++) give(state, 2, 'I01N', i);
    give(state, 2, 'I01R', 5);
    const ship = shipOf(state, 2);
    ship.x = -2800;
    ship.y = -2800;
    state.timers.nextIncomeTick = 99999;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.inventory.filter((i) => i?.itemId === 'I01N')).toHaveLength(0);
    expect(state.players[2]!.inventory[5]?.itemId).toBe('I01R'); // token kept
    expect(state.players[2]!.gold).toBe(200);
    expect(state.players[2]!.lumber).toBe(1);
    expect(grantXp).toHaveBeenCalledWith(state, ruleset, 2, 80, 'contract:captainReward');
  });

  it('does NOT pay a non-Captain hull holding 5 pieces + the token (H00J ship-type gate)', () => {
    // A normal trade hull can never satisfy the GetUnitTypeId == 'H00J' gate;
    // the reward is correctly unreachable without the (out-of-scope) Captain
    // sell-ship subsystem that mints I01N via Chop Wood.
    setShipType(state, 2, 'H00D', 100);
    for (let i = 0; i < 5; i++) give(state, 2, 'I01N', i);
    give(state, 2, 'I01R', 5);
    const ship = shipOf(state, 2);
    ship.x = -2800;
    ship.y = -2800;
    state.timers.nextIncomeTick = 99999;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.gold).toBe(0);
    expect(state.players[2]!.inventory.filter((i) => i?.itemId === 'I01N')).toHaveLength(5);
  });

  it('does nothing with the wrong piece count (exact-5 udg_LumberPieces gate)', () => {
    setShipType(state, 2, 'H00J', 100);
    for (let i = 0; i < 4; i++) give(state, 2, 'I01N', i); // 4 < 5
    give(state, 2, 'I01R', 5);
    const ship = shipOf(state, 2);
    ship.x = -2800;
    ship.y = -2800;
    state.timers.nextIncomeTick = 99999;
    stepEconomy(state, ruleset);
    expect(state.players[2]!.gold).toBe(0);
    expect(state.players[2]!.inventory.filter((i) => i?.itemId === 'I01N')).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// buildShopStock (integrator helper)
// ---------------------------------------------------------------------------

describe('buildShopStock', () => {
  it('seeds limited-stock items only', () => {
    expect(buildShopStock(ruleset, 'n001')).toEqual({ I00T: { stock: 1, nextRestockTick: 0 } });
    expect(buildShopStock(ruleset, 'n002')).toEqual({});
    expect(buildShopStock(ruleset, 'H000')).toBeNull();
  });
});
