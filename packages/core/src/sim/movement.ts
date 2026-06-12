/**
 * Movement & collision system.
 *
 * Responsibilities (docs/SEMANTICS.md §3):
 * - Order state: owns `entity.order` on all UnitEntities (ships, creeps,
 *   summons) — set via applyMovementCommand for players; creeps.ts writes
 *   orders directly (it owns creep AI, movement only executes them).
 * - Kinematics per tick: desired heading = direction to order target
 *   (dAtan2); rotate facingRad by at most
 *   min(shipSpec.turnRateRadPerTick, constants.turnRateCapRadPerTick);
 *   translate effSpeed/tickRate units along CURRENT facing only when
 *   |heading error| <= 90 deg, else pivot in place.
 * - Effective speed: base units/sec x (1 + sum of sail/aura/status pcts),
 *   clamped to [constants.minMoveSpeed, constants.maxMoveSpeed]. Sails are
 *   equipment passives on the owning player's inventory; 'slowed'/'speedAura'
 *   statuses contribute; 'ensnared' pins speed to 0.
 * - Collision: circle-vs-circle pushout (equal split), processing entities
 *   in ascending id order; then clamp to map bounds. Water-mask clamping is
 *   an OPEN follow-up (pathing not yet extracted) — until then bounds-only.
 * - Skips: dead entities, ships with pausedUntilTick > tick (repair bay),
 *   'stunned' status, casting wind-up (ShipEntity.casting !== null).
 *
 * Reads: state.entities, players (inventory for sails), ruleset.ships /
 * unitTypes / constants / map.bounds.
 * Mutates: entity.x/y/facingRad, entity.order (arrival -> idle).
 * Does NOT: apply damage, touch hp, break invisibility (move/stop are
 * exempt from invis breaking — SEMANTICS §9).
 *
 * Tick order: runs 2nd (after creeps wrote AI orders, before specials reads
 * positions for region triggers and visibility).
 */

import { dAtan2, dCos, dSin, HALF_PI, wrapAngle } from '../math.js';
import { isUnitEntity, sortedNumericKeys } from './types.js';
import type {
  Entity,
  MovementCommandU,
  Ruleset,
  SimState,
  TeamId,
  UnitEntity,
} from './types.js';

/**
 * Apply a player movement input to the player's boat: sets entity.order.
 * attackTarget validates the target exists and is visible to the player's
 * team (else emits 'commandRejected'). Ignored while dead/paused.
 */
export function applyMovementCommand(
  state: SimState,
  ruleset: Ruleset,
  cmd: MovementCommandU,
): void {
  // Movement command application is data-free; ruleset is part of the
  // uniform apply*Command signature.
  void ruleset;
  const player = state.players[cmd.player];
  if (!player || player.shipId === null) return;
  const ship = state.entities[player.shipId];
  if (!ship || ship.kind !== 'ship' || ship.dead) return;
  if (ship.pausedUntilTick > state.tick) return;

  switch (cmd.type) {
    case 'move':
      ship.order = { type: 'move', x: cmd.x, y: cmd.y };
      return;
    case 'stop':
      ship.order = { type: 'idle' };
      return;
    case 'holdPosition':
      ship.order = { type: 'hold' };
      return;
    case 'attackMove':
      ship.order = { type: 'attackMove', x: cmd.x, y: cmd.y };
      return;
    case 'attackTarget': {
      const target = state.entities[cmd.targetId];
      if (!target || target.dead) {
        rejectCommand(state, cmd.player, cmd.type, 'target does not exist');
        return;
      }
      if (!isTargetVisibleTo(target, player.team)) {
        rejectCommand(state, cmd.player, cmd.type, 'target not visible');
        return;
      }
      ship.order = { type: 'attackTarget', targetId: cmd.targetId };
      return;
    }
  }
}

/** Advance all unit positions/facings one tick (see module doc). */
export function stepMovement(state: SimState, ruleset: Ruleset): void {
  const ids = sortedNumericKeys(state.entities);

  // Phase 1: kinematics (order execution), ascending id.
  for (const id of ids) {
    const entity = state.entities[id];
    if (!entity || !isUnitEntity(entity) || entity.dead) continue;
    if (isMovementLocked(state, entity)) continue;
    stepUnitKinematics(state, ruleset, entity);
  }

  // Phase 2: collision pushout, ascending-id pair order.
  resolveCollisions(state, ruleset, ids);

  // Phase 3: clamp mobile units to map bounds (water mask is an OPEN
  // follow-up — bounds-only until pathing extraction lands).
  const bounds = ruleset.map.bounds;
  for (const id of ids) {
    const entity = state.entities[id];
    if (!entity || !isUnitEntity(entity) || entity.dead) continue;
    if (isMovementLocked(state, entity)) continue;
    if (entity.x < bounds.minX) entity.x = bounds.minX;
    else if (entity.x > bounds.maxX) entity.x = bounds.maxX;
    if (entity.y < bounds.minY) entity.y = bounds.minY;
    else if (entity.y > bounds.maxY) entity.y = bounds.maxY;
  }
}

/**
 * Current effective speed in units/sec after sails, auras, statuses and the
 * engine clamps. Exported for tests and client UI prediction.
 */
export function effectiveMoveSpeed(
  state: SimState,
  ruleset: Ruleset,
  entity: UnitEntity,
): number {
  if (isEnsnared(entity, state.tick)) return 0;

  const base = baseMoveSpeed(ruleset, entity);
  // Immobile units stay immobile — the engine min-speed clamp must not
  // mobilize a 0-speed unit.
  if (base <= 0) return 0;

  let pctSum = 0;

  // Equipment move-speed passives live on the OWNING player's inventory and
  // apply only to the player's boat. Summed across all carried equipment so
  // hull penalties (negative moveSpeedPct) combine with sail bonuses —
  // both are AOae Oae1 fractions of base speed, additive before clamping.
  if (entity.kind === 'ship') {
    const player = state.players[entity.owner];
    if (player) {
      for (const item of player.inventory) {
        if (!item) continue;
        const spec = ruleset.equipment[item.itemId];
        if (spec && spec.passives) pctSum += spec.passives.moveSpeedPct;
      }
    }
  }

  for (const status of entity.statuses) {
    if (status.kind === 'speedAura') pctSum += status.moveSpeedPct;
    else if (status.kind === 'slowed' && status.expiresAtTick > state.tick) {
      pctSum += status.moveSpeedPct;
    }
  }

  const speed = base * (1 + pctSum);
  const { minMoveSpeed, maxMoveSpeed } = ruleset.constants;
  return Math.min(maxMoveSpeed, Math.max(minMoveSpeed, speed));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function rejectCommand(
  state: SimState,
  player: number,
  commandType: string,
  reason: string,
): void {
  state.events.push({
    type: 'commandRejected',
    tick: state.tick,
    player,
    commandType,
    reason,
  });
}

/**
 * Per-team visibility for target validation. Structures carry no per-team
 * vision flags in the state model — treated as always visible (static,
 * map-known). Wards use their invisible flag (no detection data available
 * to movement).
 */
function isTargetVisibleTo(target: Entity, team: TeamId): boolean {
  if (target.kind === 'ship' || target.kind === 'creep' || target.kind === 'summon') {
    return target.vision[team];
  }
  if (target.kind === 'ward') return !target.invisible;
  return true;
}

function isStunned(entity: UnitEntity, tick: number): boolean {
  for (const status of entity.statuses) {
    if (status.kind === 'stunned' && status.expiresAtTick > tick) return true;
  }
  return false;
}

function isEnsnared(entity: UnitEntity, tick: number): boolean {
  for (const status of entity.statuses) {
    if (status.kind === 'ensnared' && status.expiresAtTick > tick) return true;
  }
  return false;
}

/**
 * True when the unit neither moves nor is displaced by collision this tick:
 * repair-bay pause, stun, or a cast wind-up in progress.
 */
function isMovementLocked(state: SimState, entity: UnitEntity): boolean {
  if (entity.kind === 'ship') {
    if (entity.pausedUntilTick > state.tick) return true;
    if (entity.casting !== null) return true;
  }
  return isStunned(entity, state.tick);
}

function baseMoveSpeed(ruleset: Ruleset, entity: UnitEntity): number {
  const ship = ruleset.ships[entity.typeId];
  if (ship) return ship.moveSpeed;
  const unitType = ruleset.unitTypes[entity.typeId];
  return unitType ? unitType.moveSpeed : 0;
}

/** Per-tick rotation, capped by the engine turn-rate cap. */
function turnRatePerTick(ruleset: Ruleset, entity: UnitEntity): number {
  const cap = ruleset.constants.turnRateCapRadPerTick;
  const ship = ruleset.ships[entity.typeId];
  const spec = ship ? ship.turnRateRadPerTick : ruleset.unitTypes[entity.typeId]?.turnRateRadPerTick;
  return spec === undefined ? cap : Math.min(spec, cap);
}

function collisionRadius(ruleset: Ruleset, entity: Entity): number {
  const ship = ruleset.ships[entity.typeId];
  if (ship) return ship.collisionRadius;
  const unitType = ruleset.unitTypes[entity.typeId];
  return unitType ? unitType.collisionRadius : 0;
}

/**
 * Distance at which an attackTarget chase stops advancing: ships use their
 * vestigial Hpal acquisition range (ShipSpec.nativeAttackRangeUnits, ua1r
 * 1000 — the attack's damage is NOT compiled, see ruleset.ts PROVISIONAL
 * list, so the chase stops at range without firing); other units use their
 * native attack range; anything without attack data stops at collision
 * contact.
 */
function attackStopDistance(ruleset: Ruleset, attacker: UnitEntity, target: Entity): number {
  const shipRange = ruleset.ships[attacker.typeId]?.nativeAttackRangeUnits;
  if (shipRange !== undefined && shipRange !== null) return shipRange;
  const attack = ruleset.unitTypes[attacker.typeId]?.attack;
  if (attack) return attack.rangeUnits;
  return collisionRadius(ruleset, attacker) + collisionRadius(ruleset, target);
}

function stepUnitKinematics(state: SimState, ruleset: Ruleset, entity: UnitEntity): void {
  const order = entity.order;
  if (order.type === 'idle' || order.type === 'hold') return;

  let goalX: number;
  let goalY: number;
  let stopDist = 0;
  const chasing = order.type === 'attackTarget';
  if (order.type === 'attackTarget') {
    const target = state.entities[order.targetId];
    if (!target || target.dead) {
      entity.order = { type: 'idle' };
      return;
    }
    goalX = target.x;
    goalY = target.y;
    stopDist = attackStopDistance(ruleset, entity, target);
  } else {
    goalX = order.x;
    goalY = order.y;
  }

  const dx = goalX - entity.x;
  const dy = goalY - entity.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0) {
    // Exactly on the order point: nothing to face (dAtan2(0,0) is 0, not
    // meaningful) — move orders complete, chases just hold.
    if (!chasing) entity.order = { type: 'idle' };
    return;
  }

  // Rotate toward the desired heading, capped per tick. Snapping exactly to
  // the desired angle when within the cap keeps headings bit-stable.
  const desired = dAtan2(dy, dx);
  const turn = turnRatePerTick(ruleset, entity);
  const errBefore = wrapAngle(desired - entity.facingRad);
  if (errBefore > turn) entity.facingRad = wrapAngle(entity.facingRad + turn);
  else if (errBefore < -turn) entity.facingRad = wrapAngle(entity.facingRad - turn);
  else entity.facingRad = desired;

  // Translate along CURRENT facing only when |heading error| <= 90°,
  // else pivot in place (SEMANTICS §3).
  const err = wrapAngle(desired - entity.facingRad);
  if (Math.abs(err) > HALF_PI) return;

  // In range of an attack target: face it, no advance, keep the order.
  if (chasing && d <= stopDist) return;

  const speed = effectiveMoveSpeed(state, ruleset, entity);
  if (speed <= 0) return;
  const step = speed / ruleset.tickRate;

  if (!chasing && d <= step) {
    // Arrival: snap to the order point and go idle.
    entity.x = goalX;
    entity.y = goalY;
    entity.order = { type: 'idle' };
    return;
  }

  const advance = chasing ? Math.min(step, d - stopDist) : step;
  entity.x += dCos(entity.facingRad) * advance;
  entity.y += dSin(entity.facingRad) * advance;
}

interface CollisionBody {
  entity: Entity;
  radius: number;
  /** Locked units and structures are immovable obstacles for pushout. */
  mobile: boolean;
}

/**
 * Single circle-vs-circle pushout pass over ascending-id pairs. Overlap is
 * split equally between two mobile bodies; an immobile party (structure,
 * paused/stunned/casting unit) absorbs none — the mobile one takes the full
 * pushout. Wards never collide (trigger dummies).
 */
function resolveCollisions(state: SimState, ruleset: Ruleset, ids: number[]): void {
  const bodies: CollisionBody[] = [];
  for (const id of ids) {
    const entity = state.entities[id];
    if (!entity || entity.dead || entity.kind === 'ward') continue;
    const radius = collisionRadius(ruleset, entity);
    if (radius <= 0) continue;
    const mobile = isUnitEntity(entity) && !isMovementLocked(state, entity);
    bodies.push({ entity, radius, mobile });
  }

  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (!a) continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (!b || (!a.mobile && !b.mobile)) continue;
      const dx = b.entity.x - a.entity.x;
      const dy = b.entity.y - a.entity.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const minDist = a.radius + b.radius;
      if (d >= minDist) continue;
      const overlap = minDist - d;
      // Unit vector from a toward b; coincident centers separate along +x
      // (deterministic fallback: lower id pushed -x, higher id +x).
      let nx: number;
      let ny: number;
      if (d > 0) {
        nx = dx / d;
        ny = dy / d;
      } else {
        nx = 1;
        ny = 0;
      }
      if (a.mobile && b.mobile) {
        const half = overlap / 2;
        a.entity.x -= nx * half;
        a.entity.y -= ny * half;
        b.entity.x += nx * half;
        b.entity.y += ny * half;
      } else if (a.mobile) {
        a.entity.x -= nx * overlap;
        a.entity.y -= ny * overlap;
      } else {
        b.entity.x += nx * overlap;
        b.entity.y += ny * overlap;
      }
    }
  }
}
