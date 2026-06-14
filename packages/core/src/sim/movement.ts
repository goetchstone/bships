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
 * - Lane navigation: for a move/attackMove the kinematics steer toward the next
 *   step of the team's static lane-navigation field (ruleset.map.navByTeam /
 *   navHomeByTeam — a precomputed BFS gradient over the water mask) when the
 *   order is a base-bound long haul, so creeps and ships follow the winding
 *   water lanes AROUND the central landmass instead of beelining into it
 *   (laneNavGoal; see types.ts NavField + docs/TERRAIN.md §3). Near the goal /
 *   on a stub mask the field is inert and movement is plain straight-line, so
 *   open-sea behaviour and all legacy tests are unchanged. Arrival/idle is
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

    resolveAgainstLand(mask, entity, prevX[id] ?? entity.x, prevY[id] ?? entity.y);

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
 * `isWater` only — no trig, no RNG, no iteration order dependence.
 *
 * Resolution order (matches the contract):
 *   1. Candidate is water  -> accept (the common case; also the all-water stub
 *      mask, so the 45 legacy movement tests stay green).
 *   2. Axis-separated slide -> keep the water-valid axis, snap the blocked axis
 *      back to its pre-move value. Tried X-kept-first then Y-kept so a unit
 *      hugging a coast advances along the open axis instead of stalling.
 *   3. Fallback -> revert to the pre-move position (never moved onto land).
 *
 * The pre-move position is assumed water-valid (the unit was there last tick
 * after this same resolver), so the fallback is always a legal tile.
 */
function resolveAgainstLand(
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
  // No water-valid slide — stall at the coast (pre-move tile).
  entity.x = fromX;
  entity.y = fromY;
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
    // move / attackMove: follow the team's static lane-navigation field around
    // the central landmass when far from the order point (the lanes wind too
    // sharply for straight-line + coast-slide to traverse — see types.ts
    // NavField / docs/TERRAIN.md §3). Near the goal (or with no field, e.g. a
    // stub mask) navStepToward returns null and we steer the true order point,
    // preserving exact arrival/idle behaviour and all legacy open-sea tests.
    const nav = laneNavGoal(ruleset, entity, order.x, order.y);
    goalX = nav.x;
    goalY = nav.y;
  }

  // Arrival is judged against the TRUE order point (move/attackMove), never an
  // intermediate nav waypoint — so a unit following the lane field keeps going
  // until it reaches the actual order point, then snaps + idles as before. For
  // a chase the order point is the (live) target, already in goalX/goalY.
  const orderX = chasing ? goalX : order.x;
  const orderY = chasing ? goalY : order.y;

  const dx = goalX - entity.x;
  const dy = goalY - entity.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const dOrder = chasing ? d : Math.sqrt((orderX - entity.x) ** 2 + (orderY - entity.y) ** 2);
  if (d === 0) {
    // Exactly on the steering goal: if it is also the order point, the move
    // completes; otherwise (a nav waypoint coincident with us) just hold facing.
    if (!chasing && dOrder === 0) entity.order = { type: 'idle' };
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
    goalX === orderX &&
    goalY === orderY
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

  if (!chasing && dOrder <= step) {
    // Arrival: snap to the TRUE order point and go idle (judged on the order
    // point, so a lane-following unit only completes at the real destination).
    entity.x = orderX;
    entity.y = orderY;
    entity.order = { type: 'idle' };
    return;
  }

  const advance = chasing ? Math.min(step, d - stopDist) : step;
  entity.x += dCos(entity.facingRad) * advance;
  entity.y += dSin(entity.facingRad) * advance;
}

/**
 * Steering goal for a move/attackMove order: the next lane-navigation waypoint
 * that routes around the central landmass toward `(orderX, orderY)`, or the
 * order point itself (straight line — the legacy behaviour) when no field helps.
 *
 * Field choice (both flow over the same water network, see types.ts NavField):
 *   - navByTeam[team]     -> the ENEMY base (the push goal),
 *   - navHomeByTeam[team] -> the OWN base (retreats / shop detours).
 * We pick the field whose goal is NEARER the order point, then steer along its
 * gradient — but ONLY when the gradient step actually reduces straight-line
 * distance to the order point (so the detour genuinely helps reach THAT order,
 * never drags the unit the wrong way). Mid-lane micro / short repositions where
 * the straight line is fine, and stub masks, fall through to the order point.
 * navStepToward returns null near the goal so the final approach is the true
 * straight line. Pure: distance compares + navStepToward arithmetic, no RNG/trig.
 */
function laneNavGoal(
  ruleset: Ruleset,
  entity: UnitEntity,
  orderX: number,
  orderY: number,
): { x: number; y: number } {
  if (entity.kind !== 'ship' && entity.kind !== 'creep' && entity.kind !== 'summon') {
    return { x: orderX, y: orderY };
  }
  const push = ruleset.map.navByTeam?.[entity.team];
  const home = ruleset.map.navHomeByTeam?.[entity.team];
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

  // SHIPS (players / AI) can push, retreat, shop or micro locally, so steer via
  // a field ONLY for a genuine LONG HAUL toward a base: the order must be
  // (a) far from the ship (not a short shop/repair/micro hop, which must stay
  // straight-line so it reaches its exact point) AND (b) its destination near a
  // base goal (so the field actually flows there). We then pick whichever field
  // (push / home) has its goal nearer the order point.
  const orderDistSq = (orderX - entity.x) ** 2 + (orderY - entity.y) ** 2;
  if (orderDistSq < NAV_SHIP_MIN_HAUL * NAV_SHIP_MIN_HAUL) return { x: orderX, y: orderY };

  const pushGapSq = (orderX - push.goalX) ** 2 + (orderY - push.goalY) ** 2;
  const homeGapSq =
    home === undefined || home.dist.length === 0
      ? Infinity
      : (orderX - home.goalX) ** 2 + (orderY - home.goalY) ** 2;
  const field = homeGapSq < pushGapSq ? (home as NavField) : push;
  const gapSq = Math.min(pushGapSq, homeGapSq);
  // Following the gradient may move AWAY from the order point briefly (rounding
  // the landmass) — that is the whole point, so there is no "must reduce
  // straight-line distance" guard.
  if (gapSq > NAV_BASE_ORDER_RADIUS * NAV_BASE_ORDER_RADIUS) return { x: orderX, y: orderY };

  const step = navStepToward(field, entity.x, entity.y);
  return step ?? { x: orderX, y: orderY };
}

/** Order-point proximity to a base goal that makes a SHIP move/attackMove
 * eligible for lane-field steering: large enough to cover a base's whole apron +
 * shop cluster + repair bay, small enough that a mid-lane waypoint stays
 * straight. (Creeps are not gated — they always follow the push field.) */
const NAV_BASE_ORDER_RADIUS = 4000;

/** Minimum straight-line order distance for a SHIP to use lane-field steering.
 * Below this a move is a local hop (shop dock, repair bay, micro) that must run
 * straight to its exact point; only long hauls toward a base follow the lane. */
const NAV_SHIP_MIN_HAUL = 2500;

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
