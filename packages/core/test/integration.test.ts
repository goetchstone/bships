/**
 * Full-stack integration: compile the REAL Classic ruleset, create a match
 * with two scripted players, and drive ~3000 ticks (150 s) through the
 * canonical applyCommands/stepTick loop. Asserts cross-module behavior that
 * unit suites mock away: creep waves spawn and fight (creeps -> movement ->
 * combat -> progression), shop purchases work against placed structures
 * (economy), income accrues (economy timers), and the whole run is
 * bit-identical across independent replays of the same seed (hashState).
 *
 * Scenario (south player slot 2, north player slot 7, AI empires 0/1):
 *   t0:   p2 sails to the south Cannon Shop (n001_0022).
 *   t300: p2 buys a Basic Cannon (I001, 200g — exactly the starting gold).
 *   t320: p2 attack-moves up the east lane toward the north side.
 *   t400: p7 attack-moves down the east lane toward the south side.
 * Lane creeps (rowboats every 35 s, battleships, a cruiser) meet mid-map
 * and kill each other regardless of player action.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileClassicRuleset } from '../src/sim/ruleset.js';
import { applyCommands, createMatch, hashState, stepTick } from '../src/sim/sim.js';
import type {
  Command,
  RawDataFiles,
  Ruleset,
  SimEvent,
  SimState,
  StructureEntity,
} from '../src/sim/types.js';
import { sortedNumericKeys } from '../src/sim/types.js';

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

const ruleset: Ruleset = compileClassicRuleset(loadRaw());

const TICKS = 3000;
const SOUTH_PLAYER = 2;
const NORTH_PLAYER = 7;
const CANNON = 'I001';
const SOUTH_CANNON_SHOP_KEY = 'n001_0022';

function findStructure(state: SimState, instanceKey: string): StructureEntity {
  for (const id of sortedNumericKeys(state.entities)) {
    const entity = state.entities[id];
    if (entity && entity.kind === 'structure' && entity.instanceKey === instanceKey) {
      return entity;
    }
  }
  throw new Error(`structure ${instanceKey} not placed`);
}

interface RunResult {
  state: SimState;
  hash: string;
  events: SimEvent[];
  /** First tick (1-based loop count) a live creep entity was observed. */
  firstCreepSeenAtTick: number | null;
}

function runScriptedMatch(seed: number): RunResult {
  const state = createMatch(ruleset, seed, [
    { slot: SOUTH_PLAYER, control: 'user' },
    { slot: NORTH_PLAYER, control: 'user' },
  ]);
  const shop = findStructure(state, SOUTH_CANNON_SHOP_KEY);
  // Stop short of the shop center (interact radius 450) so the ship never
  // has to push through the structure's collision circle.
  const script: Record<number, Command[]> = {
    0: [{ type: 'move', player: SOUTH_PLAYER, x: shop.x + 300, y: shop.y + 100 }],
    300: [{ type: 'buyItem', player: SOUTH_PLAYER, shopId: shop.id, itemId: CANNON }],
    320: [{ type: 'attackMove', player: SOUTH_PLAYER, x: 272, y: -3000 }],
    400: [{ type: 'attackMove', player: NORTH_PLAYER, x: 176, y: 3000 }],
  };

  const events: SimEvent[] = [];
  let firstCreepSeenAtTick: number | null = null;
  for (let t = 0; t < TICKS; t++) {
    applyCommands(state, ruleset, script[t] ?? []);
    events.push(...stepTick(state, ruleset));
    if (firstCreepSeenAtTick === null) {
      for (const id of sortedNumericKeys(state.entities)) {
        if (state.entities[id]?.kind === 'creep') {
          firstCreepSeenAtTick = t + 1;
          break;
        }
      }
    }
  }
  return { state, hash: hashState(state), events, firstCreepSeenAtTick };
}

function eventsOf<T extends SimEvent['type']>(
  events: SimEvent[],
  type: T,
): Extract<SimEvent, { type: T }>[] {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

describe('integration — 3000-tick scripted Classic match', () => {
  // One shared baseline run; the determinism specs replay independently.
  const run = runScriptedMatch(42);

  it('completes 3000 ticks without throwing and the match is still live', () => {
    expect(run.state.tick).toBe(TICKS);
    expect(run.state.status.phase).toBe('playing');
  });

  it('spawns creep waves on the lanes', () => {
    const waves = eventsOf(run.events, 'waveSpawned');
    expect(waves.length).toBeGreaterThanOrEqual(8);
    // Every lane fired at least once.
    const laneIds = new Set(waves.map((w) => w.laneId));
    for (const lane of ruleset.map.lanes) expect(laneIds.has(lane.id)).toBe(true);
    expect(run.firstCreepSeenAtTick).not.toBeNull();
  });

  it('no scripted command was rejected', () => {
    expect(eventsOf(run.events, 'commandRejected')).toEqual([]);
  });

  it('p2 buys a Basic Cannon from the south Cannon Shop', () => {
    const purchases = eventsOf(run.events, 'purchase');
    expect(purchases).toContainEqual({
      type: 'purchase',
      tick: 300,
      player: SOUTH_PLAYER,
      itemId: CANNON,
      shipTypeId: null,
      gold: ruleset.constants.startingGold,
    });
    const player = run.state.players[SOUTH_PLAYER];
    const cannons = player?.inventory.filter((i) => i?.itemId === CANNON) ?? [];
    // Start item + the purchased one (inventory survives death/respawn).
    expect(cannons).toHaveLength(2);
  });

  it('opposing creeps fought: at least one combat death with kill credit', () => {
    const deaths = eventsOf(run.events, 'death');
    expect(deaths.length).toBeGreaterThan(0);
    const combatKills = deaths.filter(
      (d) => d.killerPlayer !== null && d.killerPlayer !== d.victimPlayer,
    );
    expect(combatKills.length).toBeGreaterThan(0);
    // Both empires lost creeps in the lane battle.
    const victims = new Set(deaths.map((d) => d.victimPlayer));
    expect(victims.has(run.state.teams.south.aiPlayerSlot)).toBe(true);
    expect(victims.has(run.state.teams.north.aiPlayerSlot)).toBe(true);
  });

  it('gold income accrued to a player who never spent', () => {
    // p7 bought nothing: every gold above startingGold is income/share/bounty,
    // and at 5 gold per 20-tick interval income alone guarantees growth.
    const player = run.state.players[NORTH_PLAYER];
    expect(eventsOf(run.events, 'purchase').some((p) => p.player === NORTH_PLAYER)).toBe(false);
    expect(player?.gold ?? 0).toBeGreaterThan(ruleset.constants.startingGold);
  });

  it('state stays plain serializable data (hash survives a JSON round-trip)', () => {
    const clone = JSON.parse(JSON.stringify(run.state)) as SimState;
    expect(hashState(clone)).toBe(run.hash);
  });

  it('replays bit-identically: same seed => exactly equal hash and events', () => {
    const replay = runScriptedMatch(42);
    expect(replay.hash).toBe(run.hash);
    expect(replay.state.rngState).toBe(run.state.rngState);
    expect(replay.events.length).toBe(run.events.length);
  });

  it('diverges on a different seed', () => {
    const other = runScriptedMatch(43);
    expect(other.hash).not.toBe(run.hash);
  });
});

describe('integration — superbomb quest on the COMPILED ruleset', () => {
  it('arms at the own reward zone and detonates for 6000 HQ damage + 12000 g + 1200 xp', () => {
    const state = createMatch(ruleset, 7, [{ slot: SOUTH_PLAYER, control: 'user' }]);
    const player = state.players[SOUTH_PLAYER];
    if (!player || player.shipId === null) throw new Error('no south player ship');
    const ship = state.entities[player.shipId];
    if (!ship || ship.kind !== 'ship') throw new Error('not a ship');
    // Trade Ship carrying the full superbomb loadout. I032 is minted by the
    // Refinery I01F+I02Q swap (economy.runRefinery superbombSwaps, tested in
    // quests.test.ts); injected directly here to isolate the arm/detonate.
    player.shipTypeId = 'H005';
    ship.typeId = 'H005';
    player.inventory = [
      { itemId: 'I01E', charges: null, readyAtTick: 0 },
      { itemId: 'I032', charges: null, readyAtTick: 0 },
      { itemId: 'I02Q', charges: null, readyAtTick: 0 },
      null,
      null,
      null,
    ];

    // Arm at the OWN (south) reward zone: I032 -> I02Z in place.
    const armRegion = ruleset.map.regions['SouthReward'];
    if (!armRegion) throw new Error('SouthReward missing');
    ship.x = armRegion.centerX;
    ship.y = armRegion.centerY;
    const armEvents = stepTick(state, ruleset);
    expect(player.inventory[1]?.itemId).toBe('I02Z');
    expect(armEvents.some((e) => e.type === 'questProgress' && e.questId === 'superbomb' && e.stage === 'armed')).toBe(true);

    // Detonate inside the enemy main base.
    const detonateRegion = ruleset.map.regions['North_Main'];
    if (!detonateRegion) throw new Error('North_Main missing');
    ship.x = detonateRegion.centerX;
    ship.y = detonateRegion.centerY;
    const northHq = findStructure(state, 'n000_0018');
    const hpBefore = northHq.hp;
    const goldBefore = player.gold;
    const events = stepTick(state, ruleset);

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'questProgress', questId: 'superbomb', stage: 'detonated' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'hit', targetEntityId: northHq.id, weaponId: 'I02Z', amount: 6000 }),
    );
    expect(northHq.hp).toBeLessThanOrEqual(hpBefore - 6000 + 1); // -6000 (+<=1 regen)
    expect(player.gold).toBe(goldBefore + 12000);
    expect(player.xp).toBe(1200);
    expect(player.shipId).toBeNull(); // carrier exploded, respawn scheduled
    expect(player.respawnAtTick).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ability cast end-to-end on the COMPILED ruleset, through the public router
// (applyCommands -> routeCommand -> applySpecialsCommand). Regression for the
// owner's "abilities are not visibly firing" report: a castAbility command
// must reach the sim, apply its effect, and start the cooldown.
// ---------------------------------------------------------------------------

describe('integration — ability cast (F-key) on the COMPILED ruleset', () => {
  it('Shore Leave (A01D) at the home harbour heals to full and emits a cast event', () => {
    const state = createMatch(ruleset, 7, [{ slot: SOUTH_PLAYER, control: 'user' }]);
    const player = state.players[SOUTH_PLAYER];
    if (!player || player.shipId === null) throw new Error('no south player ship');
    const ship = state.entities[player.shipId];
    if (!ship || ship.kind !== 'ship') throw new Error('not a ship');

    // The real F-key binding for the starter hull is Shore Leave (the same id
    // the client's shipActiveAbilityId returns); it only fires inside the OWN
    // Main Harbour, so seat the ship there and wound it.
    const abilityId = 'A01D';
    expect(ruleset.abilities[abilityId]?.mechanic).toBe('shoreLeave');
    const main = ruleset.map.regions['South_Main'];
    if (!main) throw new Error('South_Main missing');
    ship.x = main.centerX;
    ship.y = main.centerY;
    ship.hp = 1; // wounded

    // applyCommands pushes onto state.events (stepTick later returns + clears).
    applyCommands(state, ruleset, [{ type: 'castAbility', player: SOUTH_PLAYER, abilityId }]);
    const events = state.events;

    // Effect: healed to full. Cooldown: recorded against the ability id.
    expect(ship.hp).toBe(ship.maxHp);
    expect(player.cooldownGroups[abilityId]).toBeGreaterThanOrEqual(state.tick);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'abilityCast', player: SOUTH_PLAYER, abilityId }),
    );
    expect(events.some((e) => e.type === 'commandRejected')).toBe(false);
  });

  it('the SAME cast away from the harbour is rejected (no silent success), nothing healed', () => {
    const state = createMatch(ruleset, 7, [{ slot: SOUTH_PLAYER, control: 'user' }]);
    const player = state.players[SOUTH_PLAYER];
    if (!player || player.shipId === null) throw new Error('no south player ship');
    const ship = state.entities[player.shipId];
    if (!ship || ship.kind !== 'ship') throw new Error('not a ship');

    // Out on open water, far from any harbour region center.
    ship.x = 272;
    ship.y = 0;
    ship.hp = 1;
    applyCommands(state, ruleset, [
      { type: 'castAbility', player: SOUTH_PLAYER, abilityId: 'A01D' },
    ]);
    const events = state.events;
    expect(ship.hp).toBe(1); // unchanged
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'commandRejected',
        commandType: 'castAbility',
        reason: 'notAtMainHarbour',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Game-mode vote effects (war3map.j Trig_Mode_Vote_Done_Check_Actions).
// ---------------------------------------------------------------------------

function structureExists(state: SimState, instanceKey: string): boolean {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (e && e.kind === 'structure' && e.instanceKey === instanceKey) return true;
  }
  return false;
}

describe('integration — game-mode vote effects on the COMPILED ruleset', () => {
  const TRADE_MASTERS = ['n00E_0021', 'n00F_0015'];
  const SUPERSHIP_SELLER = 'n005_0019';

  it('NormalPlay (default) keeps all NPC shops and the map default hull', () => {
    const state = createMatch(ruleset, 7, [{ slot: SOUTH_PLAYER, control: 'user' }]);
    expect(structureExists(state, SUPERSHIP_SELLER)).toBe(true);
    for (const k of TRADE_MASTERS) expect(structureExists(state, k)).toBe(true);
    expect(state.players[SOUTH_PLAYER]!.shipTypeId).toBe(ruleset.map.startingShipTypeId);
  });

  it('OnlyTraders ("Only Submarines") forces every hull to H00V and removes the trade masters', () => {
    const state = createMatch(ruleset, 7, [{ slot: SOUTH_PLAYER, control: 'user' }], {
      enabledModes: ['OnlyTraders'],
    });
    const player = state.players[SOUTH_PLAYER]!;
    expect(player.shipTypeId).toBe('H00V');
    const ship = state.entities[player.shipId!];
    expect(ship && ship.kind === 'ship' && ship.typeId).toBe('H00V');
    for (const k of TRADE_MASTERS) expect(structureExists(state, k)).toBe(false);
  });

  it('NoBP ("No Superships") removes only the supership seller', () => {
    const state = createMatch(ruleset, 7, [{ slot: SOUTH_PLAYER, control: 'user' }], {
      enabledModes: ['NoBP'],
    });
    expect(structureExists(state, SUPERSHIP_SELLER)).toBe(false);
    for (const k of TRADE_MASTERS) expect(structureExists(state, k)).toBe(true);
    // No forced hull under NoBP.
    expect(state.players[SOUTH_PLAYER]!.shipTypeId).toBe(ruleset.map.startingShipTypeId);
  });

  it('NoTraders disables the Trade Boat/Ship hulls for purchase', () => {
    const state = createMatch(ruleset, 7, [{ slot: SOUTH_PLAYER, control: 'user' }], {
      enabledModes: ['NoTraders'],
    });
    const player = state.players[SOUTH_PLAYER]!;
    const ship = state.entities[player.shipId!];
    if (!ship || ship.kind !== 'ship') throw new Error('no ship');
    // Park on the south HQ (n000_0020 sells hulls) with plenty of gold.
    const shipyard = findStructure(state, 'n000_0020');
    ship.x = shipyard.x;
    ship.y = shipyard.y;
    player.gold = 100000;
    applyCommands(state, ruleset, [
      { type: 'buyShip', player: SOUTH_PLAYER, shopId: shipyard.id, shipTypeId: 'H00D' },
    ]);
    expect(state.events.some((e) => e.type === 'commandRejected' && e.reason === 'shipDisabledInMode')).toBe(true);
    expect(player.shipTypeId).not.toBe('H00D');
  });

  it('an unknown enabled mode falls back to NormalPlay (no effect)', () => {
    const state = createMatch(ruleset, 7, [{ slot: SOUTH_PLAYER, control: 'user' }], {
      enabledModes: ['NotARealMode'],
    });
    expect(structureExists(state, SUPERSHIP_SELLER)).toBe(true);
    expect(state.players[SOUTH_PLAYER]!.shipTypeId).toBe(ruleset.map.startingShipTypeId);
  });
});
