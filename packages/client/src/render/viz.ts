/**
 * Pure visual math for client-render: colors, ship/structure sizing tiers,
 * HP-bar geometry, status tinting, and pointer hit-testing. NO pixi.js and
 * NO DOM imports — everything here is unit-testable in plain node (the
 * actual drawing lives in entities.ts/projectiles.ts/effects.ts).
 *
 * Sizing philosophy (docs/ARCH.md "Module: client-render"): silhouettes are
 * procedural placeholders — class-distinct shapes whose scale tracks the
 * catalog gold tier so a Royal Ship reads bigger than a starter Battle Ship.
 * The SAME radii feed pointer.ts hit-testing so what you see is what you
 * click.
 */

import type { SnapshotEntity, SnapshotStatusKind, StructureEntity, TeamId } from '@bships/core';

/** 2.5D vertical squash of the world plane (binding, docs/ARCH.md). */
export const FORESHORTEN = 0.82;

/** Team colors — hex mirrors of index.html --team-south / --team-north. */
export const TEAM_HEX: Record<TeamId, number> = {
  south: 0xff5c5c,
  north: 0x5c8aff,
};

/** Neutral structures: parchment gray. */
export const NEUTRAL_HEX = 0xc8bda0;

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function channel(c: number, shift: number): number {
  return (c >> shift) & 0xff;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** Linear RGB mix of two 0xRRGGBB colors, t in [0, 1]. */
export function mixColor(a: number, b: number, t: number): number {
  const r = clamp255(channel(a, 16) + (channel(b, 16) - channel(a, 16)) * t);
  const g = clamp255(channel(a, 8) + (channel(b, 8) - channel(a, 8)) * t);
  const bl = clamp255(channel(a, 0) + (channel(b, 0) - channel(a, 0)) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Multiply all channels by `f` (darken < 1 < brighten), clamped. */
export function scaleColor(c: number, f: number): number {
  return (
    (clamp255(channel(c, 16) * f) << 16) |
    (clamp255(channel(c, 8) * f) << 8) |
    clamp255(channel(c, 0) * f)
  );
}

/** Mix toward the color's own luminance gray; t=1 is fully gray. */
export function desaturate(c: number, t: number): number {
  const lum = clamp255(0.3 * channel(c, 16) + 0.59 * channel(c, 8) + 0.11 * channel(c, 0));
  return mixColor(c, (lum << 16) | (lum << 8) | lum, t);
}

// ---------------------------------------------------------------------------
// Ship sizing + class silhouettes
// ---------------------------------------------------------------------------

/** The narrow slice of the catalog the visual layer needs per ship type. */
export interface ShipDisplaySpec {
  name: string;
  gold: number;
  isSub: boolean;
}

export interface VizCatalog {
  ships: Record<string, ShipDisplaySpec>;
}

/** Gold-price tier 0..5 — drives hull scale (Classic prices 200..16000). */
export function goldTier(gold: number): number {
  if (gold <= 300) return 0;
  if (gold <= 1300) return 1;
  if (gold <= 2500) return 2;
  if (gold <= 6000) return 3;
  if (gold <= 10000) return 4;
  return 5;
}

/** Hull footprint in WORLD units (length along facing, beam across). */
export function hullSize(gold: number, isSub = false): { length: number; width: number } {
  const length = 64 + goldTier(gold) * 18;
  return { length, width: length * (isSub ? 0.3 : 0.42) };
}

export type ShipClassKey =
  | 'starter'
  | 'battle'
  | 'cruiser'
  | 'flagship'
  | 'royal'
  | 'merchant'
  | 'sub'
  | 'leviathan'
  | 'goblin';

/** Class-distinct silhouette key from the catalog spec (name + isSub). */
export function shipClassKey(spec: ShipDisplaySpec): ShipClassKey {
  if (spec.isSub) return 'sub';
  const name = spec.name.toLowerCase();
  if (name.includes('merchant') || name.includes('trade')) return 'merchant';
  if (name.includes('leviath')) return 'leviathan';
  if (name.includes('goblin')) return 'goblin';
  if (name.includes('flagship')) return 'flagship';
  if (name.includes('royal') || name.includes('pirate')) return 'royal';
  if (name.includes('cruiser')) return 'cruiser';
  if (spec.gold <= 300) return 'starter';
  return 'battle';
}

// ---------------------------------------------------------------------------
// Structures / creeps / wards sizing (visual radius in world units)
// ---------------------------------------------------------------------------

const STRUCTURE_RADIUS: Record<StructureEntity['role'], number> = {
  hq: 170,
  spawnBuilding: 140,
  tower: 60,
  shop: 95,
  repair: 120,
  missileRamp: 110,
  other: 80,
};

export function structureRadius(role: StructureEntity['role'] | undefined): number {
  return role === undefined ? STRUCTURE_RADIUS.other : STRUCTURE_RADIUS[role];
}

export const CREEP_HULL_LENGTH = 52;
export const SUMMON_HULL_LENGTH = 48;
export const WARD_RADIUS = 22;

/**
 * Visual (and hit-test) radius of one snapshot entity, in world units.
 * Ships scale with gold tier; unknown typeIds get a mid tier fallback.
 */
export function entityVisualRadius(entity: SnapshotEntity, catalog: VizCatalog): number {
  switch (entity.kind) {
    case 'ship': {
      const spec = catalog.ships[entity.typeId];
      const size = hullSize(spec?.gold ?? 2400, spec?.isSub ?? false);
      return size.length / 2;
    }
    case 'creep':
      return CREEP_HULL_LENGTH / 2;
    case 'summon':
      return SUMMON_HULL_LENGTH / 2;
    case 'ward':
      return WARD_RADIUS;
    case 'structure':
      return structureRadius(entity.role);
  }
}

// ---------------------------------------------------------------------------
// HP bars
// ---------------------------------------------------------------------------

/** Bar width in world units, scaled by maxHp and clamped for readability. */
export function hpBarWidth(maxHp: number): number {
  const w = 26 + Math.sqrt(Math.max(0, maxHp)) * 0.9;
  return Math.min(96, Math.max(34, w));
}

/** Green above 60%, yellow above 30%, red below. */
export function hpBarColor(ratio: number): number {
  if (ratio > 0.6) return 0x52d273;
  if (ratio > 0.3) return 0xe8c84e;
  return 0xe0524e;
}

// ---------------------------------------------------------------------------
// Status visuals
// ---------------------------------------------------------------------------

/** Statuses rendered as glyphs/overlays rather than (or on top of) tints. */
export type GlyphStatus = Extract<
  SnapshotStatusKind,
  'stunned' | 'shielded' | 'goblinMine' | 'revealed'
>;

export interface StatusVisual {
  /** Multiplicative tint for the hull (0xffffff = untouched). */
  tint: number;
  /** Whole-entity alpha (invisible = 0.5 — own team only by construction). */
  alpha: number;
  glyphs: GlyphStatus[];
}

/**
 * Resolve snapshot statuses into a tint/alpha/glyph set. `nowMs` drives the
 * burning flicker so the result animates without any per-entity state.
 */
export function statusVisual(statuses: readonly SnapshotStatusKind[], nowMs: number): StatusVisual {
  let tint = 0xffffff;
  let alpha = 1;
  const glyphs: GlyphStatus[] = [];
  for (const s of statuses) {
    switch (s) {
      case 'invisible':
        alpha = 0.5;
        break;
      case 'burning': {
        const flicker = 0.5 + 0.5 * Math.sin(nowMs / 45);
        tint = mixColor(tint, 0xff9a3c, 0.35 + 0.25 * flicker);
        break;
      }
      case 'slowed':
        tint = mixColor(tint, 0x4e9be8, 0.45);
        break;
      case 'ensnared':
        tint = mixColor(tint, 0x9a7a4a, 0.3);
        break;
      case 'silenced':
        tint = mixColor(tint, 0xb070e0, 0.25);
        break;
      case 'healing':
        tint = mixColor(tint, 0x6ee08a, 0.25);
        break;
      case 'hasted':
        tint = mixColor(tint, 0xb8ffd8, 0.2);
        break;
      case 'stunned':
      case 'shielded':
      case 'goblinMine':
      case 'revealed':
        glyphs.push(s);
        break;
    }
  }
  return { tint, alpha, glyphs };
}

// ---------------------------------------------------------------------------
// Facing / heading
// ---------------------------------------------------------------------------

/** Sim facing (rad, 0=east, CCW, +y north) -> Pixi rotation (y-down flips). */
export function spriteRotation(facingRad: number): number {
  return -facingRad;
}

/** World-space heading from a movement delta (+x east, +y north). */
export function headingRad(dx: number, dy: number): number {
  return Math.atan2(dy, dx);
}

// ---------------------------------------------------------------------------
// Hit-testing (pointer.ts) — THROUGH the camera transform incl. foreshorten
// ---------------------------------------------------------------------------

/** The slice of Camera hit-testing needs (kept narrow for tests). */
export interface HitTestCamera {
  zoom: number;
  worldToScreen(x: number, y: number): { x: number; y: number };
}

function hitPriority(kind: SnapshotEntity['kind']): number {
  // Units beat wards beat structures when hulls overlap (WC3 feel).
  if (kind === 'structure') return 2;
  if (kind === 'ward') return 1;
  return 0;
}

/**
 * Topmost entity under a screen point, or null. Each entity's hull is an
 * ELLIPSE on screen: rx = r*zoom, ry = r*zoom*FORESHORTEN (the world-plane
 * squash applies to hit-testing exactly as it does to rendering). Small
 * pixel slack keeps tiny hulls clickable at min zoom.
 */
export function hitTestEntities(
  entities: readonly SnapshotEntity[],
  screenX: number,
  screenY: number,
  cam: HitTestCamera,
  catalog: VizCatalog,
  slackPx = 8,
): SnapshotEntity | null {
  let best: SnapshotEntity | null = null;
  let bestScore = Infinity;
  for (const entity of entities) {
    const r = entityVisualRadius(entity, catalog);
    const sp = cam.worldToScreen(entity.x, entity.y);
    const rx = Math.max(10, r * cam.zoom) + slackPx;
    const ry = Math.max(8, r * cam.zoom * FORESHORTEN) + slackPx;
    const nx = (screenX - sp.x) / rx;
    const ny = (screenY - sp.y) / ry;
    const d = Math.hypot(nx, ny);
    if (d > 1) continue;
    const score = hitPriority(entity.kind) * 10 + d;
    if (score < bestScore) {
      best = entity;
      bestScore = score;
    }
  }
  return best;
}

/** Right-click attack eligibility: enemy ship/creep/summon/structure. */
export function isEnemyCombatant(entity: SnapshotEntity, myTeam: TeamId | null): boolean {
  if (entity.kind === 'ward') return false;
  return myTeam !== null && entity.team !== null && entity.team !== myTeam;
}
