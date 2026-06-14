/**
 * Procedural ship SILHOUETTES — one routine per `ShipFamily` so all 18 Classic
 * classes (and any modded hull) read as distinct, recognizable vessels. Pure
 * pixi `Graphics` drawing: NO camera, NO match state, NO time — everything is
 * laid out in WORLD-unit space centered on the origin, **bow toward +x** (the
 * caller rotates by `-facing` and squashes by FORESHORTEN). The single light is
 * top-left (theme `LIGHT_DIR`); bevels come from `shade()` / `shadeFace()`.
 *
 * Split contract (so the live renderer can stand the superstructure UP off the
 * water while the hull stays flat on the squashed plane):
 *
 *   - `drawShipHull(g, d, opts)`  — waterline hull + deck + bright BOW WEDGE
 *     (the unambiguous facing cue). Draw this into the rotated+squashed plane.
 *   - `drawShipSuper(g, d, opts)` — masts / turrets / bridge / stack / class
 *     "mark" (gear, periscope, maw, crates, crown…). Draw this into the raised,
 *     upright superstructure group. Subs draw their conning tower here.
 *
 * The gallery + any static showcase calls `drawShip(g, typeId, team, opts)`,
 * which resolves the recipe and bakes BOTH layers into one Graphics (returning
 * the footprint radius) so it works with no `update()` having run.
 *
 * Sizes are derived from the SAME footprint radius `viz` reports for a typeId
 * (via `hullSize`), so what-you-see == what-you-click. `ShipShape` modifiers
 * (`beam`, `masts`, `deckHeight`, `accent`, `mark`) distinguish ships within a
 * family without a bespoke function each.
 */

import { Graphics } from 'pixi.js';
import type { TeamId } from '@bships/core';

import { GOLD, METAL, METAL_DARK, mix, scale, shade, shadeFace, shipShape } from './theme.js';
import type { ShipFamily, ShipShape } from './theme.js';
import { getCatalog } from '../catalog.js';
import { NEUTRAL_HEX, TEAM_HEX, hullSize } from './viz.js';

/** Resolved drawing inputs shared by the hull + superstructure routines. */
export interface ShipDrawData {
  shape: ShipShape;
  /** Hull color already adjusted for team + submerged dimming. */
  color: number;
  /** Hull half-length in world units (bow at +len, stern at -len). */
  len: number;
  /** Hull half-beam in world units. */
  beam: number;
  /** Footprint radius == len (matches viz.entityVisualRadius for ships). */
  footprintR: number;
  submerged: boolean;
}

export interface ShipDrawOpts {
  submerged?: boolean;
}

/** Team -> base hull hue (neutral parchment when teamless, e.g. previews). */
export function shipBaseColor(team: TeamId | null): number {
  return team === null ? NEUTRAL_HEX : TEAM_HEX[team];
}

/**
 * Resolve everything the hull/superstructure routines need for a ship typeId.
 * `units.ts` calls this once per redraw (sig change) and feeds the result to
 * `drawShipHull` + `drawShipSuper`; the gallery uses it inside `drawShip`.
 */
export function resolveShipDraw(
  typeId: string,
  team: TeamId | null,
  opts: ShipDrawOpts = {},
): ShipDrawData {
  const catalog = getCatalog();
  const spec = catalog.ships[typeId];
  const gold = spec?.gold ?? 2400;
  const isSub = spec?.isSub ?? false;
  const name = spec?.name ?? '';
  const shape = shipShape(typeId, { name, gold, isSub });
  // viz.hullSize is the single source of footprint truth; the silhouette must
  // fit inside the same radius the hit-tester uses. We take its length and
  // apply the family beam ratio across the hull.
  const size = hullSize(gold, isSub);
  const len = size.length / 2;
  const beam = len * shape.beam;
  const submerged = opts.submerged === true;
  const teamColor = shipBaseColor(team);
  const color = submerged ? scale(teamColor, 0.6) : teamColor;
  return { shape, color, len, beam, footprintR: len, submerged };
}

// ===========================================================================
// Shared hull primitives. All in world units, bow at +x; the caller squashes.
// ===========================================================================

/**
 * A beveled hull body: dark waterline ring, base deck, then a lit deck inset.
 * `nose`/`tail` scale the bow/stern taper; `round` rounds the hull (traders).
 */
function bevelHull(
  g: Graphics,
  len: number,
  beam: number,
  color: number,
  o: { nose?: number; tail?: number; round?: boolean } = {},
): void {
  const l = len;
  const w = beam;
  const nose = o.nose ?? 1.08;
  const tail = o.tail ?? 0.82;
  const s = shade(color);

  if (o.round === true) {
    // Tubby cargo hull: an ellipse reads as a fat merchant boat.
    g.ellipse(0, 0, l, w * 1.05).fill(s.shade).stroke({ width: 3, color: s.outline });
    g.ellipse(-l * 0.12, -w * 0.12, l * 0.62, w * 0.62).fill({ color: s.lit, alpha: 0.92 });
  } else {
    // Pointed warship hull. The TOP edge (toward the light, -y) is the lit
    // strake; the BOTTOM edge is the shadow side — drawn as two fills.
    const hullPts = [
      l * nose, 0,
      l * 0.34, w,
      -l * tail, w * 0.82,
      -l * nose * 0.9, 0,
      -l * tail, -w * 0.82,
      l * 0.34, -w,
    ];
    g.poly(hullPts).fill(s.shade).stroke({ width: 3, color: s.outline });
    // Lit upper strake (the -y / top-left-facing side).
    g.poly([l * nose, 0, l * 0.34, -w, -l * tail, -w * 0.82, -l * nose * 0.9, 0])
      .fill({ color: shadeFace(color, 0, -1), alpha: 0.95 });
    // Deck inset (mid tone) so the rim reads as a raised gunwale.
    g.poly([
      l * 0.74, 0,
      l * 0.22, w * 0.62,
      -l * 0.72, w * 0.5,
      -l * 0.72, -w * 0.5,
      l * 0.22, -w * 0.62,
    ]).fill({ color: s.base, alpha: 0.95 });
  }
}

/**
 * The bow prow — the unambiguous "this way is forward" cue. A lit wedge of the
 * hull colour (not a stark white cap, which reads as a crayon tip) with a crisp
 * bright leading edge and a small foam spray right at the cutwater.
 */
function bowWedge(g: Graphics, len: number, beam: number, frac = 0.5, color = 0x9fb4c8): void {
  const s = shade(color);
  // Raised fore-deck: brighter hull colour, pointed.
  g.poly([len * 1.05, 0, len * frac, beam * 0.4, len * frac, -beam * 0.4]).fill({
    color: shadeFace(color, 0, -1),
    alpha: 0.96,
  });
  // Crisp lit gunwale edges catching the light, meeting at the prow.
  g.poly([len * 1.05, 0, len * frac, -beam * 0.4, len * (frac + 0.06), -beam * 0.34, len * 0.98, 0])
    .fill({ color: s.lit, alpha: 0.95 });
  // A sliver of bow foam at the cutwater — the only near-white, and tiny.
  g.poly([len * 1.06, 0, len * 0.9, beam * 0.16, len * 0.9, -beam * 0.16]).fill({
    color: 0xeef4fb,
    alpha: 0.85,
  });
}

/** A round mast / turret base, bevel-lit. */
function mast(g: Graphics, x: number, r: number, color: number, accent?: number): void {
  const s = shade(color);
  // Shadow disc offset down-right, then the lit cap up-left -> reads round.
  g.circle(x + r * 0.18, r * 0.18, r).fill(s.shade);
  g.circle(x, 0, r).fill(s.base).stroke({ width: 2, color: accent ?? s.outline });
  g.circle(x - r * 0.32, -r * 0.32, r * 0.5).fill({ color: s.lit, alpha: 0.9 });
}

/** A boxy bridge/superstructure block, bevel-lit (cruiser/flagship bridges). */
function bridgeBox(
  g: Graphics,
  x: number,
  halfLen: number,
  halfW: number,
  color: number,
): void {
  const s = shade(color);
  g.rect(x - halfLen, -halfW, halfLen * 2, halfW * 2).fill(s.base).stroke({
    width: 2,
    color: s.outline,
  });
  // Lit top-left corner band.
  g.rect(x - halfLen, -halfW, halfLen * 2, halfW * 0.6).fill({ color: s.lit, alpha: 0.85 });
  g.rect(x - halfLen, -halfW, halfLen * 0.6, halfW * 2).fill({ color: s.lit, alpha: 0.5 });
}

// ===========================================================================
// Per-family HULL routines (flat on the water plane).
// ===========================================================================

function hullSkiff(g: Graphics, d: ShipDrawData): void {
  // Sharp-bowed little gunboat (longer nose, narrower stern) so it reads as a
  // boat, not a gem, even foreshortened.
  bevelHull(g, d.len, d.beam, d.color, { nose: 1.18, tail: 0.7 });
  bowWedge(g, d.len, d.beam, 0.44, d.color);
}

function hullTrader(g: Graphics, d: ShipDrawData): void {
  bevelHull(g, d.len, d.beam, d.color, { round: true });
  bowWedge(g, d.len, d.beam, 0.5, d.color);
}

function hullFrigate(g: Graphics, d: ShipDrawData): void {
  bevelHull(g, d.len, d.beam, d.color, { nose: 1.1, tail: 0.84 });
  bowWedge(g, d.len, d.beam, 0.52, d.color);
}

function hullGoblin(g: Graphics, d: ShipDrawData): void {
  // Angular riveted plating: a chunkier hull with a notched stern.
  const l = d.len;
  const w = d.beam;
  const s = shade(d.color);
  g.poly([l * 1.0, 0, l * 0.4, w, -l * 0.5, w, -l * 0.85, w * 0.4, -l * 0.85, -w * 0.4, -l * 0.5, -w, l * 0.4, -w])
    .fill(s.shade)
    .stroke({ width: 3, color: s.outline });
  g.poly([l * 1.0, 0, l * 0.4, -w, -l * 0.5, -w, -l * 0.85, -w * 0.4])
    .fill({ color: shadeFace(d.color, 0, -1), alpha: 0.95 });
  // Riveted plate seams (the goblin-yellow trim is applied in the super mark).
  for (let i = -1; i <= 1; i++) {
    g.moveTo(i * l * 0.32, -w * 0.85).lineTo(i * l * 0.32, w * 0.85).stroke({
      width: 1.5,
      color: scale(d.color, 0.4),
      alpha: 0.8,
    });
  }
  bowWedge(g, d.len, d.beam, 0.5, d.color);
}

function hullCruiser(g: Graphics, d: ShipDrawData): void {
  // Long sleek warship: a slimmer, longer-nosed hull.
  bevelHull(g, d.len, d.beam, d.color, { nose: 1.16, tail: 0.9 });
  bowWedge(g, d.len, d.beam, 0.56, d.color);
}

function hullSubmarine(g: Graphics, d: ShipDrawData): void {
  // Slim cigar; darker + lower contrast when submerged.
  const l = d.len;
  const w = d.beam;
  const s = shade(d.color);
  const body = d.submerged ? scale(s.shade, 0.85) : s.shade;
  g.ellipse(0, 0, l, w).fill(body).stroke({ width: 3, color: s.outline });
  if (!d.submerged) {
    g.ellipse(-l * 0.1, -w * 0.25, l * 0.6, w * 0.45).fill({ color: s.lit, alpha: 0.7 });
  }
  bowWedge(g, d.len, d.beam, 0.62, d.color);
}

function hullFlagship(g: Graphics, d: ShipDrawData): void {
  bevelHull(g, d.len, d.beam, d.color, { nose: 1.12, tail: 0.88 });
  // Gold gunwale trim — the command-vessel tell.
  if (d.shape.accent !== null) {
    g.poly([d.len * 1.12, 0, d.len * 0.34, d.beam, -d.len * 0.79, 0, d.len * 0.34, -d.beam]).stroke({
      width: 2,
      color: d.shape.accent,
      alpha: 0.85,
    });
  }
  bowWedge(g, d.len, d.beam, 0.52, d.color);
}

function hullLeviathan(g: Graphics, d: ShipDrawData): void {
  // Organic beast hull: wider, with a rounded back and a pointed snout.
  const l = d.len;
  const w = d.beam;
  const s = shade(d.color);
  g.poly([l * 1.18, 0, l * 0.5, w * 0.9, -l * 0.3, w, -l * 0.95, w * 0.5, -l * 1.05, 0, -l * 0.95, -w * 0.5, -l * 0.3, -w, l * 0.5, -w * 0.9])
    .fill(s.shade)
    .stroke({ width: 3, color: s.outline });
  g.poly([l * 1.18, 0, l * 0.5, -w * 0.9, -l * 0.3, -w, -l * 0.95, -w * 0.5, -l * 1.05, 0])
    .fill({ color: shadeFace(d.color, 0, -1), alpha: 0.92 });
  bowWedge(g, d.len, d.beam, 0.5, d.color);
}

function hullRoyal(g: Graphics, d: ShipDrawData): void {
  // Ornate galleon: high bow + stern castles.
  bevelHull(g, d.len, d.beam, d.color, { nose: 1.08, tail: 0.92 });
  const s = shade(d.color);
  // Raised stern castle deck.
  g.rect(-d.len * 0.85, -d.beam * 0.7, d.len * 0.32, d.beam * 1.4).fill(s.base).stroke({
    width: 2,
    color: d.shape.accent ?? s.outline,
  });
  bowWedge(g, d.len, d.beam, 0.5, d.color);
}

const HULL_ROUTINES: Record<ShipFamily, (g: Graphics, d: ShipDrawData) => void> = {
  skiff: hullSkiff,
  trader: hullTrader,
  frigate: hullFrigate,
  goblin: hullGoblin,
  cruiser: hullCruiser,
  submarine: hullSubmarine,
  flagship: hullFlagship,
  leviathan: hullLeviathan,
  royal: hullRoyal,
};

// ===========================================================================
// Per-family SUPERSTRUCTURE routines (raised + upright off the water).
//
// These draw masts/bridges/marks. They are kept LIGHTER than the hull so when
// the renderer raises this group it reads as detail standing above the deck.
// ===========================================================================

function drawMark(g: Graphics, d: ShipDrawData): void {
  const l = d.len;
  const w = d.beam;
  const accent = d.shape.accent ?? GOLD;
  switch (d.shape.mark) {
    case 'gear':
      // Goblin gear: a cog ring near the stack.
      g.circle(-l * 0.1, 0, w * 0.34).stroke({ width: 3, color: accent });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.circle(-l * 0.1 + Math.cos(a) * w * 0.34, Math.sin(a) * w * 0.34, w * 0.07).fill(accent);
      }
      break;
    case 'spotter':
      // True-sight spotter: a small green lens forward.
      g.circle(l * 0.5, 0, w * 0.18).fill(0x7fe0a0).stroke({ width: 1.5, color: 0x1c4030 });
      break;
    case 'crates':
      // Trade boat cargo: stacked crates amidships.
      for (let i = 0; i < 3; i++) {
        const cx = -l * 0.1 + (i - 1) * w * 0.5;
        g.rect(cx - w * 0.22, -w * 0.22, w * 0.44, w * 0.44)
          .fill(0x9c7a44)
          .stroke({ width: 1.5, color: 0x5c4426 });
      }
      break;
    case 'derrick':
      // Merchant derrick: a cargo crane arm.
      g.moveTo(l * 0.1, 0).lineTo(l * 0.1, -w * 1.0).stroke({ width: 3, color: METAL });
      g.moveTo(l * 0.1, -w * 1.0).lineTo(l * 0.6, -w * 0.6).stroke({ width: 2.5, color: METAL });
      g.moveTo(l * 0.6, -w * 0.6).lineTo(l * 0.6, -w * 0.2).stroke({ width: 1, color: METAL_DARK });
      break;
    case 'maw':
      // Leviathan maw: jagged teeth at the snout + dorsal spines.
      g.poly([l * 1.16, 0, l * 0.86, w * 0.34, l * 0.86, -w * 0.34]).fill(0xf2efe0);
      for (let i = 0; i < 3; i++) {
        g.poly([l * 0.95 - i * w * 0.3, w * 0.28, l * 0.88 - i * w * 0.3, w * 0.02, l * 0.81 - i * w * 0.3, w * 0.28]).fill(0xffffff);
      }
      for (let i = -2; i <= 2; i++) {
        const x = i * l * 0.26;
        g.poly([x - w * 0.18, 0, x, -w * 0.85, x + w * 0.18, 0]).fill(scale(d.color, 1.18));
      }
      break;
    case 'crown':
      // Royal crown emblem at the stern castle.
      g.poly([-l * 0.7, -w * 0.2, -l * 0.62, -w * 0.5, -l * 0.55, -w * 0.2, -l * 0.48, -w * 0.5, -l * 0.4, -w * 0.2])
        .fill(GOLD)
        .stroke({ width: 1, color: 0x8a6a18 });
      break;
    case 'jollyroger':
      // Pirate flag: a small skull banner at the mainmast top.
      g.rect(-l * 0.02, -w * 1.5, w * 0.7, w * 0.46).fill(0x14110e).stroke({ width: 1, color: GOLD });
      g.circle(l * 0.16, -w * 1.27, w * 0.1).fill(0xe8e0cc);
      break;
    case 'periscope':
      if (!d.submerged) {
        g.moveTo(-l * 0.1, 0).lineTo(-l * 0.1, -w * 0.9).stroke({ width: 2.5, color: METAL });
        g.moveTo(-l * 0.1, -w * 0.9).lineTo(l * 0.1, -w * 0.9).stroke({ width: 2.5, color: METAL });
      }
      break;
    case 'bridge':
    case 'stack':
    case '':
    default:
      break;
  }
}

function superMasts(g: Graphics, d: ShipDrawData, positions: number[]): void {
  const r = d.beam * 0.3;
  const accent = d.shape.accent;
  for (const x of positions) {
    mast(g, x * d.len, r, scale(d.color, 1.05), accent ?? undefined);
  }
}

function superSkiff(g: Graphics, d: ShipDrawData): void {
  // A small aft deckhouse + a forward gun mast: enough structure that the
  // starter boat reads as a vessel rather than a bare hull.
  bridgeBox(g, -d.len * 0.22, d.len * 0.22, d.beam * 0.62, scale(d.color, 0.92));
  superMasts(g, d, [0.28]);
  drawMark(g, d);
}

function superTrader(g: Graphics, d: ShipDrawData): void {
  superMasts(g, d, [d.shape.mark === 'derrick' ? -0.35 : 0.3]);
  drawMark(g, d);
}

function superFrigate(g: Graphics, d: ShipDrawData): void {
  const xs = d.shape.masts >= 2 ? [0.2, -0.3] : [-0.05];
  superMasts(g, d, xs);
  drawMark(g, d);
}

function superGoblin(g: Graphics, d: ShipDrawData): void {
  // Smokestack + gear.
  const s = shade(scale(d.color, 0.9));
  g.rect(-d.len * 0.42, -d.beam * 0.42, d.beam * 0.5, d.beam * 0.84).fill(s.base).stroke({
    width: 2,
    color: s.outline,
  });
  g.ellipse(-d.len * 0.42 + d.beam * 0.25, -d.beam * 0.42, d.beam * 0.25, d.beam * 0.12).fill(0x2a2a2a);
  drawMark(g, d);
}

function superCruiser(g: Graphics, d: ShipDrawData): void {
  // Central bridge tower + fore/aft turrets.
  bridgeBox(g, -d.len * 0.05, d.len * 0.18, d.beam * 0.7, scale(d.color, 0.95));
  superMasts(g, d, [0.45, -0.5]);
  if (d.shape.masts >= 3) superMasts(g, d, [0.0]);
  drawMark(g, d);
}

function superFlagship(g: Graphics, d: ShipDrawData): void {
  // Tall command bridge stack + three masts + gold.
  bridgeBox(g, -d.len * 0.05, d.len * 0.22, d.beam * 0.78, scale(d.color, 0.95));
  // Funnel stack.
  const sc = shade(scale(d.color, 0.8));
  g.rect(-d.len * 0.3, -d.beam * 0.3, d.beam * 0.4, d.beam * 0.6).fill(sc.base).stroke({
    width: 2,
    color: sc.outline,
  });
  superMasts(g, d, [0.5, 0.05, -0.45]);
  if (d.shape.accent !== null) {
    // Gold command pennant atop the mainmast.
    g.rect(0.05 * d.len, -d.beam * 1.4, d.beam * 0.6, d.beam * 0.34).fill(d.shape.accent);
    g.moveTo(0.05 * d.len, 0).lineTo(0.05 * d.len, -d.beam * 1.4).stroke({ width: 2, color: METAL });
  }
  drawMark(g, d);
}

function superSubmarine(g: Graphics, d: ShipDrawData): void {
  // Conning tower fin (the sub's only superstructure), + periscope.
  if (!d.submerged) {
    const s = shade(scale(d.color, 0.95));
    g.poly([
      -d.len * 0.28, -d.beam * 0.9,
      d.len * 0.18, -d.beam * 0.9,
      d.len * 0.08, d.beam * 0.9,
      -d.len * 0.28, d.beam * 0.9,
    ])
      .fill(s.base)
      .stroke({ width: 2, color: s.outline });
  }
  drawMark(g, d);
}

function superLeviathan(g: Graphics, d: ShipDrawData): void {
  // Beast: spines + maw handled by the mark; eyes glow.
  drawMark(g, d);
  const eye = mix(d.shape.accent ?? 0x9fe06a, 0xffffff, 0.3);
  g.circle(d.len * 0.62, -d.beam * 0.3, d.beam * 0.12).fill(eye);
  g.circle(d.len * 0.62, d.beam * 0.3, d.beam * 0.12).fill(eye);
}

function superRoyal(g: Graphics, d: ShipDrawData): void {
  // Three big masts with sails + gold trim + crown/jolly-roger mark.
  const xs = [0.4, 0.05, -0.35];
  const s = shade(0xf0ead6);
  for (const x of xs) {
    const px = x * d.len;
    g.moveTo(px, d.beam * 0.4).lineTo(px, -d.beam * 1.3).stroke({ width: 3, color: 0x6b5234 });
    // Furled-ish sail.
    g.ellipse(px, -d.beam * 0.55, d.beam * 0.42, d.beam * 0.7).fill({ color: s.base, alpha: 0.92 }).stroke({
      width: 1.5,
      color: s.shade,
    });
    g.ellipse(px - d.beam * 0.12, -d.beam * 0.7, d.beam * 0.2, d.beam * 0.3).fill({ color: s.lit, alpha: 0.6 });
  }
  if (d.shape.accent !== null) {
    g.poly([d.len * 1.08, 0, d.len * 0.34, d.beam, -d.len * 0.82, 0, d.len * 0.34, -d.beam]).stroke({
      width: 2,
      color: d.shape.accent,
      alpha: 0.85,
    });
  }
  drawMark(g, d);
}

const SUPER_ROUTINES: Record<ShipFamily, (g: Graphics, d: ShipDrawData) => void> = {
  skiff: superSkiff,
  trader: superTrader,
  frigate: superFrigate,
  goblin: superGoblin,
  cruiser: superCruiser,
  submarine: superSubmarine,
  flagship: superFlagship,
  leviathan: superLeviathan,
  royal: superRoyal,
};

// ===========================================================================
// Public draw API.
// ===========================================================================

/** Draw the flat-on-water hull (caller rotates -facing, squashes FORESHORTEN). */
export function drawShipHull(g: Graphics, d: ShipDrawData): void {
  HULL_ROUTINES[d.shape.family](g, d);
}

/** Draw the upright superstructure (caller raises it by the height offset). */
export function drawShipSuper(g: Graphics, d: ShipDrawData): void {
  SUPER_ROUTINES[d.shape.family](g, d);
}

/**
 * Bake the full ship (hull + superstructure) into one Graphics and return the
 * footprint radius. Gallery / static-preview entry point — works with no
 * `update()` having run. The live renderer uses `resolveShipDraw` +
 * `drawShipHull` / `drawShipSuper` separately so it can stand the super up.
 */
export function drawShip(
  g: Graphics,
  typeId: string,
  team: TeamId | null,
  opts: ShipDrawOpts = {},
): number {
  const d = resolveShipDraw(typeId, team, opts);
  drawShipHull(g, d);
  drawShipSuper(g, d);
  return d.footprintR;
}
