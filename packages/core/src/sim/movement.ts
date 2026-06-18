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
 * - Lane navigation: for ANY haul beyond a short micro hop — a move/attackMove
 *   OR an attackTarget chase — the kinematics steer toward the next step of the
 *   team's static lane-navigation field (ruleset.map.navByTeam / navHomeByTeam,
 *   a precomputed BFS gradient over the water mask; the field with its goal
 *   nearer the destination is chosen, so a push uses navByTeam and a retreat /
 *   trade run uses navHomeByTeam). Creeps and ships thus follow the winding
 *   water lanes AROUND the central landmass instead of beelining into it
 *   (laneNavGoal / nearestFieldStep; see types.ts NavField + docs/TERRAIN.md §3).
 *   If a candidate step still ends wedged on a concave coast, resolveAgainstLand
 *   nudges along the same gradient rather than pinning the unit at the wall.
 *   Near the goal / on a stub mask the field is inert and movement is plain
 *   straight-line, so open-sea behaviour and all legacy tests are unchanged. Arrival/idle is
 *   always judged on the TRUE order point, never an intermediate nav waypoint.
 * - Collision: circle-vs-circle pushout (equal split), processing entities
 *   in ascending id order; then resolve against the static land/water mask
 *   (reject land moves, axis-separated coast slide, else pre-move fallback)
 *   and finally clamp to map bounds.
 * - Skips: dead entities, ships with pausedUntilTick > tick (repair bay),
 *   'stunned' status, casting wind-up (ShipEntity.casting !== null).
 *
 * Reads: state.entities, players (inventory for sails), ruleset.ships /
 * unitTypes / constants / map.bounds / map.navByTeam / map.navHomeByTeam.
 * Mutates: entity.x/y/facingRad, entity.order (arrival -> idle).
 * Does NOT: apply damage, touch hp, break invisibility (move/stop are
 * exempt from invis breaking — SEMANTICS §9).
 *
 * Tick order: runs 2nd (after creeps wrote AI orders, before specials reads
 * positions for region triggers and visibility).
 */

import { dAtan2, dCos, dSin, HALF_PI, wrapAngle } from '../math.js';
import { isUnitEntity, isWater, navStepToward, sortedNumericKeys } from './types.js';
import { compileNavField } from './ruleset.js';
import type {
  Entity,
  MovementCommandU,
  NavField,
  Ruleset,
  SimState,
  TeamId,
  UnitEntity,
  WaterMask,
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

  // Snapshot pre-move positions of every mobile unit BEFORE any mutation, so
  // the land resolver can reject a move back to a known-good (water) tile.
  // Plain Record keyed by entity id — ascending-id iteration is preserved by
  // re-reading `ids`. Captured for movement-locked units too (cheap, unused).
  const prevX: Record<number, number> = {};
  const prevY: Record<number, number> = {};
  for (const id of ids) {
    const entity = state.entities[id];
    if (!entity || !isUnitEntity(entity) || entity.dead) continue;
    prevX[id] = entity.x;
    prevY[id] = entity.y;
  }

  // Phase 1: kinematics (order execution), ascending id.
  for (const id of ids) {
    const entity = state.entities[id];
    if (!entity || !isUnitEntity(entity) || entity.dead) continue;
    if (isMovementLocked(state, entity)) continue;
    stepUnitKinematics(state, ruleset, entity);
  }

  // Phase 2: collision pushout, ascending-id pair order.
  resolveCollisions(state, ruleset, ids);

  // Phase 3: resolve mobile units against the static land/water mask, then
  // clamp to map bounds. The land resolver runs FIRST so a move that ends on
  // land can fall back to a still-in-bounds water tile; the bounds clamp is
  // the final safety net (and a no-op for the all-water stub mask, which keeps
  // today's free movement — the regression guard).
  const mask = ruleset.map.waterMask;
  const bounds = ruleset.map.bounds;
  for (const id of ids) {
    const entity = state.entities[id];
    if (!entity || !isUnitEntity(entity) || entity.dead) continue;
    if (isMovementLocked(state, entity)) continue;

    resolveAgainstLand(ruleset, mask, entity, prevX[id] ?? entity.x, prevY[id] ?? entity.y);

    if (entity.x < bounds.minX) entity.x = bounds.minX;
    else if (entity.x > bounds.maxX) entity.x = bounds.maxX;
    if (entity.y < bounds.minY) entity.y = bounds.minY;
    else if (entity.y > bounds.maxY) entity.y = bounds.maxY;
  }
}

/**
 * Keep a unit out of non-water cells (docs/TERRAIN.md §4 "pathing"). Called
 * after kinematics + pushout with the unit's CURRENT (candidate) position and
 * its pre-move (water-valid) position. Deterministic: plain arithmetic +
 * `isWater` / `navStepToward` only — no trig, no RNG, no iteration order
 * dependence.
 *
 * Resolution order (matches the contract):
 *   1. Candidate is water  -> accept (the common case; also the all-water stub
 *      mask, so the 45 legacy movement tests stay green).
 *   2. Axis-separated slide -> keep the water-valid axis, snap the blocked axis
 *      back to its pre-move value. Tried X-kept-first then Y-kept so a unit
 *      hugging a coast advances along the open axis instead of stalling.
 *   3. Gradient nudge -> when both slides hit land (a concave corner that would
 *      otherwise PIN the unit at the coast forever, re-deriving the same heading
 *      into the same wall every tick — the "ships hang up on land" bug), step a
 *      short way from the pre-move position toward the next downhill water cell
 *      of the unit's lane field, IF that point is water. This is the "if a
 *      straight step would cross land, step along the water gradient instead"
 *      recovery, so a wedged ship rounds the landmass instead of stalling.
 *   4. Fallback -> revert to the pre-move position (never moved onto land); the
 *      last resort when even the gradient cell is unavailable (stub mask, no
 *      field, or no downhill water neighbour).
 *
 * The pre-move position is assumed water-valid (the unit was there last tick
 * after this same resolver), so the fallback is always a legal tile.
 */
function resolveAgainstLand(
  ruleset: Ruleset,
  mask: WaterMask,
  entity: UnitEntity,
  fromX: number,
  fromY: number,
): void {
  const x = entity.x;
  const y = entity.y;
  if (isWater(mask, x, y)) return;

  // Slide keeping the new X (vertical wall to the side): zero the Y delta.
  if (isWater(mask, x, fromY)) {
    entity.y = fromY;
    return;
  }
  // Slide keeping the new Y (horizontal wall ahead): zero the X delta.
  if (isWater(mask, fromX, y)) {
    entity.x = fromX;
    return;
  }

  // Both slides hit land: take a short step from the pre-move tile toward the
  // lane field's next downhill water cell (toward the unit's current goal) so a
  // ship wedged on a concave coast keeps rounding the landmass instead of being
  // pinned at the wall. Only mobile, navigable kinds have a field; stub masks /
  // no-field / local-minimum return null below -> fall through to the revert.
  const goal = orderDestination(ruleset, entity);
  if (goal !== null) {
    const stepCell = nearestFieldStep(ruleset, entity, goal.x, goal.y, fromX, fromY);
    if (stepCell !== null && isWater(mask, stepCell.x, stepCell.y)) {
      // Clamp to a single step length so the nudge is a smooth slide, not a
      // teleport to the cell center. Capacity bounded by the cell size.
      const dgx = stepCell.x - fromX;
      const dgy = stepCell.y - fromY;
      const len = Math.sqrt(dgx * dgx + dgy * dgy);
      if (len > 0) {
        const stepLen = Math.min(len, LAND_GRADIENT_NUDGE_UNITS);
        const nx = fromX + (dgx / len) * stepLen;
        const ny = fromY + (dgy / len) * stepLen;
        if (isWater(mask, nx, ny)) {
          entity.x = nx;
          entity.y = ny;
          return;
        }
      }
    }
  }

  // No water-valid slide or gradient nudge — stall at the coast (pre-move tile).
  entity.x = fromX;
  entity.y = fromY;
}

/**
 * The world point a unit's current order is trying to reach — the lane field is
 * picked by which base goal is nearer THIS point. Move/attackMove use the order
 * point; an attackTarget chase uses the live target (null if it vanished). Idle/
 * hold have no destination. Pure lookups, no RNG/trig.
 */
function orderDestination(
  ruleset: Ruleset,
  entity: UnitEntity,
): { x: number; y: number } | null {
  const order = entity.order;
  if (order.type === 'move' || order.type === 'attackMove') return { x: order.x, y: order.y };
  if (order.type === 'attackTarget') {
    // The resolver has no SimState handle, so the live target position is not
    // available here. A combat chase heads toward the enemy, so steer along the
    // push field: returning its goal point selects navByTeam in nearestFieldStep
    // and rounds the landmass toward the enemy base. Better than pinning the
    // unit at the coast (null), which is the bug we are fixing.
    const push = ruleset.map.navByTeam?.[entity.team];
    if (push !== undefined && push.dist.length > 0) return { x: push.goalX, y: push.goalY };
    return null;
  }
  return null;
}

/** Max single-tick distance the land resolver nudges a wedged unit along the
 * water gradient (cellSize is 128, so this stays within one cell). */
const LAND_GRADIENT_NUDGE_UNITS = 96;

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

/**
 * Distance at which a CREEP/SUMMON attack-moving onto a point stops advancing
 * and holds to fire: its native attack range less a small inset, so it sits in
 * range of the hold-gate's frontmost-structure target (tower, then HQ) and
 * combat auto-acquires it — instead of walking onto the point (which would let
 * the hold gate retarget the next structure and the creep ghost past). Returns
 * 0 for units with no native attack (they close to the exact point as before).
 * Ships are excluded: their attack is vestigial (no compiled damage) and their
 * attack-move must still reach its exact point. Pure arithmetic.
 */
function creepEngageStopDistance(ruleset: Ruleset, entity: UnitEntity): number {
  if (entity.kind === 'ship') return 0;
  const range = ruleset.unitTypes[entity.typeId]?.attack?.rangeUnits;
  if (range === undefined || range <= 0) return 0;
  return Math.max(0, range - CREEP_ENGAGE_RANGE_MARGIN);
}

/**
 * True when a living ENEMY structure (tower/HQ/etc.) sits at world point
 * (px, py) — used to confirm a creep's attack-move order point is the
 * hold-gate's frontmost-structure target (creeps.ts writes order.x/y exactly to
 * the structure position) before halting the creep in attack range. The
 * hold-gate's structure position is matched exactly, so a tiny epsilon guards
 * float identity. Ascending-id scan, plain arithmetic — deterministic.
 */
function enemyStructureAt(state: SimState, team: TeamId, px: number, py: number): boolean {
  const EPS = 1; // world units; order point is copied verbatim from the structure
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (
      e !== undefined &&
      e.kind === 'structure' &&
      !e.dead &&
      e.hp > 0 &&
      e.team !== null &&
      e.team !== team &&
      Math.abs(e.x - px) <= EPS &&
      Math.abs(e.y - py) <= EPS
    ) {
      return true;
    }
  }
  return false;
}

function stepUnitKinematics(state: SimState, ruleset: Ruleset, entity: UnitEntity): void {
  const order = entity.order;
  if (order.type === 'idle' || order.type === 'hold') return;

  // The TRUE destination this order is judged against: the live target (chase)
  // or the order point (move/attackMove). Arrival, the attack stop-distance and
  // the creep hold-gate are all measured against THIS, never an intermediate
  // nav waypoint.
  let orderX: number;
  let orderY: number;
  // The point the kinematics actually STEER toward this tick: either the true
  // destination (straight-line, the common close-range case) or the next lane
  // field waypoint that rounds the central landmass when far.
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
    orderX = target.x;
    orderY = target.y;
    stopDist = attackStopDistance(ruleset, entity, target);
    // Route the chase around land too: when the target is beyond a short hop,
    // steer the next lane-field waypoint toward it (field chosen by which base
    // goal is nearer the target). Close in / same basin / stub mask -> null ->
    // steer the live target directly (preserving the exact in-range approach).
    let goal: { x: number; y: number } | null = null;
    const tDistSq = (orderX - entity.x) ** 2 + (orderY - entity.y) ** 2;
    if (tDistSq >= NAV_SHIP_MIN_HAUL * NAV_SHIP_MIN_HAUL) {
      goal = nearestFieldStep(ruleset, entity, orderX, orderY, entity.x, entity.y);
    }
    goalX = goal?.x ?? orderX;
    goalY = goal?.y ?? orderY;
  } else {
    orderX = order.x;
    orderY = order.y;
    // move / attackMove: follow the team's static lane-navigation field around
    // the central landmass when far from the order point (the lanes wind too
    // sharply for straight-line + coast-slide to traverse — see types.ts
    // NavField / docs/TERRAIN.md §3). Near the goal (or with no field, e.g. a
    // stub mask) navStepToward returns null and we steer the true order point,
    // preserving exact arrival/idle behaviour and all legacy open-sea tests.
    const nav = laneNavGoal(
      ruleset,
      entity,
      order.x,
      order.y,
      state.players[entity.owner]?.control === 'user',
    );
    goalX = nav.x;
    goalY = nav.y;
  }

  // Distance to the STEERING goal (heading) vs the TRUE destination (stop/arrival).
  const dx = goalX - entity.x;
  const dy = goalY - entity.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const dOrder = Math.sqrt((orderX - entity.x) ** 2 + (orderY - entity.y) ** 2);
  // Steering onto a nav waypoint that is NOT the true destination (the long haul
  // down the lane around land). For a chase this means routing around land; for
  // a move it is the lane-following leg.
  const viaWaypoint = goalX !== orderX || goalY !== orderY;
  if (d === 0) {
    // Exactly on the steering goal: if it is also the order point, the move
    // completes; otherwise (a nav waypoint coincident with us) just hold facing.
    if (!chasing && !viaWaypoint && dOrder === 0) entity.order = { type: 'idle' };
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

  // In range of an attack target: face it, no advance, keep the order. Judged on
  // the TRUE target distance (dOrder), so steering a lane waypoint around land
  // never spuriously "stops in range" at the waypoint.
  if (chasing && dOrder <= stopDist) return;

  // Creep/summon HOLD: when attack-moving and steering the TRUE order point
  // directly (the lane field has handed off to the straight-line final approach
  // — goal === order point), stop advancing once within native attack range of a
  // living enemy STRUCTURE sitting at that order point, and hold there so combat
  // fires on it (the hold-gate keeps the order on the frontmost in-lane structure
  // while it lives). Gating on a structure actually being AT the order point
  // means a plain navigation waypoint (no structure there) is still run to
  // completion — only the hold-gate's tower/HQ targets stall the creep in range.
  // Steering an intermediate nav waypoint (goal != order point) is the long haul
  // down the lane — keep moving. Players/ships are never gated.
  if (
    !chasing &&
    order.type === 'attackMove' &&
    !viaWaypoint
  ) {
    const engageStop = creepEngageStopDistance(ruleset, entity);
    if (
      engageStop > 0 &&
      dOrder <= engageStop &&
      enemyStructureAt(state, entity.team, orderX, orderY)
    ) {
      return;
    }
  }

  const speed = effectiveMoveSpeed(state, ruleset, entity);
  if (speed <= 0) return;
  const step = speed / ruleset.tickRate;

  if (!chasing && !viaWaypoint && dOrder <= step) {
    // Arrival: snap to the TRUE order point and go idle (judged on the order
    // point, so a lane-following unit only completes at the real destination).
    entity.x = orderX;
    entity.y = orderY;
    entity.order = { type: 'idle' };
    return;
  }

  // Advance along the current facing. Steering a nav waypoint (move OR chase
  // routed around land) takes a full step toward it; a direct chase clamps so it
  // does not overshoot the target's stop ring (judged on dOrder, the TRUE target
  // distance, not the waypoint).
  const advance = chasing && !viaWaypoint ? Math.min(step, dOrder - stopDist) : step;
  if (advance <= 0) return;
  entity.x += dCos(entity.facingRad) * advance;
  entity.y += dSin(entity.facingRad) * advance;
}

/**
 * Steering goal for a move/attackMove order: the next lane-navigation waypoint
 * that routes around the central landmass toward `(orderX, orderY)`, or the
 * order point itself (straight line — the legacy behaviour) when no field helps.
 *
 * CREEPS / SUMMONS always ride the team push field down their lane (then hand
 * off to the straight line near their hold-gate order point). SHIPS choose
 * whichever static field's goal is nearest the order point — push toward the
 * enemy base, home toward the own base, or a trader-destination field
 * (map.navToRegion) — via nearestFieldStep, so a push, a retreat and an outbound
 * trade leg each follow the right gradient around the land. Short micro hops
 * (below NAV_SHIP_MIN_HAUL) and stub masks fall through to the order point;
 * navStepToward returns null near the goal so the final approach is the true
 * straight line. Pure: distance compares + navStepToward arithmetic, no RNG/trig.
 */
function laneNavGoal(
  ruleset: Ruleset,
  entity: UnitEntity,
  orderX: number,
  orderY: number,
  playerControlled: boolean,
): { x: number; y: number } {
  if (entity.kind !== 'ship' && entity.kind !== 'creep' && entity.kind !== 'summon') {
    return { x: orderX, y: orderY };
  }
  const push = ruleset.map.navByTeam?.[entity.team];
  if (push === undefined || push.dist.length === 0) return { x: orderX, y: orderY };

  // CREEPS / SUMMONS follow the push field for the LONG HAUL down their lane,
  // but must actually CLOSE ON the creep-AI hold-gate's order point (the
  // frontmost living enemy structure — a tower, then the HQ) rather than ghost
  // past it along the field toward the base. So: once within NAV_ENGAGE_RADIUS
  // of the order point, steer the order point STRAIGHT-LINE (the final approach
  // onto the chokepoint, where stepUnitKinematics halts the unit in attack
  // range so it holds + fires); otherwise ride the field gradient toward it.
  // The field's goal and the hold-gate's order both lie down the lane, so the
  // gradient carries the unit to the order's vicinity, then this hands off to
  // the straight line. Pure arithmetic — no RNG/trig.
  if (entity.kind === 'creep' || entity.kind === 'summon') {
    const orderDistSq = (orderX - entity.x) ** 2 + (orderY - entity.y) ** 2;
    if (orderDistSq <= NAV_ENGAGE_RADIUS * NAV_ENGAGE_RADIUS) return { x: orderX, y: orderY };
    const step = navStepToward(push, entity.x, entity.y);
    return step ?? { x: orderX, y: orderY };
  }

  // SHIPS (players / AI) can push, retreat, shop, run trade routes or micro
  // locally. Steer via a field for any genuine HAUL (anything beyond a short
  // micro hop), NOT just base-bound orders: the real reason ships "hang up on
  // land" is that mid-lane brawl/siege points and trader destinations (shops,
  // refinery, reward zones, pickup corners) are NOT near a base goal, so the
  // old base-proximity gate excluded essentially every order and left ships
  // beelining into the coast. We now pick whichever field (push toward the
  // enemy base / home toward the own base) flows nearer the ORDER POINT and ride
  // its gradient around the landmass; the field's local-goal handoff
  // (navStepToward returns null within localGoalDistCells, types.ts) restores
  // the exact straight-line final approach so arrival is unchanged. Only true
  // micro/short repositions (below NAV_SHIP_MIN_HAUL) stay straight-line so they
  // reach their exact point without a cell-granular detour.
  const orderDistSq = (orderX - entity.x) ** 2 + (orderY - entity.y) ** 2;
  const isShortApproach = orderDistSq < NAV_SHIP_MIN_HAUL * NAV_SHIP_MIN_HAUL;
  // Straight-line ONLY when the direct path is genuinely CLEAR WATER and it is a
  // short hop — the common close-range / open-sea case (also the stub-mask case,
  // where isWater is always true so this always wins and legacy replays are
  // unchanged). When the straight segment crosses land — or it's a genuine haul —
  // ride the nearest-goal field gradient (which the per-POI navToRegion fields
  // paint up to each dock), following it to within 1 cell on a blocked short
  // approach so the ship rounds the spit onto the dock instead of beelining in.
  const mask = ruleset.map.waterMask;
  const blocked = segmentCrossesLand(mask, entity.x, entity.y, orderX, orderY);
  if (isShortApproach && !blocked) return { x: orderX, y: orderY };

  // PLAYER SHIPS: route via a flow field computed to the EXACT clicked point
  // whenever the straight line is blocked. A field to the destination ALWAYS
  // flows toward where the human actually clicked (unlike the nearest-base/region
  // heuristic, which mis-routes a mid-map click toward a base and leaves the ship
  // oscillating / wedged against the central land — "it just sits there"). Used
  // CONSISTENTLY (not just as a null-fallback) so the ship never flip-flops
  // between this and a wrong-way field. compileNavField is pure → the cache never
  // affects determinism (see fieldToPoint). GATED to players: the AI (captains +
  // the delicately-tuned trader) keeps the exact path below, so its routing and
  // every AI/determinism test is byte-unchanged.
  if (playerControlled) {
    // Clear water all the way (any distance) → straight to the exact click.
    if (!blocked) return { x: orderX, y: orderY };
    // Blocked → route around the land via a field to the exact destination.
    const field = fieldToPoint(mask, orderX, orderY);
    if (field !== null) {
      const step = navStepToward(
        field,
        entity.x,
        entity.y,
        isShortApproach ? DOCK_APPROACH_LOCAL_GOAL_CELLS : undefined,
      );
      if (step !== null) return step;
    }
    return { x: orderX, y: orderY };
  }

  // AI SHIPS (and players on a clear long haul): the nearest-goal field gradient
  // that routes around the central landmass, then the straight-line final
  // approach. Exactly the verified-green behaviour.
  const step = nearestFieldStep(
    ruleset,
    entity,
    orderX,
    orderY,
    entity.x,
    entity.y,
    isShortApproach ? DOCK_APPROACH_LOCAL_GOAL_CELLS : undefined,
  );
  return step ?? { x: orderX, y: orderY };
}

/** Per-mask memo of on-demand flow fields keyed by goal CELL, used only by the
 *  laneNavGoal RESCUE path (an order whose straight line beaches and which no
 *  precompiled field reaches). compileNavField is a PURE function of (mask,
 *  goal), so cached results are identical regardless of cache state or eviction
 *  order — determinism is preserved (the cache is a memo, never in SimState /
 *  hashState). A per-mask cap bounds memory; eviction just forces a recompute
 *  that yields the same field. Keyed on the WaterMask object (WeakMap) so
 *  distinct masks never collide and entries GC with their mask. */
const fieldToPointCache = new WeakMap<WaterMask, Map<number, NavField>>();
const FIELD_TO_POINT_CAP = 128;

function fieldToPoint(mask: WaterMask, x: number, y: number): NavField | null {
  if (mask.cells.length === 0) return null; // stub mask -> straight-line caller
  const col = Math.floor((x - mask.bounds.minX) / mask.cellSizeX);
  const row = Math.floor((mask.bounds.maxY - y) / mask.cellSizeY);
  if (col < 0 || col >= mask.cols || row < 0 || row >= mask.rows) return null;
  const key = row * mask.cols + col;
  let perMask = fieldToPointCache.get(mask);
  if (perMask === undefined) {
    perMask = new Map();
    fieldToPointCache.set(mask, perMask);
  }
  const cached = perMask.get(key);
  if (cached !== undefined) return cached;
  const field = compileNavField(mask, x, y);
  if (perMask.size >= FIELD_TO_POINT_CAP) {
    const oldest = perMask.keys().next().value;
    if (oldest !== undefined) perMask.delete(oldest);
  }
  perMask.set(key, field);
  return field;
}

/** Hand-off distance (in cells) for a SHIP rounding land onto a dock: follow the
 *  field gradient to within ONE cell of the goal's water-access cell before the
 *  straight-line final step, so the ship rounds the coastal spit instead of
 *  beelining into it. Open hauls keep navStepToward's default (6). */
const DOCK_APPROACH_LOCAL_GOAL_CELLS = 1;

/** True if the straight segment (x0,y0)->(x1,y1) passes over any LAND cell
 *  (sampled at half-cell resolution incl. the endpoint), i.e. a naive
 *  straight-line move would beach the ship. The source cell is skipped so a
 *  coast-hugging start is not a false positive. On a stub mask (isWater always
 *  true) this is always false — open-sea movement is unchanged. Pure arithmetic
 *  + isWater: deterministic. */
function segmentCrossesLand(mask: WaterMask, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return false;
  const step = Math.min(mask.cellSizeX, mask.cellSizeY) * 0.5 || 64;
  const n = Math.max(1, Math.ceil(len / step));
  for (let i = 1; i <= n; i++) {
    const t = (i * step) / len;
    const tt = t > 1 ? 1 : t;
    if (!isWater(mask, x0 + dx * tt, y0 + dy * tt)) return true;
    if (t >= 1) break;
  }
  return false;
}

/**
 * Pick the static NavField whose goal is NEAREST `(towardX, towardY)` and return
 * the next downhill water cell to steer toward from `(fromX, fromY)`, or null to
 * fall through to a straight line (no field, stub mask, unreachable/land source
 * cell, or already in the goal's local basin).
 *
 * Candidate fields (all flow over the same water network around the central
 * land): the team push field (toward the enemy base), the team home field
 * (toward the own base), and the static trader-destination fields
 * (map.navToRegion: the pickup corners + Refinery + reward zones). Choosing by
 * goal proximity means a push uses navByTeam, a retreat / inbound-trade leg uses
 * navHomeByTeam, and an OUTBOUND trade leg to a far pickup corner uses that
 * region's field — exactly the gradient that rounds the land toward THAT goal.
 *
 * Shared by laneNavGoal (move/attackMove), the attackTarget chase, and
 * resolveAgainstLand so all three steer on the SAME gradient. Pure: distance
 * compares + a FIXED-order scan (push, home, then region fields in their stable
 * insertion order) + navStepToward arithmetic — no RNG/trig and no
 * iteration-order ambiguity (ties keep the earlier field). Open-sea-safe: with
 * empty fields (stub mask) every candidate is skipped and this returns null, so
 * the caller keeps today's straight-line behaviour and legacy replays/tests are
 * unchanged.
 */
function nearestFieldStep(
  ruleset: Ruleset,
  entity: UnitEntity,
  towardX: number,
  towardY: number,
  fromX: number,
  fromY: number,
  localGoalDistCells?: number,
): { x: number; y: number } | null {
  let best: NavField | null = null;
  let bestGapSq = Infinity;
  const consider = (field: NavField | undefined): void => {
    if (field === undefined || field.dist.length === 0) return;
    const gapSq = (towardX - field.goalX) ** 2 + (towardY - field.goalY) ** 2;
    // Strict `<` so the fixed scan order breaks ties to the earlier field.
    if (gapSq < bestGapSq) {
      bestGapSq = gapSq;
      best = field;
    }
  };
  consider(ruleset.map.navByTeam?.[entity.team]);
  consider(ruleset.map.navHomeByTeam?.[entity.team]);
  // Region fields only help traders sailing OUT to a non-base destination; for
  // captains a base field's goal is always nearer their order, so this never
  // changes captain steering. Insertion order of navToRegion is stable (ruleset
  // builds it from a fixed allowlist array).
  for (const name in ruleset.map.navToRegion) consider(ruleset.map.navToRegion[name]);
  if (best === null) return null;
  return navStepToward(best, fromX, fromY, localGoalDistCells);
}

/** Minimum straight-line order distance for a SHIP to use lane-field steering.
 * Below this a move is a local hop (shop dock approach, repair bay, micro) that
 * runs straight to its exact point; at or above it ANY order (mid-lane brawl,
 * siege, trade-route leg, retreat) rides the lane field around the landmass — a
 * few cells of slack (cellSize 128) so cross-lane moves route but adjacent-cell
 * nudges stay straight. The old base-proximity gate is gone: it excluded every
 * mid-lane / trader order, which is why ships beelined into the coast. */
const NAV_SHIP_MIN_HAUL = 800;

/** Order-point proximity at which a CREEP/SUMMON drops the lane field and steers
 * its order point straight-line — the final approach onto the hold-gate's
 * frontmost-structure target so it closes into attack range and holds there
 * (combat then fires). Sized above the creeps' largest native attack range
 * (cruiser 900 / tower-band lanes) so the unit is already steering the
 * structure directly before stepUnitKinematics' engage-stop kicks in, yet small
 * enough that the field still does the long-haul lane routing around land. */
const NAV_ENGAGE_RADIUS = 1400;

/** Margin subtracted from a creep/summon's native attack range to get the
 * distance at which it STOPS advancing onto an attack-move target and holds in
 * range to fire. The small inset keeps the unit comfortably inside range
 * (auto-acquire is judged on exact range) without parking on the structure. */
const CREEP_ENGAGE_RANGE_MARGIN = 64;

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
