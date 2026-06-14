/**
 * Structures — elevated, beveled buildings drawn at correct scale with one
 * consistent top-left light and drop shadows on the water (render-world).
 *
 * This module owns the per-structure DRAW recipe and the role -> silhouette /
 * height tables. It fixes the historical "giant flag" scale bug: upright
 * features (flag pennants, cranes, signs, masts) are NEVER placed with raw
 * world-unit offsets relative to the footprint radius. Instead the building's
 * standing-up height comes from `depth.logicalHeight(footprintR, ratio)`
 * (whose HEIGHT_MAX_RATIO clamp caps any feature at ~2.4x its footprint) and is
 * projected to screen px by `depth.heightOffsetPx(height, zoom)`. So an HQ keep
 * stands ~2-2.4x its footprint tall, a tower a bit taller-for-its-width, and a
 * flag is a small detail riding on top of the keep — never a screen-dominating
 * marker.
 *
 * Layering per structure (back -> front), composed by `drawStructure`:
 *   1. drop shadow  (foreshortened ellipse on the water, offset down-right)
 *   2. footprint / waterline ring at the screen base
 *   3. beveled body raised UP by heightOffsetPx(logicalHeight(r, ratio), zoom)
 *   4. team-color trim (only the trim carries team color; body is neutral
 *      masonry/timber/metal so south vs north stays unmistakable but the
 *      diorama reads as one world)
 *   5. small upright detail (flag / crane / sign / missile) on top
 *
 * Drawing is split so the gallery can render a structure statically with no
 * match: `drawStructure(target, role, team)` builds the whole stack into a
 * passed Container at a fixed reference zoom. The live world layer (world.ts)
 * uses the lower-level `buildStructureParts` so it can pool the sub-graphics
 * and only redraw on signature change.
 *
 * Pure helpers (role selection, height ratios, the part geometry math) are
 * exported and pixi-free where testable; the pixi drawing consumes
 * theme.ts + depth.ts + viz.ts only.
 */

import { Container, Graphics } from 'pixi.js';
import type { StructureEntity, TeamId } from '@bships/core';

import {
  CANVAS_LIGHT,
  FORESHORTEN,
  GOLD,
  METAL,
  METAL_DARK,
  NEUTRAL_COLOR,
  STONE,
  STONE_DARK,
  TEAM_COLOR,
  TIMBER,
  TIMBER_DARK,
  mix,
  scale,
  seaContour,
  shade,
  shadeFace,
  dropShadow,
} from './theme.js';
import { heightOffsetPx, logicalHeight } from './depth.js';
import { structureRadius } from './viz.js';

export type StructureRole = StructureEntity['role'];

/** Every role the sim can emit; the gallery iterates this in order. */
export const STRUCTURE_ROLES: readonly StructureRole[] = [
  'hq',
  'spawnBuilding',
  'tower',
  'shop',
  'repair',
  'missileRamp',
  'other',
];

/**
 * Height-as-fraction-of-footprint per role, fed through
 * `logicalHeight(footprintR, ratio)`. These are deliberately MODERATE — the
 * HEIGHT_MAX_RATIO clamp (2.4) is the hard cap, and most roles sit comfortably
 * below it so buildings read as solid, grounded structures rather than spires.
 * A tower is intentionally the tallest-for-its-width (slim + tall); the HQ is
 * the biggest by footprint but a broad keep, not a needle.
 */
export const ROLE_HEIGHT_RATIO: Record<StructureRole, number> = {
  hq: 1.15, // broad fortress keep
  spawnBuilding: 0.85, // harbor warehouse + crane
  tower: 2.1, // slim, tall watchtower (still under the 2.4 clamp)
  shop: 0.9, // market tent
  repair: 0.55, // low dry-dock / cradle
  missileRamp: 0.7, // launch gantry
  other: 0.8, // generic depot
};

/**
 * Coarse silhouette family per role — the switch the renderer draws. Distinct
 * from the height ratio so tests can assert "every role maps to a known
 * silhouette" independently of the numeric tuning.
 */
export type StructureSilhouette =
  | 'keep' // hq: hexagonal bastion + inner keep + flag
  | 'harbor' // spawnBuilding: pier + warehouse + crane
  | 'watchtower' // tower: tall round turret + crenellations
  | 'market' // shop: striped awning tent + sign
  | 'drydock' // repair: rails + cradle + wrench
  | 'gantry' // missileRamp: inclined rail + missile
  | 'depot'; // other: generic block + roof

export function structureSilhouette(role: StructureRole): StructureSilhouette {
  switch (role) {
    case 'hq':
      return 'keep';
    case 'spawnBuilding':
      return 'harbor';
    case 'tower':
      return 'watchtower';
    case 'shop':
      return 'market';
    case 'repair':
      return 'drydock';
    case 'missileRamp':
      return 'gantry';
    case 'other':
      return 'depot';
  }
}

/** Team trim color; neutral structures (unowned shops/empire) use parchment. */
export function trimColor(team: TeamId | null): number {
  return team === null ? NEUTRAL_COLOR : TEAM_COLOR[team];
}

/**
 * The structure's logical height (world units) — `logicalHeight` applied with
 * this role's ratio. Exported so world.ts and tests agree, and so the giant-
 * flag guard (the clamp) lives in exactly one place.
 */
export function structureHeight(role: StructureRole): number {
  return logicalHeight(structureRadius(role), ROLE_HEIGHT_RATIO[role]);
}

// ===========================================================================
// SHADOW + FOOTPRINT — shared base every silhouette sits on.
// ===========================================================================

/**
 * Draw the drop shadow for a footprint of radius `r` and logical `height`
 * into `g`, centered at the local origin (the world base of the structure).
 * Offsets/radii are in screen px at zoom 1; the world layer scales the whole
 * container by zoom so these read consistently. The ellipse is foreshortened
 * (ry < rx) so it lies flat on the squashed water plane.
 */
export function drawDropShadow(g: Graphics, r: number, height: number): void {
  const s = dropShadow(r, height);
  // Soft edge approximated with a faint outer ellipse + a denser core.
  g.ellipse(s.dx, s.dy, s.rx * 1.18, s.ry * 1.18).fill({ color: s.color, alpha: s.alpha * 0.45 });
  g.ellipse(s.dx, s.dy, s.rx, s.ry).fill({ color: s.color, alpha: s.alpha });
}

/**
 * Waterline footprint: a foreshortened disc on the sea with a faint lit rim,
 * so the building visibly meets the water (the contact shadow's counterpart).
 */
export function drawFootprint(g: Graphics, r: number, team: TeamId | null): void {
  const trim = trimColor(team);
  // Dark sea-contour just outside the pad so the building's base reads crisply
  // against the water (the grounded-silhouette counterpart of the hull contour).
  g.ellipse(0, 0, r * 0.98, r * 0.98 * FORESHORTEN).stroke({
    width: 2.5,
    color: seaContour(STONE),
    alpha: 0.85,
  });
  // Wet stone pad, darker than the surrounding water-pop hulls.
  g.ellipse(0, 0, r * 0.92, r * 0.92 * FORESHORTEN).fill({ color: scale(STONE_DARK, 0.7), alpha: 0.92 });
  // Lit rim on the top-left (toward the light), tinted by team trim for a
  // clear at-a-glance owner cue right at the waterline.
  g.ellipse(0, 0, r * 0.92, r * 0.92 * FORESHORTEN).stroke({
    width: 2,
    color: mix(scale(STONE, 1.12), trim, 0.32),
    alpha: 0.7,
  });
}

// ===========================================================================
// BEVELED PRIMITIVES — small helpers that shade faces from the global light.
// Each returns nothing; they draw into `g` (the body group, in local px where
// +x is right, -y is UP since the body has already been raised by the caller).
// ===========================================================================

/**
 * A beveled vertical box (a building wall block) of half-width `hw`, sitting
 * on the local origin and rising to height `h` (px) above it. Front face lit
 * per the light, a thin top cap, and a darker right side for solidity.
 */
function bevelBox(g: Graphics, hw: number, h: number, base: number): void {
  const s = shade(base);
  // Right shadow side (a thin parallelogram) for a hint of thickness.
  const side = hw * 0.22;
  g.poly([hw, 0, hw + side, -side * 0.6, hw + side, -h - side * 0.6, hw, -h]).fill(s.shade);
  // Front face.
  g.rect(-hw, -h, hw * 2, h).fill(s.base).stroke({ width: 1.5, color: s.outline, alpha: 0.5 });
  // Lit top cap.
  g.poly([-hw, -h, hw, -h, hw + side, -h - side * 0.6, -hw + side, -h - side * 0.6]).fill(s.lit);
}

/** A foreshortened disc cap (tower roof / keep dome) centered at (0, cy). */
function discCap(g: Graphics, cx: number, cy: number, rx: number, base: number): void {
  const s = shade(base);
  g.ellipse(cx, cy, rx, rx * FORESHORTEN).fill(s.lit).stroke({ width: 1.5, color: s.outline, alpha: 0.6 });
}

// ===========================================================================
// PER-ROLE SILHOUETTES — drawn in BODY space (origin = waterline base, up=-y).
// `r` is the footprint radius in world units; `hPx` is the screen-px standing
// height the body should occupy (so features scale with the camera). `trim` is
// the team color used sparingly for accents. `nowMs` lets a couple of details
// (the flag, a beacon) shimmer; pass 0 for a static gallery frame.
// ===========================================================================

function drawKeep(g: Graphics, r: number, hPx: number, trim: number, nowMs: number): void {
  // Hexagonal stone bastion footprint wall, raised slightly.
  const wallH = hPx * 0.5;
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(Math.cos(a) * r * 0.88, Math.sin(a) * r * 0.88 * FORESHORTEN);
  }
  // Bastion wall prism: dark base ring + lit top ring offset up by wallH.
  g.poly(pts).fill(shade(STONE).shade);
  const topPts = pts.map((v, i) => (i % 2 === 1 ? v - wallH : v));
  g.poly(topPts).fill(shade(STONE).base).stroke({ width: 2, color: shade(STONE).outline, alpha: 0.6 });
  // Crenellation merlons around the top ring.
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    const mx = Math.cos(a) * r * 0.88;
    const my = Math.sin(a) * r * 0.88 * FORESHORTEN - wallH;
    g.rect(mx - r * 0.08, my - r * 0.16, r * 0.16, r * 0.18).fill(shade(STONE).lit);
  }
  // Inner keep tower rising the full height.
  const keepHW = r * 0.4;
  bevelBox(g, keepHW, hPx, mix(STONE, trim, 0.08));
  discCap(g, 0, -hPx, keepHW * 0.92, mix(STONE, trim, 0.12));
  // Team-trim banner band near the keep top.
  g.rect(-keepHW, -hPx * 0.78, keepHW * 2, hPx * 0.14).fill({ color: trim, alpha: 0.95 });
  // Flag: small detail on a short pole atop the keep (NOT a giant marker).
  const poleTop = -hPx - keepHW * 0.5;
  g.moveTo(0, -hPx).lineTo(0, poleTop).stroke({ width: 2, color: scale(METAL, 1.05) });
  const wave = Math.sin(nowMs / 320) * keepHW * 0.12;
  g.poly([0, poleTop, keepHW * 0.8 + wave, poleTop + keepHW * 0.18, 0, poleTop + keepHW * 0.36]).fill(trim);
}

function drawHarbor(g: Graphics, r: number, hPx: number, trim: number): void {
  // Timber pier deck on the water (flat, foreshortened).
  g.rect(-r, -r * 0.12 * FORESHORTEN, r * 2, r * 0.6 * FORESHORTEN)
    .fill(shade(TIMBER).shade)
    .stroke({ width: 1.5, color: TIMBER_DARK, alpha: 0.8 });
  for (let i = -3; i <= 3; i++) {
    g.moveTo(i * r * 0.28, -r * 0.12 * FORESHORTEN)
      .lineTo(i * r * 0.28, r * 0.48 * FORESHORTEN)
      .stroke({ width: 1, color: TIMBER_DARK, alpha: 0.7 });
  }
  // Warehouse block raised to full height, slightly left of center. All
  // offsets are inlined (no Container/transform) so the body stays one pooled
  // Graphics in the world layer.
  const whHW = r * 0.42;
  const ox = -r * 0.28;
  const wb = shade(STONE);
  const side = whHW * 0.22;
  g.poly([ox + whHW, 0, ox + whHW + side, -side * 0.6, ox + whHW + side, -hPx - side * 0.6, ox + whHW, -hPx]).fill(wb.shade);
  g.rect(ox - whHW, -hPx, whHW * 2, hPx).fill(wb.base).stroke({ width: 1.5, color: wb.outline, alpha: 0.5 });
  // Gabled lit roof.
  g.poly([ox - whHW, -hPx, ox, -hPx - whHW * 0.7, ox + whHW, -hPx]).fill(wb.lit);
  g.rect(ox - whHW, -hPx * 0.42, whHW * 2, hPx * 0.12).fill({ color: trim, alpha: 0.95 });
  // Crane: metal mast + jib + hook line, on the right of the pier.
  const cm = scale(METAL, 1.0);
  const craneX = r * 0.5;
  const craneTop = -hPx * 1.05;
  g.moveTo(craneX, 0).lineTo(craneX, craneTop).stroke({ width: 4, color: cm });
  g.moveTo(craneX, craneTop).lineTo(craneX + r * 0.6, craneTop + r * 0.28).stroke({ width: 3, color: cm });
  g.moveTo(craneX + r * 0.6, craneTop + r * 0.28)
    .lineTo(craneX + r * 0.6, craneTop + r * 0.7)
    .stroke({ width: 1, color: METAL_DARK });
  g.rect(craneX + r * 0.5, craneTop + r * 0.7, r * 0.2, r * 0.14).fill(shade(TIMBER).base);
}

function drawWatchtower(g: Graphics, r: number, hPx: number, trim: number): void {
  // Slim round turret: a tall shaded shaft + crenellated cap + accent band.
  const hw = r * 0.55;
  const sh = shade(STONE);
  // Right shadow side gives the cylinder volume.
  const side = hw * 0.3;
  g.poly([hw, 0, hw + side, -side * 0.5, hw + side, -hPx - side * 0.5, hw, -hPx]).fill(sh.shade);
  // Front shaft with a faux-cylinder gradient feel via two faces.
  g.rect(-hw, -hPx, hw * 1.2, hPx).fill(sh.base);
  g.rect(hw * 0.2, -hPx, hw * 0.8, hPx).fill(mix(sh.base, sh.shade, 0.5));
  g.rect(-hw, -hPx, hw * 0.5, hPx).fill(sh.lit);
  g.rect(-hw, -hPx, hw * 2, hPx).stroke({ width: 1.5, color: sh.outline, alpha: 0.5 });
  // Crenellated cap (wider than shaft).
  const capH = r * 0.4;
  g.rect(-hw * 1.25, -hPx - capH, hw * 2.5, capH).fill(sh.lit).stroke({ width: 1.5, color: sh.outline, alpha: 0.6 });
  for (let i = -1; i <= 1; i++) {
    g.rect(i * hw * 0.85 - hw * 0.22, -hPx - capH - r * 0.22, hw * 0.44, r * 0.24).fill(sh.base);
  }
  // Team accent band mid-shaft.
  g.rect(-hw, -hPx * 0.55, hw * 2, hPx * 0.12).fill({ color: trim, alpha: 0.95 });
}

function drawMarket(g: Graphics, r: number, hPx: number, trim: number): void {
  // Four-post stall frame (timber) under a striped awning tent.
  const sh = shade(TIMBER);
  const postX = r * 0.72;
  for (const sx of [-postX, postX]) {
    g.rect(sx - r * 0.06, -hPx * 0.7, r * 0.12, hPx * 0.7).fill(sh.base);
  }
  // Counter.
  g.rect(-postX, -hPx * 0.34, postX * 2, hPx * 0.16).fill(sh.shade).stroke({ width: 1, color: TIMBER_DARK, alpha: 0.7 });
  // Striped peaked awning: alternating trim / canvas panels.
  const peakY = -hPx;
  const eaveY = -hPx * 0.7;
  const panels = 4;
  for (let i = 0; i < panels; i++) {
    const x0 = -postX + (i * postX * 2) / panels;
    const x1 = -postX + ((i + 1) * postX * 2) / panels;
    const col = i % 2 === 0 ? trim : CANVAS_LIGHT;
    g.poly([x0, eaveY, x1, eaveY, (x0 + x1) / 2, peakY]).fill({ color: col, alpha: 0.92 });
  }
  // Awning ridge highlight.
  g.moveTo(-postX, eaveY).lineTo(postX, eaveY).stroke({ width: 1.5, color: scale(CANVAS_LIGHT, 1.1), alpha: 0.7 });
  // Gold coin sign on a short post (small detail).
  const signX = postX * 0.95;
  g.moveTo(signX, -hPx * 0.34).lineTo(signX, -hPx * 1.02).stroke({ width: 2.5, color: TIMBER_DARK });
  g.circle(signX, -hPx * 1.08, r * 0.16).fill(GOLD).stroke({ width: 1.5, color: scale(GOLD, 0.7) });
}

function drawDrydock(g: Graphics, r: number, hPx: number, trim: number): void {
  // Low cradle: two parallel rails on the water + upright braces + wrench mark.
  const railTop = shade(STONE);
  for (const ry of [-r * 0.42, r * 0.34]) {
    g.rect(-r * 0.95, ry, r * 1.9, r * 0.2 * FORESHORTEN)
      .fill(railTop.base)
      .stroke({ width: 1.5, color: trim, alpha: 0.8 });
  }
  // Cradle braces standing up (short — repair is a low structure).
  const cm = scale(METAL, 1.0);
  for (let i = -2; i <= 2; i++) {
    const x = i * r * 0.38;
    g.rect(x - r * 0.05, -hPx, r * 0.1, hPx).fill(cm);
    g.rect(x - r * 0.05, -hPx, r * 0.1, hPx).stroke({ width: 1, color: METAL_DARK, alpha: 0.6 });
  }
  // Cross beam.
  g.rect(-r * 0.85, -hPx, r * 1.7, r * 0.14).fill(shade(METAL).lit);
  // Wrench/gear accent (the repair tell), small, on top.
  g.circle(0, -hPx - r * 0.22, r * 0.2).stroke({ width: 3, color: GOLD });
  g.circle(0, -hPx - r * 0.22, r * 0.08).fill(GOLD);
}

function drawGantry(g: Graphics, r: number, hPx: number, trim: number): void {
  // Concrete base block (low) + inclined launch rail + a missile on the rail.
  const base = shade(STONE_DARK);
  g.rect(-r * 0.75, -hPx * 0.4, r * 1.5, hPx * 0.4 + r * 0.3 * FORESHORTEN).fill(base.base).stroke({
    width: 1.5,
    color: trim,
    alpha: 0.85,
  });
  // Inclined rail (metal) from lower-left to upper-right.
  const cm = scale(METAL, 1.0);
  g.moveTo(-r * 0.55, -hPx * 0.2).lineTo(r * 0.7, -hPx).stroke({ width: 6, color: cm });
  g.moveTo(-r * 0.55, -hPx * 0.05).lineTo(r * 0.7, -hPx * 0.85).stroke({ width: 3, color: METAL_DARK });
  // Missile body riding the rail, nose up-right, with a team-trim warhead.
  const mx = r * 0.35;
  const my = -hPx * 0.62;
  // Use shadeFace so the cylinder lights from the top-left consistently.
  g.ellipse(mx, my, r * 0.34, r * 0.13).fill(shadeFace(CANVAS_LIGHT, -0.4, -0.9)).stroke({
    width: 1,
    color: METAL_DARK,
    alpha: 0.7,
  });
  g.poly([mx + r * 0.3, my - r * 0.05, mx + r * 0.5, my - r * 0.18, mx + r * 0.28, my - r * 0.16]).fill(trim);
  // Fins.
  g.poly([mx - r * 0.28, my, mx - r * 0.42, my - r * 0.12, mx - r * 0.2, my - r * 0.06]).fill(METAL_DARK);
}

function drawDepot(g: Graphics, r: number, hPx: number, trim: number): void {
  // Generic supply block + gabled roof + trim door.
  const sh = shade(STONE);
  const hw = r * 0.7;
  const side = hw * 0.22;
  g.poly([hw, 0, hw + side, -side * 0.6, hw + side, -hPx - side * 0.6, hw, -hPx]).fill(sh.shade);
  g.rect(-hw, -hPx, hw * 2, hPx).fill(sh.base).stroke({ width: 1.5, color: sh.outline, alpha: 0.5 });
  g.poly([-hw, -hPx, 0, -hPx - hw * 0.6, hw, -hPx]).fill(sh.lit);
  // Trim door.
  g.rect(-hw * 0.35, -hPx * 0.6, hw * 0.7, hPx * 0.6).fill({ color: trim, alpha: 0.9 });
}

/**
 * Draw the body (steps 3-5: beveled body + trim + upright detail) into `g`,
 * where `g`'s local origin is the structure's waterline base and -y is up. The
 * caller has already raised this graphic by the height offset, so features
 * here are in screen px relative to the base. `hPx` is the standing height in
 * screen px (footprint-derived, NOT a raw world offset — that is the giant-flag
 * fix). Exposed for tests of the dispatch (every role draws without throwing).
 */
export function drawStructureBody(
  g: Graphics,
  role: StructureRole,
  r: number,
  hPx: number,
  team: TeamId | null,
  nowMs: number,
): void {
  const trim = trimColor(team);
  switch (structureSilhouette(role)) {
    case 'keep':
      drawKeep(g, r, hPx, trim, nowMs);
      break;
    case 'harbor':
      drawHarbor(g, r, hPx, trim);
      break;
    case 'watchtower':
      drawWatchtower(g, r, hPx, trim);
      break;
    case 'market':
      drawMarket(g, r, hPx, trim);
      break;
    case 'drydock':
      drawDrydock(g, r, hPx, trim);
      break;
    case 'gantry':
      drawGantry(g, r, hPx, trim);
      break;
    case 'depot':
      drawDepot(g, r, hPx, trim);
      break;
  }
}

// ===========================================================================
// drawStructure — the gallery-facing static composer.
// ===========================================================================

/**
 * Build the full layered structure (shadow + footprint + raised beveled body)
 * into `target` at a fixed reference zoom (1). Used by the render gallery to
 * show every role to scale with NO match running. The live world layer
 * (world.ts) does the same composition but pools the parts; this is the simple
 * all-at-once form.
 *
 * Coordinate note: the returned graphics are in screen px at zoom 1 around a
 * local origin at the structure's waterline. The gallery positions `target`
 * via the camera and may scale it by a display zoom.
 */
export function drawStructure(
  target: Container,
  role: StructureRole,
  team: TeamId | null,
  nowMs = 0,
): void {
  const r = structureRadius(role);
  const height = structureHeight(role);
  const hPx = heightOffsetPx(height, 1);

  const shadow = new Graphics();
  drawDropShadow(shadow, r, height);

  const footprint = new Graphics();
  drawFootprint(footprint, r, team);

  const body = new Graphics();
  drawStructureBody(body, role, r, hPx, team, nowMs);

  target.addChild(shadow, footprint, body);
}
