/**
 * Per-team sight-radius FOG OF WAR — one shared model for every consumer.
 *
 * The sim's `entity.vision` flags cover ONLY invisibility-vs-detection
 * (specials.recomputeVisibility). This module adds the fog layer on top:
 * which points/entities a TEAM can currently see with its live units' sight
 * radii + its active detection zones. It was born in packages/server
 * (snapshot filtering — the security boundary) and moved here so the SIM
 * plays by the same rules the humans see (owner-reported 2026-07-09: "the AI
 * seems to see through fog of war" — it did; the AI brain and the auto-fire
 * acquisition consulted only the invisibility flags, and weapon ranges reach
 * 2500u while sight tops out at 1800u, so long-range weapons sniped INTO the
 * fog. In WC3 a unit cannot acquire a target its owner cannot see — long
 * -range fire needs a spotter).
 *
 * Consumers:
 * - packages/server snapshot fog (via the re-exporting server/visibility.ts).
 * - combat.ts auto-fire / cast / stop-to-engage target validity.
 * - ai.ts enemy-unit scans (aggro, kill-commit, offensive casts).
 * Structures are ALWAYS visible (placement is public map knowledge — the
 * documented v1 divergence), so structure scans stay ungated.
 *
 * `teamVisionOf` memoizes per (state, tick): recomputing the circles is O(n)
 * and several systems ask for them each tick. The memo is a WeakMap keyed on
 * the SimState object, never stored IN the state — a pure derivation, so
 * hashState/replays are untouched (same pattern as movement.ts fieldToPoint).
 */

import { sortedNumericKeys } from './types.js';
import { segmentCrossesLand } from './movement.js';
import type { Entity, Projectile, Ruleset, SimState, TeamId, WaterMask } from './types.js';

/**
 * Goblin Scout Crew carrier true sight (usable item 'gemt' analogue) —
 * PROVISIONAL constants (SEMANTICS §5, confidence medium; open question to
 * move into the Ruleset). Canonical home: this module; specials.ts imports
 * them for its detector collection.
 */
export const GEM_TRUE_SIGHT_ITEM_ID = 'I00F';
export const GEM_TRUE_SIGHT_RADIUS = 900;

/** One circular vision/detection source in world units. */
export interface SightCircle {
  x: number;
  y: number;
  radius: number;
}

/** Everything team T can see with, recomputed from scratch each tick. */
export interface TeamVision {
  readonly team: TeamId;
  /** Fog sight sources: live friendly entities + the team's detection zones. */
  readonly sight: readonly SightCircle[];
  /** True-sight sources (mirrors specials.ts' detector collection). */
  readonly detectors: readonly SightCircle[];
  /**
   * The land mask for line-of-sight blocking: BSP's land is CLIFFS
   * (owner-confirmed 2026-07-09: "you shouldn't be able to see over the land
   * to the other side — they were mountains/cliffs in the original"), so a
   * sight circle does NOT penetrate land. The open-sea stub mask (no cells)
   * makes LOS a no-op, keeping legacy open-water tests unchanged.
   */
  readonly mask: WaterMask | undefined;
}

/** True when (x, y) lies inside any of the circles (inclusive boundary),
 *  ignoring land line-of-sight — the raw radius test. Prefer `coveredSight`
 *  for anything gameplay-visible. */
export function coveredBy(circles: readonly SightCircle[], x: number, y: number): boolean {
  for (const c of circles) {
    const dx = c.x - x;
    const dy = c.y - y;
    if (dx * dx + dy * dy <= c.radius * c.radius) return true;
  }
  return false;
}

/**
 * True when (x, y) is inside some circle AND the sight line from that
 * circle's center does not cross land (cliffs block vision). The radius test
 * runs first so the segment sampling only happens for nearby sources.
 */
export function coveredSight(
  circles: readonly SightCircle[],
  mask: WaterMask | undefined,
  x: number,
  y: number,
): boolean {
  // No real mask (open-sea stub, or a synthetic test ruleset without a map):
  // LOS is a no-op and coverage is the plain radius test.
  const los = mask !== undefined && mask.cells.length > 0;
  for (const c of circles) {
    const dx = c.x - x;
    const dy = c.y - y;
    if (dx * dx + dy * dy > c.radius * c.radius) continue;
    if (!los || !segmentCrossesLand(mask, c.x, c.y, x, y)) return true;
  }
  return false;
}

/**
 * Collect team T's sight sources and true-sight detectors from the current
 * state. Ascending entity-id iteration for determinism (output order never
 * affects the boolean results, but keeps payload diffs reproducible).
 */
export function computeTeamVision(state: SimState, ruleset: Ruleset, team: TeamId): TeamVision {
  const sight: SightCircle[] = [];
  const detectors: SightCircle[] = [];

  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead || e.team !== team) continue;

    if (e.kind === 'ward') {
      // Expired-but-not-yet-removed wards see nothing (mirrors specials).
      if (e.expiresAtTick !== null && state.tick >= e.expiresAtTick) continue;
      if (e.sightRadius > 0) sight.push({ x: e.x, y: e.y, radius: e.sightRadius });
      if (e.detectionRadius !== null && e.detectionRadius > 0) {
        detectors.push({ x: e.x, y: e.y, radius: e.detectionRadius });
      }
      continue;
    }

    if (e.kind === 'ship') {
      // Submerged subs swap typeId, but both forms live in ruleset.ships.
      const spec = ruleset.ships[e.typeId];
      const sightRadius = spec?.sightRadius ?? 0;
      if (sightRadius > 0) sight.push({ x: e.x, y: e.y, radius: sightRadius });
      const detectionRadius = spec?.detectionRadius ?? null;
      if (detectionRadius !== null && detectionRadius > 0) {
        detectors.push({ x: e.x, y: e.y, radius: detectionRadius });
      }
      // Carrier true sight (Goblin Scout Crew) — constants shared with
      // specials.ts' detector collection.
      const player = state.players[e.owner];
      if (player?.inventory.some((item) => item !== null && item.itemId === GEM_TRUE_SIGHT_ITEM_ID)) {
        detectors.push({ x: e.x, y: e.y, radius: GEM_TRUE_SIGHT_RADIUS });
      }
    } else {
      // creep / structure / summon
      const spec = ruleset.unitTypes[e.typeId];
      const sightRadius = spec?.sightRadius ?? 0;
      if (sightRadius > 0) sight.push({ x: e.x, y: e.y, radius: sightRadius });
      const detectionRadius = spec?.detectionRadius ?? null;
      if (detectionRadius !== null && detectionRadius > 0) {
        detectors.push({ x: e.x, y: e.y, radius: detectionRadius });
      }
    }
  }

  for (const zone of state.detectionZones) {
    if (zone.team === team && zone.expiresAtTick > state.tick) {
      sight.push({ x: zone.x, y: zone.y, radius: zone.radius });
      detectors.push({ x: zone.x, y: zone.y, radius: zone.radius });
    }
  }

  return { team, sight, detectors, mask: ruleset.map?.waterMask };
}

/** Per-(state, tick) memo of both teams' vision — see the module doc. The
 *  per-entity verdict map exists because combat re-validates the same
 *  candidates per weapon per tick and the AI re-scans them per think: the
 *  circles + LOS math runs ONCE per (entity, team, tick). Entities do not
 *  move within a tick after specials ran, so the verdict is stable. */
interface VisionMemo {
  tick: number;
  byTeam: Partial<Record<TeamId, TeamVision>>;
  verdicts: Partial<Record<TeamId, Map<number, boolean>>>;
}

const VISION_MEMO = new WeakMap<SimState, VisionMemo>();

function memoOf(state: SimState): VisionMemo {
  let memo = VISION_MEMO.get(state);
  if (memo === undefined || memo.tick !== state.tick) {
    memo = { tick: state.tick, byTeam: {}, verdicts: {} };
    VISION_MEMO.set(state, memo);
  }
  return memo;
}

/**
 * Drop the memo for this state — called by specials.recomputeVisibility after
 * the movement phase settled positions, so combat (which runs next) always
 * judges fog on THIS tick's positions rather than reusing verdicts the
 * pre-step AI thinks computed on last tick's. Deterministic: the invalidation
 * point is a fixed phase boundary of stepTick.
 */
export function invalidateVisionMemo(state: SimState): void {
  VISION_MEMO.delete(state);
}

/** Memoized computeTeamVision for the state's CURRENT tick. */
export function teamVisionOf(state: SimState, ruleset: Ruleset, team: TeamId): TeamVision {
  const memo = memoOf(state);
  let vision = memo.byTeam[team];
  if (vision === undefined) {
    vision = computeTeamVision(state, ruleset, team);
    memo.byTeam[team] = vision;
  }
  return vision;
}

/**
 * The inclusion rule (module doc above). Serves double duty: the server's
 * snapshot security predicate AND the sim's targeting/AI fog gate — an
 * entity for which this returns false must neither be SENT to the team nor
 * ACTED ON by the team's units.
 */
export function isEntityVisible(vision: TeamVision, entity: Entity): boolean {
  // Structures: placement is public map knowledge (documented v1 divergence:
  // live HP is sent too).
  if (entity.kind === 'structure') return true;
  if (entity.team === vision.team) return true;

  if (entity.kind === 'ward') {
    if (entity.invisible && !coveredSight(vision.detectors, vision.mask, entity.x, entity.y)) {
      return false;
    }
    return coveredSight(vision.sight, vision.mask, entity.x, entity.y);
  }

  // Enemy ship/creep/summon: sim-owned invisibility flag AND fog check
  // (radius + cliffs line of sight).
  if (!entity.vision[vision.team]) return false;
  return coveredSight(vision.sight, vision.mask, entity.x, entity.y);
}

/** Memoized one-call form of the fog gate for sim-internal consumers: the
 *  full circles + LOS math runs once per (entity, team, tick). */
export function isVisibleToTeamFog(
  state: SimState,
  ruleset: Ruleset,
  target: Entity,
  team: TeamId,
): boolean {
  const memo = memoOf(state);
  let verdicts = memo.verdicts[team];
  if (verdicts === undefined) {
    verdicts = new Map();
    memo.verdicts[team] = verdicts;
  }
  const cached = verdicts.get(target.id);
  if (cached !== undefined) return cached;
  const verdict = isEntityVisible(teamVisionOf(state, ruleset, team), target);
  verdicts.set(target.id, verdict);
  return verdict;
}

/** All entities team T may receive this tick, ascending id order. */
export function collectVisibleEntities(state: SimState, vision: TeamVision): Entity[] {
  const out: Entity[] = [];
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead) continue;
    if (isEntityVisible(vision, e)) out.push(e);
  }
  return out;
}

/** Projectiles: own-team always, enemy only when inside sight range. */
export function isProjectileVisible(vision: TeamVision, projectile: Projectile): boolean {
  return (
    projectile.team === vision.team ||
    coveredSight(vision.sight, vision.mask, projectile.x, projectile.y)
  );
}
