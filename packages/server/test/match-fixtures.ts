/**
 * Synthetic-world fixtures for the server-match tests (visibility.test.ts,
 * snapshot.test.ts). A hand-built minimal SimState + a tiny cast Ruleset let
 * the fog/snapshot rules be tested with exact distances, independent of the
 * real map data (match.test.ts covers the real-ruleset integration).
 */

import type {
  CreepEntity,
  PlayerState,
  Projectile,
  Ruleset,
  ShipEntity,
  SimState,
  StructureEntity,
  SummonEntity,
  TeamId,
  WardEntity,
} from '@bships/core';

/**
 * Only the fields visibility.ts/snapshot.ts read (ships/unitTypes radii).
 * Cast: the modules under test never touch the rest of the Ruleset.
 */
export const testRuleset = {
  ships: {
    SHIP: { sightRadius: 800, detectionRadius: null },
    DETSHIP: { sightRadius: 800, detectionRadius: 600 },
  },
  unitTypes: {
    TOWER: { sightRadius: 900, detectionRadius: null },
    CREEP: { sightRadius: 500, detectionRadius: null },
  },
} as unknown as Ruleset;

export function makeState(tick = 100): SimState {
  return {
    tick,
    rngState: 1,
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

export function makePlayer(slot: number, team: TeamId): PlayerState {
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
    shipTypeId: 'SHIP',
    shipId: null,
    inventory: [null, null, null, null, null, null],
    cooldownGroups: {},
    missileReadyAtTick: 0,
    respawnAtTick: null,
    goldDumpEnabled: false,
  };
}

function nextId(state: SimState): number {
  const id = state.nextEntityId;
  state.nextEntityId += 1;
  return id;
}

export function addShip(
  state: SimState,
  team: TeamId,
  x: number,
  y: number,
  opts: Partial<ShipEntity> = {},
): ShipEntity {
  const id = nextId(state);
  const ship: ShipEntity = {
    id,
    kind: 'ship',
    typeId: 'SHIP',
    x,
    y,
    facingRad: 0,
    dead: false,
    owner: team === 'south' ? 2 : 7,
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
    ...opts,
  };
  state.entities[id] = ship;
  return ship;
}

export function addCreep(
  state: SimState,
  team: TeamId,
  x: number,
  y: number,
  opts: Partial<CreepEntity> = {},
): CreepEntity {
  const id = nextId(state);
  const creep: CreepEntity = {
    id,
    kind: 'creep',
    typeId: 'CREEP',
    x,
    y,
    facingRad: 0,
    dead: false,
    owner: team === 'south' ? 0 : 1,
    team,
    hp: 50,
    maxHp: 50,
    order: { type: 'idle' },
    statuses: [],
    vision: { south: true, north: true },
    attackReadyAtTick: 0,
    laneId: 'lane',
    waypointIndex: 0,
    ...opts,
  };
  state.entities[id] = creep;
  return creep;
}

export function addSummon(
  state: SimState,
  team: TeamId,
  x: number,
  y: number,
  opts: Partial<SummonEntity> = {},
): SummonEntity {
  const id = nextId(state);
  const summon: SummonEntity = {
    id,
    kind: 'summon',
    typeId: 'CREEP',
    x,
    y,
    facingRad: 0,
    dead: false,
    owner: team === 'south' ? 2 : 7,
    team,
    hp: 50,
    maxHp: 50,
    order: { type: 'idle' },
    statuses: [],
    vision: { south: true, north: true },
    attackReadyAtTick: 0,
    expiresAtTick: null,
    ...opts,
  };
  state.entities[id] = summon;
  return summon;
}

export function addStructure(
  state: SimState,
  team: TeamId | null,
  x: number,
  y: number,
  opts: Partial<StructureEntity> = {},
): StructureEntity {
  const id = nextId(state);
  const structure: StructureEntity = {
    id,
    kind: 'structure',
    typeId: 'TOWER',
    x,
    y,
    facingRad: 0,
    dead: false,
    owner: team === null ? null : team === 'south' ? 2 : 7,
    team,
    instanceKey: `TOWER_${id}`,
    role: 'tower',
    hp: 1000,
    maxHp: 1000,
    statuses: [],
    attackReadyAtTick: 0,
    shopStock: null,
    ...opts,
  };
  state.entities[id] = structure;
  return structure;
}

export function addWard(
  state: SimState,
  team: TeamId,
  x: number,
  y: number,
  opts: Partial<WardEntity> = {},
): WardEntity {
  const id = nextId(state);
  const ward: WardEntity = {
    id,
    kind: 'ward',
    typeId: 'WARD',
    x,
    y,
    facingRad: 0,
    dead: false,
    owner: team === 'south' ? 2 : 7,
    team,
    expiresAtTick: null,
    sightRadius: 400,
    detectionRadius: null,
    invisible: true,
    invulnerable: true,
    ...opts,
  };
  state.entities[id] = ward;
  return ward;
}

export function addProjectile(
  state: SimState,
  team: TeamId,
  x: number,
  y: number,
  opts: Partial<Projectile> = {},
): Projectile {
  const id = nextId(state);
  const projectile: Projectile = {
    id,
    ownerPlayer: team === 'south' ? 2 : 7,
    team,
    sourceEntityId: null,
    weaponId: 'I000',
    mechanic: 'phoenixFire',
    x,
    y,
    speedPerTick: 30,
    homingTargetId: null,
    targetX: x,
    targetY: y,
    intendedTargetId: null,
    payload: { amount: 10, attackType: 'pierce', damageType: 'physical', noTypeMult: false },
    ...opts,
  };
  state.projectiles[id] = projectile;
  return projectile;
}
