/**
 * Match orchestrator — createMatch / applyCommands / stepTick / hashState.
 * Defines the canonical command routing and tick order every system was
 * contracted against; do not reorder without updating every module doc +
 * packages/core/docs/MODULES.md.
 *
 * Harness loop per tick N:
 *   applyCommands(state, ruleset, commandsForTickN);  // sorted by player
 *   const events = stepTick(state, ruleset);
 *
 * Command routing (commands are stably sorted by player slot, preserving
 * the server's relative order per player — the sorted stream is part of
 * the replay):
 *   move/stop/holdPosition/attackMove/attackTarget -> movement.applyMovementCommand
 *   buyItem/sellItem/useItem/dropItem/pickupItem/buyShip/setGoldDump
 *                                                  -> economy.applyEconomyCommand
 *   castAbility: ruleset.abilities[id].mechanic is a weapon
 *     ('stormBoltWeapon'/'phoenixFireWeapon')       -> combat.applyCombatCommand
 *     anything else                                 -> specials.applySpecialsCommand
 *   fireMissile                                     -> specials.applySpecialsCommand
 *   research/learnSkill                             -> progression.applyProgressionCommand
 *   Unknown player / ended match -> emit 'commandRejected'.
 *
 * stepTick order (TICK_SYSTEM_ORDER):
 *   0. If status.phase === 'ended': return [] (state frozen).
 *   1. creeps.stepCreeps        — wave timers fire, creep AI writes orders.
 *   2. movement.stepMovement    — kinematics + collision (fresh positions).
 *   3. specials.stepSpecials    — region triggers, quests, missiles, dive,
 *                                 bays, wards; recomputeVisibility LAST.
 *   4. combat.stepCombat        — PF/native fire (uses fresh vision),
 *                                 projectiles, regen/DoT, deaths flagged.
 *   5. economy.stepEconomy      — income, restocks, contracts, gold dump.
 *   6. progression.stepProgression — consume pendingDeaths (XP/bounty/
 *                                 respawn scheduling), research completion.
 *   7. finalize (this module)   — win check: an HQ (role 'hq') dead ->
 *                                 status ended + 'matchEnded'; delete
 *                                 entities with dead === true; clear
 *                                 pendingDeaths; tick++; drain and return
 *                                 state.events.
 *
 * RNG draw order at init (replay contract): createMatch draws EXACTLY ONE
 * rollInt — the empire-share period (map-layout income note). The street
 * merchant is NOT pre-rolled: timers.streetMerchantSpawnTick is seeded null
 * and economy rolls it at income.streetMerchant.rollAtTick (integrator
 * resolution of the economy/createMatch ownership conflict).
 */

import { PI } from '../math.js';
import { initAiMemory } from './ai.js';
import { stepCombat, applyCombatCommand } from './combat.js';
import { stepCreeps } from './creeps.js';
import { applyEconomyCommand, buildShopStock, recomputeShipStats, stepEconomy } from './economy.js';
import { applyMovementCommand, stepMovement } from './movement.js';
import { applyProgressionCommand, stepProgression } from './progression.js';
import { applySpecialsCommand, stepSpecials } from './specials.js';
import {
  allocEntityId,
  enemyTeam,
  rollInt,
  sortedNumericKeys,
} from './types.js';
import type {
  Command,
  ItemInstance,
  PlayerConfig,
  PlayerState,
  Ruleset,
  ShipEntity,
  SimEvent,
  SimState,
  StructureEntity,
  TeamId,
} from './types.js';

/**
 * Per-team AI empire slot, derived from the lane data (lane.creepOwner /
 * lane.team — slots 0 south / 1 north in Classic). Data-driven so patched
 * rulesets keep working.
 */
function aiSlotOf(ruleset: Ruleset, team: TeamId): number {
  for (const lane of ruleset.map.lanes) {
    if (lane.team === team) return lane.creepOwner;
  }
  return team === 'south' ? 0 : 1;
}

function itemInstance(ruleset: Ruleset, itemId: string): ItemInstance {
  return { itemId, charges: ruleset.equipment[itemId]?.charges ?? null, readyAtTick: 0 };
}

/**
 * Build tick-0 state from the ruleset map.
 *
 * - 12 PlayerStates from map.playerStarts: slots 0/1 are the AI empires
 *   (control 'computer'); slots named in playerConfigs use the configured
 *   control; remaining slots are unoccupied and marked 'computer' so
 *   economy's MAP_CONTROL_USER human count (income table key, empire-share
 *   divisor) counts only actual players — they still receive per-slot
 *   income, matching the verbatim per-slot triggers (war3map.j CountRed/
 *   CountBlue + Trig_GoldPerSecond*).
 * - Teams inserted 'south' then 'north' (the fixed iteration order).
 * - Structures placed from map.structures in array order (compileMap
 *   already skipped removedAtMapStart showcases), then each configured
 *   player's starting ship in ascending slot order — entity ids are
 *   assigned in that sequence from nextEntityId = 1.
 * - Every player starts with constants.startingGold and
 *   xp.skillPointsPerLevel unspent points (WC3 heroes spend one at L1).
 * - Timers: first waves at preSpawnDelayTicks; income/gold-dump after one
 *   full period; empireSharePeriodTicks rolled ONCE here with the match
 *   Rng (the only init draw); streetMerchantSpawnTick = null (economy
 *   rolls it).
 *
 * Throws on invalid playerConfigs (unknown slot, AI slot, duplicate) —
 * match setup errors are programming errors, not commands to reject.
 */
export function createMatch(
  ruleset: Ruleset,
  seed: number,
  playerConfigs: PlayerConfig[],
  options?: { enabledModes?: string[] },
): SimState {
  const map = ruleset.map;
  const aiSlots: Record<TeamId, number> = {
    south: aiSlotOf(ruleset, 'south'),
    north: aiSlotOf(ruleset, 'north'),
  };

  const configBySlot: Record<number, PlayerConfig> = {};
  for (const config of playerConfigs) {
    if (!(config.slot in map.playerStarts)) {
      throw new Error(`createMatch: slot ${config.slot} is not a map player slot`);
    }
    if (config.slot === aiSlots.south || config.slot === aiSlots.north) {
      throw new Error(`createMatch: slot ${config.slot} is an AI empire slot`);
    }
    if (config.slot in configBySlot) {
      throw new Error(`createMatch: duplicate player slot ${config.slot}`);
    }
    if (config.ai != null && config.control !== 'computer') {
      throw new Error(`createMatch: AI slot ${config.slot} must have control 'computer'`);
    }
    configBySlot[config.slot] = config;
  }

  const players: Record<number, PlayerState> = {};
  for (const slot of sortedNumericKeys(map.playerStarts)) {
    const start = map.playerStarts[slot];
    if (!start) continue;
    const isAi = slot === aiSlots.south || slot === aiSlots.north;
    const config = configBySlot[slot];
    players[slot] = {
      slot,
      team: start.team,
      control: isAi ? 'computer' : (config?.control ?? 'computer'),
      gold: ruleset.constants.startingGold,
      lumber: 0,
      xp: 0,
      level: 1,
      unspentSkillPoints: ruleset.xp.skillPointsPerLevel,
      heroSkillLevels: {},
      shipTypeId: map.startingShipTypeId,
      shipId: null,
      inventory: [null, null, null, null, null, null],
      cooldownGroups: {},
      missileReadyAtTick: 0,
      respawnAtTick: null,
      goldDumpEnabled: false,
    };
  }

  const state: SimState = {
    tick: 0,
    rngState: seed >>> 0,
    nextEntityId: 1,
    status: { phase: 'playing' },
    // Game-mode flags ('-OnlySailors' etc.) are fixed at match setup; the
    // stack-rule onlyInModes gates read them (Classic default: none).
    enabledModes: [...(options?.enabledModes ?? [])].sort(),
    players,
    teams: {
      south: { id: 'south', aiPlayerSlot: aiSlots.south, upgrades: {}, research: null },
      north: { id: 'north', aiPlayerSlot: aiSlots.north, upgrades: {}, research: null },
    },
    entities: {},
    projectiles: {},
    groundItems: {},
    detectionZones: [],
    pendingDeaths: [],
    events: [],
    timers: {
      nextWaveTick: {},
      nextIncomeTick: ruleset.income.intervalTicks,
      empireSharePeriodTicks: 0,
      nextEmpireShareTick: 0,
      nextGoldDumpTick: ruleset.income.goldDumpPeriodTicks,
      streetMerchantSpawnTick: null,
    },
    aiMemory: {},
  };
  for (const wave of map.waves) {
    state.timers.nextWaveTick[wave.name] = wave.preSpawnDelayTicks;
  }
  // The ONLY init-time draw (see module doc).
  state.timers.empireSharePeriodTicks = rollInt(
    state,
    ruleset.income.empireShareMinTicks,
    ruleset.income.empireShareMaxTicks,
  );
  state.timers.nextEmpireShareTick = state.timers.empireSharePeriodTicks;

  // Seed AI brain memory for configured AI slots (ascending slot order).
  // initAiMemory derives the brain's PRIVATE PRNG stream from (seed, slot)
  // — it does NOT touch state.rngState, so adding AI players never shifts the
  // sim-mechanic RNG draw order (the replay contract). See docs/AI.md.
  for (const slot of sortedNumericKeys(configBySlot)) {
    const config = configBySlot[slot];
    if (config?.ai == null) continue;
    state.aiMemory[slot] = initAiMemory(slot, seed, config.ai);
  }

  // --- preplaced structures (map.structures array order) -------------------
  for (const placement of map.structures) {
    const unitType = ruleset.unitTypes[placement.typeId];
    if (!unitType) {
      throw new Error(`createMatch: structure type ${placement.typeId} missing from unitTypes`);
    }
    const owner = placement.owner;
    const ownerPlayer = owner !== null ? players[owner] : undefined;
    const id = allocEntityId(state);
    const structure: StructureEntity = {
      id,
      kind: 'structure',
      typeId: placement.typeId,
      x: placement.x,
      y: placement.y,
      facingRad: (placement.facingDeg * PI) / 180,
      dead: false,
      owner,
      team: ownerPlayer ? ownerPlayer.team : null,
      instanceKey: placement.instanceKey,
      role: placement.role,
      hp: unitType.maxHp,
      maxHp: unitType.maxHp,
      statuses: [],
      attackReadyAtTick: 0,
      shopStock: buildShopStock(ruleset, placement.typeId),
    };
    state.entities[id] = structure;
  }

  // --- configured players' starting ships (ascending slot) -----------------
  for (const slot of sortedNumericKeys(players)) {
    if (!(slot in configBySlot)) continue;
    const player = players[slot];
    const start = map.playerStarts[slot];
    if (!player || !start) continue;
    const shipSpec = ruleset.ships[map.startingShipTypeId];
    if (!shipSpec) throw new Error(`createMatch: starting ship ${map.startingShipTypeId} missing`);
    const id = allocEntityId(state);
    const ship: ShipEntity = {
      id,
      kind: 'ship',
      typeId: map.startingShipTypeId,
      owner: slot,
      team: player.team,
      x: start.x,
      y: start.y,
      facingRad: (start.facingDeg * PI) / 180,
      dead: false,
      hp: shipSpec.maxHp,
      maxHp: shipSpec.maxHp,
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
    for (const itemId of start.startItems) {
      const free = player.inventory.indexOf(null);
      if (free >= 0) player.inventory[free] = itemInstance(ruleset, itemId);
    }
    // Bake start-item passives into derived stats and revive at full.
    recomputeShipStats(state, ruleset, slot);
    ship.hp = ship.maxHp;
  }

  return state;
}

function rejectCommand(state: SimState, cmd: Command, reason: string): void {
  state.events.push({
    type: 'commandRejected',
    tick: state.tick,
    player: cmd.player,
    commandType: cmd.type,
    reason,
  });
}

function routeCommand(state: SimState, ruleset: Ruleset, cmd: Command): void {
  switch (cmd.type) {
    case 'move':
    case 'stop':
    case 'holdPosition':
    case 'attackMove':
    case 'attackTarget':
      applyMovementCommand(state, ruleset, cmd);
      return;
    case 'buyItem':
    case 'sellItem':
    case 'useItem':
    case 'dropItem':
    case 'pickupItem':
    case 'buyShip':
    case 'setGoldDump':
      applyEconomyCommand(state, ruleset, cmd);
      return;
    case 'castAbility': {
      const mechanic = ruleset.abilities[cmd.abilityId]?.mechanic;
      if (mechanic === 'stormBoltWeapon' || mechanic === 'phoenixFireWeapon') {
        applyCombatCommand(state, ruleset, cmd);
      } else {
        applySpecialsCommand(state, ruleset, cmd);
      }
      return;
    }
    case 'fireMissile':
      applySpecialsCommand(state, ruleset, cmd);
      return;
    case 'research':
    case 'learnSkill':
      applyProgressionCommand(state, ruleset, cmd);
      return;
  }
}

/**
 * Validate + route this tick's commands. Commands are stably sorted by
 * player slot (ties keep the given order) before dispatch — the sorted
 * order is the replay order. Pure dispatch: all game logic lives in the
 * per-module apply*Command handlers.
 */
export function applyCommands(state: SimState, ruleset: Ruleset, commands: Command[]): void {
  const ordered = [...commands].sort((a, b) => a.player - b.player);
  for (const cmd of ordered) {
    if (state.status.phase === 'ended') {
      rejectCommand(state, cmd, 'matchEnded');
      continue;
    }
    if (!state.players[cmd.player]) {
      rejectCommand(state, cmd, 'unknownPlayer');
      continue;
    }
    routeCommand(state, ruleset, cmd);
  }
}

/**
 * Advance exactly one tick in the canonical order (module doc). Returns the
 * events produced this tick (including ones pushed during applyCommands)
 * and clears the buffer.
 */
export function stepTick(state: SimState, ruleset: Ruleset): SimEvent[] {
  if (state.status.phase === 'ended') {
    // Frozen: drop any buffered rejection events, advance nothing.
    state.events = [];
    return [];
  }

  stepCreeps(state, ruleset);
  stepMovement(state, ruleset);
  stepSpecials(state, ruleset);
  stepCombat(state, ruleset);
  stepEconomy(state, ruleset);
  stepProgression(state, ruleset);

  // --- finalize -------------------------------------------------------------
  // Win check BEFORE deleting the dead: an HQ death ends the match. Both
  // HQs dying on the same tick is a draw (winner null).
  const deadHqTeams: TeamId[] = [];
  for (const id of sortedNumericKeys(state.entities)) {
    const entity = state.entities[id];
    if (
      entity &&
      entity.kind === 'structure' &&
      entity.role === 'hq' &&
      entity.dead &&
      entity.team !== null &&
      !deadHqTeams.includes(entity.team)
    ) {
      deadHqTeams.push(entity.team);
    }
  }
  if (deadHqTeams.length > 0) {
    const loser = deadHqTeams[0];
    const winner = deadHqTeams.length === 1 && loser !== undefined ? enemyTeam(loser) : null;
    state.status = { phase: 'ended', winner, endedAtTick: state.tick };
    state.events.push({ type: 'matchEnded', tick: state.tick, winner });
  }

  for (const id of sortedNumericKeys(state.entities)) {
    const entity = state.entities[id];
    if (entity && entity.dead) delete state.entities[id];
  }
  state.pendingDeaths = [];
  state.tick += 1;

  const events = state.events;
  state.events = [];
  return events;
}

/**
 * Stable stringification: object keys sorted ascending, arrays in order,
 * numbers via JSON (ECMAScript number-to-string is fully specified, so the
 * output is engine-independent). `undefined` object values are skipped like
 * JSON.stringify does.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new Error(`hashState: unserializable value of type ${typeof value}`);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/**
 * Deterministic digest for replay/desync checks: FNV-1a 64 over the stable
 * stringification of the entire state EXCEPT `events` (derived output).
 * Two states from the same (ruleset, seed, command stream) hash identically
 * on every JS engine.
 */
export function hashState(state: SimState): string {
  const parts: string[] = [];
  for (const key of Object.keys(state).sort()) {
    if (key === 'events') continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify((state as unknown as Record<string, unknown>)[key])}`);
  }
  const serialized = `{${parts.join(',')}}`;
  let hash = FNV_OFFSET;
  for (let i = 0; i < serialized.length; i++) {
    hash ^= BigInt(serialized.charCodeAt(i));
    hash = (hash * FNV_PRIME) & U64;
  }
  return hash.toString(16).padStart(16, '0');
}
