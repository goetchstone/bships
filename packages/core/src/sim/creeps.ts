/**
 * Lane creep system: Imperial wave spawning + creep AI.
 *
 * Verbatim source: war3map.j Trig_Rowboat_Spawn / Trig_Battle_Ship_Spawn /
 * Trig_Cruiser_Spawn -> Trig_Spawn_Ships (l.9538-9726) and
 * Trig_Continue_Attacking_South/North (l.9727-9759), compiled into
 * ruleset.map.waves / map.lanes by the ruleset module.
 *
 * Behaviors:
 * - Wave timers: timers.nextWaveTick[wave.name] (this module owns the
 *   field; createMatch seeds it to preSpawnDelayTicks, and stepCreeps
 *   lazily seeds any missing key identically). A wave fires when
 *   tick >= due, then due += periodTicks — the timer keeps running even
 *   when no lane can spawn, matching the WC3 periodic timer.
 * - Per fire, every lane whose OWN harbor (structure instanceKey ===
 *   lane.ownHarborKey) is alive spawns wave.count creeps at the lane spawn
 *   point: wave.bountyTypeId while the destination enemy harbor
 *   (lane.bountyGateEnemyHarborKey) lives, wave.zeroBountyTypeId after
 *   (h00E/h00F/h00G zero-bounty twins — preserved data asymmetry).
 * - Spawn-time team upgrades (TeamState.upgrades, e.g. R003/R004): effect
 *   perLevel arrays are PER-LEVEL increments (index 0 = level 1) summed up
 *   to the researched level. pctBaseMaxHp (fraction of base) + flatMaxHp
 *   bake into hp/maxHp. flatMoveSpeed has no CreepEntity field, so it is
 *   encoded as a permanent 'speedAura' status with moveSpeedPct =
 *   flat / base speed (movement's pct formula then yields base + flat);
 *   sourceAbilityId carries the upgrade id. Attack upgrades
 *   (bonusAttackDice / flatAttackDamage) are NOT baked — combat applies
 *   them at fire time from upgrade levels.
 * - Verbatim order quirk (GetUnitsInRectOfPlayer): after spawning, the
 *   lane's FIRST waypoint is issued as attackMove to ALL units owned by
 *   lane.creepOwner inside the spawn region — stragglers from earlier
 *   waves included, not just the new creeps.
 * - Waypoint AI: a waypoint with issuedOnEnteringRegions is issued when a
 *   creep with a lower waypointIndex is inside any of those regions (the
 *   enemy-HQ re-order on entering either enemy harbor zone). Inside-region
 *   checks emulate WC3 enter-region events; the waypointIndex gate
 *   prevents per-tick re-issue.
 * - Hold-at-tower AI (docs/TERRAIN.md §4 creep-ai): after the waypoint pass,
 *   each living creep targets the FRONTMOST living enemy structure in its lane
 *   (enemy towers first, then the enemy HQ) — it attack-moves onto it so
 *   combat's auto-acquire fires and the land funnel + collision physically
 *   stall it at the chokepoint, rather than ghosting past to the HQ. When that
 *   structure dies the creep retargets the next one forward, and once every
 *   enemy structure in the corridor is dead the creep falls back to its plain
 *   waypoint order (open run to the HQ point). "In its lane" = within
 *   LANE_CORRIDOR_HALF_WIDTH of the lane axis (spawn -> final waypoint) and
 *   ahead of the creep along that axis; "frontmost" = smallest forward
 *   projection among those. This is pure static-geometry arithmetic + the
 *   existing structureAlive liveness scan: no RNG draws, no trig built-ins,
 *   deterministic, so replay stays bit-identical. Players are never touched —
 *   this writes creep `order` only.
 *
 * Reads: ruleset.map.lanes/waves/regions, ruleset.unitTypes/upgrades,
 * teams.upgrades, structure liveness via instanceKey.
 * Mutates: state.entities (new CreepEntity via allocEntityId, in spawn
 * order), creep order/waypointIndex (plus order on creep-owner units in
 * the quirk), timers.nextWaveTick, state.events ('waveSpawned').
 * Never: damage, gold, items, RNG draws.
 *
 * Tick order: runs 1st (orders written before movement executes them).
 */

import { dSqrt, PI } from '../math.js';
import type {
  CreepEntity,
  LaneSpec,
  Ruleset,
  SimState,
  Status,
  StructureEntity,
  TeamId,
  WaveSpec,
} from './types.js';
import {
  allocEntityId,
  enemyTeam,
  isUnitEntity,
  pointInRegion,
  sortedNumericKeys,
} from './types.js';

/**
 * Lateral half-width (world units) of a lane "corridor" for the hold-at-tower
 * AI. An enemy structure counts as being "in the lane" only when its
 * perpendicular distance from the lane axis (spawn -> final waypoint) is within
 * this band. Sized from the real map: the towers guarding each lane sit ≤ ~945u
 * off the axis, while the nearest tower belonging to an ADJACENT lane is
 * ≥ ~1210u off — so 1100 cleanly assigns every chokepoint tower + the HQ to one
 * lane without a creep ever fixating on a tower it can never reach.
 */
const LANE_CORRIDOR_HALF_WIDTH = 1100;

/** True while a structure with this instanceKey exists and is alive. */
function structureAlive(state: SimState, instanceKey: string): boolean {
  if (instanceKey === '') return false;
  for (const id of sortedNumericKeys(state.entities)) {
    const entity = state.entities[id];
    if (
      entity !== undefined &&
      entity.kind === 'structure' &&
      entity.instanceKey === instanceKey &&
      !entity.dead &&
      entity.hp > 0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Unit-vector lane axis = direction from the spawn point toward the FINAL
 * waypoint (the enemy HQ). Used to project structures/creeps onto the
 * direction of travel for the hold-at-tower AI. Degenerate lanes (no
 * waypoints, or a final waypoint coincident with the spawn) return null and
 * disable the hold gate for that lane. Pure arithmetic — no trig.
 */
function laneAxis(lane: LaneSpec): { ux: number; uy: number } | null {
  const final = lane.waypoints[lane.waypoints.length - 1];
  if (final === undefined) return null;
  const dx = final.x - lane.spawnX;
  const dy = final.y - lane.spawnY;
  const len = dSqrt(dx * dx + dy * dy);
  if (len === 0) return null;
  return { ux: dx / len, uy: dy / len };
}

/**
 * Frontmost LIVING enemy structure ahead of a creep along its lane axis, or
 * null when none remains (towers + HQ all dead, or the creep is already past
 * the last structure). "Ahead" = strictly larger forward projection than the
 * creep; "in the lane" = perpendicular offset within LANE_CORRIDOR_HALF_WIDTH;
 * "frontmost" = smallest forward projection among those (nearest to the creep
 * toward the enemy HQ). Towers and the HQ are treated uniformly — both are
 * enemy structures on the axis — so the natural ordering yields towers first
 * (smaller projection) then the HQ (largest), matching the contract.
 *
 * Determinism: iterates state.entities in ascending-id order (ties broken by
 * id) and mirrors structureAlive's liveness predicate. No RNG, no trig.
 */
function frontmostEnemyStructure(
  state: SimState,
  creep: CreepEntity,
  axis: { ux: number; uy: number },
  spawnX: number,
  spawnY: number,
): StructureEntity | null {
  const foeTeam = enemyTeam(creep.team);
  // Forward projection of the creep onto the lane axis (origin = spawn point).
  const creepFwd = (creep.x - spawnX) * axis.ux + (creep.y - spawnY) * axis.uy;
  let best: StructureEntity | null = null;
  let bestFwd = Infinity;
  for (const id of sortedNumericKeys(state.entities)) {
    const entity = state.entities[id];
    if (
      entity === undefined ||
      entity.kind !== 'structure' ||
      entity.dead ||
      entity.hp <= 0 ||
      entity.team !== foeTeam ||
      (entity.role !== 'tower' && entity.role !== 'hq')
    ) {
      continue;
    }
    const rx = entity.x - spawnX;
    const ry = entity.y - spawnY;
    const fwd = rx * axis.ux + ry * axis.uy;
    if (fwd <= creepFwd) continue; // behind or level with the creep
    // Perpendicular (lateral) offset from the lane axis.
    const lat = Math.abs(rx * axis.uy - ry * axis.ux);
    if (lat > LANE_CORRIDOR_HALF_WIDTH) continue; // belongs to another lane
    if (fwd < bestFwd) {
      best = entity;
      bestFwd = fwd;
    }
  }
  return best;
}

interface SpawnUpgradeMods {
  /** Sum of pctBaseMaxHp fractions across researched levels. */
  hpPctOfBase: number;
  hpFlat: number;
  /** flatMoveSpeed contributions (units/sec), ascending upgrade id. */
  speedFlat: { upgradeId: string; amount: number }[];
}

/**
 * Total spawn-time effect of the team's researched upgrades on one creep
 * type. perLevel entries are per-level increments; researched level L sums
 * the first L entries.
 */
function spawnUpgradeMods(
  state: SimState,
  ruleset: Ruleset,
  team: TeamId,
  typeId: string,
): SpawnUpgradeMods {
  const mods: SpawnUpgradeMods = { hpPctOfBase: 0, hpFlat: 0, speedFlat: [] };
  const teamUpgrades = state.teams[team].upgrades;
  for (const upgradeId of Object.keys(ruleset.upgrades).sort()) {
    const spec = ruleset.upgrades[upgradeId];
    if (spec === undefined || !spec.appliesToUnitTypes.includes(typeId)) continue;
    const level = teamUpgrades[spec.id] ?? 0;
    if (level <= 0) continue;
    const perLevel = spec.effect.perLevel;
    let total = 0;
    const upto = Math.min(level, perLevel.length);
    for (let i = 0; i < upto; i++) total += perLevel[i] ?? 0;
    switch (spec.effect.kind) {
      case 'pctBaseMaxHp':
        mods.hpPctOfBase += total;
        break;
      case 'flatMaxHp':
        mods.hpFlat += total;
        break;
      case 'flatMoveSpeed':
        mods.speedFlat.push({ upgradeId: spec.id, amount: total });
        break;
      default:
        // Attack effects (bonusAttackDice/flatAttackDamage) are applied by
        // combat at fire time; flatHpRegen has no creep-side spawn field.
        break;
    }
  }
  return mods;
}

/** One creep tick: fire due waves, advance waypoint AI. */
export function stepCreeps(state: SimState, ruleset: Ruleset): void {
  // --- Wave timers -------------------------------------------------------
  for (const wave of ruleset.map.waves) {
    let due = state.timers.nextWaveTick[wave.name];
    if (due === undefined) {
      due = wave.preSpawnDelayTicks;
      state.timers.nextWaveTick[wave.name] = due;
    }
    if (state.tick < due) continue;
    for (const lane of ruleset.map.lanes) {
      if (structureAlive(state, lane.ownHarborKey)) {
        spawnWave(state, ruleset, wave, lane);
      }
    }
    state.timers.nextWaveTick[wave.name] = due + wave.periodTicks;
  }

  // --- Waypoint AI (enemy-HQ re-order on entering a trigger region) ------
  const lanesById: Record<string, LaneSpec> = {};
  for (const lane of ruleset.map.lanes) lanesById[lane.id] = lane;
  for (const id of sortedNumericKeys(state.entities)) {
    const entity = state.entities[id];
    if (entity === undefined || entity.kind !== 'creep' || entity.dead) continue;
    const lane = lanesById[entity.laneId];
    if (lane === undefined) continue;
    for (let i = entity.waypointIndex + 1; i < lane.waypoints.length; i++) {
      const waypoint = lane.waypoints[i];
      if (waypoint === undefined || waypoint.issuedOnEnteringRegions === null) continue;
      let entered = false;
      for (const regionName of waypoint.issuedOnEnteringRegions) {
        const region = ruleset.map.regions[regionName];
        if (region !== undefined && pointInRegion(region, entity.x, entity.y)) {
          entered = true;
          break;
        }
      }
      if (entered) {
        entity.order = { type: 'attackMove', x: waypoint.x, y: waypoint.y };
        entity.waypointIndex = i;
      }
    }
  }

  // --- Hold-at-tower AI (docs/TERRAIN.md §4) -----------------------------
  // After the waypoint pass has set each creep's base order, gate it to the
  // frontmost living enemy structure in the lane: the creep attack-moves onto
  // that structure (combat auto-acquires + fires; movement + the land funnel
  // stall it at the chokepoint) instead of ghosting toward the HQ waypoint.
  // When no enemy structure remains ahead, the creep keeps its waypoint order
  // (open run to the HQ point). Players are never touched.
  //
  // The opposing-wave CLASH (spawn ships fighting each other before pushing on)
  // is NOT done here by retargeting: that produced a perfect stalemate wall.
  // Instead movement.ts halts an attack-moving creep while a living enemy is in
  // its attack arc (WC3 attack-move), so the waves brawl where they meet AND the
  // front stays dynamic — survivors leak through and resume the push.
  for (const id of sortedNumericKeys(state.entities)) {
    const entity = state.entities[id];
    if (entity === undefined || entity.kind !== 'creep' || entity.dead) continue;
    const lane = lanesById[entity.laneId];
    if (lane === undefined) continue;
    const axis = laneAxis(lane);
    if (axis === null) continue;
    const target = frontmostEnemyStructure(state, entity, axis, lane.spawnX, lane.spawnY);
    if (target === null) continue; // nothing ahead -> keep the waypoint order
    // Hold gate: target the structure rather than advance past it. attackMove
    // (not attackTarget) so combat picks the nearest in-range foe each tick
    // and movement keeps closing on the chokepoint — see module doc.
    entity.order = { type: 'attackMove', x: target.x, y: target.y };
  }
}

/**
 * Spawn one wave on one lane (no timer/harbor checks — caller gates).
 * Exported for tests. Creeps spawn at the lane spawn point with
 * spawnFacingDeg, ascending ids in spawn order; then the verbatim order
 * quirk re-issues the first waypoint to every creep-owner unit inside the
 * spawn region.
 */
export function spawnWave(
  state: SimState,
  ruleset: Ruleset,
  wave: WaveSpec,
  lane: LaneSpec,
): void {
  const typeId = structureAlive(state, lane.bountyGateEnemyHarborKey)
    ? wave.bountyTypeId
    : wave.zeroBountyTypeId;
  const unitType = ruleset.unitTypes[typeId];
  if (unitType === undefined) {
    // Defensive: never THROW from the per-tick hot path. A live match would
    // crash on its first wave if a data edit dropped a creep type, and the
    // server's per-tick try/catch (match.ts) would convert that into an abrupt
    // finish(null) — a player perceives the game "crashing" mid-match. The wave
    // timer is advanced by the caller (stepCreeps) regardless, so skipping this
    // spawn just means no creeps this fire (no infinite retry). With current
    // data every wave type resolves, so this branch is unreachable and the
    // replay hash is unchanged; it exists only so future data drift degrades
    // gracefully instead of killing the match. Deterministic: pure early
    // return, no RNG/trig/state mutation.
    return;
  }
  const mods = spawnUpgradeMods(state, ruleset, lane.team, typeId);
  const maxHp = Math.round(unitType.maxHp * (1 + mods.hpPctOfBase) + mods.hpFlat);
  const facingRad = (lane.spawnFacingDeg * PI) / 180;
  const firstWaypoint = lane.waypoints[0];

  for (let i = 0; i < wave.count; i++) {
    // Fresh statuses array per creep — status objects are mutated in place
    // by other systems and must never be aliased across entities.
    const statuses: Status[] = [];
    for (const contribution of mods.speedFlat) {
      if (contribution.amount !== 0 && unitType.moveSpeed > 0) {
        statuses.push({
          kind: 'speedAura',
          moveSpeedPct: contribution.amount / unitType.moveSpeed,
          sourceAbilityId: contribution.upgradeId,
        });
      }
    }
    const creep: CreepEntity = {
      id: allocEntityId(state),
      typeId,
      x: lane.spawnX,
      y: lane.spawnY,
      facingRad,
      dead: false,
      kind: 'creep',
      owner: lane.creepOwner,
      team: lane.team,
      hp: maxHp,
      maxHp,
      order:
        firstWaypoint === undefined
          ? { type: 'idle' }
          : { type: 'attackMove', x: firstWaypoint.x, y: firstWaypoint.y },
      statuses,
      vision: { south: lane.team === 'south', north: lane.team === 'north' },
      attackReadyAtTick: state.tick,
      laneId: lane.id,
      waypointIndex: 0,
    };
    state.entities[creep.id] = creep;
  }

  // Verbatim order quirk: ALL creep-owner units inside the spawn region
  // (new spawns and stragglers alike) are issued the first waypoint.
  if (firstWaypoint !== undefined) {
    const spawnRegion = ruleset.map.regions[lane.spawnRegion];
    if (spawnRegion !== undefined) {
      for (const id of sortedNumericKeys(state.entities)) {
        const entity = state.entities[id];
        if (entity === undefined || !isUnitEntity(entity) || entity.dead) continue;
        if (entity.owner !== lane.creepOwner) continue;
        if (!pointInRegion(spawnRegion, entity.x, entity.y)) continue;
        entity.order = { type: 'attackMove', x: firstWaypoint.x, y: firstWaypoint.y };
        if (entity.kind === 'creep') entity.waypointIndex = 0;
      }
    }
  }

  state.events.push({
    type: 'waveSpawned',
    tick: state.tick,
    laneId: lane.id,
    waveName: wave.name,
    count: wave.count,
  });
}
