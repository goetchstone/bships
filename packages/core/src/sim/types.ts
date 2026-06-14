/**
 * Complete state model for the BattleShips Pro v1.187 simulation core.
 *
 * Everything in SimState is a plain serializable object (POJO): no classes,
 * no Maps, no functions. A match is fully determined by
 * (Ruleset, seed, ordered command stream) and must replay bit-identically.
 *
 * Determinism conventions (binding for every system module):
 * - Time is integer ticks at `Ruleset.tickRate` (20). Data durations compile
 *   to ticks via `secondsToTicks`.
 * - Randomness ONLY via `rollInt`/`rollFloat` below (threads `state.rngState`
 *   through the shared mulberry32 Rng). Never Math.random / Date.
 * - Angle math ONLY via dSin/dCos/dAtan2 from `../math.js`.
 * - Iteration over entity/player records must be in ascending numeric id
 *   order — use `sortedNumericKeys`. (JS Records with canonical integer keys
 *   already iterate ascending per spec, but the helper makes intent explicit.)
 * - Candidate sets for random picks are built in ascending entity-id order
 *   before drawing (docs/SEMANTICS.md preamble).
 */

import { Rng } from '../rng.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type EntityId = number;

export type TeamId = 'south' | 'north';

/** The opposing team. */
export function enemyTeam(team: TeamId): TeamId {
  return team === 'south' ? 'north' : 'south';
}

/** WC3 attack types (rows of the type-vs-defense table). */
export type AttackType = 'normal' | 'pierce' | 'siege' | 'magic' | 'chaos' | 'spells' | 'hero';

/** WC3 defense types (columns of the type-vs-defense table). */
export type DefenseType =
  | 'unarmored'
  | 'light'
  | 'medium'
  | 'heavy'
  | 'fortified'
  | 'hero'
  | 'divine'
  | 'normal';

/**
 * Data durations are authored in seconds; the sim runs integer ticks.
 * WC3 cooldowns below one tick (Vulcan/Laser 0.05 s) clamp to 1 tick.
 */
export function secondsToTicks(seconds: number, tickRate: number): number {
  return Math.max(1, Math.round(seconds * tickRate));
}

/** Ascending numeric keys of a Record — the canonical iteration order. */
export function sortedNumericKeys(record: Record<number, unknown>): number[] {
  return Object.keys(record)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Axis-aligned region rect (WC3 world units, +x east, +y north). */
export interface RegionRect {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
}

export function pointInRegion(region: RegionRect, x: number, y: number): boolean {
  return x >= region.minX && x < region.maxX && y >= region.minY && y < region.maxY;
}

// ---------------------------------------------------------------------------
// RNG threading
// ---------------------------------------------------------------------------

/**
 * Draw a uniform integer in [min, max] from the match RNG, advancing
 * `state.rngState`. This is the ONLY sanctioned access to randomness.
 */
export function rollInt(state: SimState, min: number, max: number): number {
  const rng = Rng.fromState(state.rngState);
  const value = rng.int(min, max);
  state.rngState = rng.getState();
  return value;
}

/** Draw a uniform float in [0, 1) from the match RNG, advancing state. */
export function rollFloat(state: SimState): number {
  const rng = Rng.fromState(state.rngState);
  const value = rng.next();
  state.rngState = rng.getState();
  return value;
}

// ---------------------------------------------------------------------------
// Commands (every player input)
// ---------------------------------------------------------------------------

export interface MoveCommand {
  type: 'move';
  player: number;
  x: number;
  y: number;
}

export interface StopCommand {
  type: 'stop';
  player: number;
}

export interface HoldPositionCommand {
  type: 'holdPosition';
  player: number;
}

export interface AttackMoveCommand {
  type: 'attackMove';
  player: number;
  x: number;
  y: number;
}

export interface AttackTargetCommand {
  type: 'attackTarget';
  player: number;
  targetId: EntityId;
}

export interface BuyItemCommand {
  type: 'buyItem';
  player: number;
  shopId: EntityId;
  itemId: string;
}

/**
 * Classic has no sell-back (no shop carries Asid — SEMANTICS §8); economy
 * rejects this command when `constants.sellbackRate === 0`. Present in the
 * union so Balanced rulesets can enable it without protocol changes.
 */
export interface SellItemCommand {
  type: 'sellItem';
  player: number;
  slot: number;
}

export interface UseItemCommand {
  type: 'useItem';
  player: number;
  slot: number;
  targetId?: EntityId;
  x?: number;
  y?: number;
}

export interface DropItemCommand {
  type: 'dropItem';
  player: number;
  slot: number;
  x: number;
  y: number;
}

export interface PickupItemCommand {
  type: 'pickupItem';
  player: number;
  groundItemId: number;
}

export interface BuyShipCommand {
  type: 'buyShip';
  player: number;
  shopId: EntityId;
  shipTypeId: string;
}

/** Hero skills and innate ship abilities (Dive, Hide, Captain's Cannon...). */
export interface CastAbilityCommand {
  type: 'castAbility';
  player: number;
  abilityId: string;
  targetId?: EntityId;
  x?: number;
  y?: number;
}

/** A032 — target is rolled by the missile system, never player-aimed. */
export interface FireMissileCommand {
  type: 'fireMissile';
  player: number;
}

export interface ResearchCommand {
  type: 'research';
  player: number;
  upgradeId: string;
}

export interface LearnSkillCommand {
  type: 'learnSkill';
  player: number;
  abilityId: string;
}

/** '-golddump on/off' chat toggle. */
export interface SetGoldDumpCommand {
  type: 'setGoldDump';
  player: number;
  enabled: boolean;
}

export type Command =
  | MoveCommand
  | StopCommand
  | HoldPositionCommand
  | AttackMoveCommand
  | AttackTargetCommand
  | BuyItemCommand
  | SellItemCommand
  | UseItemCommand
  | DropItemCommand
  | PickupItemCommand
  | BuyShipCommand
  | CastAbilityCommand
  | FireMissileCommand
  | ResearchCommand
  | LearnSkillCommand
  | SetGoldDumpCommand;

/** Routing groups — sim.applyCommands dispatches by these. */
export type MovementCommandU =
  | MoveCommand
  | StopCommand
  | HoldPositionCommand
  | AttackMoveCommand
  | AttackTargetCommand;

export type EconomyCommandU =
  | BuyItemCommand
  | SellItemCommand
  | UseItemCommand
  | DropItemCommand
  | PickupItemCommand
  | BuyShipCommand
  | SetGoldDumpCommand;

/** castAbility whose AbilitySpec.mechanic is a stormBolt/PF weapon. */
export type CombatCommandU = CastAbilityCommand;

/** fireMissile + castAbility for all non-weapon ship abilities. */
export type SpecialsCommandU = CastAbilityCommand | FireMissileCommand;

export type ProgressionCommandU = ResearchCommand | LearnSkillCommand;

// ---------------------------------------------------------------------------
// Events (client / stats consumption; not replayed — purely derived)
// ---------------------------------------------------------------------------

export type SimEvent =
  | {
      type: 'death';
      tick: number;
      entityId: EntityId;
      entityTypeId: string;
      victimPlayer: number | null;
      killerPlayer: number | null;
      x: number;
      y: number;
    }
  | {
      type: 'hit';
      tick: number;
      targetEntityId: EntityId;
      attackerPlayer: number | null;
      weaponId: string | null;
      amount: number;
    }
  | {
      type: 'purchase';
      tick: number;
      player: number;
      itemId: string | null;
      shipTypeId: string | null;
      gold: number;
    }
  | { type: 'refund'; tick: number; player: number; itemId: string; gold: number; reason: string }
  | { type: 'itemUsed'; tick: number; player: number; itemId: string }
  | { type: 'xpGained'; tick: number; player: number; amount: number; reason: string }
  | { type: 'levelUp'; tick: number; player: number; level: number }
  | { type: 'bounty'; tick: number; player: number; amount: number; victimEntityId: EntityId }
  | { type: 'respawn'; tick: number; player: number; entityId: EntityId }
  | {
      type: 'missileLaunched';
      tick: number;
      player: number;
      warheadItemId: string;
      targetEntityId: EntityId;
    }
  | { type: 'researchStarted'; tick: number; team: TeamId; upgradeId: string; level: number }
  | { type: 'researchComplete'; tick: number; team: TeamId; upgradeId: string; level: number }
  | { type: 'questProgress'; tick: number; player: number; questId: string; stage: string }
  | {
      type: 'proximityWarning';
      tick: number;
      ownerPlayer: number;
      wardEntityId: EntityId;
      intruderEntityId: EntityId;
    }
  | { type: 'waveSpawned'; tick: number; laneId: string; waveName: string; count: number }
  | { type: 'matchEnded'; tick: number; winner: TeamId | null }
  | { type: 'commandRejected'; tick: number; player: number; commandType: string; reason: string };

// ---------------------------------------------------------------------------
// Damage pipeline
// ---------------------------------------------------------------------------

/**
 * One damage instance entering combat.applyDamage. Pipeline (SEMANTICS §1):
 * - damageType 'true'  -> applied verbatim (suicide bombs, SetUnitLifeBJ).
 * - damageType 'magic' -> typeMult(attackType, defenseType) x hull AIsr
 *   reduction; armor VALUE ignored.
 * - damageType 'physical' -> typeMult x armor-value factor
 *   ((armor*0.06)/(1+armor*0.06), amplification for negative armor).
 * - noTypeMult (Kaboom warheads): physical armor-value factor applies, but
 *   the attack-vs-defense multiplier is skipped.
 */
export interface DamageInstance {
  amount: number;
  attackType: AttackType;
  damageType: 'physical' | 'magic' | 'true';
  noTypeMult: boolean;
  /** PF buff DoT cannot reduce HP below 1 (SEMANTICS §2). */
  nonLethal: boolean;
  sourcePlayer: number | null;
  sourceEntityId: EntityId | null;
  weaponId: string | null;
}

// ---------------------------------------------------------------------------
// Statuses (buffs/debuffs on units) — tagged POJOs in entity.statuses
// ---------------------------------------------------------------------------

export type Status =
  | {
      kind: 'dot';
      buffId: string;
      dmgPerTick: number;
      expiresAtTick: number;
      nonLethal: boolean;
      sourcePlayer: number | null;
    }
  | { kind: 'hot'; buffId: string; healPerTick: number; expiresAtTick: number }
  | {
      /**
       * Timed invisibility (smoke/Hide) or Ghost (expiresAtTick null).
       * breaksOnAction: removed permanently by attack/cast/item use; Ghost
       * instead gets a transient 'revealed' status for the action window.
       */
      kind: 'invisible';
      buffId: string | null;
      expiresAtTick: number | null;
      breaksOnAction: boolean;
    }
  | { kind: 'revealed'; expiresAtTick: number }
  | {
      /** PF retarget gate marker (Acid BNab 20 s, Nuke B016 4 s, cosmetic 0.01 s). */
      kind: 'weaponBuff';
      buffId: string;
      expiresAtTick: number;
    }
  | {
      /** Bstt Goblin Mine: arms on the victim's next item use / cast, kills 5 s later. */
      kind: 'goblinMine';
      sourcePlayer: number;
      detonateAtTick: number | null;
    }
  | { kind: 'ensnared'; expiresAtTick: number }
  | { kind: 'stunned'; expiresAtTick: number }
  | { kind: 'silenced'; expiresAtTick: number }
  | { kind: 'slowed'; moveSpeedPct: number; expiresAtTick: number }
  | { kind: 'shielded'; expiresAtTick: number }
  | { kind: 'speedAura'; moveSpeedPct: number; sourceAbilityId: string };

// ---------------------------------------------------------------------------
// Entities (tagged POJOs)
// ---------------------------------------------------------------------------

export type UnitOrder =
  | { type: 'idle' }
  | { type: 'hold' }
  | { type: 'move'; x: number; y: number }
  | { type: 'attackMove'; x: number; y: number }
  | { type: 'attackTarget'; targetId: EntityId };

/** Per-team computed visibility, refreshed by specials each tick. */
export interface VisionFlags {
  south: boolean;
  north: boolean;
}

/** Wind-up casts (I026 Underwater Launch 3.5 s). */
export interface CastingState {
  abilityOrItemId: string;
  slot: number | null;
  targetId: EntityId | null;
  x: number | null;
  y: number | null;
  completesAtTick: number;
}

interface EntityCommon {
  id: EntityId;
  typeId: string;
  x: number;
  y: number;
  facingRad: number;
  /** Set when hp reaches 0 (or scripted kill); removed in tick finalize. */
  dead: boolean;
}

export interface ShipEntity extends EntityCommon {
  kind: 'ship';
  owner: number;
  team: TeamId;
  hp: number;
  /** Base ship + hull bonus; economy recomputes on inventory change. */
  maxHp: number;
  order: UnitOrder;
  statuses: Status[];
  vision: VisionFlags;
  /**
   * Native-attack timer. Currently inert for ships: the vestigial Hpal
   * attack's damage is not compiled (PROVISIONAL, ruleset.ts) — right-click
   * chases stop at ShipSpec.nativeAttackRangeUnits without firing.
   */
  attackReadyAtTick: number;
  casting: CastingState | null;
  /** Repair-bay pause: unit is frozen + invulnerable until this tick. */
  pausedUntilTick: number;
  invulnerableUntilTick: number;
  /** True while a sub is in its submerged form (typeId already swapped). */
  submerged: boolean;
}

export interface CreepEntity extends EntityCommon {
  kind: 'creep';
  /** AI empire player slot (0 south, 1 north). */
  owner: number;
  team: TeamId;
  hp: number;
  maxHp: number;
  order: UnitOrder;
  statuses: Status[];
  vision: VisionFlags;
  attackReadyAtTick: number;
  laneId: string;
  waypointIndex: number;
}

export interface StructureEntity extends EntityCommon {
  kind: 'structure';
  /** Player slot, or null for neutral shops. */
  owner: number | null;
  team: TeamId | null;
  /** Stable map key (e.g. 'n003_0024') for lane/income gating; '' if none. */
  instanceKey: string;
  role: 'hq' | 'spawnBuilding' | 'tower' | 'shop' | 'repair' | 'missileRamp' | 'other';
  hp: number;
  maxHp: number;
  statuses: Status[];
  attackReadyAtTick: number;
  /** Per-item stock for shops; null for non-shops. */
  shopStock: Record<string, { stock: number; nextRestockTick: number }> | null;
}

export interface WardEntity extends EntityCommon {
  kind: 'ward';
  owner: number;
  team: TeamId;
  expiresAtTick: number | null;
  sightRadius: number;
  /** True-sight radius; null = not a detector (Motion Detector). */
  detectionRadius: number | null;
  invisible: boolean;
  invulnerable: boolean;
}

/** Summoned combat units (Leviathian Charm nba2, Seamonster, Spy nvil). */
export interface SummonEntity extends EntityCommon {
  kind: 'summon';
  owner: number;
  team: TeamId;
  hp: number;
  maxHp: number;
  order: UnitOrder;
  statuses: Status[];
  vision: VisionFlags;
  attackReadyAtTick: number;
  expiresAtTick: number | null;
}

export type Entity = ShipEntity | CreepEntity | StructureEntity | WardEntity | SummonEntity;

/** Mobile combatants. */
export type UnitEntity = ShipEntity | CreepEntity | SummonEntity;

/** Anything that can take damage. */
export type Combatant = UnitEntity | StructureEntity;

export function isUnitEntity(e: Entity): e is UnitEntity {
  return e.kind === 'ship' || e.kind === 'creep' || e.kind === 'summon';
}

export function isCombatant(e: Entity): e is Combatant {
  return e.kind !== 'ward';
}

/** Allocate the next entity/projectile/ground-item id (shared counter). */
export function allocEntityId(state: SimState): EntityId {
  const id = state.nextEntityId;
  state.nextEntityId = id + 1;
  return id;
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

/**
 * In-flight shots, including missile-warhead dummies (h00N/h00O/h00P).
 * Homing (homingTargetId set): re-homes every tick, guaranteed hit on
 * arrival; fizzles if the target dies in flight. Non-homing: flies to
 * (targetX, targetY) captured at launch and hits only if intendedTargetId's
 * collision circle covers the impact point on arrival (SEMANTICS §2).
 */
export interface Projectile {
  id: number;
  ownerPlayer: number | null;
  team: TeamId;
  sourceEntityId: EntityId | null;
  /** Weapon item/ability rawcode, or unit typeId for native attacks. */
  weaponId: string;
  mechanic: 'phoenixFire' | 'stormBolt' | 'kaboomMissile' | 'nativeAttack';
  x: number;
  y: number;
  speedPerTick: number;
  homingTargetId: EntityId | null;
  targetX: number;
  targetY: number;
  intendedTargetId: EntityId | null;
  /** Pre-rolled payload (dice rolled at launch for native attacks). */
  payload: {
    amount: number;
    attackType: AttackType;
    damageType: 'physical' | 'magic';
    noTypeMult: boolean;
  };
}

// ---------------------------------------------------------------------------
// Players, teams, items
// ---------------------------------------------------------------------------

/**
 * One carried item. `readyAtTick` is both the Phoenix-Fire instance cooldown
 * (each carried cannon runs its own timer) and the active-item cooldown.
 */
export interface ItemInstance {
  itemId: string;
  /** null = unlimited charges. */
  charges: number | null;
  readyAtTick: number;
}

export interface GroundItem {
  id: number;
  itemId: string;
  x: number;
  y: number;
  charges: number | null;
  /**
   * Absolute tick the item becomes usable again — carried over from the
   * dropping owner's ItemInstance so a drop/re-pick cycle cannot launder
   * item or Phoenix-Fire instance cooldowns.
   */
  readyAtTick: number;
}

/**
 * Player-scoped state. Inventory lives here (not on the ship entity) because
 * Change_Ship transfers all six slots across hull swaps and respawns
 * (script-rules.json §2); slots beyond the current ship's inventorySlots
 * must be empty (economy enforces).
 */
export interface PlayerState {
  slot: number;
  team: TeamId;
  control: 'user' | 'computer';
  gold: number;
  /** Trigger-managed contract lumber (udg_PlayerLumber), NOT WC3 lumber. */
  lumber: number;
  xp: number;
  level: number;
  unspentSkillPoints: number;
  /** abilityId -> learned rank. */
  heroSkillLevels: Record<string, number>;
  shipTypeId: string;
  /** null while dead / awaiting respawn. */
  shipId: EntityId | null;
  /** Always length 6; null = empty slot. */
  inventory: (ItemInstance | null)[];
  /** Item cooldown groups (icid, e.g. 'Aeye' wards, 'Aslo') -> readyAtTick. */
  cooldownGroups: Record<string, number>;
  /** Scripted ~2 s missile-launch throttle (A032 strip/re-add). */
  missileReadyAtTick: number;
  respawnAtTick: number | null;
  goldDumpEnabled: boolean;
}

export interface TeamState {
  id: TeamId;
  aiPlayerSlot: number;
  /** upgradeId -> researched level. Team-shared by construction (tech sharing). */
  upgrades: Record<string, number>;
  /** One research in flight per team. */
  research: { upgradeId: string; completesAtTick: number } | null;
}

// ---------------------------------------------------------------------------
// Match state
// ---------------------------------------------------------------------------

export type MatchStatus =
  | { phase: 'playing' }
  | { phase: 'ended'; winner: TeamId | null; endedAtTick: number };

export interface PendingDeath {
  entityId: EntityId;
  victimPlayer: number | null;
  killerPlayer: number | null;
  killerEntityId: EntityId | null;
  /** Scripted deaths (suicide bombs, Goblin Bomber) skip normal bounty/XP. */
  scripted: boolean;
}

/** Timed true-sight areas from flares (AIfa). Owned by specials. */
export interface DetectionZone {
  team: TeamId;
  x: number;
  y: number;
  radius: number;
  expiresAtTick: number;
}

/**
 * Match-scoped periodic timers. Field ownership: nextWaveTick — creeps;
 * everything else — economy.
 */
export interface MatchTimers {
  nextWaveTick: Record<string, number>;
  nextIncomeTick: number;
  /** Rolled ONCE at createMatch with the match Rng (map-layout income note). */
  empireSharePeriodTicks: number;
  nextEmpireShareTick: number;
  nextGoldDumpTick: number;
  /** Street Merchant spawn schedule; null = roll failed or already spawned. */
  streetMerchantSpawnTick: number | null;
}

export interface SimState {
  tick: number;
  rngState: number;
  nextEntityId: number;
  status: MatchStatus;
  /**
   * Active game-mode flags ('OnlySailors', 'InstantDeath'...). Classic
   * default: empty. StackRule.onlyInModes rules apply only when listed here.
   */
  enabledModes: string[];
  /** Keyed by player slot 0-11 (0/1 are the AI empire players). */
  players: Record<number, PlayerState>;
  /** Fixed keys; createMatch inserts 'south' then 'north'. */
  teams: Record<TeamId, TeamState>;
  entities: Record<number, Entity>;
  projectiles: Record<number, Projectile>;
  groundItems: Record<number, GroundItem>;
  detectionZones: DetectionZone[];
  /**
   * Treasure-hunt active location index per team (1..locationCount), or null
   * before the seed tick. Seeded once at TreasureHuntSpec.seedTick and
   * rerolled on every pickup — BOTH draws come from the match Rng
   * (state.rngState) in a fixed order (south then north at the seed tick;
   * reroll inline in the ascending-slot contract scan) so the match replays
   * bit-identically. A serializable POJO field per the determinism mandate.
   */
  treasureByTeam: Record<TeamId, number | null>;
  /** Written by combat/specials, consumed by progression, cleared in finalize. */
  pendingDeaths: PendingDeath[];
  /** Per-tick event buffer: cleared and returned by stepTick. Excluded from hashState. */
  events: SimEvent[];
  timers: MatchTimers;
  /**
   * Per-slot AI brain memory, keyed by player slot (2-11). Present ONLY for
   * AI-controlled slots; empty record when the match has no AI players.
   *
   * Lives inside SimState (rather than a server-side side table) so it is
   * covered by hashState and survives serialize/reconnect — the determinism
   * mandate (docs/AI.md). Because it is brain-derived AND hashed, an AI match
   * reproduces bit-identically by RE-RUNNING the brain from (seed, AI configs),
   * not by replaying only the logged command stream (which would leave this
   * memory frozen at init); see `sim/ai.ts` "REPLAY CONTRACT". The server's
   * AI runner reads + writes these entries via `sim/ai.ts` only; nothing in
   * the tick systems (creeps/movement/.../progression) touches them.
   */
  aiMemory: Record<number, AiMemory>;
}

export interface PlayerConfig {
  slot: number;
  control: 'user' | 'computer';
  /**
   * When set, this slot is driven by the deterministic AI brain
   * (`sim/ai.ts`). `control` MUST be 'computer' for an AI slot — an AI is a
   * server-driven computer player whose emitted Commands flow through the
   * normal applyCommands path. Omit (or null) for human/idle computer slots.
   *
   * NOTE: AI slots are still real player slots (2-11); the AI empire slots
   * 0/1 are NEVER AI-brain-controlled (they are the creep owners) and
   * createMatch rejects an aiConfig on slot 0/1.
   */
  ai?: AiConfig | null;
}

// ---------------------------------------------------------------------------
// AI players (computer-controlled captains) — see docs/AI.md
// ---------------------------------------------------------------------------

/**
 * AI skill tier. Tunes think cadence, economy efficiency, retreat threshold,
 * and micro quality (docs/AI.md difficulty table). 'normal' is the default.
 */
export type AiDifficulty = 'easy' | 'normal' | 'hard';

/**
 * Per-slot AI configuration, fixed at match setup and stored in SimState so
 * it survives serialize/reconnect and is covered by hashState (determinism).
 * The brain reads `difficulty` to derive its cadence and behavior knobs; it
 * holds NO mutable runtime state (that lives in `AiMemory`).
 */
export interface AiConfig {
  difficulty: AiDifficulty;
}

/**
 * Per-slot mutable AI brain memory. A plain serializable POJO (no classes,
 * Maps, or functions) so it lives inside SimState and is therefore covered by
 * hashState and survives serialize/reconnect/replay bit-identically.
 *
 * Determinism contract: the brain draws randomness ONLY from a PRNG seeded
 * deterministically from (initialSeed, slot, state.tick) — see
 * `sim/ai.ts` `seedAiRng`. It NEVER touches `state.rngState` (that channel is
 * reserved for sim mechanics whose draw order is the replay contract), nor
 * Math.random / Date / Math trig built-ins. `aiRngState` below is the brain's
 * OWN PRNG stream, advanced only by the brain.
 *
 * All tick-valued fields are ABSOLUTE sim ticks (like the rest of SimState).
 */
export interface AiMemory {
  slot: number;
  difficulty: AiDifficulty;
  /**
   * Seed captured at createMatch for this slot's private PRNG stream:
   * derived from (match seed, slot) so two AIs on the same seed diverge and a
   * replay reproduces every decision. The brain folds in `state.tick` per
   * call (see `seedAiRng`) so re-running the same tick is reproducible.
   */
  initialSeed: number;
  /** The brain's private mulberry32 state, advanced ONLY by the brain. */
  aiRngState: number;
  /** Next tick the brain is allowed to think on (cadence gate). */
  nextThinkTick: number;
  /** Lane this bot committed to ('south-west' etc.), or null until chosen. */
  laneId: string | null;
  /**
   * Current high-level intent, for hysteresis (avoid flip-flopping between
   * push and retreat every think). Brain-owned enum; see `sim/ai.ts`.
   */
  stance: 'push' | 'retreat' | 'regroup';
  /**
   * Absolute tick this bot entered the current `retreat` stance (0 while
   * pushing). The brain force-flips back to `push` after a bounded number of
   * ticks even if not fully healed, so a bot that cannot reach its repair bay
   * (e.g. blocked / no heal item) re-engages instead of idling at base
   * forever. Reset to 0 on every push transition. See `sim/ai.ts`.
   */
  retreatSinceTick: number;
  /** Last waypoint the bot issued a move/attackMove to (stuck detection). */
  lastOrderX: number | null;
  lastOrderY: number | null;
  /** Ship position the last time the brain checked progress (stuck detect). */
  lastProgressX: number | null;
  lastProgressY: number | null;
  /** Tick of the last progress check; paired with lastProgress[XY]. */
  lastProgressTick: number;
  /**
   * Consecutive thinks with no meaningful movement — when this crosses the
   * brain's threshold the bot re-routes (new waypoint) to break a stuck loop.
   */
  stuckCount: number;
}

/** Canonical system order inside stepTick (documented in sim.ts). */
export const TICK_SYSTEM_ORDER = [
  'creeps',
  'movement',
  'specials',
  'combat',
  'economy',
  'progression',
] as const;

export type SystemName = (typeof TICK_SYSTEM_ORDER)[number];

// ===========================================================================
// Ruleset — compiled balance data. Nothing below is hardcoded in systems;
// Classic = data/json verbatim, compiled by ruleset.compileClassicRuleset.
// ===========================================================================

export interface TargetFilter {
  /** Non-structure units (ships/creeps/summons). */
  ships: boolean;
  structures: boolean;
  /** atar 'enemies,hero' — sniper line: enemy hero ships only. */
  heroOnly: boolean;
}

export interface DotSpec {
  dmgPerTick: number;
  durationTicks: number;
  buffId: string;
  /** PF buff DoT cannot kill (clamps at 1 HP) — SEMANTICS §2. */
  nonLethal: boolean;
}

export interface WeaponSpec {
  id: string;
  name: string;
  abilityId: string | null;
  mechanic: 'phoenixFire' | 'stormBolt' | 'kaboomMissile';
  gold: number | null;
  damage: number;
  cooldownTicks: number;
  /** Acquisition/cast range in map units; null = map-wide (warheads). */
  rangeUnits: number | null;
  aoeRadius: number | null;
  /** Map units per TICK (compiled from units/sec); null = instant. */
  projectileSpeedPerTick: number | null;
  homing: boolean;
  targets: TargetFilter;
  attackType: AttackType;
  damageType: 'physical' | 'magic';
  /** Kaboom: armor value applies, attack-vs-defense multiplier skipped. */
  noTypeMult: boolean;
  dot: DotSpec | null;
  /** Applied buff; gates PF retargeting while present on a candidate. */
  buffId: string | null;
  buffDurationTicks: number;
  /** Wind-up before launch (I026: 3.5 s). 0 = instant. */
  castTimeTicks: number;
  /** Item cooldown group (icid), e.g. 'Aslo'; null = none. */
  cooldownGroup: string | null;
}

export interface EquipmentPassives {
  maxHpBonus: number;
  /** AIsr spell-damage reduction fraction (0.10/0.20/0.30). Never stacks. */
  damageReductionPct: number;
  armorBonus: number;
  /** Fraction of base move speed; negative on hulls. */
  moveSpeedPct: number;
  hpRegenPerTick: number;
}

export type EquipmentActive =
  | { kind: 'instantHeal'; amount: number; cooldownTicks: number }
  | { kind: 'blink'; maxDistance: number; cooldownTicks: number }
  | { kind: 'invisibility'; durationTicks: number; cooldownTicks: number; buffId: string }
  | {
      kind: 'summonWard';
      wardTypeId: string;
      durationTicks: number;
      cooldownTicks: number;
    }
  | {
      kind: 'flare';
      radius: number;
      durationTicks: number;
      cooldownTicks: number;
      detectsInvisible: boolean;
    }
  | { kind: 'reveal'; durationTicks: number | null }
  | {
      kind: 'rejuvenation';
      totalHeal: number;
      durationTicks: number;
      rangeUnits: number;
      buffId: string;
    }
  | { kind: 'xpTome'; xp: number }
  | { kind: 'summonUnit'; unitTypeId: string; durationTicks: number }
  | { kind: 'flavor' };

export interface EquipmentSpec {
  id: string;
  name: string;
  category: 'hull' | 'sail' | 'repair' | 'utility' | 'consumable';
  gold: number | null;
  passives: EquipmentPassives | null;
  active: EquipmentActive | null;
  /** null = unlimited. */
  charges: number | null;
  /** Trade goods removed when dropped/given (Goblin Mechanic etc.). */
  perishable: boolean;
  /** Item cooldown group (icid); null = per-item cooldown only. */
  cooldownGroup: string | null;
}

export interface HeroSkillRule {
  abilityId: string;
  ranks: number;
  /** alsk — hero levels per learnable rank (BSP: 2). */
  levelsPerRank: number;
  /** arlv — minimum hero level for rank 1 (Goblin Bomber: 8). */
  minHeroLevel: number;
}

export interface AbilitySpec {
  abilityId: string;
  name: string;
  kind: 'heroSkill' | 'innate';
  /**
   * 'stormBoltWeapon'/'phoenixFireWeapon' route to combat (weaponId set);
   * 'hullHp'/'sailSpeed'/'mechanicsRegen' are passive per-rank stats;
   * 'dive'/'invisibility'/'flareDetection'/'trueSightPassive' route to
   * specials; 'special' = exotic kit (Capsize, EMP, Eat Hero...) interpreted
   * by specials via specialKey — may be stubbed pre-parity.
   */
  mechanic:
    | 'stormBoltWeapon'
    | 'phoenixFireWeapon'
    | 'hullHp'
    | 'sailSpeed'
    | 'mechanicsRegen'
    | 'dive'
    | 'invisibility'
    | 'flareDetection'
    | 'trueSightPassive'
    | 'special';
  specialKey: string | null;
  skill: HeroSkillRule | null;
  /** Per-rank magnitude (damage, HP, %, HP/s...); index 0 = rank 1. */
  magnitudePerRank: number[];
  durationTicksPerRank: number[] | null;
  cooldownTicks: number | null;
  rangeUnits: number | null;
  /** Link into Ruleset.weapons for weapon-mechanic abilities. */
  weaponId: string | null;
}

export interface BountySpec {
  base: number;
  dice: number;
  sides: number;
}

export interface ShipSpec {
  typeId: string;
  name: string;
  gold: number;
  /** Raw object-data fields (uhpm/udef) preserved for audit. */
  rawHp: number;
  rawArmor: number;
  /** Effective values: rawHp + 25*str; rawArmor - 2 + 0.3*agi (hero math). */
  maxHp: number;
  armor: number;
  defenseType: DefenseType;
  /** Map units per second (base, before sails/auras/clamps). */
  moveSpeed: number;
  /** umvr capped at 0.20 rad/frame -> compiled rad per TICK. */
  turnRateRadPerTick: number;
  collisionRadius: number;
  inventorySlots: number;
  isSub: boolean;
  /** AbilitySpec ids: hero skills + innate abilities of this hull. */
  abilityIds: string[];
  hpRegenPerTick: number;
  bounty: BountySpec;
  sightRadius: number;
  /** Built-in true sight (H001 Adtg 1200); null otherwise. */
  detectionRadius: number | null;
  /**
   * Vestigial Hpal native-attack acquisition range (units.json ua1r 1000).
   * Used as the attackTarget chase stop distance; the attack's DAMAGE is not
   * compiled (ua1b absent — Hpal base value pending the 1.24 SLK extraction,
   * documented PROVISIONAL in ruleset.ts), so ships deal no native damage.
   */
  nativeAttackRangeUnits: number | null;
}

export interface UnitAttackSpec {
  damageBase: number;
  damageDice: number;
  damageSides: number;
  cooldownTicks: number;
  rangeUnits: number;
  attackType: AttackType;
  projectileSpeedPerTick: number | null;
  targets: TargetFilter;
  /** R005-style bonus dice land here per researched level. */
  upgradeIds: string[];
}

/** Creeps, towers, HQs, shops, wards, summon units, missile dummies. */
export interface UnitTypeSpec {
  typeId: string;
  name: string;
  maxHp: number;
  armor: number;
  defenseType: DefenseType;
  attack: UnitAttackSpec | null;
  /** Units/sec; 0 for structures. */
  moveSpeed: number;
  turnRateRadPerTick: number;
  collisionRadius: number;
  isStructure: boolean;
  /** ulev — drives kill XP. */
  level: number;
  bounty: BountySpec;
  hpRegenPerTick: number;
  sightRadius: number;
  detectionRadius: number | null;
  permanentlyInvisible: boolean;
  invulnerable: boolean;
}

export interface UpgradeSpec {
  id: string;
  name: string;
  maxLevel: number;
  /** On the Upgrade Center's (n00P ures) research list; R002 is orphaned. */
  researchable: boolean;
  /** index 0 = level 1. */
  goldCostPerLevel: number[];
  researchTicks: number;
  appliesToUnitTypes: string[];
  effect:
    | { kind: 'flatMaxHp'; perLevel: number[] }
    | { kind: 'flatAttackDamage'; perLevel: number[] }
    | { kind: 'pctBaseMaxHp'; perLevel: number[] }
    | { kind: 'flatMoveSpeed'; perLevel: number[] }
    | { kind: 'bonusAttackDice'; perLevel: number[] }
    | { kind: 'flatHpRegen'; perLevel: number[] };
}

export interface ShopItemEntry {
  itemId: string;
  gold: number;
  /** Contract gating (udg_PlayerLumber); 0 = none. */
  lumberCost: number;
  /** null = unlimited stock. */
  stockMax: number | null;
  restockTicks: number | null;
}

export interface ShopSpec {
  structureTypeId: string;
  /** Aneu select/interact radius (Main Harbor 400). */
  interactRadius: number;
  items: ShopItemEntry[];
  ships: { shipTypeId: string; gold: number; lumberCost: number }[];
}

export interface StackRule {
  id: string;
  itemIds: string[];
  maxPerShip: number;
  bannedOnShipTypes: string[];
  /** Mutually-exclusive rule groups (Kraken vs hull/sail/repair). */
  exclusiveWithRuleIds: string[];
  /** Game modes where the rule applies; null = always (sniper cap: OnlySailors). */
  onlyInModes: string[] | null;
}

export interface SubRules {
  surfacedTypeId: string;
  submergedTypeId: string;
  torpedoItemIds: string[];
  maxTorpedoBaysPerSub: number;
  /**
   * SubAcquiredItems BLACKLIST (war3map.j 9353-9404): the repair woods,
   * repair crews and Kraken that subs may NOT carry (auto-refunded on
   * pickup). Everything else is carryable.
   */
  bannedItemIds: string[];
  diveAbilityId: string;
  diveCooldownTicks: number;
}

export interface MissileRules {
  castAbilityId: string;
  /** I01N — consumed alongside the warhead each launch. */
  lumberItemId: string;
  throttleTicks: number;
  /** warhead itemId -> payload dummy + WeaponSpec link. */
  warheads: Record<string, { dummyTypeId: string; weaponId: string }>;
  targeting: 'randomEnemyLeadPlayerStructure';
  buggfixPeriodTicks: number;
  /** Preserved asymmetric bug: retry only fixes south-owned missiles. */
  buggfixSouthOnly: boolean;
}

export interface SuicideQuestSpec {
  id: string;
  shipTypeId: string;
  startItemId: string;
  requiredItemIds: string[];
  unarmedTokenId: string | null;
  armedTokenId: string;
  pickupRegion: string | null;
  /** JASS UnitInventoryCount gate at the pickup stage (< N); null = none. */
  pickupMaxCarriedItems: number | null;
  /** Items that BLOCK arming when carried (superbomb: the goblin token I01G). */
  armForbiddenItemIds: string[];
  /** Region where the token is armed, per carrying player's team. */
  armRegionByTeam: Record<TeamId, string>;
  /** Enemy main-base rect that triggers detonation, per carrier's team. */
  detonateRegionByTeam: Record<TeamId, string>;
  /** Flat true damage to the enemy HQ (bypasses armor/reduction). */
  hqDamage: number;
  rewardGold: number;
  rewardXp: number;
  warnPingTicks: number;
}

export interface TradeRouteSpec {
  /** Contract item carried at pickup AND delivery (kept, never consumed). */
  contractItemId: string;
  goodsItemId: string;
  goodsName: string;
  pickupRegion: string;
  /** Restricts the route to this team's players; null = both teams. */
  team: TeamId | null;
  /** Eligible carrier hulls -> JASS UnitInventoryCount pickup gate (< N). */
  carrierMaxItems: Record<string, number>;
  /** OWN-team reward zone where contract + goods pay out. */
  deliverRegionByTeam: Record<TeamId, string>;
  rewardGold: number;
  rewardXp: number;
  rewardLumber: number;
}

/**
 * One refinery cash-in route (gg_rct_{South,North}Reward
 * Trig_*_Rewards_Refinery). Mirrors TradeRouteSpec's reward shape: the
 * carrier delivers the ORIGINAL contract + the REFINED good + the
 * membership book to its OWN reward zone; the refined good is removed
 * (contract + book kept) and gold/XP/lumber paid. Pays 1.5x the raw route's
 * gold (war3map.j 13664-14068).
 */
export interface RefineryRewardRoute {
  /** The trade-route contract carried (kept on cash-in). */
  contractItemId: string;
  /** The refined good consumed on cash-in. */
  refinedGoodId: string;
  /** Restricts the route to this team; null = both teams (mirrors raw routes). */
  team: TeamId | null;
  rewardGold: number;
  rewardXp: number;
  rewardLumber: number;
}

/**
 * REFINERY CHAIN (questSystems.refinery): a two-step value-upgrade of trade
 * goods, gated on the never-consumed membership item I02Q Book of Formulas.
 * - Step 1 (refine swap at refineRegion): a carrier holding a RAW good + the
 *   book swaps the raw good for its REFINED good in place. No team gate, no
 *   contract, no inventory-count gate.
 * - Step 2 (cash-in at the OWN reward zone): contract + refined good + book
 *   carried -> refined good removed, gold/XP/lumber paid.
 */
export interface RefinerySpec {
  /** I02Q — required to enter both steps; never consumed. */
  membershipItemId: string;
  /** Central swap rect (gg_rct_Refinery). */
  refineRegion: string;
  /** Per-team cash-in rect (gg_rct_{South,North}Reward). */
  rewardRegionByTeam: Record<TeamId, string>;
  /** Eligible carrier hulls (H00D/H005 -> JASS UnitInventoryCount gate < N). */
  carrierMaxItems: Record<string, number>;
  /** rawGoodId -> refinedGoodId swaps at refineRegion (ascending rawGoodId). */
  refineSwaps: { rawGoodId: string; refinedGoodId: string }[];
  rewardRoutes: RefineryRewardRoute[];
}

/**
 * REPAIR BUILDINGS MISSION (questSystems.repairMission, item I01I). Despite
 * the name there is no "repair a building" action — the deliverable is a
 * consumable token whose USE pays out.
 * - Buy I01I (igol 0, threshold lumberThreshold, never consumed) from a
 *   Trade Master.
 * - Token step (at tokenRegion): a carrier holding the contract and NOT the
 *   token, with a free slot, gains the token (contract kept).
 * - Reward step (USE-ITEM, mirrors economy.useItem): using the token (or its
 *   refined variant while carrying the book) pays gold/XP/lumber.
 */
export interface RepairMissionSpec {
  /** I01I — the purchased mission contract (kept; pure threshold). */
  contractItemId: string;
  /** udg_PlayerLumber threshold to buy (18); never consumed. */
  lumberThreshold: number;
  /** Region where the carrier is granted the token (gg_rct_GoblinBombShop). */
  tokenRegion: string;
  /** I01J Goblin Mechanic — the consumable reward token. */
  tokenItemId: string;
  /** Eligible carrier hulls -> JASS UnitInventoryCount gate (< N). */
  carrierMaxItems: Record<string, number>;
  reward: { rewardGold: number; rewardXp: number; rewardLumber: number };
  /** Refinery upgrade: I01J + book -> refinedTokenId at the refine region. */
  refinedVariant: {
    membershipItemId: string;
    refineRegion: string;
    refinedTokenId: string;
    reward: { rewardGold: number; rewardXp: number; rewardLumber: number };
  };
}

/**
 * TREASURE HUNT (questSystems.treasureHunts, I02H south / I02I north).
 * - Buy the team's contract (igol 1000, refunds engine lumber, NO threshold).
 * - Find: exactly ONE active treasure location per team (a 1..N index in
 *   SimState.treasureByTeam), seeded at the seed tick and rerolled on pickup.
 *   A registered H005 carrying the contract, not the treasure, with a free
 *   slot, that enters the rect matching its team's current number gains the
 *   treasure; the team number is rerolled from the match Rng.
 * - Return: at the OWN reward zone the registered boat with contract +
 *   treasure pays out; BOTH the treasure AND the contract are consumed.
 * - Refined branch (refinedVariant): the Treasure can instead be REFINED into
 *   the Golden Statue (I02G -> I030) at the Refinery while carrying the book
 *   (Trig_Golden_Treasure_Pick_Up), then cashed at the OWN reward zone with
 *   contract + Golden Statue + book for the 1.5x reward (21000g vs 14000g;
 *   Trig_{South,North}TreasureReward_Copy). The contract + statue are removed;
 *   the book is kept.
 */
export interface TreasureHuntSpec {
  /** Team -> the contract item that team buys (I02H south / I02I north). */
  contractByTeam: Record<TeamId, string>;
  /** I02G Treasure — granted on find, consumed on return. */
  treasureItemId: string;
  /** Only this hull can find/return treasure (H005). */
  carrierShipType: string;
  /** JASS UnitInventoryCount gate at find (< N). */
  pickupMaxCarriedItems: number;
  /** Number of treasure locations (8); treasure index is 1..N. */
  locationCount: number;
  /** Tick the per-team treasure numbers are first seeded (GetRandomInt 1..N). */
  seedTick: number;
  /** Team -> (treasure number string -> region name). */
  locationRegionsByNumber: Record<TeamId, Record<string, string>>;
  /** Per-team return rect (gg_rct_{South,North}Reward). */
  rewardRegionByTeam: Record<TeamId, string>;
  reward: { rewardGold: number; rewardXp: number; rewardLumber: number };
  /**
   * The refined Golden-Statue branch: refine the Treasure at the Refinery
   * (gated on the Book of Formulas), then cash it for the larger reward.
   */
  refinedVariant: {
    /** I02Q Book of Formulas — gates both the refine and the cash-in; kept. */
    membershipItemId: string;
    /** Central swap rect (gg_rct_Refinery) — same rect as the trade-good refines. */
    refineRegion: string;
    /** I030 Golden Statue — the refined Treasure (granted by the swap, consumed on cash-in). */
    refinedTreasureId: string;
    reward: { rewardGold: number; rewardXp: number; rewardLumber: number };
  };
}

/** The three secondary quest chains (questSystems in script-rules.json). */
export interface QuestSystems {
  refinery: RefinerySpec;
  repairMission: RepairMissionSpec;
  treasureHunts: TreasureHuntSpec;
}

export interface ContractRules {
  /** itemId -> udg_PlayerLumber threshold at purchase (I00S 4 ... I00Q 25). */
  lumberCosts: Record<string, number>;
  /**
   * itemId -> ENGINE lumber refunded at purchase (the items.json ilum charge
   * given straight back — net zero). Informational only: udg_PlayerLumber
   * (PlayerState.lumber) is NEVER credited by purchases.
   */
  lumberRefunds: Record<string, number>;
  tradeRoutes: TradeRouteSpec[];
  captainReward: {
    pieceItemId: string;
    piecesRequired: number;
    tokenItemId: string;
    rewardGold: number;
    rewardXp: number;
    rewardLumber: number;
  };
}

export interface XpRules {
  /** Cumulative XP to REACH level index (xpToLevel[2] = 200...). */
  xpToLevel: number[];
  /** Kill XP from a normal unit by victim level (index = level). */
  killXpByVictimLevel: number[];
  /** Hero kill XP by victim level 1..5; +heroKillXpPerLevelAbove beyond. */
  heroKillXpByVictimLevel: number[];
  heroKillXpPerLevelAbove: number;
  shareRadius: number;
  summonFactor: number;
  /** Provisional 12 — top OPEN question (SEMANTICS §6). */
  heroLevelCap: number;
  skillPointsPerLevel: number;
}

export interface RespawnRules {
  /** delay = perLevelSeconds*level + baseSeconds + rollInt(0, randMaxSeconds). */
  perLevelSeconds: number;
  baseSeconds: number;
  randMaxSeconds: number;
  invulnerableTicks: number;
}

export interface IncomeRules {
  intervalTicks: number;
  /** Keyed by team human count (1-5): gold per human slot + to team AI. */
  byHumanCount: Record<number, { perHumanSlot: number; toTeamAi: number }>;
  /** Preserved bug: BOTH teams' income gates on the NORTH HQ being alive. */
  requiresNorthHqAlive: boolean;
  empireShareMinTicks: number;
  empireShareMaxTicks: number;
  goldDumpPeriodTicks: number;
  streetMerchant: {
    rollAtTick: number;
    spawnAtTick: number;
    rollMin: number;
    rollMax: number;
    /** Spawn if roll > threshold. */
    threshold: number;
    merchantTypeId: string;
  };
}

export interface RulesetConstants {
  startingGold: number;
  /** Engine clamps in units/sec (gameplay-constant defaults 150/400). */
  minMoveSpeed: number;
  maxMoveSpeed: number;
  /** 0.20 rad per 0.03 s frame -> compiled cap in rad per TICK. */
  turnRateCapRadPerTick: number;
  /** Armor formula constants: 0.06 and 0.94. */
  armorFactorPerPoint: number;
  negativeArmorBase: number;
  heroStrHpBonus: number;
  heroAgiArmorPerPoint: number;
  heroArmorBaseOffset: number;
  heroStrRegenPerSecond: number;
  /** OPEN (BALANCE §9.4): Classic ships false — warheads deal Dda2 once. */
  missileExplodeOnDeathDoubling: boolean;
  /** 0 in Classic (no Asid on any shop). */
  sellbackRate: number;
  /** Dont_Attack_Friends: ally damage prevented globally. */
  friendlyFire: boolean;
  /** PF buff DoT clamps at 1 HP. */
  pfDotNonLethal: boolean;
}

export interface StructurePlacement {
  typeId: string;
  /** Stable key from map data ('n003_0024') or generated 'typeId@x,y'. */
  instanceKey: string;
  owner: number | null;
  x: number;
  y: number;
  facingDeg: number;
  role: StructureEntity['role'];
  /** For neutral shops: which team's zone they sit in; null = open to both. */
  shopSide: TeamId | null;
}

export interface LaneSpec {
  id: string;
  creepOwner: number;
  team: TeamId;
  spawnX: number;
  spawnY: number;
  spawnFacingDeg: number;
  spawnRegion: string;
  /** Structure instanceKeys gating spawn / bounty variant. */
  ownHarborKey: string;
  bountyGateEnemyHarborKey: string;
  waypoints: {
    x: number;
    y: number;
    /** Re-issue this waypoint when the creep enters any of these regions. */
    issuedOnEnteringRegions: string[] | null;
  }[];
}

export interface WaveSpec {
  name: string;
  periodTicks: number;
  count: number;
  preSpawnDelayTicks: number;
  /** Spawned while the destination enemy harbor lives / after it dies. */
  bountyTypeId: string;
  zeroBountyTypeId: string;
}

export interface MapSpec {
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  regions: Record<string, RegionRect>;
  structures: StructurePlacement[];
  /** Keyed by player slot. */
  playerStarts: Record<
    number,
    { team: TeamId; x: number; y: number; facingDeg: number; startItems: string[] }
  >;
  startingShipTypeId: string;
  lanes: LaneSpec[];
  waves: WaveSpec[];
  respawnRegionByTeam: Record<TeamId, string>;
  repairBays: { team: TeamId; stationRegion: string; exitRegion: string }[];
  /**
   * SUBMERGED subs (H00W) entering mainRegion teleport to exitRegion center
   * — war3map.j Trig_*SubHarbor_Copy checks the submerged form (integrator
   * resolution; the map-layout annotation said "surfaced" but the JASS wins).
   */
  subTeleports: { team: TeamId; mainRegion: string; exitRegion: string }[];
  tempItemRegion: string;
  /** Street Merchant spawn points by team. */
  streetMerchantRegions: Record<TeamId, string>;
}

export interface Ruleset {
  name: string;
  tickRate: number;
  constants: RulesetConstants;
  /** Full TFT attack-vs-defense multiplier table (spells x0.70 vs hero...). */
  attackTypeVsDefense: Record<AttackType, Record<DefenseType, number>>;
  weapons: Record<string, WeaponSpec>;
  equipment: Record<string, EquipmentSpec>;
  abilities: Record<string, AbilitySpec>;
  ships: Record<string, ShipSpec>;
  unitTypes: Record<string, UnitTypeSpec>;
  upgrades: Record<string, UpgradeSpec>;
  /** Keyed by shop structure typeId. */
  shops: Record<string, ShopSpec>;
  stackRules: StackRule[];
  subRules: SubRules;
  missiles: MissileRules;
  suicideQuests: SuicideQuestSpec[];
  contracts: ContractRules;
  questSystems: QuestSystems;
  xp: XpRules;
  respawn: RespawnRules;
  income: IncomeRules;
  map: MapSpec;
}

/** Balanced rulesets = named deep-partial overrides on Classic (DESIGN.md). */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface RulesetPatch {
  name: string;
  description: string;
  changes: DeepPartial<Ruleset>;
}

// ---------------------------------------------------------------------------
// Raw data files (parsed JSON from data/json/, passed to the compiler)
// ---------------------------------------------------------------------------

export interface RawWeaponRow {
  rawcode: string;
  name: string;
  abilityCode?: string | null;
  abilityBase?: string | null;
  gold: number | null;
  damage: number | null;
  cooldown: number | null;
  range: number | null;
  aoe: number | null;
  projectileSpeed: number | null;
  targets: string | null;
  special: string | null;
  provenance?: string;
  tooltipMismatch?: string | null;
  dps?: number | null;
  dpsPer100g?: number | null;
  disputed?: unknown;
}

export interface RawEquipmentRow {
  rawcode: string;
  name: string;
  category: string;
  gold: number | null;
  effects: string;
  provenance?: string;
  special?: string | null;
}

export interface RawShipRow {
  rawcode: string;
  name: string;
  gold: number;
  hp: number;
  armor: number;
  moveSpeed: number;
  inventorySlots: number;
  special: string;
}

export interface RawUpgradeLevelRow {
  level: number;
  goldCost: number;
  effect: string;
}

export interface RawUpgradeRow {
  rawcode: string;
  name: string;
  maxLevel: number;
  appliesTo: string;
  levels: RawUpgradeLevelRow[];
}

export interface RawScriptedItemRow {
  rawcode: string;
  name: string;
  gold: number | null;
  damage: number | null;
  cooldown: number | null;
  aoe: number | null;
  shots: number | null;
  special: string;
  lines: number[];
}

export interface RawTradeRouteRow {
  contractItemId: string;
  goodsItemId: string;
  goodsName: string;
  pickupRegion: string;
  team: string | null;
  carrierMaxItems: Record<string, number>;
  deliverRegionByTeam: Record<string, string>;
  rewardGold: number;
  rewardXp: number;
  rewardLumber: number;
  lines?: number[];
}

/** questSystems block of script-rules.json (the three secondary chains). */
export interface RawQuestSystems {
  refinery: {
    membershipItemId: string;
    refineRegion: string;
    rewardRegionByTeam: Record<string, string>;
    carrierShipTypes: string[];
    refineSteps: { rawGoodId: string; refinedGoodId: string }[];
    rewardRoutes: {
      contractItemId: string;
      refinedGoodId: string;
      team: string | null;
      rewardGold: number;
      rewardXp: number;
      rewardLumber: number;
    }[];
  };
  repairMission: {
    contractItemId: string;
    lumberThreshold: number;
    tokenRegion: string;
    tokenItemId: string;
    carrierMaxItems: Record<string, number>;
    reward: { rewardGold: number; rewardXp: number; rewardLumber: number };
    refinedVariant: {
      membershipItemId: string;
      refineRegion: string;
      refinedTokenId: string;
      reward: { rewardGold: number; rewardXp: number; rewardLumber: number };
    };
  };
  treasureHunts: {
    contractByTeam: Record<string, string>;
    treasureItemId: string;
    contractGold: number;
    contractLumberRefund: number;
    contractLumberThreshold: number;
    carrierShipType: string;
    pickupMaxCarriedItems: number;
    treasureLocationCount: number;
    treasureSeededAtSeconds: number;
    treasureLocationRegionsByNumber: Record<string, Record<string, string>>;
    rewardRegionByTeam: Record<string, string>;
    reward: { rewardGold: number; rewardXp: number; rewardLumber: number };
    refinedVariant: {
      membershipItemId: string;
      refineRegion: string;
      refinedTreasureId: string;
      reward: { rewardGold: number; rewardXp: number; rewardLumber: number };
    };
  };
}

export interface RawMapLayoutFile {
  mapBounds: {
    playableArea: { minX: number; minY: number; maxX: number; maxY: number };
  };
  playerStarts: {
    teams: Record<string, { aiPlayer: number; humanPlayers: number[]; displayName: string }>;
    startingGold: number;
    players: {
      player: number;
      team: string;
      control: string;
      startLocation: { x: number; y: number };
      shipSpawn?: { type: string; name: string; x: number; y: number; facing: number };
      startItems?: string[];
    }[];
  };
  structures: {
    type: string;
    name: string | null;
    owner: number | string;
    x: number;
    y: number;
    facing: number;
    role: string;
    id?: string;
    removedAtMapStart?: boolean;
    resourceAmount?: number;
    note?: string;
  }[];
  regions: {
    name: string;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    centerX: number;
    centerY: number;
    purpose?: string;
    weatherEffect?: string;
  }[];
  creepSpawns: {
    firstWavesFiredAtMapStart: boolean;
    waves: {
      name: string;
      periodSeconds: number;
      periodTicks: number;
      count: number;
      preSpawnSleepSeconds: number;
      typeWhileEnemyHarborAlive: string;
      typeAfterEnemyHarborDestroyed: string;
    }[];
    lanes: {
      id: string;
      creepOwner: number;
      team: string;
      spawnRegion: string;
      spawnPoint: { x: number; y: number };
      spawnFacing: number;
      requiresOwnHarborAlive: string;
      bountyGateEnemyHarbor: string;
      waypoints: {
        order: string;
        kind: string;
        region?: string;
        unit?: string;
        x: number;
        y: number;
        issuedOnEnteringRegions?: string[];
      }[];
    }[];
  };
  income: {
    goldPerSecond: {
      intervalSeconds: number;
      intervalTicks: number;
      condition: string;
      byHumanCountOnTeam: Record<string, { perHumanSlot: number; toTeamAi: number }>;
    };
    empireGoldShare: { periodSeconds: { min: number; max: number } };
    goldDump: { periodSeconds: number; periodTicks: number };
    heroRespawn: {
      delaySecondsFormula: string;
      reviveRegion: Record<string, string>;
      invulnerableAfterReviveSeconds: number;
    };
  };
}

/**
 * Parsed contents of the data/json files. The caller (server/test harness)
 * does the file IO; the core stays IO-free. Fields typed `unknown` are the
 * raw object-data dumps — the ruleset compiler owns narrow extractors for
 * the handful of fields it needs (unit stats, ability curves, stock fields).
 */
export interface RawDataFiles {
  weapons: { weapons: RawWeaponRow[] };
  equipment: { items: RawEquipmentRow[] };
  ships: { ships: RawShipRow[] };
  upgradeCurves: { upgrades: RawUpgradeRow[] };
  scriptRules: {
    mechanism: string;
    scriptedItems: RawScriptedItemRow[];
    tradeRoutes: RawTradeRouteRow[];
    questSystems: RawQuestSystems;
  };
  mapLayout: RawMapLayoutFile;
  units: unknown;
  abilities: unknown;
  items: unknown;
  buffs: unknown;
  strings: unknown;
}
