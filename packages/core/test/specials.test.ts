/**
 * Specials module tests. Other modules' skeletons throw, so combat
 * (applyDamage/applyHeal) and progression (grantXp) are mocked with minimal
 * deterministic stand-ins; everything else runs against hand-built fixture
 * state and a hand-compiled Ruleset that uses REAL data values wherever the
 * contract names them (warhead payloads, dive stats, quest rewards, ability
 * radii/durations, detector ranges).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DamageInstance,
  Entity,
  ItemInstance,
  PlayerState,
  RegionRect,
  Ruleset,
  ShipEntity,
  ShipSpec,
  SimState,
  StructureEntity,
  SuicideQuestSpec,
  TeamId,
  UnitTypeSpec,
  WardEntity,
} from '../src/sim/types.js';

// ---------------------------------------------------------------------------
// Cross-module mocks (combat + progression are other implementers' modules)
// ---------------------------------------------------------------------------

const recorded = vi.hoisted(() => ({
  damage: [] as { targetId: number; damage: DamageInstance }[],
  heals: [] as { targetId: number; amount: number }[],
  xp: [] as { playerSlot: number; amount: number; reason: string }[],
}));

vi.mock('../src/sim/combat.js', () => ({
  applyDamage: (
    state: SimState,
    _ruleset: Ruleset,
    targetId: number,
    damage: DamageInstance,
  ): void => {
    recorded.damage.push({ targetId, damage });
    const target = state.entities[targetId];
    if (!target || target.dead || target.kind === 'ward') return;
    target.hp -= damage.amount;
    if (target.hp <= 0) target.dead = true;
  },
  applyHeal: (state: SimState, targetId: number, amount: number): void => {
    recorded.heals.push({ targetId, amount });
    const target = state.entities[targetId];
    if (!target || target.dead || target.kind === 'ward') return;
    target.hp = Math.min(target.maxHp, target.hp + amount);
  },
}));

vi.mock('../src/sim/progression.js', () => ({
  grantXp: (
    state: SimState,
    _ruleset: Ruleset,
    playerSlot: number,
    amount: number,
    reason: string,
  ): void => {
    recorded.xp.push({ playerSlot, amount, reason });
    const player = state.players[playerSlot];
    if (player) player.xp += amount;
  },
}));

import {
  applyEquipmentActive,
  applySpecialsCommand,
  breakInvisibilityOnAction,
  recomputeVisibility,
  stepSpecials,
} from '../src/sim/specials.js';
import { stepMovement } from '../src/sim/movement.js';
import { isWater } from '../src/sim/types.js';

beforeEach(() => {
  recorded.damage.length = 0;
  recorded.heals.length = 0;
  recorded.xp.length = 0;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function region(name: string, minX: number, minY: number, maxX: number, maxY: number): RegionRect {
  return { name, minX, minY, maxX, maxY, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 };
}

function shipSpec(typeId: string, over: Partial<ShipSpec>): ShipSpec {
  return {
    typeId,
    name: typeId,
    gold: 0,
    rawHp: 0,
    rawArmor: 0,
    maxHp: 1000,
    armor: 0,
    defenseType: 'hero',
    moveSpeed: 170,
    turnRateRadPerTick: 0.333,
    collisionRadius: 16,
    inventorySlots: 6,
    isSub: false,
    abilityIds: [],
    hpRegenPerTick: 0,
    bounty: { base: 0, dice: 0, sides: 0 },
    sightRadius: 1600,
    detectionRadius: null,
    nativeAttackRangeUnits: null,
    ...over,
  };
}

function unitTypeSpec(typeId: string, over: Partial<UnitTypeSpec>): UnitTypeSpec {
  return {
    typeId,
    name: typeId,
    maxHp: 1000,
    armor: 0,
    defenseType: 'fortified',
    attack: null,
    moveSpeed: 0,
    turnRateRadPerTick: 0.333,
    collisionRadius: 32,
    isStructure: false,
    level: 1,
    bounty: { base: 0, dice: 0, sides: 0 },
    hpRegenPerTick: 0,
    sightRadius: 800,
    detectionRadius: null,
    permanentlyInvisible: false,
    invulnerable: false,
    ...over,
  };
}

const goblinRunQuest: SuicideQuestSpec = {
  id: 'goblinRun',
  shipTypeId: 'H005',
  startItemId: 'I01E',
  requiredItemIds: [],
  unarmedTokenId: 'I01F',
  armedTokenId: 'I01G',
  pickupRegion: 'GoblinBombShop',
  pickupMaxCarriedItems: 4, // JASS UnitInventoryCount < 4
  armForbiddenItemIds: [],
  armRegionByTeam: { south: 'SouthReward', north: 'NorthReward' },
  detonateRegionByTeam: { south: 'North_Main', north: 'South_Main' },
  hqDamage: 4000,
  rewardGold: 8000,
  rewardXp: 1200,
  warnPingTicks: 240,
};

const superbombQuest: SuicideQuestSpec = {
  id: 'superbomb',
  shipTypeId: 'H005',
  startItemId: 'I01E',
  requiredItemIds: ['I02Q'],
  unarmedTokenId: 'I032',
  armedTokenId: 'I02Z',
  pickupRegion: null,
  pickupMaxCarriedItems: null,
  armForbiddenItemIds: ['I01G'],
  armRegionByTeam: { south: 'SouthReward', north: 'NorthReward' },
  detonateRegionByTeam: { south: 'North_Main', north: 'South_Main' },
  hqDamage: 6000,
  rewardGold: 12000,
  rewardXp: 1200,
  warnPingTicks: 240,
};

/** Empty (no-op) lane-nav field — navStepToward returns null, straight-line. */
function stubNavField() {
  return {
    cols: 0,
    rows: 0,
    cellSizeX: 1,
    cellSizeY: 1,
    bounds: { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 },
    goalX: 0,
    goalY: 0,
    dist: new Int32Array(0),
  };
}

function makeRuleset(): Ruleset {
  const attackRow = {
    unarmored: 1,
    light: 1,
    medium: 1,
    heavy: 1,
    fortified: 1,
    hero: 1,
    divine: 1,
    normal: 1,
  };
  return {
    name: 'test',
    tickRate: 20,
    constants: {
      startingGold: 1000,
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
      normal: { ...attackRow },
      pierce: { ...attackRow },
      siege: { ...attackRow },
      magic: { ...attackRow },
      chaos: { ...attackRow },
      spells: { ...attackRow },
      hero: { ...attackRow },
    },
    weapons: {
      // Missile warheads: data/json/weapons.json I01O/I01P/I01Q — Kaboom
      // payloads, physical, armor value applies, NO type multiplier.
      A03P: warheadWeapon('A03P', 50, 200 / 20),
      A03Q: warheadWeapon('A03Q', 250, 300 / 20),
      A03R: warheadWeapon('A03R', 500, 400 / 20),
    },
    equipment: {},
    abilities: {
      // A04C Dive Dive! — AEme, cooldown 5 s (acdn, abilities.json).
      A04C: {
        abilityId: 'A04C',
        name: 'Dive Dive!',
        kind: 'innate',
        mechanic: 'dive',
        specialKey: null,
        skill: null,
        magnitudePerRank: [0],
        durationTicksPerRank: null,
        cooldownTicks: 100,
        rangeUnits: null,
        weaponId: null,
      },
      // A047 Hide — Aivs hero skill, 6 ranks, durations 6..16 s, CD 25 s.
      A047: {
        abilityId: 'A047',
        name: 'Hide',
        kind: 'heroSkill',
        mechanic: 'invisibility',
        specialKey: null,
        skill: { abilityId: 'A047', ranks: 6, levelsPerRank: 2, minHeroLevel: 1 },
        magnitudePerRank: [0, 0, 0, 0, 0, 0],
        durationTicksPerRank: [120, 160, 200, 240, 280, 320],
        cooldownTicks: 500,
        rangeUnits: null,
        weaponId: null,
      },
      // A04D Echo-Location — AIfa area 1500, 30 s, CD 120 s (abilities.json).
      A04D: {
        abilityId: 'A04D',
        name: 'Echo-Location',
        kind: 'innate',
        mechanic: 'flareDetection',
        specialKey: null,
        skill: null,
        magnitudePerRank: [1500],
        durationTicksPerRank: [600],
        cooldownTicks: 2400,
        rangeUnits: null,
        weaponId: null,
      },
      // A01A Capsize — exotic 'special' mechanic, pre-parity stub.
      A01A: {
        abilityId: 'A01A',
        name: 'Capsize',
        kind: 'heroSkill',
        mechanic: 'special',
        specialKey: 'capsize',
        skill: { abilityId: 'A01A', ranks: 6, levelsPerRank: 2, minHeroLevel: 1 },
        magnitudePerRank: [0, 0, 0, 0, 0, 0],
        durationTicksPerRank: null,
        cooldownTicks: 200,
        rangeUnits: 600,
        weaponId: null,
      },
      // A00Y Fishing Net — ANen Ensnare, hero skill rank 1, range 800 (aran),
      // duration 8 s = 160 ticks (ahdu), cooldown 35 s = 700 ticks (acdn).
      A00Y: {
        abilityId: 'A00Y',
        name: 'Fishing Net',
        kind: 'heroSkill',
        mechanic: 'ensnare',
        specialKey: null,
        skill: { abilityId: 'A00Y', ranks: 1, levelsPerRank: 2, minHeroLevel: 5 },
        magnitudePerRank: [],
        durationTicksPerRank: [160],
        cooldownTicks: 700,
        rangeUnits: 800,
        weaponId: null,
      },
      // A009 Onboard Mechanics — passive hero skill, never castable.
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
      // A01D Shore Leave — innate, base Afzy, acdn 0 (no cooldown), usable only
      // inside the OWN Main Harbour region (specials.castShoreLeave).
      A01D: {
        abilityId: 'A01D',
        name: 'Shore Leave',
        kind: 'innate',
        mechanic: 'shoreLeave',
        specialKey: null,
        skill: null,
        magnitudePerRank: [],
        durationTicksPerRank: null,
        cooldownTicks: null,
        rangeUnits: null,
        weaponId: null,
      },
    },
    ships: {
      // Effective hero HP = raw + 25 (ships.json + compile convention).
      H000: shipSpec('H000', { maxHp: 225, moveSpeed: 170, abilityIds: ['A01D'] }),
      H001: shipSpec('H001', {
        maxHp: 775,
        moveSpeed: 250,
        detectionRadius: 1200, // Adtg aran (abilities.json)
        abilityIds: ['A047', 'A01A', 'A00Y'],
      }),
      H005: shipSpec('H005', { maxHp: 100, moveSpeed: 280, inventorySlots: 4 }),
      H00V: shipSpec('H00V', {
        maxHp: 2025,
        moveSpeed: 200,
        isSub: true,
        abilityIds: ['A04C', 'A04D'],
      }),
      H00W: shipSpec('H00W', { maxHp: 1025, moveSpeed: 100, isSub: true, abilityIds: [] }),
    },
    unitTypes: {
      n000: unitTypeSpec('n000', { maxHp: 50000, isStructure: true }),
      n00D: unitTypeSpec('n00D', { maxHp: 5000, isStructure: true }),
      n004: unitTypeSpec('n004', { maxHp: 4000, isStructure: true }),
      // nvil Spy ward: Atru true sight, 1600 sight, invulnerable.
      nvil: unitTypeSpec('nvil', {
        maxHp: 100,
        sightRadius: 1600,
        detectionRadius: 1600,
        invulnerable: true,
      }),
      // ohwd Motion Detector: sight 1, NOT a detector, invisible+invuln.
      ohwd: unitTypeSpec('ohwd', {
        maxHp: 5,
        sightRadius: 1,
        detectionRadius: null,
        permanentlyInvisible: true,
        invulnerable: true,
      }),
      nba2: unitTypeSpec('nba2', { maxHp: 8500, moveSpeed: 140 }),
    },
    upgrades: {},
    shops: {},
    stackRules: [],
    subRules: {
      surfacedTypeId: 'H00V',
      submergedTypeId: 'H00W',
      torpedoItemIds: ['I02N', 'I02O', 'I02P', 'I026'],
      maxTorpedoBaysPerSub: 1,
      bannedItemIds: ['I00B', 'I00C', 'I00D', 'I00E', 'I011', 'I017', 'I01H', 'I01W', 'I01X'],
      diveAbilityId: 'A04C',
      diveCooldownTicks: 100, // 5 s (A04C acdn)
    },
    missiles: {
      castAbilityId: 'A032',
      lumberItemId: 'I01N',
      throttleTicks: 40, // ~2 s scripted throttle
      warheads: {
        I01O: { dummyTypeId: 'h00N', weaponId: 'A03P' },
        I01P: { dummyTypeId: 'h00O', weaponId: 'A03Q' },
        I01Q: { dummyTypeId: 'h00P', weaponId: 'A03R' },
      },
      targeting: 'randomEnemyLeadPlayerStructure',
      buggfixPeriodTicks: 400,
      buggfixSouthOnly: true,
    },
    suicideQuests: [goblinRunQuest, superbombQuest],
    contracts: {
      lumberCosts: {},
      lumberRefunds: {},
      tradeRoutes: [],
      captainReward: {
        pieceItemId: 'I01N',
        piecesRequired: 5,
        tokenItemId: 'I01R',
        rewardGold: 200,
        rewardXp: 80,
        rewardLumber: 1,
      },
    },
    xp: {
      xpToLevel: [0, 0, 200, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400, 6500, 7700],
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
      goldDumpPeriodTicks: 600,
      streetMerchant: {
        rollAtTick: 0,
        spawnAtTick: 0,
        rollMin: 1,
        rollMax: 100,
        threshold: 50,
        merchantTypeId: 'n00R',
      },
    },
    map: {
      bounds: { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 },
      // Stub mask (empty cells) -> isWater true everywhere, nearestWater snaps
      // nothing, so blink lands on its clamped point exactly as before.
      waterMask: {
        bounds: { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 },
        cols: 0,
        rows: 0,
        cellSizeX: 1,
        cellSizeY: 1,
        cells: new Uint8Array(0),
      },
      navByTeam: { south: stubNavField(), north: stubNavField() },
      navHomeByTeam: { south: stubNavField(), north: stubNavField() },
      regions: {
        GoblinBombShop: region('GoblinBombShop', 0, 0, 200, 200),
        SouthReward: region('SouthReward', 400, 0, 600, 200),
        NorthReward: region('NorthReward', 400, 800, 600, 1000),
        North_Main: region('North_Main', 800, 800, 1000, 1000),
        South_Main: region('South_Main', 800, -1000, 1000, -800),
        Repair_Station_South: region('Repair_Station_South', -200, -200, -100, -100),
        Repair_Out_South: region('Repair_Out_South', -90, -90, -70, -70),
        Repair_Station_North: region('Repair_Station_North', -200, 100, -100, 200),
        Repair_Out_North: region('Repair_Out_North', -90, 70, -70, 90),
        SubMoveNorth: region('SubMoveNorth', 1200, 800, 1210, 810),
        SubMoveSouth: region('SubMoveSouth', 1200, -810, 1210, -800),
        SouthRespawn: region('SouthRespawn', -1500, -1500, -1400, -1400),
        NorthRespawn: region('NorthRespawn', -1500, 1400, -1400, 1500),
        Temp_Item_Region: region('Temp_Item_Region', 1900, 1900, 2000, 2000),
      },
      structures: [],
      playerStarts: {},
      startingShipTypeId: 'H000',
      lanes: [],
      waves: [],
      respawnRegionByTeam: { south: 'SouthRespawn', north: 'NorthRespawn' },
      repairBays: [
        { team: 'south', stationRegion: 'Repair_Station_South', exitRegion: 'Repair_Out_South' },
        { team: 'north', stationRegion: 'Repair_Station_North', exitRegion: 'Repair_Out_North' },
      ],
      subTeleports: [
        { team: 'north', mainRegion: 'North_Main', exitRegion: 'SubMoveNorth' },
        { team: 'south', mainRegion: 'South_Main', exitRegion: 'SubMoveSouth' },
      ],
      tempItemRegion: 'Temp_Item_Region',
      streetMerchantRegions: { south: 'SouthRespawn', north: 'NorthRespawn' },
    },
  };
}

function warheadWeapon(id: string, damage: number, speedPerTick: number) {
  return {
    id,
    name: id,
    abilityId: id,
    mechanic: 'kaboomMissile' as const,
    gold: null,
    damage,
    cooldownTicks: 40,
    rangeUnits: null,
    aoeRadius: 200,
    projectileSpeedPerTick: speedPerTick,
    homing: true,
    targets: { ships: false, structures: true, heroOnly: false },
    attackType: 'normal' as const,
    damageType: 'physical' as const,
    noTypeMult: true,
    dot: null,
    buffId: null,
    buffDurationTicks: 0,
    castTimeTicks: 0,
    cooldownGroup: null,
  };
}

function makePlayer(slot: number, team: TeamId, over?: Partial<PlayerState>): PlayerState {
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
    shipId: null,
    inventory: [null, null, null, null, null, null],
    cooldownGroups: {},
    missileReadyAtTick: 0,
    respawnAtTick: null,
    goldDumpEnabled: false,
    ...over,
  };
}

function item(itemId: string, charges: number | null = null): ItemInstance {
  return { itemId, charges, readyAtTick: 0 };
}

function makeShip(
  ruleset: Ruleset,
  id: number,
  owner: number,
  team: TeamId,
  typeId: string,
  x: number,
  y: number,
): ShipEntity {
  const spec = ruleset.ships[typeId];
  const maxHp = spec ? spec.maxHp : 1000;
  return {
    id,
    typeId,
    x,
    y,
    facingRad: 0,
    dead: false,
    kind: 'ship',
    owner,
    team,
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
  owner: number | null,
  team: TeamId | null,
  typeId: string,
  x: number,
  y: number,
  role: StructureEntity['role'] = 'other',
): StructureEntity {
  return {
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
    hp: 50000,
    maxHp: 50000,
    statuses: [],
    attackReadyAtTick: 0,
    shopStock: null,
  };
}

function makeWard(
  id: number,
  owner: number,
  team: TeamId,
  x: number,
  y: number,
  over?: Partial<WardEntity>,
): WardEntity {
  return {
    id,
    typeId: 'nvil',
    x,
    y,
    facingRad: 0,
    dead: false,
    kind: 'ward',
    owner,
    team,
    expiresAtTick: null,
    sightRadius: 1600,
    detectionRadius: 1600,
    invisible: false,
    invulnerable: true,
    ...over,
  };
}

function makeState(players: PlayerState[], entities: Entity[], tick = 100): SimState {
  const playerRecord: Record<number, PlayerState> = {};
  for (const p of players) playerRecord[p.slot] = p;
  const entityRecord: Record<number, Entity> = {};
  let maxId = 0;
  for (const e of entities) {
    entityRecord[e.id] = e;
    if (e.id > maxId) maxId = e.id;
  }
  return {
    tick,
    rngState: 0xc0ffee,
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

function smoke(expiresAtTick: number) {
  return { kind: 'invisible' as const, buffId: 'B00I', expiresAtTick, breaksOnAction: true };
}

function ghost() {
  return { kind: 'invisible' as const, buffId: null, expiresAtTick: null, breaksOnAction: false };
}

function rejections(state: SimState): string[] {
  return state.events
    .filter((e) => e.type === 'commandRejected')
    .map((e) => (e.type === 'commandRejected' ? e.reason : ''));
}

// ---------------------------------------------------------------------------
// Visibility matrix
// ---------------------------------------------------------------------------

describe('recomputeVisibility', () => {
  it('a plain ship is visible to both teams', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship]);
    recomputeVisibility(state, rs);
    expect(ship.vision).toEqual({ south: true, north: true });
  });

  it('a smoked ship is hidden from the enemy but always visible to its own team', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    ship.statuses.push(smoke(999));
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship]);
    recomputeVisibility(state, rs);
    expect(ship.vision).toEqual({ south: true, north: false });
  });

  it("a 'revealed' status overrides invisibility", () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    ship.statuses.push(smoke(999), { kind: 'revealed', expiresAtTick: 999 });
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship]);
    recomputeVisibility(state, rs);
    expect(ship.vision.north).toBe(true);
  });

  it('an expired invisible status no longer hides (and stepSpecials prunes it)', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    ship.statuses.push(smoke(100)); // expires exactly now (tick 100)
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship], 100);
    recomputeVisibility(state, rs);
    expect(ship.vision.north).toBe(true);
    stepSpecials(state, rs);
    expect(ship.statuses).toEqual([]);
  });

  it('H001 hull true sight (Adtg 1200) reveals a smoked enemy in range only', () => {
    const rs = makeRuleset();
    const smoked = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    smoked.statuses.push(smoke(999));
    const detector = makeShip(rs, 11, 7, 'north', 'H001', 1100, 0);
    const state = makeState(
      [makePlayer(2, 'south', { shipId: 10 }), makePlayer(7, 'north', { shipId: 11 })],
      [smoked, detector],
    );
    recomputeVisibility(state, rs);
    expect(smoked.vision.north).toBe(true);

    detector.x = 1300; // outside Adtg 1200
    recomputeVisibility(state, rs);
    expect(smoked.vision.north).toBe(false);
  });

  it('a detector on the OWN team does not reveal the unit to the enemy', () => {
    const rs = makeRuleset();
    const smoked = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    smoked.statuses.push(smoke(999));
    const allyDetector = makeShip(rs, 11, 3, 'south', 'H001', 100, 0);
    const state = makeState(
      [makePlayer(2, 'south', { shipId: 10 }), makePlayer(3, 'south', { shipId: 11 })],
      [smoked, allyDetector],
    );
    recomputeVisibility(state, rs);
    expect(smoked.vision.north).toBe(false);
  });

  it('Spy ward true sight (Atru 1600) reveals; an expired ward does not', () => {
    const rs = makeRuleset();
    const smoked = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    smoked.statuses.push(smoke(999));
    const ward = makeWard(11, 7, 'north', 1500, 0, { expiresAtTick: 200 });
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [smoked, ward], 100);
    recomputeVisibility(state, rs);
    expect(smoked.vision.north).toBe(true);

    state.tick = 200; // ward expiry reached
    recomputeVisibility(state, rs);
    expect(smoked.vision.north).toBe(false);
  });

  it('a Goblin Scout Crew (gemt) carrier reveals within ~900', () => {
    const rs = makeRuleset();
    const smoked = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    smoked.statuses.push(smoke(999));
    const carrier = makeShip(rs, 11, 7, 'north', 'H000', 850, 0);
    const enemyPlayer = makePlayer(7, 'north', { shipId: 11 });
    enemyPlayer.inventory[0] = item('I00F');
    const state = makeState([makePlayer(2, 'south', { shipId: 10 }), enemyPlayer], [
      smoked,
      carrier,
    ]);
    recomputeVisibility(state, rs);
    expect(smoked.vision.north).toBe(true);

    carrier.x = 950; // outside 900
    recomputeVisibility(state, rs);
    expect(smoked.vision.north).toBe(false);
  });

  it('an active enemy detection zone (flare) reveals; an expired one does not', () => {
    const rs = makeRuleset();
    const smoked = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    smoked.statuses.push(smoke(999));
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [smoked], 100);
    state.detectionZones.push({ team: 'north', x: 500, y: 0, radius: 1200, expiresAtTick: 150 });
    recomputeVisibility(state, rs);
    expect(smoked.vision.north).toBe(true);

    state.tick = 150;
    recomputeVisibility(state, rs);
    expect(smoked.vision.north).toBe(false);
  });

  it('the permanent ghost (dive) is hidden until detected', () => {
    const rs = makeRuleset();
    const sub = makeShip(rs, 10, 2, 'south', 'H00W', 0, 0);
    sub.submerged = true;
    sub.statuses.push(ghost());
    const ward = makeWard(11, 7, 'north', 3000, 0);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [sub, ward]);
    recomputeVisibility(state, rs);
    expect(sub.vision.north).toBe(false);

    ward.x = 1000; // within Atru 1600
    recomputeVisibility(state, rs);
    expect(sub.vision.north).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// breakInvisibilityOnAction
// ---------------------------------------------------------------------------

describe('breakInvisibilityOnAction', () => {
  it('removes breaks-on-action smoke permanently', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    ship.statuses.push(smoke(999));
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship]);
    breakInvisibilityOnAction(state, 10);
    expect(ship.statuses).toEqual([]);
  });

  it('ghost is kept but gains revealed for 1 tick on an instant action', () => {
    const rs = makeRuleset();
    const sub = makeShip(rs, 10, 2, 'south', 'H00W', 0, 0);
    sub.statuses.push(ghost());
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [sub], 100);
    breakInvisibilityOnAction(state, 10);
    expect(sub.statuses).toContainEqual(ghost());
    expect(sub.statuses).toContainEqual({ kind: 'revealed', expiresAtTick: 101 });
  });

  it('ghost wind-up cast keeps the unit revealed until completesAtTick', () => {
    const rs = makeRuleset();
    const sub = makeShip(rs, 10, 2, 'south', 'H00W', 0, 0);
    sub.statuses.push(ghost());
    sub.casting = {
      abilityOrItemId: 'I026',
      slot: 0,
      targetId: 99,
      x: null,
      y: null,
      completesAtTick: 170, // 3.5 s wind-up
    };
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [sub], 100);
    breakInvisibilityOnAction(state, 10);
    expect(sub.statuses).toContainEqual({ kind: 'revealed', expiresAtTick: 170 });
  });

  it('move/stop never call it: a smoked ship keeps smoke without actions', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    ship.statuses.push(smoke(999));
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship]);
    stepSpecials(state, rs); // a full specials tick is not an action
    expect(ship.statuses).toContainEqual(smoke(999));
  });

  it('arms a goblin mine: scripted kill 5 s (100 ticks) after the action', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    ship.statuses.push({ kind: 'goblinMine', sourcePlayer: 7, detonateAtTick: null });
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship], 100);

    breakInvisibilityOnAction(state, 10);
    const mine = ship.statuses.find((s) => s.kind === 'goblinMine');
    expect(mine).toEqual({ kind: 'goblinMine', sourcePlayer: 7, detonateAtTick: 200 });

    state.tick = 199;
    stepSpecials(state, rs);
    expect(ship.dead).toBe(false);

    state.tick = 200;
    stepSpecials(state, rs);
    expect(ship.dead).toBe(true);
    expect(state.pendingDeaths).toEqual([
      { entityId: 10, victimPlayer: 2, killerPlayer: 7, killerEntityId: null, scripted: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Missile system
// ---------------------------------------------------------------------------

function missileFixture() {
  const rs = makeRuleset();
  const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
  const player = makePlayer(2, 'south', { shipId: 10 });
  // Enemy lead (slot 1) structures + an enemy NON-lead (slot 7) structure.
  const leadHq = makeStructure(20, 1, 'north', 'n000', 900, 900, 'hq');
  const leadRamp = makeStructure(21, 1, 'north', 'n00D', 850, 850, 'missileRamp');
  const leadTower = makeStructure(22, 1, 'north', 'n004', 800, 800, 'tower');
  const humanRamp = makeStructure(23, 7, 'north', 'n00D', 700, 700, 'missileRamp');
  const state = makeState([player, makePlayer(7, 'north')], [
    ship,
    leadHq,
    leadRamp,
    leadTower,
    humanRamp,
  ]);
  return { rs, state, player, ship };
}

describe('fireMissile', () => {
  it('rejects without the lumber item and consumes nothing', () => {
    const { rs, state, player } = missileFixture();
    player.inventory[0] = item('I01O');
    const rngBefore = state.rngState;
    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
    expect(rejections(state)).toEqual(['missingLumber']);
    expect(player.inventory[0]).toEqual(item('I01O'));
    expect(state.rngState).toBe(rngBefore);
    expect(Object.keys(state.projectiles)).toHaveLength(0);
  });

  it('rejects without a warhead', () => {
    const { rs, state, player } = missileFixture();
    player.inventory[0] = item('I01N');
    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
    expect(rejections(state)).toEqual(['missingWarhead']);
  });

  it('fires one missile per carried warhead tier when enough I01N is carried', () => {
    // war3map.j 11006-11129: three sequential, NON-exclusive branches —
    // I01O + I01P with 2x I01N launches BOTH, each consuming its own pair.
    const { rs, state, player } = missileFixture();
    player.inventory[0] = item('I01N');
    player.inventory[1] = item('I01O');
    player.inventory[2] = item('I01P');
    player.inventory[3] = item('I01N');
    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
    expect(rejections(state)).toEqual([]);
    expect(player.inventory[0]).toBeNull();
    expect(player.inventory[1]).toBeNull();
    expect(player.inventory[2]).toBeNull();
    expect(player.inventory[3]).toBeNull();
    const launches = state.events.filter((e) => e.type === 'missileLaunched');
    expect(launches.map((e) => (e.type === 'missileLaunched' ? e.warheadItemId : ''))).toEqual([
      'I01O',
      'I01P',
    ]);
    expect(Object.keys(state.projectiles)).toHaveLength(2);
    expect(player.missileReadyAtTick).toBe(state.tick + 40); // throttle set once
  });

  it('a second tier silently skips when the lumber ran out (per-branch re-check)', () => {
    const { rs, state, player } = missileFixture();
    player.inventory[0] = item('I01N'); // only ONE piece of lumber
    player.inventory[1] = item('I01O');
    player.inventory[2] = item('I01P');
    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
    expect(rejections(state)).toEqual([]);
    expect(player.inventory[0]).toBeNull(); // consumed by the I01O branch
    expect(player.inventory[1]).toBeNull();
    expect(player.inventory[2]).toEqual(item('I01P')); // kept, no lumber left
    expect(Object.keys(state.projectiles)).toHaveLength(1);
  });

  it('duplicate warheads of the SAME tier fire only once per cast', () => {
    const { rs, state, player } = missileFixture();
    player.inventory[0] = item('I01N');
    player.inventory[1] = item('I01O');
    player.inventory[2] = item('I01O');
    player.inventory[3] = item('I01N');
    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
    expect(Object.keys(state.projectiles)).toHaveLength(1);
    expect(player.inventory[2]).toEqual(item('I01O')); // second copy kept
    expect(player.inventory[3]).toEqual(item('I01N')); // second lumber kept
  });

  it('rejects while repair-bay paused or mid-windup (no bypass of the cast gates)', () => {
    const { rs, state, player, ship } = missileFixture();
    player.inventory[0] = item('I01N');
    player.inventory[1] = item('I01O');
    ship.pausedUntilTick = state.tick + 100;
    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
    expect(rejections(state)).toEqual(['paused']);
    expect(player.inventory[0]).toEqual(item('I01N'));

    ship.pausedUntilTick = 0;
    ship.casting = { abilityOrItemId: 'I026', slot: 0, targetId: 99, x: null, y: null, completesAtTick: 999 };
    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
    expect(rejections(state)).toEqual(['paused', 'casting']);
  });

  it('launching breaks smoke invisibility (an action like any other)', () => {
    const { rs, state, player, ship } = missileFixture();
    ship.statuses.push(smoke(99999));
    player.inventory[0] = item('I01N');
    player.inventory[1] = item('I01O');
    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
    expect(ship.statuses.some((s) => s.kind === 'invisible')).toBe(false);
  });

  it('rejects while the ~2 s launch throttle is running', () => {
    const { rs, state, player } = missileFixture();
    player.inventory[0] = item('I01N');
    player.inventory[1] = item('I01O');
    player.missileReadyAtTick = state.tick + 1;
    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
    expect(rejections(state)).toEqual(['missileNotReady']);
    expect(player.inventory[0]).toEqual(item('I01N'));
  });

  it('launch consumes BOTH items, throttles, spawns the warhead projectile and emits the event', () => {
    const { rs, state, player, ship } = missileFixture();
    player.inventory[0] = item('I01N');
    player.inventory[1] = item('I01O');
    player.inventory[2] = item('I00C'); // bystander item, untouched

    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });

    expect(player.inventory[0]).toBeNull();
    expect(player.inventory[1]).toBeNull();
    expect(player.inventory[2]).toEqual(item('I00C'));
    expect(player.missileReadyAtTick).toBe(state.tick + 40);

    const projectiles = Object.values(state.projectiles);
    expect(projectiles).toHaveLength(1);
    const proj = projectiles[0];
    expect(proj).toMatchObject({
      mechanic: 'kaboomMissile',
      weaponId: 'A03P',
      // Dummy owned by the firing TEAM's lead player (south -> slot 0).
      ownerPlayer: 0,
      team: 'south',
      sourceEntityId: ship.id,
      x: ship.x,
      y: ship.y,
      speedPerTick: 10, // h00N umvs 200 / 20
      payload: { amount: 50, attackType: 'normal', damageType: 'physical', noTypeMult: true },
    });
    // Target is one of the enemy LEAD player's structures.
    expect([20, 21, 22]).toContain(proj?.intendedTargetId);

    const launched = state.events.find((e) => e.type === 'missileLaunched');
    expect(launched).toMatchObject({
      player: 2,
      warheadItemId: 'I01O',
      targetEntityId: proj?.intendedTargetId,
    });
  });

  it('never targets structures of enemy players other than the lead (slot 0/1)', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { rs, state, player } = missileFixture();
      state.rngState = seed;
      player.inventory[0] = item('I01N');
      player.inventory[1] = item('I01Q');
      applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
      const proj = Object.values(state.projectiles)[0];
      expect([20, 21, 22]).toContain(proj?.intendedTargetId); // never 23 (slot 7)
    }
  });

  it('rolls uniformly over the ascending-id candidate list (replay-stable)', () => {
    const targets = new Set<number>();
    for (let seed = 1; seed <= 25; seed++) {
      const { rs, state, player } = missileFixture();
      state.rngState = seed;
      player.inventory[0] = item('I01N');
      player.inventory[1] = item('I01O');
      applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
      const proj = Object.values(state.projectiles)[0];
      if (proj?.intendedTargetId !== null && proj !== undefined) {
        targets.add(proj.intendedTargetId);
      }
    }
    expect(targets.size).toBeGreaterThan(1); // spreads across candidates

    // Bit-identical replay: same seed, same state -> same target.
    const a = missileFixture();
    const b = missileFixture();
    for (const f of [a, b]) {
      f.player.inventory[0] = item('I01N');
      f.player.inventory[1] = item('I01O');
      f.state.rngState = 777;
      applySpecialsCommand(f.state, f.rs, { type: 'fireMissile', player: 2 });
    }
    expect(Object.values(a.state.projectiles)[0]?.intendedTargetId).toBe(
      Object.values(b.state.projectiles)[0]?.intendedTargetId,
    );
  });

  it('decrements multi-charge stacks instead of removing them', () => {
    const { rs, state, player } = missileFixture();
    player.inventory[0] = item('I01N', 3);
    player.inventory[1] = item('I01P');
    applySpecialsCommand(state, rs, { type: 'fireMissile', player: 2 });
    expect(player.inventory[0]).toEqual({ itemId: 'I01N', charges: 2, readyAtTick: 0 });
    expect(player.inventory[1]).toBeNull();
    expect(Object.values(state.projectiles)[0]?.payload.amount).toBe(250); // I01P -> A03Q
  });
});

// ---------------------------------------------------------------------------
// castAbility: dive
// ---------------------------------------------------------------------------

describe('castAbility dive (A04C)', () => {
  function diveFixture() {
    const rs = makeRuleset();
    const sub = makeShip(rs, 10, 2, 'south', 'H00V', 0, 0);
    const player = makePlayer(2, 'south', { shipId: 10, shipTypeId: 'H00V' });
    const state = makeState([player], [sub]);
    return { rs, state, player, sub };
  }

  it('swaps H00V -> H00W on the same entity, preserving HP fraction', () => {
    const { rs, state, player, sub } = diveFixture();
    sub.hp = 1012.5; // 50% of 2025

    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A04C' });

    expect(sub.id).toBe(10);
    expect(sub.typeId).toBe('H00W');
    expect(sub.maxHp).toBe(1025);
    expect(sub.hp).toBeCloseTo(512.5, 9);
    expect(sub.submerged).toBe(true);
    expect(sub.statuses).toContainEqual(ghost());
    expect(player.cooldownGroups['A04C']).toBe(state.tick + 100);
  });

  it('enforces the 5 s cooldown, then surfaces back and drops the ghost', () => {
    const { rs, state, player, sub } = diveFixture();
    sub.hp = 2025;
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A04C' });
    expect(sub.typeId).toBe('H00W');

    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A04C' });
    expect(rejections(state)).toEqual(['onCooldown']);
    expect(sub.typeId).toBe('H00W');

    state.tick += 100;
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A04C' });
    expect(sub.typeId).toBe('H00V');
    expect(sub.maxHp).toBe(2025);
    expect(sub.hp).toBeCloseTo(2025, 9);
    expect(sub.submerged).toBe(false);
    expect(sub.statuses.some((s) => s.kind === 'invisible')).toBe(false);
    expect(player.cooldownGroups['A04C']).toBe(state.tick + 100);
  });

  it('keeps equipment maxHp bonuses across the swap (delta carryover)', () => {
    const { rs, state, sub } = diveFixture();
    sub.maxHp = 2125; // base 2025 + 100 equipment bonus baked in by economy
    sub.hp = 2125;
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A04C' });
    expect(sub.maxHp).toBe(1125); // 1025 + the same 100 bonus
    expect(sub.hp).toBeCloseTo(1125, 9);
  });

  it('breaks an active smoke when cast (a cast is an action)', () => {
    const { rs, state, sub } = diveFixture();
    sub.statuses.push(smoke(999));
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A04C' });
    expect(sub.statuses.some((s) => s.kind === 'invisible' && s.expiresAtTick !== null)).toBe(
      false,
    );
  });

  it('rejects on a non-submarine hull', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship]);
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A04C' });
    expect(rejections(state)).toEqual(['notASubmarine']);
    expect(ship.typeId).toBe('H000');
  });
});

// ---------------------------------------------------------------------------
// castAbility: invisibility / flare / stubs
// ---------------------------------------------------------------------------

describe('castAbility hide / flare / specials stubs', () => {
  it('Hide applies rank-scaled smoke and starts its cooldown', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H001', 0, 0);
    const player = makePlayer(2, 'south', { shipId: 10, heroSkillLevels: { A047: 2 } });
    const state = makeState([player], [ship]);

    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A047' });

    expect(ship.statuses).toContainEqual({
      kind: 'invisible',
      buffId: 'A047',
      expiresAtTick: state.tick + 160, // rank 2 -> 8 s
      breaksOnAction: true,
    });
    expect(player.cooldownGroups['A047']).toBe(state.tick + 500);

    recomputeVisibility(state, rs);
    expect(ship.vision).toEqual({ south: true, north: false });
  });

  it('Hide rejects when the skill is not learned', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H001', 0, 0);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship]);
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A047' });
    expect(rejections(state)).toEqual(['notLearned']);
    expect(ship.statuses).toEqual([]);
  });

  it('casting Hide does not break the invisibility it grants, and respects its cooldown', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H001', 0, 0);
    const player = makePlayer(2, 'south', { shipId: 10, heroSkillLevels: { A047: 1 } });
    const state = makeState([player], [ship]);

    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A047' });
    expect(ship.statuses.filter((s) => s.kind === 'invisible')).toHaveLength(1);

    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A047' });
    expect(rejections(state)).toEqual(['onCooldown']);
  });

  it('Echo-Location creates a 1500-radius, 30 s detection zone for the team', () => {
    const rs = makeRuleset();
    const sub = makeShip(rs, 10, 2, 'south', 'H00V', 0, 0);
    const player = makePlayer(2, 'south', { shipId: 10 });
    const state = makeState([player], [sub]);

    applySpecialsCommand(state, rs, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A04D',
      x: 500,
      y: 250,
    });

    expect(state.detectionZones).toEqual([
      { team: 'south', x: 500, y: 250, radius: 1500, expiresAtTick: state.tick + 600 },
    ]);
    expect(player.cooldownGroups['A04D']).toBe(state.tick + 2400);
  });

  it('flare cast rejects without a target point and from a hull lacking the ability', () => {
    const rs = makeRuleset();
    const sub = makeShip(rs, 10, 2, 'south', 'H00V', 0, 0);
    const plain = makeShip(rs, 11, 3, 'south', 'H000', 0, 0);
    const state = makeState(
      [makePlayer(2, 'south', { shipId: 10 }), makePlayer(3, 'south', { shipId: 11 })],
      [sub, plain],
    );

    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A04D' });
    applySpecialsCommand(state, rs, {
      type: 'castAbility',
      player: 3,
      abilityId: 'A04D',
      x: 0,
      y: 0,
    });
    expect(rejections(state)).toEqual(['missingTarget', 'notLearned']);
    expect(state.detectionZones).toEqual([]);
  });

  it("exotic 'special' abilities reject with reason 'unimplemented' and mutate nothing", () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H001', 0, 0);
    const player = makePlayer(2, 'south', { shipId: 10, heroSkillLevels: { A01A: 3 } });
    const state = makeState([player], [ship]);

    applySpecialsCommand(state, rs, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A01A',
      targetId: 10,
    });

    expect(rejections(state)).toEqual(['unimplemented']);
    expect(ship.statuses).toEqual([]);
    expect(player.cooldownGroups).toEqual({});
  });

  it('passive mechanics are not activatable', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    const state = makeState(
      [makePlayer(2, 'south', { shipId: 10, heroSkillLevels: { A009: 1 } })],
      [ship],
    );
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A009' });
    expect(rejections(state)).toEqual(['notActivatable']);
  });

  it('stunned and silenced ships cannot cast specials abilities (combat-path parity)', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H001', 0, 0);
    const player = makePlayer(2, 'south', { shipId: 10, heroSkillLevels: { A047: 1 } });
    const state = makeState([player], [ship], 100);

    ship.statuses.push({ kind: 'stunned', expiresAtTick: 200 });
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A047' });
    ship.statuses = [{ kind: 'silenced', expiresAtTick: 200 }];
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A047' });
    expect(rejections(state)).toEqual(['stunned', 'silenced']);
    expect(ship.statuses.some((s) => s.kind === 'invisible')).toBe(false);

    // An EXPIRED stun no longer blocks.
    ship.statuses = [{ kind: 'stunned', expiresAtTick: 100 }];
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A047' });
    expect(ship.statuses.some((s) => s.kind === 'invisible')).toBe(true);
  });

  it('unknown ability / unknown player / dead ship are rejected', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    ship.dead = true;
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship]);
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 9, abilityId: 'A047' });
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A047' });
    expect(rejections(state)).toEqual(['unknownPlayer', 'noShip']);
  });
});

// ---------------------------------------------------------------------------
// castAbility: net (A00Y Fishing Net — ANen Ensnare)
// ---------------------------------------------------------------------------

describe('castAbility net (A00Y)', () => {
  /** Caster H001 with A00Y learned; target enemy ship within net range. */
  function netFixture(targetDistance = 500) {
    const rs = makeRuleset();
    const caster = makeShip(rs, 10, 2, 'south', 'H001', 0, 0);
    const target = makeShip(rs, 11, 7, 'north', 'H000', targetDistance, 0);
    const caster2 = makePlayer(2, 'south', { shipId: 10, heroSkillLevels: { A00Y: 1 } });
    const target7 = makePlayer(7, 'north', { shipId: 11 });
    const state = makeState([caster2, target7], [caster, target], 100);
    return { rs, state, caster, target, casterPlayer: caster2 };
  }

  it('nets an in-range enemy ship for 8 s (160 ticks) and starts the 35 s cooldown', () => {
    const { rs, state, target, casterPlayer } = netFixture(500);
    applySpecialsCommand(state, rs, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A00Y',
      targetId: 11,
    });
    expect(target.statuses).toContainEqual({ kind: 'ensnared', expiresAtTick: 100 + 160 });
    expect(casterPlayer.cooldownGroups['A00Y']).toBe(100 + 700);
    const cast = state.events.find((e) => e.type === 'abilityCast');
    expect(cast).toMatchObject({ type: 'abilityCast', player: 2, abilityId: 'A00Y', targetEntityId: 11 });
  });

  it('a netted ship cannot move (movement step keeps it in place) until the hold expires', () => {
    const { rs, state, target } = netFixture(500);
    applySpecialsCommand(state, rs, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A00Y',
      targetId: 11,
    });
    // Order the netted ship to move; effectiveMoveSpeed is 0 while ensnared.
    target.order = { type: 'move', x: 2000, y: 0 };
    const x0 = target.x;
    // Ensnared from tick 100..259 (expiresAtTick 260, active while 260 > tick).
    for (let t = 100; t < 260; t++) {
      state.tick = t;
      stepMovement(state, rs);
      expect(target.x).toBe(x0); // pinned the whole hold
    }
    // At tick 260 the hold has lapsed (260 > 260 is false) -> the ship moves.
    state.tick = 260;
    stepMovement(state, rs);
    expect(target.x).toBeGreaterThan(x0);
  });

  it('rejects an out-of-range target (> 800) and nets nothing', () => {
    const far = netFixture(900);
    applySpecialsCommand(far.state, far.rs, {
      type: 'castAbility',
      player: 2,
      abilityId: 'A00Y',
      targetId: 11,
    });
    expect(rejections(far.state)).toEqual(['outOfRange']);
    expect(far.target.statuses).toEqual([]);
  });

  it('rejects a friendly / missing target and an unlearned net', () => {
    const rs = makeRuleset();
    const caster = makeShip(rs, 10, 2, 'south', 'H001', 0, 0);
    const ally = makeShip(rs, 12, 3, 'south', 'H000', 300, 0);
    const enemy = makeShip(rs, 11, 7, 'north', 'H000', 300, 0);
    const state = makeState(
      [
        makePlayer(2, 'south', { shipId: 10, heroSkillLevels: { A00Y: 1 } }),
        makePlayer(3, 'south', { shipId: 12 }),
        makePlayer(7, 'north', { shipId: 11 }),
      ],
      [caster, ally, enemy],
      100,
    );
    // Friendly target.
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A00Y', targetId: 12 });
    // Missing target.
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A00Y' });
    expect(rejections(state)).toEqual(['invalidTarget', 'missingTarget']);
    expect(ally.statuses).toEqual([]);

    // Not learned: a caster without the skill point.
    const rs2 = makeRuleset();
    const c2 = makeShip(rs2, 10, 2, 'south', 'H001', 0, 0);
    const e2 = makeShip(rs2, 11, 7, 'north', 'H000', 300, 0);
    const s2 = makeState(
      [makePlayer(2, 'south', { shipId: 10 }), makePlayer(7, 'north', { shipId: 11 })],
      [c2, e2],
      100,
    );
    applySpecialsCommand(s2, rs2, { type: 'castAbility', player: 2, abilityId: 'A00Y', targetId: 11 });
    expect(rejections(s2)).toEqual(['notLearned']);
  });

  it('respects its cooldown (a second cast while cooling down is rejected)', () => {
    const { rs, state } = netFixture(500);
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A00Y', targetId: 11 });
    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A00Y', targetId: 11 });
    expect(rejections(state)).toEqual(['onCooldown']);
  });
});

// ---------------------------------------------------------------------------
// castAbility: Shore Leave (A01D — the F-key ship ability for H000/subs)
// ---------------------------------------------------------------------------

describe('castAbility shore leave (A01D)', () => {
  // South_Main region in the fixture: 800..1000 x, -1000..-800 y.
  const insideSouthMain = { x: 900, y: -900 };

  it('repairs the hull to full when cast inside the OWN Main Harbour', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', insideSouthMain.x, insideSouthMain.y);
    ship.hp = 40; // damaged (maxHp 225)
    const player = makePlayer(2, 'south', { shipId: 10 });
    const state = makeState([player], [ship]);

    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A01D' });

    expect(ship.hp).toBe(ship.maxHp);
    expect(rejections(state)).toEqual([]);
    const cast = state.events.find((e) => e.type === 'abilityCast');
    expect(cast).toMatchObject({ type: 'abilityCast', player: 2, abilityId: 'A01D', targetEntityId: 10 });
  });

  it('is rejected when NOT close to the Main Harbour (faithful to the tooltip gate)', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0); // open water, not South_Main
    ship.hp = 40;
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship]);

    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A01D' });

    expect(ship.hp).toBe(40); // no heal
    expect(rejections(state)).toEqual(['notAtMainHarbour']);
  });

  it('uses the OWN team region: a north ship is not repaired in the south base', () => {
    const rs = makeRuleset();
    // Standing inside South_Main, but the ship is NORTH — its gate is North_Main.
    const ship = makeShip(rs, 10, 7, 'north', 'H000', insideSouthMain.x, insideSouthMain.y);
    ship.hp = 40;
    const state = makeState([makePlayer(7, 'north', { shipId: 10 })], [ship]);

    applySpecialsCommand(state, rs, { type: 'castAbility', player: 7, abilityId: 'A01D' });

    expect(ship.hp).toBe(40);
    expect(rejections(state)).toEqual(['notAtMainHarbour']);
  });

  it('is rejected when the ability is not on the current hull', () => {
    const rs = makeRuleset();
    // H005 carries no A01D in this fixture.
    const ship = makeShip(rs, 10, 2, 'south', 'H005', insideSouthMain.x, insideSouthMain.y);
    ship.hp = 40;
    const state = makeState([makePlayer(2, 'south', { shipId: 10, shipTypeId: 'H005' })], [ship]);

    applySpecialsCommand(state, rs, { type: 'castAbility', player: 2, abilityId: 'A01D' });

    expect(rejections(state)).toEqual(['notOnShip']);
  });
});

// ---------------------------------------------------------------------------
// Suicide quests
// ---------------------------------------------------------------------------

describe('suicide quests', () => {
  function questFixture(team: TeamId = 'south') {
    const rs = makeRuleset();
    const carrier = makeShip(rs, 10, 2, team, 'H005', -500, -500);
    const player = makePlayer(2, team, { shipId: 10, shipTypeId: 'H005' });
    player.inventory[0] = item('I01E');
    const southHq = makeStructure(20, 0, 'south', 'n000', 900, -900, 'hq');
    const northHq = makeStructure(21, 1, 'north', 'n000', 900, 900, 'hq');
    const state = makeState([player], [carrier, southHq, northHq]);
    return { rs, state, player, carrier, southHq, northHq };
  }

  function questEvents(state: SimState): { questId: string; stage: string }[] {
    const out: { questId: string; stage: string }[] = [];
    for (const e of state.events) {
      if (e.type === 'questProgress') out.push({ questId: e.questId, stage: e.stage });
    }
    return out;
  }

  it('goblin run pickup: H005 with I01E in GoblinBombShop gains I01F', () => {
    const { rs, state, player, carrier } = questFixture();
    carrier.x = 100;
    carrier.y = 100;
    stepSpecials(state, rs);
    expect(player.inventory[1]).toEqual(item('I01F'));
    expect(questEvents(state)).toEqual([{ questId: 'goblinRun', stage: 'pickedUp' }]);

    // Idempotent while the token is held.
    stepSpecials(state, rs);
    expect(player.inventory.filter((i) => i?.itemId === 'I01F')).toHaveLength(1);
  });

  it('pickup requires a free slot within the hull capacity (H005 = 4)', () => {
    const { rs, state, player, carrier } = questFixture();
    carrier.x = 100;
    carrier.y = 100;
    player.inventory[1] = item('I00C');
    player.inventory[2] = item('I00C');
    player.inventory[3] = item('I00C'); // slots 0-3 full; 4/5 beyond capacity
    stepSpecials(state, rs);
    expect(player.inventory.some((i) => i?.itemId === 'I01F')).toBe(false);
  });

  it('pickup requires the quest hull type', () => {
    const { rs, state, player, carrier } = questFixture();
    carrier.typeId = 'H000';
    carrier.x = 100;
    carrier.y = 100;
    stepSpecials(state, rs);
    expect(player.inventory.some((i) => i?.itemId === 'I01F')).toBe(false);
  });

  it('arming at the own reward zone swaps I01F -> I01G and warns the enemy', () => {
    const { rs, state, player, carrier } = questFixture();
    player.inventory[1] = item('I01F');
    carrier.x = 500;
    carrier.y = 100; // SouthReward
    stepSpecials(state, rs);
    expect(player.inventory[1]).toEqual(item('I01G'));
    expect(questEvents(state)).toEqual([
      { questId: 'goblinRun', stage: 'armed' },
      { questId: 'goblinRun', stage: 'enemyWarned' },
    ]);
  });

  it('north carriers arm at NorthReward and detonate in South_Main', () => {
    const { rs, state, player, carrier, southHq } = questFixture('north');
    player.team = 'north';
    player.inventory[1] = item('I01F');
    carrier.x = 500;
    carrier.y = 900; // NorthReward
    stepSpecials(state, rs);
    expect(player.inventory[1]).toEqual(item('I01G'));

    carrier.x = 900;
    carrier.y = -900; // South_Main
    stepSpecials(state, rs);
    expect(southHq.hp).toBe(50000 - 4000);
    expect(carrier.dead).toBe(true);
  });

  it('detonation: 4000 TRUE damage to the enemy HQ, scripted death, 8000 g + 1200 xp', () => {
    const { rs, state, player, carrier, northHq, southHq } = questFixture();
    player.inventory[1] = item('I01G');
    carrier.x = 900;
    carrier.y = 900; // North_Main
    stepSpecials(state, rs);

    expect(recorded.damage).toHaveLength(1);
    expect(recorded.damage[0]?.targetId).toBe(northHq.id);
    expect(recorded.damage[0]?.damage).toMatchObject({
      amount: 4000,
      damageType: 'true',
      noTypeMult: true,
      nonLethal: false,
      sourcePlayer: 2,
      sourceEntityId: 10,
    });
    expect(northHq.hp).toBe(46000);
    expect(southHq.hp).toBe(50000); // own HQ untouched

    expect(carrier.dead).toBe(true);
    expect(state.pendingDeaths).toEqual([
      { entityId: 10, victimPlayer: 2, killerPlayer: null, killerEntityId: null, scripted: true },
    ]);
    expect(player.gold).toBe(8000);
    expect(recorded.xp).toEqual([{ playerSlot: 2, amount: 1200, reason: 'quest:goblinRun' }]);
    expect(questEvents(state)).toEqual([{ questId: 'goblinRun', stage: 'detonated' }]);

    // Verbatim: WC3 heroes keep items through death — tokens are NOT removed.
    expect(player.inventory[0]).toEqual(item('I01E'));
    expect(player.inventory[1]).toEqual(item('I01G'));
  });

  it('no detonation without the ARMED token', () => {
    const { rs, state, carrier, northHq } = questFixture();
    const player = state.players[2];
    if (player) player.inventory[1] = item('I01F'); // unarmed only
    carrier.x = 900;
    carrier.y = 900;
    stepSpecials(state, rs);
    expect(northHq.hp).toBe(50000);
    expect(carrier.dead).toBe(false);
  });

  it('superbomb chain: I032 -> I02Z at the reward zone, 6000 true + 12000 g on detonation', () => {
    const { rs, state, player, carrier, northHq } = questFixture();
    player.inventory[1] = item('I032');
    player.inventory[2] = item('I02Q');
    carrier.x = 500;
    carrier.y = 100; // SouthReward
    stepSpecials(state, rs);
    expect(player.inventory[1]).toEqual(item('I02Z'));
    expect(questEvents(state)).toEqual([
      { questId: 'superbomb', stage: 'armed' },
      { questId: 'superbomb', stage: 'enemyWarned' },
    ]);

    carrier.x = 900;
    carrier.y = 900; // North_Main
    stepSpecials(state, rs);
    expect(recorded.damage[0]?.damage.amount).toBe(6000);
    expect(northHq.hp).toBe(44000);
    expect(carrier.dead).toBe(true);
    expect(player.gold).toBe(12000);
    expect(recorded.xp).toEqual([{ playerSlot: 2, amount: 1200, reason: 'quest:superbomb' }]);
  });

  it('superbomb arm is BLOCKED while carrying the goblin armed token I01G', () => {
    const { rs, state, player, carrier } = questFixture();
    player.inventory[1] = item('I032');
    player.inventory[2] = item('I02Q');
    player.inventory[3] = item('I01G'); // forbidden at the arm stage
    carrier.x = 500;
    carrier.y = 100; // SouthReward
    stepSpecials(state, rs);
    expect(player.inventory[1]).toEqual(item('I032')); // not swapped
  });

  it('goblin pickup respects the JASS UnitInventoryCount < 4 gate', () => {
    const { rs, state, player, carrier } = questFixture();
    // Give the fixture hull headroom so a free slot exists at 4 carried
    // items — the <4 gate must block on COUNT, not on capacity.
    const h005 = rs.ships['H005'];
    if (h005) h005.inventorySlots = 6;
    player.inventory[1] = item('I00C');
    player.inventory[2] = item('I00C');
    player.inventory[3] = item('I00C'); // I01E + 3 = 4 carried, slots free
    carrier.x = 100;
    carrier.y = 100; // GoblinBombShop
    stepSpecials(state, rs);
    expect(player.inventory.some((i) => i?.itemId === 'I01F')).toBe(false);

    player.inventory[3] = null; // 3 carried < 4 -> pickup fires
    stepSpecials(state, rs);
    expect(player.inventory.some((i) => i?.itemId === 'I01F')).toBe(true);
  });

  it('superbomb detonation additionally requires I02Q', () => {
    const { rs, state, player, carrier, northHq } = questFixture();
    player.inventory[1] = item('I02Z'); // armed but no I02Q
    carrier.x = 900;
    carrier.y = 900;
    stepSpecials(state, rs);
    expect(northHq.hp).toBe(50000);
    expect(carrier.dead).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sub base teleports
// ---------------------------------------------------------------------------

describe('sub base teleports', () => {
  it('a SUBMERGED sub (H00W) entering a main-base interior is moved to the exit center', () => {
    const rs = makeRuleset();
    const sub = makeShip(rs, 10, 2, 'south', 'H00W', 900, 900); // North_Main
    sub.submerged = true;
    sub.order = { type: 'move', x: 950, y: 950 };
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [sub]);
    stepSpecials(state, rs);
    expect(sub.x).toBe(1205); // SubMoveNorth center
    expect(sub.y).toBe(805);
    expect(sub.order).toEqual({ type: 'idle' });
  });

  it('a surfaced sub (H00V) is NOT teleported (war3map.j checks H00W)', () => {
    const rs = makeRuleset();
    const sub = makeShip(rs, 10, 2, 'south', 'H00V', 900, 900);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [sub]);
    stepSpecials(state, rs);
    expect(sub.x).toBe(900);
    expect(sub.y).toBe(900);
  });

  it('applies to either team entering either main (no ownership filter in the script)', () => {
    const rs = makeRuleset();
    const sub = makeShip(rs, 10, 7, 'north', 'H00W', 900, -900); // South_Main
    const state = makeState([makePlayer(7, 'north', { shipId: 10 })], [sub]);
    stepSpecials(state, rs);
    expect(sub.x).toBe(1205); // SubMoveSouth center
    expect(sub.y).toBe(-805);
  });
});

// ---------------------------------------------------------------------------
// Repair bays
// ---------------------------------------------------------------------------

describe('repair bays', () => {
  it('admits one damaged allied ship at a time, heals to full and ejects to the exit', () => {
    const rs = makeRuleset();
    const first = makeShip(rs, 10, 2, 'south', 'H000', -150, -150);
    first.hp = 50;
    const second = makeShip(rs, 11, 3, 'south', 'H000', -160, -160);
    second.hp = 80;
    const state = makeState(
      [makePlayer(2, 'south', { shipId: 10 }), makePlayer(3, 'south', { shipId: 11 })],
      [first, second],
      100,
    );

    stepSpecials(state, rs); // tick 100: first (lowest id) admitted
    // +1 keeps the occupant movement-locked THROUGH its release tick, so a
    // stale order can never step it out of the station before the heal.
    expect(first.pausedUntilTick).toBe(131);
    expect(first.invulnerableUntilTick).toBe(131);
    expect(second.pausedUntilTick).toBe(0); // bay busy

    for (state.tick = 101; state.tick < 130; state.tick++) {
      stepSpecials(state, rs);
      expect(second.pausedUntilTick).toBe(0); // still busy, single occupancy
      expect(first.hp).toBe(50); // healed only at release
    }

    state.tick = 130;
    stepSpecials(state, rs); // release tick (pausedUntilTick - 1)
    expect(first.hp).toBe(225);
    expect(first.x).toBe(-80); // Repair_Out_South center
    expect(first.y).toBe(-80);
    expect(first.order).toEqual({ type: 'idle' });
    expect(recorded.heals).toEqual([{ targetId: 10, amount: 175 }]);
    expect(second.pausedUntilTick).toBe(0); // bay frees only after release

    state.tick = 131;
    stepSpecials(state, rs); // now the second ship is admitted
    expect(second.pausedUntilTick).toBe(162);
  });

  it('ignores full-hp ships, enemy ships and ships outside the station', () => {
    const rs = makeRuleset();
    const healthy = makeShip(rs, 10, 2, 'south', 'H000', -150, -150);
    const enemy = makeShip(rs, 11, 7, 'north', 'H000', -155, -155);
    enemy.hp = 10;
    const faraway = makeShip(rs, 12, 3, 'south', 'H000', 500, 500);
    faraway.hp = 10;
    const state = makeState(
      [
        makePlayer(2, 'south', { shipId: 10 }),
        makePlayer(7, 'north', { shipId: 11 }),
        makePlayer(3, 'south', { shipId: 12 }),
      ],
      [healthy, enemy, faraway],
    );
    stepSpecials(state, rs);
    expect(healthy.pausedUntilTick).toBe(0);
    expect(enemy.pausedUntilTick).toBe(0);
    expect(faraway.pausedUntilTick).toBe(0);
    expect(recorded.heals).toEqual([]);
  });

  it('each team bay serves its own team', () => {
    const rs = makeRuleset();
    const northern = makeShip(rs, 10, 7, 'north', 'H000', -150, 150); // Repair_Station_North
    northern.hp = 60;
    const state = makeState([makePlayer(7, 'north', { shipId: 10 })], [northern], 100);
    stepSpecials(state, rs);
    expect(northern.pausedUntilTick).toBe(131);
  });
});

// ---------------------------------------------------------------------------
// Ward / summon / zone lifecycle + proximity warnings
// ---------------------------------------------------------------------------

describe('ward, summon and zone lifecycle', () => {
  it('expired wards and summons die without a PendingDeath (expiry is not a kill)', () => {
    const rs = makeRuleset();
    const ward = makeWard(10, 2, 'south', 0, 0, { expiresAtTick: 100 });
    const summon: Entity = {
      id: 11,
      typeId: 'nba2',
      x: 50,
      y: 50,
      facingRad: 0,
      dead: false,
      kind: 'summon',
      owner: 2,
      team: 'south',
      hp: 8500,
      maxHp: 8500,
      order: { type: 'idle' },
      statuses: [],
      vision: { south: true, north: true },
      attackReadyAtTick: 0,
      expiresAtTick: 150,
    };
    const state = makeState([makePlayer(2, 'south')], [ward, summon], 100);

    stepSpecials(state, rs);
    expect(ward.dead).toBe(true);
    expect(summon.dead).toBe(false);

    state.tick = 150;
    stepSpecials(state, rs);
    expect(summon.dead).toBe(true);
    expect(state.pendingDeaths).toEqual([]);
  });

  it('expired detection zones are dropped', () => {
    const rs = makeRuleset();
    const state = makeState([makePlayer(2, 'south')], [], 100);
    state.detectionZones.push(
      { team: 'south', x: 0, y: 0, radius: 1200, expiresAtTick: 100 },
      { team: 'south', x: 0, y: 0, radius: 1200, expiresAtTick: 300 },
    );
    stepSpecials(state, rs);
    expect(state.detectionZones).toEqual([
      { team: 'south', x: 0, y: 0, radius: 1200, expiresAtTick: 300 },
    ]);
  });

  it('motion detectors (no true sight) emit proximityWarning for enemies in sight radius only', () => {
    const rs = makeRuleset();
    // Synthetic warning radius: verbatim ohwd sight is 1 and NO warning
    // trigger exists in war3map.j — radius source flagged open.
    const detector = makeWard(10, 2, 'south', 0, 0, {
      typeId: 'ohwd',
      sightRadius: 600,
      detectionRadius: null,
      invisible: true,
    });
    const intruder = makeShip(rs, 11, 7, 'north', 'H000', 300, 0);
    const ally = makeShip(rs, 12, 3, 'south', 'H000', 100, 0);
    const distant = makeShip(rs, 13, 8, 'north', 'H000', 1000, 0);
    const state = makeState(
      [
        makePlayer(2, 'south'),
        makePlayer(7, 'north', { shipId: 11 }),
        makePlayer(3, 'south', { shipId: 12 }),
        makePlayer(8, 'north', { shipId: 13 }),
      ],
      [detector, intruder, ally, distant],
    );

    stepSpecials(state, rs);
    const warnings = state.events.filter((e) => e.type === 'proximityWarning');
    expect(warnings).toEqual([
      {
        type: 'proximityWarning',
        tick: state.tick,
        ownerPlayer: 2,
        wardEntityId: 10,
        intruderEntityId: 11,
      },
    ]);
    // Motion detectors grant no vision: a smoked enemy stays hidden.
    intruder.statuses.push(smoke(999));
    recomputeVisibility(state, rs);
    expect(intruder.vision.south).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Equipment actives (economy -> specials helper)
// ---------------------------------------------------------------------------

describe('applyEquipmentActive', () => {
  it('smoke machine: timed invisibility with the item buff', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship], 100);
    const handled = applyEquipmentActive(state, rs, 2, {
      kind: 'invisibility',
      durationTicks: 200, // I01K: 10 s
      cooldownTicks: 1400,
      buffId: 'B00I',
    });
    expect(handled).toBe(true);
    expect(ship.statuses).toEqual([
      { kind: 'invisible', buffId: 'B00I', expiresAtTick: 300, breaksOnAction: true },
    ]);
  });

  it('re-applied smoke refreshes (replaces) instead of stacking, keeping the ghost', () => {
    const rs = makeRuleset();
    const sub = makeShip(rs, 10, 2, 'south', 'H00W', 0, 0);
    sub.statuses.push(ghost(), smoke(150));
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [sub], 100);
    applyEquipmentActive(state, rs, 2, {
      kind: 'invisibility',
      durationTicks: 600,
      cooldownTicks: 4800,
      buffId: 'B00I',
    });
    const invis = sub.statuses.filter((s) => s.kind === 'invisible');
    expect(invis).toHaveLength(2); // ghost + one refreshed smoke
    expect(invis).toContainEqual(ghost());
    expect(invis).toContainEqual({
      kind: 'invisible',
      buffId: 'B00I',
      expiresAtTick: 700,
      breaksOnAction: true,
    });
  });

  it('sentry/spy ward placement clones the unit-type detection stats', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship], 100);
    const handled = applyEquipmentActive(
      state,
      rs,
      2,
      { kind: 'summonWard', wardTypeId: 'nvil', durationTicks: 10800, cooldownTicks: 0 },
      400,
      0,
    );
    expect(handled).toBe(true);
    const ward = state.entities[11]; // nextEntityId after ship id 10
    expect(ward).toMatchObject({
      kind: 'ward',
      typeId: 'nvil',
      owner: 2,
      team: 'south',
      x: 400,
      y: 0,
      detectionRadius: 1600,
      invulnerable: true,
      expiresAtTick: 10900,
    });
  });

  it('flare items create a detection zone only when they detect invisible', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship], 100);
    expect(
      applyEquipmentActive(
        state,
        rs,
        2,
        { kind: 'flare', radius: 1200, durationTicks: 300, cooldownTicks: 1200, detectsInvisible: true },
        600,
        600,
      ),
    ).toBe(true);
    expect(state.detectionZones).toEqual([
      { team: 'south', x: 600, y: 600, radius: 1200, expiresAtTick: 400 },
    ]);

    expect(
      applyEquipmentActive(
        state,
        rs,
        2,
        { kind: 'flare', radius: 1200, durationTicks: 300, cooldownTicks: 1200, detectsInvisible: false },
        -600,
        -600,
      ),
    ).toBe(true);
    expect(state.detectionZones).toHaveLength(1); // reveal-only: no zone
  });

  it('blink clamps to max distance; foreign kinds are not handled', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', 0, 0);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship], 100);
    expect(
      applyEquipmentActive(
        state,
        rs,
        2,
        { kind: 'blink', maxDistance: 1200, cooldownTicks: 1000 },
        2000,
        0,
      ),
    ).toBe(true);
    expect(ship.x).toBe(1200);
    expect(ship.y).toBe(0);

    expect(
      applyEquipmentActive(state, rs, 2, {
        kind: 'instantHeal',
        amount: 300,
        cooldownTicks: 900,
      }),
    ).toBe(false);
  });

  it('blink crosses a NON-water gap to far-side water within range (Light Teleporter)', () => {
    const rs = makeRuleset();
    // 8 cols x 1 row over the -2000..2000 box (cell 500 wide): cols 0-2 water,
    // cols 3-4 a LAND gap (x -500..500), cols 5-7 water. Normal MOVE pathing
    // cannot cross the land gap; the teleport must.
    rs.map.waterMask = {
      bounds: { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 },
      cols: 8,
      rows: 1,
      cellSizeX: 500,
      cellSizeY: 4000,
      cells: new Uint8Array([1, 1, 1, 0, 0, 1, 1, 1]),
    };
    const ship = makeShip(rs, 10, 2, 'south', 'H000', -750, 0); // col 2 (water)
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship], 100);
    expect(isWater(rs.map.waterMask, ship.x, ship.y)).toBe(true);

    const handled = applyEquipmentActive(
      state,
      rs,
      2,
      { kind: 'blink', maxDistance: 1200, cooldownTicks: 1000 },
      700, // far-side water (col 5)
      0,
    );
    expect(handled).toBe(true);
    // Landed across the land gap on the FAR (positive) side, on valid water.
    expect(ship.x).toBeGreaterThan(500);
    expect(isWater(rs.map.waterMask, ship.x, ship.y)).toBe(true);
    expect(ship.order).toEqual({ type: 'idle' });
  });

  it('blink is rejected (nothing consumed) when no water is reachable near the landing', () => {
    const rs = makeRuleset();
    // Entirely land -> nearestWater finds nothing -> reject. (The source cell
    // being land is irrelevant; blink never validates where it starts.)
    rs.map.waterMask = {
      bounds: { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 },
      cols: 8,
      rows: 1,
      cellSizeX: 500,
      cellSizeY: 4000,
      cells: new Uint8Array(8).fill(0),
    };
    const ship = makeShip(rs, 10, 2, 'south', 'H000', -750, 0);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship], 100);
    const handled = applyEquipmentActive(
      state,
      rs,
      2,
      { kind: 'blink', maxDistance: 1200, cooldownTicks: 1000 },
      700,
      0,
    );
    expect(handled).toBe(false); // caller consumes no charge/cooldown
    expect(ship.x).toBe(-750); // unmoved
    expect(ship.y).toBe(0);
  });

  it('blink breaks a net: the ship relocates AND the ensnared hold is cleared (escape)', () => {
    const rs = makeRuleset(); // stub mask -> all water
    const ship = makeShip(rs, 10, 2, 'south', 'H001', 0, 0);
    ship.statuses.push({ kind: 'ensnared', expiresAtTick: 260 });
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship], 100);

    const handled = applyEquipmentActive(
      state,
      rs,
      2,
      { kind: 'blink', maxDistance: 1200, cooldownTicks: 1000 },
      800,
      0,
    );
    expect(handled).toBe(true);
    expect(ship.x).toBe(800); // relocated
    expect(ship.statuses.some((s) => s.kind === 'ensnared')).toBe(false); // freed

    // And it can actually move next tick (no lingering root).
    ship.order = { type: 'move', x: 2000, y: 0 };
    const before = ship.x;
    stepMovement(state, rs);
    expect(ship.x).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// stepSpecials integration: tick is side-effect free without triggers
// ---------------------------------------------------------------------------

describe('stepSpecials', () => {
  it('is a pure visibility refresh when nothing is in any trigger region', () => {
    const rs = makeRuleset();
    const ship = makeShip(rs, 10, 2, 'south', 'H000', -500, 500);
    const state = makeState([makePlayer(2, 'south', { shipId: 10 })], [ship], 100);
    const rngBefore = state.rngState;
    stepSpecials(state, rs);
    expect(state.events).toEqual([]);
    expect(state.pendingDeaths).toEqual([]);
    expect(state.rngState).toBe(rngBefore); // specials draws only on missile launch
    expect(ship.vision).toEqual({ south: true, north: true });
  });
});
