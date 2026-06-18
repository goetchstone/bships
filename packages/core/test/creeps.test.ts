/**
 * Creep AI unit tests — focused on the hold-at-tower behavior added by the
 * creep-ai module (docs/TERRAIN.md §4). A live lane creep must target the
 * frontmost living enemy structure in its lane (towers first, then HQ),
 * hold/attack it rather than advance past, and resume forward once it dies.
 *
 * These are stand-alone fixtures: stepCreeps reads only
 * ruleset.map.{lanes,waves,regions}, ruleset.unitTypes/upgrades, and
 * state.teams[*].upgrades. Everything else on the Ruleset/SimState is an inert
 * stub. Waves are left empty so the wave-spawn pass is a no-op and the tests
 * isolate the waypoint + hold-gate pass; creeps are placed directly.
 *
 * Lane geometry mirrors the real south-east lane: spawn at negative y, final
 * waypoint = the enemy HQ at positive y, so the lane axis points +y (north).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stepCreeps } from '../src/sim/creeps.js';
import { compileClassicRuleset } from '../src/sim/ruleset.js';
import { applyCommands, createMatch, hashState, stepTick } from '../src/sim/sim.js';
import { sortedNumericKeys } from '../src/sim/types.js';
import type {
  CreepEntity,
  LaneSpec,
  RawDataFiles,
  Ruleset,
  SimEvent,
  SimState,
  StructureEntity,
  TeamId,
} from '../src/sim/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOUTH_HQ_Y = 6400; // enemy (north) HQ, final waypoint
const SPAWN_Y = -5792; // south-east lane spawn
const SPAWN_X = 272;

/** A south lane: creeps travel from the south spawn toward the north HQ. */
function southLane(): LaneSpec {
  return {
    id: 'south-east',
    creepOwner: 0,
    team: 'south',
    spawnX: SPAWN_X,
    spawnY: SPAWN_Y,
    spawnFacingDeg: 90,
    spawnRegion: 'SpawnSE',
    ownHarborKey: 'ownHarbor',
    bountyGateEnemyHarborKey: 'enemyHarbor',
    waypoints: [
      // wp0: far enemy side; wp1: the enemy HQ (no region gating exercised).
      { x: 176, y: 5104, issuedOnEnteringRegions: null },
      { x: -1152, y: SOUTH_HQ_Y, issuedOnEnteringRegions: null },
    ],
  };
}

function makeRuleset(lanes: LaneSpec[]): Ruleset {
  // stepCreeps reads map.lanes/waves/regions, unitTypes, upgrades; the rest is
  // inert for these tests.
  return {
    name: 'test',
    tickRate: 20,
    constants: {} as Ruleset['constants'],
    attackTypeVsDefense: {} as Ruleset['attackTypeVsDefense'],
    weapons: {},
    equipment: {},
    abilities: {},
    ships: {},
    unitTypes: {},
    upgrades: {},
    shops: {},
    stackRules: [],
    subRules: {} as Ruleset['subRules'],
    missiles: {} as Ruleset['missiles'],
    suicideQuests: [],
    contracts: {} as Ruleset['contracts'],
    questSystems: {} as Ruleset['questSystems'],
    xp: {} as Ruleset['xp'],
    respawn: {} as Ruleset['respawn'],
    income: {} as Ruleset['income'],
    map: {
      bounds: { minX: -5536, minY: -8192, maxX: 5312, maxY: 6656 },
      waterMask: { bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, cols: 0, rows: 0, cellSizeX: 1, cellSizeY: 1, cells: new Uint8Array(0) },
      regions: {},
      structures: [],
      playerStarts: {},
      startingShipTypeId: 'H000',
      lanes,
      waves: [],
      respawnRegionByTeam: { south: 'a', north: 'b' },
      repairBays: [],
      subTeleports: [],
      tempItemRegion: 't',
      streetMerchantRegions: { south: 's', north: 'n' },
    },
  } as Ruleset;
}

function makeState(): SimState {
  const teamState = (id: TeamId, slot: number) => ({
    id,
    aiPlayerSlot: slot,
    upgrades: {},
    research: null,
  });
  return {
    tick: 100,
    rngState: 12345,
    nextEntityId: 1000,
    status: { phase: 'playing' },
    enabledModes: [],
    players: {},
    teams: { south: teamState('south', 0), north: teamState('north', 1) },
    entities: {},
    projectiles: {},
    groundItems: {},
    detectionZones: [],
    treasureByTeam: { south: null, north: null },
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
    aiMemory: {},
  };
}

let nextId = 1;
function addCreep(state: SimState, x: number, y: number, laneId = 'south-east'): CreepEntity {
  const id = nextId++;
  const creep: CreepEntity = {
    id,
    typeId: 'h00B',
    x,
    y,
    facingRad: 0,
    dead: false,
    kind: 'creep',
    owner: 0,
    team: 'south',
    hp: 1000,
    maxHp: 1000,
    order: { type: 'attackMove', x: 176, y: 5104 }, // base waypoint[0] order
    statuses: [],
    vision: { south: true, north: false },
    attackReadyAtTick: 0,
    laneId,
    waypointIndex: 0,
  };
  state.entities[id] = creep;
  return creep;
}

function addStructure(
  state: SimState,
  role: StructureEntity['role'],
  team: TeamId | null,
  x: number,
  y: number,
  instanceKey: string,
): StructureEntity {
  const id = nextId++;
  const s: StructureEntity = {
    id,
    typeId: role === 'hq' ? 'n000' : 'n004',
    x,
    y,
    facingRad: 0,
    dead: false,
    kind: 'structure',
    owner: team === 'north' ? 1 : team === 'south' ? 0 : null,
    team,
    instanceKey,
    role,
    hp: role === 'hq' ? 20000 : 6500,
    maxHp: role === 'hq' ? 20000 : 6500,
    statuses: [],
    attackReadyAtTick: 0,
    shopStock: null,
  };
  state.entities[id] = s;
  return s;
}

// Real north (enemy) tower/HQ positions on / near the south-east lane axis.
const ENEMY_TOWER_FRONT = { x: -192, y: 1472 }; // first defensive ring, lat ~382
const ENEMY_TOWER_BACK = { x: -320, y: 4928 }; // inner ring, lat ~656
const ENEMY_HQ = { x: -1152, y: 6400 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stepCreeps — hold at frontmost living enemy structure', () => {
  it('targets the frontmost live enemy tower and does NOT advance past it', () => {
    const ruleset = makeRuleset([southLane()]);
    const state = makeState();
    // Creep partway up the lane, both enemy towers + HQ ahead and alive.
    const creep = addCreep(state, 200, -2000);
    addStructure(state, 'tower', 'north', ENEMY_TOWER_FRONT.x, ENEMY_TOWER_FRONT.y, 'frontTower');
    addStructure(state, 'tower', 'north', ENEMY_TOWER_BACK.x, ENEMY_TOWER_BACK.y, 'backTower');
    addStructure(state, 'hq', 'north', ENEMY_HQ.x, ENEMY_HQ.y, 'enemyHq');

    stepCreeps(state, ruleset);

    // Order points at the FRONT tower (smallest forward projection), not the
    // back tower, the HQ, or the open waypoint.
    expect(creep.order).toEqual({
      type: 'attackMove',
      x: ENEMY_TOWER_FRONT.x,
      y: ENEMY_TOWER_FRONT.y,
    });
    // Hold gate must not advance the waypoint index past the tower.
    expect(creep.waypointIndex).toBe(0);
  });

  it('retargets the next structure (back tower) after the front tower dies', () => {
    const ruleset = makeRuleset([southLane()]);
    const state = makeState();
    const creep = addCreep(state, 200, -2000);
    const front = addStructure(state, 'tower', 'north', ENEMY_TOWER_FRONT.x, ENEMY_TOWER_FRONT.y, 'frontTower');
    addStructure(state, 'tower', 'north', ENEMY_TOWER_BACK.x, ENEMY_TOWER_BACK.y, 'backTower');
    addStructure(state, 'hq', 'north', ENEMY_HQ.x, ENEMY_HQ.y, 'enemyHq');

    // Front tower destroyed.
    front.dead = true;
    front.hp = 0;

    stepCreeps(state, ruleset);

    expect(creep.order).toEqual({
      type: 'attackMove',
      x: ENEMY_TOWER_BACK.x,
      y: ENEMY_TOWER_BACK.y,
    });
  });

  it('targets the enemy HQ once every enemy tower in the lane is dead', () => {
    const ruleset = makeRuleset([southLane()]);
    const state = makeState();
    const creep = addCreep(state, 200, -2000);
    const front = addStructure(state, 'tower', 'north', ENEMY_TOWER_FRONT.x, ENEMY_TOWER_FRONT.y, 'frontTower');
    const back = addStructure(state, 'tower', 'north', ENEMY_TOWER_BACK.x, ENEMY_TOWER_BACK.y, 'backTower');
    addStructure(state, 'hq', 'north', ENEMY_HQ.x, ENEMY_HQ.y, 'enemyHq');
    front.dead = true;
    front.hp = 0;
    back.dead = true;
    back.hp = 0;

    stepCreeps(state, ruleset);

    expect(creep.order).toEqual({ type: 'attackMove', x: ENEMY_HQ.x, y: ENEMY_HQ.y });
  });

  it('falls back to the plain waypoint order when no enemy structure is ahead', () => {
    const ruleset = makeRuleset([southLane()]);
    const state = makeState();
    const creep = addCreep(state, 200, -2000);
    // All enemy structures dead -> nothing to hold at.
    const front = addStructure(state, 'tower', 'north', ENEMY_TOWER_FRONT.x, ENEMY_TOWER_FRONT.y, 'frontTower');
    const hq = addStructure(state, 'hq', 'north', ENEMY_HQ.x, ENEMY_HQ.y, 'enemyHq');
    front.dead = true;
    front.hp = 0;
    hq.dead = true;
    hq.hp = 0;

    stepCreeps(state, ruleset);

    // Untouched base waypoint[0] order.
    expect(creep.order).toEqual({ type: 'attackMove', x: 176, y: 5104 });
  });

  it('ignores friendly (same-team) structures — only enemy towers/HQ gate', () => {
    const ruleset = makeRuleset([southLane()]);
    const state = makeState();
    const creep = addCreep(state, 200, -2000);
    // A friendly (south) tower ahead must NOT cause a hold.
    addStructure(state, 'tower', 'south', -192, 1472, 'friendlyTower');

    stepCreeps(state, ruleset);

    expect(creep.order).toEqual({ type: 'attackMove', x: 176, y: 5104 });
  });

  it('ignores enemy structures from an adjacent lane (outside the corridor)', () => {
    const ruleset = makeRuleset([southLane()]);
    const state = makeState();
    const creep = addCreep(state, 200, -2000);
    // A north tower belonging to the WEST lane: far off the east-lane axis
    // (x ~ -2752, lateral offset > 1100) — must be ignored.
    addStructure(state, 'tower', 'north', -2752, 1472, 'westLaneTower');

    stepCreeps(state, ruleset);

    expect(creep.order).toEqual({ type: 'attackMove', x: 176, y: 5104 });
  });

  it('does not hold at a structure behind the creep (already passed)', () => {
    const ruleset = makeRuleset([southLane()]);
    const state = makeState();
    // Creep is past both towers, near the HQ; only structures ahead count.
    const creep = addCreep(state, -1100, 6000);
    addStructure(state, 'tower', 'north', ENEMY_TOWER_FRONT.x, ENEMY_TOWER_FRONT.y, 'frontTower');
    addStructure(state, 'tower', 'north', ENEMY_TOWER_BACK.x, ENEMY_TOWER_BACK.y, 'backTower');
    addStructure(state, 'hq', 'north', ENEMY_HQ.x, ENEMY_HQ.y, 'enemyHq');

    stepCreeps(state, ruleset);

    // Both towers are behind (smaller forward projection); the HQ is the only
    // structure still ahead, so the creep targets it.
    expect(creep.order).toEqual({ type: 'attackMove', x: ENEMY_HQ.x, y: ENEMY_HQ.y });
  });

  it('does not modify player ships (creep order logic only)', () => {
    const ruleset = makeRuleset([southLane()]);
    const state = makeState();
    addStructure(state, 'tower', 'north', ENEMY_TOWER_FRONT.x, ENEMY_TOWER_FRONT.y, 'frontTower');
    // A player ship near the lane with its own order.
    const shipId = nextId++;
    state.entities[shipId] = {
      id: shipId,
      typeId: 'H000',
      x: 200,
      y: -2000,
      facingRad: 0,
      dead: false,
      kind: 'ship',
      owner: 2,
      team: 'south',
      hp: 100,
      maxHp: 100,
      order: { type: 'move', x: 5000, y: 5000 },
      statuses: [],
      vision: { south: true, north: false },
      attackReadyAtTick: 0,
      casting: null,
      pausedUntilTick: 0,
      invulnerableUntilTick: 0,
      submerged: false,
    };

    stepCreeps(state, ruleset);

    expect(state.entities[shipId]?.kind === 'ship' && state.entities[shipId].order).toEqual({
      type: 'move',
      x: 5000,
      y: 5000,
    });
  });

  it('is deterministic and draws no RNG: rngState is unchanged', () => {
    const ruleset = makeRuleset([southLane()]);
    const state = makeState();
    addCreep(state, 200, -2000);
    addStructure(state, 'tower', 'north', ENEMY_TOWER_FRONT.x, ENEMY_TOWER_FRONT.y, 'frontTower');
    addStructure(state, 'hq', 'north', ENEMY_HQ.x, ENEMY_HQ.y, 'enemyHq');
    const before = state.rngState;

    stepCreeps(state, ruleset);

    expect(state.rngState).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// End-to-end on the REAL compiled Classic ruleset (terrain-less = open sea,
// per docs/TERRAIN.md §5): the hold gate must bring creeps into combat with
// enemy towers AND opposing creeps must still meet and fight.
// ---------------------------------------------------------------------------

function loadJson<T>(name: string): T {
  const url = new URL(`../../../data/json/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

function loadRaw(): RawDataFiles {
  return {
    weapons: loadJson('weapons.json'),
    equipment: loadJson('equipment.json'),
    ships: loadJson('ships.json'),
    upgradeCurves: loadJson('upgrade-curves.json'),
    scriptRules: loadJson('script-rules.json'),
    mapLayout: loadJson('map-layout.json'),
    gameplayConstants: loadJson('gameplay-constants.json'),
    units: loadJson('units.json'),
    abilities: loadJson('abilities.json'),
    items: loadJson('items.json'),
    buffs: loadJson('buffs.json'),
    strings: loadJson('strings.json'),
  };
}

describe('stepCreeps — end-to-end on the compiled Classic ruleset', () => {
  const ruleset = compileClassicRuleset(loadRaw());
  const TICKS = 2000;

  function run(seed: number): { events: SimEvent[]; state: SimState } {
    // No human players: pure creep-vs-structure / creep-vs-creep.
    const state = createMatch(ruleset, seed, []);
    const events: SimEvent[] = [];
    for (let t = 0; t < TICKS; t++) {
      applyCommands(state, ruleset, []);
      events.push(...stepTick(state, ruleset));
    }
    return { events, state };
  }

  const baseline = run(7);

  it('creeps engage enemy towers: an enemy tower takes hit damage', () => {
    // Opposing waves now CLASH where they meet (movement.ts halts an attack-
    // moving creep while an enemy is in its arc), so in a PERFECTLY symmetric
    // open-sea mirror — no hero to tip a lane, no land funnel to break the
    // symmetry — the front sits at mid-lane and creeps may never leak to a tower.
    // To pin the creep->tower engagement deterministically we disable the NORTH
    // spawn buildings so SOUTH creeps advance UNOPPOSED to the north towers and
    // hold + fire on them. ownHarborKey resolves to role 'spawnBuilding' (not the
    // HQ), so the match does not end; the dead buildings are reaped next tick and
    // structureAlive then gates north spawning off. (The mid-lane clash itself is
    // pinned by the 'opposing creeps still fight' case below + terrain-integration.)
    const state = createMatch(ruleset, 7, []);
    const northSpawnKeys = new Set(
      ruleset.map.lanes.filter((l) => l.team === 'north').map((l) => l.ownHarborKey),
    );
    for (const id of sortedNumericKeys(state.entities)) {
      const e = state.entities[id];
      if (e && e.kind === 'structure' && northSpawnKeys.has(e.instanceKey)) {
        e.dead = true;
        e.hp = 0;
      }
    }
    const northTowerIds = new Set<number>();
    for (const id of sortedNumericKeys(state.entities)) {
      const e = state.entities[id];
      if (e && e.kind === 'structure' && e.role === 'tower' && e.team === 'north') {
        northTowerIds.add(e.id);
      }
    }
    expect(northTowerIds.size).toBeGreaterThan(0);
    let towerHits = 0;
    for (let t = 0; t < 6000; t++) {
      applyCommands(state, ruleset, []);
      for (const ev of stepTick(state, ruleset)) {
        if (ev.type === 'hit' && northTowerIds.has(ev.targetEntityId)) towerHits += 1;
      }
    }
    expect(towerHits).toBeGreaterThan(0);
  });

  it('opposing creeps still fight: cross-team creep deaths with kill credit', () => {
    const deaths = baseline.events.filter(
      (e): e is Extract<SimEvent, { type: 'death' }> => e.type === 'death',
    );
    expect(deaths.length).toBeGreaterThan(0);
    const combatKills = deaths.filter(
      (d) => d.killerPlayer !== null && d.killerPlayer !== d.victimPlayer,
    );
    expect(combatKills.length).toBeGreaterThan(0);
    // Both empires lost creeps (south empire slot 0, north empire slot 1).
    const victims = new Set(deaths.map((d) => d.victimPlayer));
    expect(victims.has(baseline.state.teams.south.aiPlayerSlot)).toBe(true);
    expect(victims.has(baseline.state.teams.north.aiPlayerSlot)).toBe(true);
  });

  it('replays bit-identically (no added/removed RNG draws)', () => {
    const replay = run(7);
    expect(hashState(replay.state)).toBe(hashState(baseline.state));
    expect(replay.events.length).toBe(baseline.events.length);
  });

  // Crash-guard (work item A): spawnWave must NEVER throw on the per-tick hot
  // path, even if a data edit leaves a wave pointing at a creep type that is not
  // in ruleset.unitTypes. Previously it threw `spawnWave: unknown creep unit
  // type`, which the server's per-tick try/catch turns into an abrupt
  // finish(null) — a player perceives the game crashing mid-match. Now the bad
  // wave is skipped (no creeps that fire) and the match keeps stepping. We patch
  // EVERY wave's creep types to bogus ids so a spawn is attempted with an
  // unknown type, then step well past several wave periods and assert no throw.
  it('a wave with an unknown creep unit type is skipped, not thrown — the match keeps stepping', () => {
    const broken: Ruleset = {
      ...ruleset,
      map: {
        ...ruleset.map,
        waves: ruleset.map.waves.map((w) => ({
          ...w,
          bountyTypeId: 'ZZZZ', // not in unitTypes
          zeroBountyTypeId: 'ZZZZ',
        })),
      },
    };
    // Sanity: the bogus type really is absent.
    expect(broken.unitTypes['ZZZZ']).toBeUndefined();

    const state = createMatch(broken, 7, []);
    expect(() => {
      // Step past several wave periods (waves fire on a periodic timer); with the
      // old throw this would die on the first spawn.
      for (let t = 0; t < 2000; t++) {
        applyCommands(state, broken, []);
        stepTick(state, broken);
      }
    }).not.toThrow();
    // The match advanced normally — no creep ever spawned from the broken waves.
    let creepCount = 0;
    for (const id of sortedNumericKeys(state.entities)) {
      if (state.entities[id]?.kind === 'creep') creepCount++;
    }
    expect(creepCount).toBe(0);
    expect(state.tick).toBe(2000);
  });
});
