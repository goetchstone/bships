/**
 * Progression module tests. All fixture state is hand-built (no dependency
 * on other modules' implementations). Balance numbers are the REAL Classic
 * values from data/json + SEMANTICS.md §6/§7:
 * - XP curve 50·(n²+n−2): 200/500/900/.../7700 (cap 12 provisional)
 * - kill XP by victim level: 25/40/60/85/115/150; hero 100..300 +100/level
 * - share radius 1200, summon factor 0.5
 * - bounties: h00I 5+2d10, h00H 25+2d50, h00E 0, n004 499+1d1, H000 79+1d1
 * - respawn: 2·level+5+rand(0,3) s (war3map.j:1836), invuln 5 s (100 ticks)
 * - skills: alsk=2 everywhere; A01Y Captain's Cannon 6 ranks arlv=1,
 *   A055 Goblin Bomber 1 rank arlv=8
 * - research: R000 Tower Defense 400 g/level ×10, 180 s (3600 ticks)
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../src/rng.js';
import { applyProgressionCommand, grantXp, stepProgression } from '../src/sim/progression.js';
import type {
  AttackType,
  CreepEntity,
  DefenseType,
  Entity,
  PlayerState,
  Ruleset,
  ShipEntity,
  SimEvent,
  SimState,
  StructureEntity,
  SummonEntity,
  TeamId,
  UnitTypeSpec,
  WardEntity,
} from '../src/sim/types.js';

// ---------------------------------------------------------------------------
// Ruleset fixture (real Classic data for everything progression reads)
// ---------------------------------------------------------------------------

const ATTACK_TYPES: readonly AttackType[] = [
  'normal',
  'pierce',
  'siege',
  'magic',
  'chaos',
  'spells',
  'hero',
];
const DEFENSE_TYPES: readonly DefenseType[] = [
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
  for (const a of ATTACK_TYPES) {
    const row = {} as Record<DefenseType, number>;
    for (const d of DEFENSE_TYPES) row[d] = 1;
    table[a] = row;
  }
  return table;
}

function unitType(
  typeId: string,
  name: string,
  level: number,
  bounty: { base: number; dice: number; sides: number },
  isStructure = false,
): UnitTypeSpec {
  return {
    typeId,
    name,
    maxHp: 100,
    armor: 0,
    defenseType: 'heavy',
    attack: null,
    moveSpeed: isStructure ? 0 : 200,
    turnRateRadPerTick: 0.333,
    collisionRadius: 16,
    isStructure,
    level,
    bounty,
    hpRegenPerTick: 0,
    sightRadius: 800,
    detectionRadius: null,
    permanentlyInvisible: false,
    invulnerable: false,
  };
}

function fixtureRuleset(): Ruleset {
  return {
    name: 'test-classic',
    tickRate: 20,
    constants: {
      startingGold: 1100,
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
    attackTypeVsDefense: flatTypeTable(),
    weapons: {},
    equipment: {},
    abilities: {
      // Captain's Cannon: alev=6, alsk=2, arlv default 1 (abilities.json A01Y).
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
      // Enforced Hull: passive hullHp skill, alev=6, alsk=2, arlv=1 (A007).
      A007: {
        abilityId: 'A007',
        name: 'Enforced Hull',
        kind: 'heroSkill',
        mechanic: 'hullHp',
        specialKey: null,
        skill: { abilityId: 'A007', ranks: 6, levelsPerRank: 2, minHeroLevel: 1 },
        magnitudePerRank: [100, 200, 300, 400, 500, 600],
        durationTicksPerRank: null,
        cooldownTicks: null,
        rangeUnits: null,
        weaponId: null,
      },
      // Goblin Bomber: 1 rank, arlv=8 (abilities.json A055).
      A055: {
        abilityId: 'A055',
        name: 'Goblin Bomber',
        kind: 'heroSkill',
        mechanic: 'special',
        specialKey: 'goblinBomber',
        skill: { abilityId: 'A055', ranks: 1, levelsPerRank: 2, minHeroLevel: 8 },
        magnitudePerRank: [1],
        durationTicksPerRank: null,
        cooldownTicks: null,
        rangeUnits: null,
        weaponId: null,
      },
    },
    ships: {
      // H000 starter: 200 raw HP -> 225 effective, bounty 79+1d1 = 80.
      H000: {
        typeId: 'H000',
        name: 'Battle Ship',
        properName: 'Sailor',
        gold: 200,
        rawHp: 200,
        rawArmor: 0,
        maxHp: 225,
        armor: -1.7,
        defenseType: 'hero',
        moveSpeed: 170,
        turnRateRadPerTick: 0.333,
        collisionRadius: 10,
        inventorySlots: 6,
        isSub: false,
        abilityIds: ['A01Y', 'A007', 'A03W', 'A009', 'A01D'],
        hpRegenPerTick: 0.0025,
        bounty: { base: 79, dice: 1, sides: 1 },
        sightRadius: 1400,
        detectionRadius: null,
        nativeAttackRangeUnits: null,
      },
      // Fixture hull carrying the Goblin Bomber skill for arlv=8 gating tests.
      H00D: {
        typeId: 'H00D',
        name: 'Goblin Ship',
        gold: 5000,
        rawHp: 1500,
        rawArmor: 0,
        maxHp: 1525,
        armor: -1.7,
        defenseType: 'hero',
        moveSpeed: 200,
        turnRateRadPerTick: 0.333,
        collisionRadius: 12,
        inventorySlots: 6,
        isSub: false,
        abilityIds: ['A055'],
        hpRegenPerTick: 0,
        bounty: { base: 499, dice: 1, sides: 1 },
        sightRadius: 1400,
        detectionRadius: null,
        nativeAttackRangeUnits: null,
      },
    },
    unitTypes: {
      // Lane creeps (units.json ulev/ubba/ubdi/ubsi verbatim).
      h00I: unitType('h00I', 'Imperial Rowboat', 2, { base: 5, dice: 2, sides: 10 }),
      h00H: unitType('h00H', 'Imperial Cruiser', 6, { base: 25, dice: 2, sides: 50 }),
      // Zero-bounty mirror twin (preserved data asymmetry).
      h00E: unitType('h00E', 'Imperial Rowboat', 1, { base: 0, dice: 0, sides: 0 }),
      // Cannon Tower: structure, bounty 499+1d1 = 500, no kill XP.
      n004: unitType('n004', 'Cannon Tower', 2, { base: 499, dice: 1, sides: 1 }, true),
      // Summon stand-in (level 6 pairs with the 150 XP row for the ×0.5 test).
      nba2: unitType('nba2', 'Leviathian', 6, { base: 349, dice: 1, sides: 1 }),
    },
    upgrades: {
      R000: {
        id: 'R000',
        name: 'Tower Defense',
        maxLevel: 10,
        researchable: true,
        goldCostPerLevel: [400, 400, 400, 400, 400, 400, 400, 400, 400, 400],
        researchTicks: 3600,
        appliesToUnitTypes: ['n004'],
        effect: { kind: 'flatMaxHp', perLevel: [500, 500, 500, 500, 500, 500, 500, 500, 500, 500] },
      },
      // R002 mirror: present in data but absent from n00P's ures list.
      R002: {
        id: 'R002',
        name: 'Tower Mechanics',
        maxLevel: 10,
        researchable: false,
        goldCostPerLevel: [2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500],
        researchTicks: 3600,
        appliesToUnitTypes: [],
        effect: { kind: 'flatHpRegen', perLevel: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10] },
      },
      // R003 mirror: pctBaseMaxHp FRACTIONS of base max HP (compiled /100).
      R003: {
        id: 'R003',
        name: 'Ship Hull',
        maxLevel: 10,
        researchable: true,
        goldCostPerLevel: [550, 550, 550, 550, 550, 550, 550, 550, 550, 550],
        researchTicks: 900,
        appliesToUnitTypes: ['h00I', 'h00H', 'h00E'],
        effect: { kind: 'pctBaseMaxHp', perLevel: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25] },
      },
      R005: {
        id: 'R005',
        name: 'Ship Cannons',
        maxLevel: 10,
        researchable: true,
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
      torpedoItemIds: [],
      maxTorpedoBaysPerSub: 1,
      bannedItemIds: [],
      diveAbilityId: 'A04C',
      diveCooldownTicks: 100,
    },
    missiles: {
      castAbilityId: 'A032',
      lumberItemId: 'I01N',
      throttleTicks: 40,
      warheads: {},
      targeting: 'randomEnemyLeadPlayerStructure',
      buggfixPeriodTicks: 200,
      buggfixSouthOnly: true,
    },
    suicideQuests: [],
    contracts: {
      lumberCosts: {},
      lumberRefunds: {},
      tradeRoutes: [],
      captainReward: {
        pieceItemId: 'I013',
        piecesRequired: 5,
        tokenItemId: 'I014',
        rewardGold: 200,
        rewardXp: 80,
        rewardLumber: 1,
      },
    },
    xp: {
      // 50·(n²+n−2) cumulative to reach level n; cap 12 provisional.
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
      byHumanCount: { 1: { perHumanSlot: 2, toTeamAi: 2 } },
      requiresNorthHqAlive: true,
      empireShareMinTicks: 1200,
      empireShareMaxTicks: 2400,
      goldDumpPeriodTicks: 600,
      streetMerchant: {
        rollAtTick: 1200,
        spawnAtTick: 2400,
        rollMin: 1,
        rollMax: 100,
        threshold: 50,
        merchantTypeId: 'n00S',
      },
    },
    map: {
      bounds: { minX: -7680, minY: -7680, maxX: 7680, maxY: 7680 },
      regions: {
        // Real rects from map-layout.json.
        SouthRespawn: {
          name: 'SouthRespawn',
          minX: -1024,
          minY: -6528,
          maxX: -768,
          maxY: -6272,
          centerX: -896,
          centerY: -6400,
        },
        NorthRespawn: {
          name: 'NorthRespawn',
          minX: -1280,
          minY: 5824,
          maxX: -1024,
          maxY: 6080,
          centerX: -1152,
          centerY: 5952,
        },
      },
      structures: [],
      playerStarts: {},
      startingShipTypeId: 'H000',
      lanes: [],
      waves: [],
      respawnRegionByTeam: { south: 'SouthRespawn', north: 'NorthRespawn' },
      repairBays: [],
      subTeleports: [],
      tempItemRegion: 'TempItem',
      streetMerchantRegions: { south: 'SouthMerchant', north: 'NorthMerchant' },
    },
  };
}

// ---------------------------------------------------------------------------
// State fixtures
// ---------------------------------------------------------------------------

function makePlayer(slot: number, team: TeamId, over: Partial<PlayerState> = {}): PlayerState {
  return {
    slot,
    team,
    control: slot <= 1 ? 'computer' : 'user',
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

const SEED = 1187;

function makeState(): SimState {
  return {
    tick: 100,
    rngState: SEED,
    nextEntityId: 1,
    status: { phase: 'playing' },
    enabledModes: [],
    players: {
      0: makePlayer(0, 'south'),
      1: makePlayer(1, 'north'),
      2: makePlayer(2, 'south'),
      3: makePlayer(3, 'south'),
      4: makePlayer(4, 'south'),
      7: makePlayer(7, 'north'),
      8: makePlayer(8, 'north'),
      9: makePlayer(9, 'north'),
      10: makePlayer(10, 'north'),
    },
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
      empireSharePeriodTicks: 1200,
      nextEmpireShareTick: 0,
      nextGoldDumpTick: 0,
      streetMerchantSpawnTick: null,
    },
  };
}

function addEntity(state: SimState, entity: Entity): void {
  state.entities[entity.id] = entity;
  if (state.nextEntityId <= entity.id) state.nextEntityId = entity.id + 1;
}

function addShip(
  state: SimState,
  id: number,
  owner: number,
  x: number,
  y: number,
  over: Partial<ShipEntity> = {},
): ShipEntity {
  const player = state.players[owner];
  const team = player ? player.team : 'south';
  const ship: ShipEntity = {
    id,
    kind: 'ship',
    typeId: 'H000',
    owner,
    team,
    x,
    y,
    facingRad: 0,
    dead: false,
    hp: 225,
    maxHp: 225,
    order: { type: 'idle' },
    statuses: [],
    vision: { south: team === 'south', north: team === 'north' },
    attackReadyAtTick: 0,
    casting: null,
    pausedUntilTick: 0,
    invulnerableUntilTick: 0,
    submerged: false,
    ...over,
  };
  addEntity(state, ship);
  if (player && !ship.dead) player.shipId = id;
  return ship;
}

function addCreep(state: SimState, id: number, typeId: string, team: TeamId): CreepEntity {
  const creep: CreepEntity = {
    id,
    kind: 'creep',
    typeId,
    owner: team === 'south' ? 0 : 1,
    team,
    x: 0,
    y: 0,
    facingRad: 0,
    dead: false,
    hp: 100,
    maxHp: 100,
    order: { type: 'idle' },
    statuses: [],
    vision: { south: true, north: true },
    attackReadyAtTick: 0,
    laneId: team === 'south' ? 'south-mid' : 'north-mid',
    waypointIndex: 0,
  };
  addEntity(state, creep);
  return creep;
}

function addStructure(state: SimState, id: number, typeId: string, team: TeamId): StructureEntity {
  const structure: StructureEntity = {
    id,
    kind: 'structure',
    typeId,
    owner: team === 'south' ? 0 : 1,
    team,
    instanceKey: `${typeId}_${id}`,
    role: 'tower',
    x: 0,
    y: 0,
    facingRad: 0,
    dead: false,
    hp: 6500,
    maxHp: 6500,
    statuses: [],
    attackReadyAtTick: 0,
    shopStock: null,
  };
  addEntity(state, structure);
  return structure;
}

function addWard(state: SimState, id: number, typeId: string, owner: number): WardEntity {
  const player = state.players[owner];
  const team = player ? player.team : 'south';
  const ward: WardEntity = {
    id,
    kind: 'ward',
    typeId,
    owner,
    team,
    x: 0,
    y: 0,
    facingRad: 0,
    dead: false,
    expiresAtTick: null,
    sightRadius: 800,
    detectionRadius: null,
    invisible: false,
    invulnerable: true,
  };
  addEntity(state, ward);
  return ward;
}

function addSummon(state: SimState, id: number, typeId: string, owner: number): SummonEntity {
  const player = state.players[owner];
  const team = player ? player.team : 'south';
  const summon: SummonEntity = {
    id,
    kind: 'summon',
    typeId,
    owner,
    team,
    x: 0,
    y: 0,
    facingRad: 0,
    dead: false,
    hp: 100,
    maxHp: 100,
    order: { type: 'idle' },
    statuses: [],
    vision: { south: true, north: true },
    attackReadyAtTick: 0,
    expiresAtTick: null,
  };
  addEntity(state, summon);
  return summon;
}

function pushDeath(
  state: SimState,
  entityId: number,
  killerPlayer: number | null,
  scripted = false,
): void {
  const entity = state.entities[entityId];
  if (!entity) throw new Error(`fixture: no entity ${entityId}`);
  entity.dead = true;
  const victimPlayer =
    entity.kind === 'ship' || entity.kind === 'summon' ? entity.owner : null;
  state.pendingDeaths.push({
    entityId,
    victimPlayer,
    killerPlayer,
    killerEntityId: null,
    scripted,
  });
}

function eventsOf<T extends SimEvent['type']>(
  state: SimState,
  type: T,
): Extract<SimEvent, { type: T }>[] {
  return state.events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

/** Replay the seeded Rng to compute expected draws + final rng state. */
function expectedRolls(
  seed: number,
  rolls: [number, number][],
): { values: number[]; state: number } {
  const rng = Rng.fromState(seed);
  const values = rolls.map(([lo, hi]) => rng.int(lo, hi));
  return { values, state: rng.getState() };
}

function player(state: SimState, slot: number): PlayerState {
  const p = state.players[slot];
  if (!p) throw new Error(`fixture: no player ${slot}`);
  return p;
}

// ---------------------------------------------------------------------------
// grantXp — curve, cap, skill points
// ---------------------------------------------------------------------------

describe('grantXp', () => {
  it('reaches level 2 at exactly 200 xp and grants a skill point', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    grantXp(state, rs, 2, 200, 'tome');
    const p = player(state, 2);
    expect(p.xp).toBe(200);
    expect(p.level).toBe(2);
    expect(p.unspentSkillPoints).toBe(1);
    expect(eventsOf(state, 'xpGained')).toEqual([
      { type: 'xpGained', tick: 100, player: 2, amount: 200, reason: 'tome' },
    ]);
    expect(eventsOf(state, 'levelUp')).toEqual([
      { type: 'levelUp', tick: 100, player: 2, level: 2 },
    ]);
  });

  it('199 xp stays level 1', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    grantXp(state, rs, 2, 199, 'tome');
    expect(player(state, 2).level).toBe(1);
    expect(player(state, 2).unspentSkillPoints).toBe(0);
    expect(eventsOf(state, 'levelUp')).toHaveLength(0);
  });

  it('one grant can cross multiple thresholds (500 xp -> level 3, 2 points)', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    grantXp(state, rs, 2, 500, 'quest:suicideRun');
    const p = player(state, 2);
    expect(p.level).toBe(3);
    expect(p.unspentSkillPoints).toBe(2);
    expect(eventsOf(state, 'levelUp').map((e) => e.level)).toEqual([2, 3]);
  });

  it('clamps xp at the heroLevelCap threshold (7700) and stops leveling', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const p = player(state, 2);
    p.level = 11;
    p.xp = 6500;
    grantXp(state, rs, 2, 100000, 'tome');
    expect(p.level).toBe(12);
    expect(p.xp).toBe(7700);
    expect(p.unspentSkillPoints).toBe(1);
    expect(eventsOf(state, 'xpGained')).toEqual([
      { type: 'xpGained', tick: 100, player: 2, amount: 1200, reason: 'tome' },
    ]);
    expect(eventsOf(state, 'levelUp').map((e) => e.level)).toEqual([12]);
  });

  it('grants at the cap with full xp are no-ops (no events)', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const p = player(state, 2);
    p.level = 12;
    p.xp = 7700;
    grantXp(state, rs, 2, 500, 'tome');
    expect(p.xp).toBe(7700);
    expect(state.events).toHaveLength(0);
  });

  it('ignores unknown player slots and non-positive amounts', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    grantXp(state, rs, 5, 100, 'tome');
    grantXp(state, rs, 2, 0, 'tome');
    expect(state.events).toHaveLength(0);
    expect(player(state, 2).xp).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Kill XP — table, split, remainder, fallback, structure/summon/scripted
// ---------------------------------------------------------------------------

describe('kill XP', () => {
  it('level-2 lane creep pays 40, split evenly across killing-team ships in 1200', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addCreep(state, 5, 'h00I', 'south');
    addShip(state, 10, 7, 300, 0);
    addShip(state, 11, 8, 0, 1200); // exactly at the share radius -> included
    pushDeath(state, 5, 7);
    stepProgression(state, rs);
    expect(player(state, 7).xp).toBe(20);
    expect(player(state, 8).xp).toBe(20);
    expect(eventsOf(state, 'xpGained')).toEqual([
      { type: 'xpGained', tick: 100, player: 7, amount: 20, reason: 'kill' },
      { type: 'xpGained', tick: 100, player: 8, amount: 20, reason: 'kill' },
    ]);
  });

  it('ships beyond 1200 of the death do not share', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addCreep(state, 5, 'h00I', 'south');
    addShip(state, 10, 7, 0, 0);
    addShip(state, 11, 8, 0, 1201); // 1 unit out of range
    pushDeath(state, 5, 7);
    stepProgression(state, rs);
    expect(player(state, 7).xp).toBe(40);
    expect(player(state, 8).xp).toBe(0);
  });

  it('integer split gives the remainder to the lowest-id ship (150 / 4 = 39/37/37/37)', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addCreep(state, 5, 'h00H', 'south'); // level 6 cruiser -> 150 XP
    addShip(state, 10, 8, 100, 0);
    addShip(state, 11, 7, -100, 0);
    addShip(state, 12, 9, 0, 100);
    addShip(state, 13, 10, 0, -100);
    pushDeath(state, 5, 7);
    stepProgression(state, rs);
    // Lowest entity id 10 belongs to player 8 -> it takes 37 + remainder 2.
    expect(player(state, 8).xp).toBe(39);
    expect(player(state, 7).xp).toBe(37);
    expect(player(state, 9).xp).toBe(37);
    expect(player(state, 10).xp).toBe(37);
  });

  it('falls back to full XP for the killing player when no ship is in range', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addCreep(state, 5, 'h00H', 'south');
    addShip(state, 10, 7, 5000, 5000); // far away
    pushDeath(state, 5, 7);
    stepProgression(state, rs);
    expect(player(state, 7).xp).toBe(150);
    expect(eventsOf(state, 'xpGained')).toEqual([
      { type: 'xpGained', tick: 100, player: 7, amount: 150, reason: 'kill' },
    ]);
  });

  it('dead ships and enemy-team ships never share', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addCreep(state, 5, 'h00H', 'south');
    addShip(state, 10, 7, 0, 0);
    addShip(state, 11, 8, 50, 0, { dead: true });
    addShip(state, 12, 3, 60, 0); // south ship (victim's own side)
    pushDeath(state, 5, 7);
    stepProgression(state, rs);
    expect(player(state, 7).xp).toBe(150);
    expect(player(state, 8).xp).toBe(0);
    expect(player(state, 3).xp).toBe(0);
  });

  it('structures grant no kill XP with buildingKillsGiveXp off, but pay their bounty (n004 -> 500 gold)', () => {
    const rs = fixtureRuleset();
    rs.xp.buildingKillsGiveXp = false; // engine default
    const state = makeState();
    addStructure(state, 5, 'n004', 'south');
    addShip(state, 10, 7, 0, 0);
    pushDeath(state, 5, 7);
    stepProgression(state, rs);
    expect(eventsOf(state, 'xpGained')).toHaveLength(0);
    expect(player(state, 7).xp).toBe(0);
    expect(player(state, 7).gold).toBe(500); // 499 + 1d1
    expect(eventsOf(state, 'bounty')).toEqual([
      { type: 'bounty', tick: 100, player: 7, amount: 500, victimEntityId: 5 },
    ]);
  });

  it('war3mapMisc.txt BuildingKillsGiveExp=1: a structure kill grants normal-table XP at its own level (n004 level 2 -> 40), plus its bounty', () => {
    const rs = fixtureRuleset();
    rs.xp.buildingKillsGiveXp = true; // war3mapMisc.txt override
    const state = makeState();
    addStructure(state, 5, 'n004', 'south'); // fixture unitType level 2
    addShip(state, 10, 7, 0, 0);
    pushDeath(state, 5, 7);
    stepProgression(state, rs);
    expect(player(state, 7).xp).toBe(40); // killXpByVictimLevel[2] (fixture table)
    expect(player(state, 7).gold).toBe(500); // 499 + 1d1, unaffected by the flag
    expect(eventsOf(state, 'xpGained')).toEqual([
      { type: 'xpGained', tick: 100, player: 7, amount: 40, reason: 'kill' },
    ]);
  });

  it('wards grant no kill XP even with buildingKillsGiveXp on', () => {
    const rs = fixtureRuleset();
    rs.xp.buildingKillsGiveXp = true;
    const state = makeState();
    addWard(state, 5, 'n004', 1); // ward entity kind, not a structure, regardless of typeId
    addShip(state, 10, 7, 0, 0);
    pushDeath(state, 5, 7);
    stepProgression(state, rs);
    expect(eventsOf(state, 'xpGained')).toHaveLength(0);
    expect(player(state, 7).xp).toBe(0);
  });

  it('summons pay floor(normalXp × summonFactor) (level 6 -> 75)', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addSummon(state, 5, 'nba2', 2);
    addShip(state, 10, 7, 0, 0);
    pushDeath(state, 5, 7);
    stepProgression(state, rs);
    expect(player(state, 7).xp).toBe(75);
  });

  it('hero victims pay the hero table (level 3 -> 160; level 7 -> 300 + 2×100)', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    player(state, 7).level = 3;
    addShip(state, 5, 7, 0, 0);
    addShip(state, 10, 2, 100, 0);
    pushDeath(state, 5, 2);
    stepProgression(state, rs);
    expect(player(state, 2).xp).toBe(160);

    const state2 = makeState();
    player(state2, 7).level = 7;
    addShip(state2, 5, 7, 0, 0);
    addShip(state2, 10, 2, 100, 0);
    pushDeath(state2, 5, 2);
    stepProgression(state2, rs);
    expect(player(state2, 2).xp).toBe(500);
  });

  it('scripted deaths grant no XP or bounty but still schedule the hero respawn', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    player(state, 7).level = 4;
    addShip(state, 5, 7, 0, 0);
    addShip(state, 10, 2, 100, 0);
    pushDeath(state, 5, 2, true);
    const expected = expectedRolls(SEED, [[0, 3]]); // jitter only, no bounty dice
    stepProgression(state, rs);
    expect(player(state, 2).xp).toBe(0);
    expect(player(state, 2).gold).toBe(0);
    expect(eventsOf(state, 'bounty')).toHaveLength(0);
    expect(player(state, 7).shipId).toBeNull();
    const jitter = expected.values[0] ?? 0;
    expect(player(state, 7).respawnAtTick).toBe(100 + (2 * 4 + 5 + jitter) * 20);
    expect(state.rngState).toBe(expected.state);
  });

  it('deaths with no killer grant nothing and draw nothing', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addCreep(state, 5, 'h00I', 'south');
    addShip(state, 10, 7, 0, 0);
    pushDeath(state, 5, null);
    stepProgression(state, rs);
    expect(player(state, 7).xp).toBe(0);
    expect(player(state, 7).gold).toBe(0);
    expect(state.rngState).toBe(SEED);
  });
});

// ---------------------------------------------------------------------------
// Bounty dice determinism
// ---------------------------------------------------------------------------

describe('bounty', () => {
  it('pays base + independent per-die rolls matching the seeded Rng (h00I 5+2d10)', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addCreep(state, 5, 'h00I', 'south');
    pushDeath(state, 5, 7);
    const expected = expectedRolls(SEED, [
      [1, 10],
      [1, 10],
    ]);
    stepProgression(state, rs);
    const amount = 5 + (expected.values[0] ?? 0) + (expected.values[1] ?? 0);
    expect(player(state, 7).gold).toBe(amount);
    expect(eventsOf(state, 'bounty')).toEqual([
      { type: 'bounty', tick: 100, player: 7, amount, victimEntityId: 5 },
    ]);
    // Exactly two draws were consumed.
    expect(state.rngState).toBe(expected.state);
  });

  // A zero-bounty unit pays nothing and draws no rng. The fixture's h00E is a
  // FORCED-zero stand-in for the mechanism (wards/missile dummies are 0 too); the
  // real Classic h00E now PAYS via the owner BOUNTY_TWIN_COUNTERPART override.
  it('a zero-bounty unit pays nothing and consumes no rng', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addCreep(state, 5, 'h00E', 'north');
    pushDeath(state, 5, 2);
    stepProgression(state, rs);
    expect(player(state, 2).gold).toBe(0);
    expect(eventsOf(state, 'bounty')).toHaveLength(0);
    expect(state.rngState).toBe(SEED);
  });

  it('processes pendingDeaths in array order (rng sequence covers both bounties)', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addCreep(state, 5, 'h00I', 'south');
    addCreep(state, 6, 'h00H', 'south');
    pushDeath(state, 5, 7);
    pushDeath(state, 6, 8);
    const expected = expectedRolls(SEED, [
      [1, 10],
      [1, 10],
      [1, 50],
      [1, 50],
    ]);
    stepProgression(state, rs);
    expect(player(state, 7).gold).toBe(5 + (expected.values[0] ?? 0) + (expected.values[1] ?? 0));
    expect(player(state, 8).gold).toBe(25 + (expected.values[2] ?? 0) + (expected.values[3] ?? 0));
    expect(state.rngState).toBe(expected.state);
  });
});

// ---------------------------------------------------------------------------
// Respawn — scheduling formula, execution, invulnerability
// ---------------------------------------------------------------------------

describe('respawn', () => {
  it('schedules with the JASS formula: (2·level + 5 + rand(0,3)) seconds in ticks', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    player(state, 7).level = 4;
    addShip(state, 5, 7, 0, 0); // H000 bounty 79+1d1 -> one draw before jitter
    pushDeath(state, 5, 2);
    const expected = expectedRolls(SEED, [
      [1, 1],
      [0, 3],
    ]);
    stepProgression(state, rs);
    const p = player(state, 7);
    expect(p.shipId).toBeNull();
    const jitter = expected.values[1] ?? 0;
    expect(p.respawnAtTick).toBe(100 + (2 * 4 + 5 + jitter) * 20);
    expect(player(state, 2).gold).toBe(80); // 79 + 1d1
    expect(state.rngState).toBe(expected.state);
  });

  it('spawns a fresh invulnerable ship at the team respawn region center', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const p = player(state, 7);
    p.respawnAtTick = 100;
    p.inventory[0] = { itemId: 'I001', charges: null, readyAtTick: 0 };
    state.nextEntityId = 42;
    stepProgression(state, rs);
    expect(p.shipId).toBe(42);
    expect(p.respawnAtTick).toBeNull();
    const ship = state.entities[42];
    expect(ship).toBeDefined();
    if (!ship || ship.kind !== 'ship') throw new Error('expected ship entity');
    expect(ship.typeId).toBe('H000');
    expect(ship.owner).toBe(7);
    expect(ship.team).toBe('north');
    expect(ship.x).toBe(-1152); // NorthRespawn center (map-layout.json)
    expect(ship.y).toBe(5952);
    expect(ship.hp).toBe(225);
    expect(ship.maxHp).toBe(225);
    expect(ship.invulnerableUntilTick).toBe(100 + 100); // 5 s at 20 ticks/s
    expect(ship.dead).toBe(false);
    // Inventory untouched — it lives on PlayerState.
    expect(p.inventory[0]).toEqual({ itemId: 'I001', charges: null, readyAtTick: 0 });
    expect(eventsOf(state, 'respawn')).toEqual([
      { type: 'respawn', tick: 100, player: 7, entityId: 42 },
    ]);
  });

  it('south players revive at the SouthRespawn center', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    player(state, 2).respawnAtTick = 99; // overdue still fires
    stepProgression(state, rs);
    const id = player(state, 2).shipId;
    expect(id).not.toBeNull();
    const ship = id === null ? undefined : state.entities[id];
    if (!ship || ship.kind !== 'ship') throw new Error('expected ship entity');
    expect(ship.x).toBe(-896);
    expect(ship.y).toBe(-6400);
  });

  it('does nothing before respawnAtTick', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    player(state, 7).respawnAtTick = 101;
    stepProgression(state, rs);
    expect(player(state, 7).shipId).toBeNull();
    expect(player(state, 7).respawnAtTick).toBe(101);
    expect(state.events).toHaveLength(0);
  });

  it('simultaneous respawns allocate entity ids in ascending player-slot order', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    player(state, 8).respawnAtTick = 100;
    player(state, 2).respawnAtTick = 100;
    state.nextEntityId = 7;
    stepProgression(state, rs);
    expect(player(state, 2).shipId).toBe(7);
    expect(player(state, 8).shipId).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// learnSkill — alsk=2 ladder, arlv=8 unlock, points, rejection semantics
// ---------------------------------------------------------------------------

describe('learnSkill', () => {
  it("learns Captain's Cannon rank 1 at hero level 1 and spends the point", () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const p = player(state, 2);
    p.unspentSkillPoints = 1;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A01Y' });
    expect(p.heroSkillLevels['A01Y']).toBe(1);
    expect(p.unspentSkillPoints).toBe(0);
    expect(eventsOf(state, 'commandRejected')).toHaveLength(0);
  });

  it('free spending (Classic default, skillLevelGated=false): rank 2 at hero level 1', () => {
    const rs = fixtureRuleset();
    rs.xp.skillLevelGated = false; // owner-directed default: no per-rank level gate
    const state = makeState();
    const p = player(state, 2);
    p.heroSkillLevels['A01Y'] = 1;
    p.unspentSkillPoints = 1;
    p.level = 1; // would be too low for rank 2 under the WC3 alsk gate
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A01Y' });
    expect(p.heroSkillLevels['A01Y']).toBe(2);
    expect(p.unspentSkillPoints).toBe(0);
    expect(eventsOf(state, 'commandRejected')).toHaveLength(0);
  });

  it('rank 2 requires hero level 3 (alsk=2) when the level gate is enabled', () => {
    const rs = fixtureRuleset();
    rs.xp.skillLevelGated = true; // faithful WC3 alsk ladder (off by default)
    const state = makeState();
    const p = player(state, 2);
    p.heroSkillLevels['A01Y'] = 1;
    p.unspentSkillPoints = 1;
    p.level = 2;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A01Y' });
    expect(p.heroSkillLevels['A01Y']).toBe(1);
    expect(p.unspentSkillPoints).toBe(1);
    expect(eventsOf(state, 'commandRejected')).toEqual([
      {
        type: 'commandRejected',
        tick: 100,
        player: 2,
        commandType: 'learnSkill',
        reason: 'levelTooLow',
      },
    ]);
    p.level = 3;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A01Y' });
    expect(p.heroSkillLevels['A01Y']).toBe(2);
  });

  it('rank 6 requires hero level 11 when the level gate is enabled', () => {
    const rs = fixtureRuleset();
    rs.xp.skillLevelGated = true;
    const state = makeState();
    const p = player(state, 2);
    p.heroSkillLevels['A01Y'] = 5;
    p.unspentSkillPoints = 1;
    p.level = 10;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A01Y' });
    expect(p.heroSkillLevels['A01Y']).toBe(5);
    p.level = 11;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A01Y' });
    expect(p.heroSkillLevels['A01Y']).toBe(6);
  });

  it('rejects past max rank', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const p = player(state, 2);
    p.heroSkillLevels['A01Y'] = 6;
    p.unspentSkillPoints = 1;
    p.level = 12;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A01Y' });
    expect(p.heroSkillLevels['A01Y']).toBe(6);
    expect(eventsOf(state, 'commandRejected')[0]?.reason).toBe('maxRank');
  });

  it('Goblin Bomber (arlv=8) unlocks at hero level 8, not 7, when the level gate is enabled', () => {
    const rs = fixtureRuleset();
    rs.xp.skillLevelGated = true;
    const state = makeState();
    const p = player(state, 2);
    p.shipTypeId = 'H00D';
    p.unspentSkillPoints = 1;
    p.level = 7;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A055' });
    expect(p.heroSkillLevels['A055']).toBeUndefined();
    expect(eventsOf(state, 'commandRejected')[0]?.reason).toBe('levelTooLow');
    p.level = 8;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A055' });
    expect(p.heroSkillLevels['A055']).toBe(1);
  });

  it('rejects without an unspent skill point', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const p = player(state, 2);
    p.level = 5;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A01Y' });
    expect(p.heroSkillLevels['A01Y']).toBeUndefined();
    expect(eventsOf(state, 'commandRejected')[0]?.reason).toBe('noSkillPoints');
  });

  it('rejects skills not on the current hull and unknown abilities', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const p = player(state, 2);
    p.unspentSkillPoints = 1;
    p.level = 12;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A055' });
    expect(eventsOf(state, 'commandRejected')[0]?.reason).toBe('notOnShip');
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'AXXX' });
    expect(eventsOf(state, 'commandRejected')[1]?.reason).toBe('notASkill');
    expect(p.unspentSkillPoints).toBe(1);
  });

  it('passive hullHp skill increments its rank (stat recompute owned by economy)', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const p = player(state, 2);
    p.unspentSkillPoints = 1;
    applyProgressionCommand(state, rs, { type: 'learnSkill', player: 2, abilityId: 'A007' });
    expect(p.heroSkillLevels['A007']).toBe(1);
    expect(p.unspentSkillPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Research — start, completion, team sharing
// ---------------------------------------------------------------------------

describe('research', () => {
  it('charges the commanding player and queues team research (R000: 400 g, 3600 ticks)', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    player(state, 2).gold = 1000;
    applyProgressionCommand(state, rs, { type: 'research', player: 2, upgradeId: 'R000' });
    expect(player(state, 2).gold).toBe(600);
    expect(state.teams.south.research).toEqual({ upgradeId: 'R000', completesAtTick: 3700 });
    expect(eventsOf(state, 'researchStarted')).toEqual([
      { type: 'researchStarted', tick: 100, team: 'south', upgradeId: 'R000', level: 1 },
    ]);
  });

  it('rejects when gold is short, the slot is busy, or the upgrade is unknown/maxed', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const p = player(state, 2);
    p.gold = 399;
    applyProgressionCommand(state, rs, { type: 'research', player: 2, upgradeId: 'R000' });
    expect(eventsOf(state, 'commandRejected')[0]?.reason).toBe('insufficientGold');
    expect(p.gold).toBe(399);
    expect(state.teams.south.research).toBeNull();

    p.gold = 2000;
    state.teams.south.research = { upgradeId: 'R005', completesAtTick: 500 };
    applyProgressionCommand(state, rs, { type: 'research', player: 2, upgradeId: 'R000' });
    expect(eventsOf(state, 'commandRejected')[1]?.reason).toBe('researchBusy');
    expect(p.gold).toBe(2000);

    state.teams.south.research = null;
    applyProgressionCommand(state, rs, { type: 'research', player: 2, upgradeId: 'R999' });
    expect(eventsOf(state, 'commandRejected')[2]?.reason).toBe('unknownUpgrade');

    state.teams.south.upgrades['R000'] = 10;
    applyProgressionCommand(state, rs, { type: 'research', player: 2, upgradeId: 'R000' });
    expect(eventsOf(state, 'commandRejected')[3]?.reason).toBe('maxLevel');
    expect(p.gold).toBe(2000);
  });

  it('completes due research into TeamState.upgrades and frees the slot', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    state.teams.south.research = { upgradeId: 'R000', completesAtTick: 100 };
    stepProgression(state, rs);
    expect(state.teams.south.upgrades['R000']).toBe(1);
    expect(state.teams.south.research).toBeNull();
    expect(eventsOf(state, 'researchComplete')).toEqual([
      { type: 'researchComplete', tick: 100, team: 'south', upgradeId: 'R000', level: 1 },
    ]);
  });

  it('does not complete research early', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    state.teams.south.research = { upgradeId: 'R000', completesAtTick: 101 };
    stepProgression(state, rs);
    expect(state.teams.south.upgrades['R000']).toBeUndefined();
    expect(state.teams.south.research).toEqual({ upgradeId: 'R000', completesAtTick: 101 });
  });

  it('levels are team-shared: a teammate continues at the next level, enemies start fresh', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    state.teams.south.upgrades['R000'] = 1;
    player(state, 3).gold = 400;
    applyProgressionCommand(state, rs, { type: 'research', player: 3, upgradeId: 'R000' });
    expect(player(state, 3).gold).toBe(0);
    expect(eventsOf(state, 'researchStarted')[0]?.level).toBe(2);

    player(state, 7).gold = 400;
    applyProgressionCommand(state, rs, { type: 'research', player: 7, upgradeId: 'R000' });
    expect(eventsOf(state, 'researchStarted')[1]).toEqual({
      type: 'researchStarted',
      tick: 100,
      team: 'north',
      upgradeId: 'R000',
      level: 1,
    });
    expect(state.teams.north.upgrades['R000']).toBeUndefined();
  });

  it('both teams complete independently in south-then-north order on the same tick', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    state.teams.south.research = { upgradeId: 'R000', completesAtTick: 100 };
    state.teams.north.research = { upgradeId: 'R005', completesAtTick: 100 };
    stepProgression(state, rs);
    const done = eventsOf(state, 'researchComplete');
    expect(done.map((e) => e.team)).toEqual(['south', 'north']);
    expect(state.teams.south.upgrades['R000']).toBe(1);
    expect(state.teams.north.upgrades['R005']).toBe(1);
  });

  it("rejects upgrades absent from the Upgrade Center's research list (R002)", () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const p = player(state, 2);
    p.gold = 99999;
    applyProgressionCommand(state, rs, { type: 'research', player: 2, upgradeId: 'R002' });
    expect(eventsOf(state, 'commandRejected')[0]?.reason).toBe('notResearchable');
    expect(p.gold).toBe(99999);
    expect(state.teams.south.research).toBeNull();
  });

  it('R000 completion immediately buffs STANDING towers of the researching team only', () => {
    // WC3 applies a finished upgrade to existing units — the pre-placed
    // n004 towers never respawn, so this is R000''s only effect path.
    const rs = fixtureRuleset();
    const state = makeState();
    const southTower = addStructure(state, 30, 'n004', 'south');
    const northTower = addStructure(state, 31, 'n004', 'north');
    southTower.hp = 6000;
    state.teams.south.research = { upgradeId: 'R000', completesAtTick: 100 };
    stepProgression(state, rs);
    expect(southTower.maxHp).toBe(7000); // 6500 + 500 (L1)
    expect(southTower.hp).toBe(6500); // current hp rises by the same delta
    expect(northTower.maxHp).toBe(6500); // enemy towers untouched
    expect(northTower.hp).toBe(6500);
  });

  it('R003 completion applies the pctBaseMaxHp fraction to LIVING lane creeps', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    const creep = addCreep(state, 30, 'h00I', 'south'); // base maxHp 100
    const enemyCreep = addCreep(state, 31, 'h00I', 'north');
    state.teams.south.research = { upgradeId: 'R003', completesAtTick: 100 };
    stepProgression(state, rs);
    expect(creep.maxHp).toBe(125); // +25% of the BASE (unit-type) max HP
    expect(creep.hp).toBe(125);
    expect(enemyCreep.maxHp).toBe(100);
  });

  it('flatMoveSpeed completion extends the speedAura encoding on live creeps', () => {
    const rs = fixtureRuleset();
    rs.upgrades['R004'] = {
      id: 'R004',
      name: 'Ship Sails',
      maxLevel: 10,
      researchable: true,
      goldCostPerLevel: Array(10).fill(500) as number[],
      researchTicks: 900,
      appliesToUnitTypes: ['h00I'],
      effect: { kind: 'flatMoveSpeed', perLevel: Array(10).fill(10) as number[] },
    };
    const state = makeState();
    const creep = addCreep(state, 30, 'h00I', 'south'); // base speed 200
    state.teams.south.research = { upgradeId: 'R004', completesAtTick: 100 };
    stepProgression(state, rs);
    expect(creep.statuses).toEqual([
      { kind: 'speedAura', moveSpeedPct: 10 / 200, sourceAbilityId: 'R004' },
    ]);
    // A second level ACCUMULATES on the same aura.
    state.teams.south.research = { upgradeId: 'R004', completesAtTick: 100 };
    stepProgression(state, rs);
    expect(creep.statuses).toEqual([
      { kind: 'speedAura', moveSpeedPct: 20 / 200, sourceAbilityId: 'R004' },
    ]);
  });
});

describe('kill XP global fallback gating', () => {
  it('grants nothing to a killing player without a living hero ship (AI empire slots)', () => {
    const rs = fixtureRuleset();
    const state = makeState();
    addCreep(state, 5, 'h00H', 'south');
    // Killer is the north AI empire (slot 1) — it never has a hero ship.
    pushDeath(state, 5, 1);
    stepProgression(state, rs);
    expect(player(state, 1).xp).toBe(0);
    expect(eventsOf(state, 'xpGained')).toHaveLength(0);
  });
});
