/**
 * Per-team sight-radius fog of war — THE security boundary of the server.
 *
 * The sim's `entity.vision` flags cover ONLY invisibility-vs-detection
 * (specials.recomputeVisibility: "Fog-of-war is not modeled — a non-invisible
 * unit is visible to both teams"). This module adds the fog layer on top,
 * per team, each tick:
 *
 * - Sight sources of team T: every live entity of team T (sightRadius from
 *   ShipSpec / UnitTypeSpec / WardEntity.sightRadius) plus T's active
 *   `state.detectionZones` (flares grant area vision).
 * - Structures: ALWAYS included for both teams — placement is public map
 *   knowledge. Live HP rides along: an accepted v1 divergence from WC3 fog
 *   memory (the original shows the last-seen state of a fogged building).
 * - Own-team units/wards/summons: always included.
 * - Enemy units (ship/creep/summon): included iff `entity.vision[T]`
 *   (invisibility check, sim-owned) AND inside some T sight source.
 * - Enemy wards: included iff (!ward.invisible OR covered by a T detector —
 *   mirrors specials' detector collection) AND inside T sight range.
 * - Projectiles: included iff own-team OR inside T sight range.
 * - Ground items: not in snapshots v1 (documented gap; pickups still work
 *   blind via quest regions).
 */

import { sortedNumericKeys } from '@bships/core';
import type { Entity, Projectile, Ruleset, SimState, TeamId } from '@bships/core';

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
}

/**
 * Goblin Scout Crew carrier true sight — MIRRORS the provisional constants
 * in core/src/sim/specials.ts (GEM_TRUE_SIGHT_*, not exported there; open
 * question to migrate into the Ruleset). Keep in sync.
 */
const GEM_TRUE_SIGHT_ITEM_ID = 'I00F';
const GEM_TRUE_SIGHT_RADIUS = 900;

/** True when (x, y) lies inside any of the circles (inclusive boundary). */
export function coveredBy(circles: readonly SightCircle[], x: number, y: number): boolean {
  for (const c of circles) {
    const dx = c.x - x;
    const dy = c.y - y;
    if (dx * dx + dy * dy <= c.radius * c.radius) return true;
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
      // Carrier true sight (Goblin Scout Crew) — see constant doc above.
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

  return { team, sight, detectors };
}

/**
 * The inclusion rule (module doc above). This is the security predicate —
 * an entity for which this returns false MUST NOT appear anywhere in the
 * team's snapshot payload.
 */
export function isEntityVisible(vision: TeamVision, entity: Entity): boolean {
  // Structures: placement is public map knowledge (documented v1 divergence:
  // live HP is sent too).
  if (entity.kind === 'structure') return true;
  if (entity.team === vision.team) return true;

  if (entity.kind === 'ward') {
    if (entity.invisible && !coveredBy(vision.detectors, entity.x, entity.y)) return false;
    return coveredBy(vision.sight, entity.x, entity.y);
  }

  // Enemy ship/creep/summon: sim-owned invisibility flag AND fog check.
  if (!entity.vision[vision.team]) return false;
  return coveredBy(vision.sight, entity.x, entity.y);
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
  return projectile.team === vision.team || coveredBy(vision.sight, projectile.x, projectile.y);
}
