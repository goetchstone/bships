/**
 * THE shared visual system for the procedural pseudo-3D renderer
 * (docs/DESIGN.md "Art direction", packages/client/docs/RENDER.md).
 *
 * One source of truth for: the palette (team colors, water depth ramp,
 * structure/UI colors — all dark-mode-safe), the pseudo-3D lighting/shadow
 * constants, color helpers (bevel/shade/mix/scale), and the per-ship-class
 * SHAPE SPEC (a drawing recipe per ship typeId so all 18 classes read as
 * distinct vessels). NO pixi.js and NO DOM imports — everything here is pure
 * data + math, unit-testable in plain node. The actual drawing lives in the
 * render-world / render-units / render-fx modules that consume this file.
 *
 * Coordinate reminder (binding, docs/ARCH.md): world is +x east, +y north;
 * screen is Pixi y-down; the camera squashes the world plane vertically by
 * FORESHORTEN. "Up" on screen (toward -screenY) is therefore both "north" and
 * "higher off the water" — the pseudo-3D height model in depth.ts maps an
 * object's HEIGHT to an upward screen offset, and the shadow goes the other
 * way (down/south-east of the object). Light comes from the top-left.
 */

import type { TeamId } from '@bships/core';

import { FORESHORTEN } from './viz.js';

export { FORESHORTEN };

// ===========================================================================
// PALETTE — dark-mode-safe; team hues mirror index.html --team-south/north.
// ===========================================================================

/**
 * Team colors. These MUST match the HUD CSS (`--team-south`/`--team-north`)
 * so a unit's canvas color and its minimap/scoreboard color agree. South is
 * warm red, north cool blue — unmistakable at gameplay zoom.
 */
export const TEAM_COLOR: Record<TeamId, number> = {
  south: 0xff5c5c,
  north: 0x5c8aff,
};

/** Neutral (unowned shops, creep-empire structures): warm parchment gray. */
export const NEUTRAL_COLOR = 0xc8bda0;

/** Gold accent (royal trim, level-up, currency cues) — mirrors --gold. */
export const GOLD = 0xf2c14e;

/**
 * Water depth ramp, shallowest (coast) -> deepest (open sea). The world
 * renderer interpolates along this by a per-pixel/per-band "depth" value so
 * the sea reads as layered rather than a single flat fill. All cool navies,
 * tuned to sit darker than every unit so hulls pop.
 */
export const WATER_RAMP: readonly number[] = [
  0x123a52, // shallow / near coast
  0x0e2f46, // mid
  0x0a2438, // deep (matches the old WATER_DEEP baseline)
  0x07182a, // abyss / map edge
];

/** Foam / wave-crest highlight stroked on the lighter water bands. */
export const WATER_FOAM = 0xbfe3ff;

/** Coastline / shoal tint where land would meet water (procedural islands). */
export const COAST_SAND = 0x8a7a55;
export const COAST_ROCK = 0x4a5560;

/** Map-edge abyss vignette fill (outside playable bounds). */
export const ABYSS = 0x04101c;

/** Masonry for stone structures (towers, HQ keep), lit/shadow derived. */
export const STONE = 0x6a7a8c;
export const STONE_DARK = 0x3a4a5c;

/** Timber for piers / docks / shop frames. */
export const TIMBER = 0x6b5234;
export const TIMBER_DARK = 0x4a3a26;

/** Canvas/awning neutral (shop tents). */
export const CANVAS_LIGHT = 0xe8e0cc;

/** Metal (cranes, missile rails, hardware). */
export const METAL = 0x9aa4ad;
export const METAL_DARK = 0x5a646d;

/** Generic UI ink colors mirrored from index.html for canvas-drawn labels. */
export const INK = 0xd8e6f2;
export const INK_DIM = 0x7d96ab;
export const INK_OUTLINE = 0x06121f;

// ---------------------------------------------------------------------------
// HP bar palette (re-exported here so all modules share one source).
// ---------------------------------------------------------------------------

export const HP_GREEN = 0x52d273;
export const HP_YELLOW = 0xe8c84e;
export const HP_RED = 0xe0524e;
export const HP_BACK = 0x06121f;

// ===========================================================================
// PSEUDO-3D CONSTANTS — one consistent light, one consistent shadow.
// ===========================================================================

/**
 * Light direction in SCREEN space (unit vector, y-down). Top-left key light:
 * surfaces facing up-left are lit, down-right are shadowed. Every bevel in
 * the renderer derives its lit/shadow placement from this single vector so
 * the whole scene reads as one coherent diorama.
 */
export const LIGHT_DIR = { x: -0.55, y: -0.83 } as const;

/** Lit-face brightening / shadow-face darkening factors for bevels. */
export const BEVEL_LIT = 1.28;
export const BEVEL_SHADE = 0.62;

/** Ambient floor so shadowed faces never go pure black (keeps team hue). */
export const AMBIENT = 0.42;

/**
 * Drop-shadow on the water under every unit/structure. Offset is in SCREEN
 * px BEFORE the camera zoom (renderers multiply by zoom). It points opposite
 * the light (down-right) and is small for low things, scaled up by height
 * via depth.ts. The shadow ellipse is foreshortened like the water plane.
 */
export const SHADOW = {
  /** Base screen-px offset of the shadow center from the footprint center. */
  offsetX: 6,
  offsetY: 7,
  /** Opacity of the shadow fill (multiplied down for tall thin things). */
  alpha: 0.34,
  /** Soft-edge blur radius hint (px) — renderers may apply a BlurFilter or
   *  approximate with a second fainter ellipse; 0 disables. */
  blur: 4,
  /** Shadow color (cool, not pure black — reads as water absorbing light). */
  color: 0x05121e,
} as const;

/**
 * Height model reference. depth.ts converts an object's logical HEIGHT (world
 * units "tall") into an upward screen-offset and a shadow stretch. The
 * reference height is the height that produces an offset of exactly its own
 * value at zoom 1 (i.e. a 1:1 calibration anchor); tune in one place.
 */
export const HEIGHT_REF = 100;

/**
 * Fraction of an object's height that becomes an UPWARD screen offset of its
 * visual top (the "standing up" cue). 0 = flat decal on the water, 1 = full
 * height projects straight up. 0.62 reads as a believable ~3/4 camera tilt
 * without towers detaching from their footprints.
 */
export const HEIGHT_TO_SCREEN = 0.62;

// ===========================================================================
// COLOR HELPERS — pure, channel math on 0xRRGGBB integers.
// ===========================================================================

function ch(c: number, shift: number): number {
  return (c >> shift) & 0xff;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function pack(r: number, g: number, b: number): number {
  return (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);
}

/** Linear RGB mix of two colors, t in [0,1] (t=0 -> a, t=1 -> b). */
export function mix(a: number, b: number, t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return pack(
    ch(a, 16) + (ch(b, 16) - ch(a, 16)) * u,
    ch(a, 8) + (ch(b, 8) - ch(a, 8)) * u,
    ch(a, 0) + (ch(b, 0) - ch(a, 0)) * u,
  );
}

/** Multiply all channels by `f` (f<1 darken, f>1 brighten), clamped. */
export function scale(c: number, f: number): number {
  return pack(ch(c, 16) * f, ch(c, 8) * f, ch(c, 0) * f);
}

/** Perceptual luminance of a color in [0,255]. */
export function luminance(c: number): number {
  return 0.299 * ch(c, 16) + 0.587 * ch(c, 8) + 0.114 * ch(c, 0);
}

/** Mix toward the color's own gray; t=1 fully desaturated. */
export function desaturate(c: number, t: number): number {
  const l = clamp255(luminance(c));
  return mix(c, pack(l, l, l), t);
}

/**
 * Sample the water depth ramp at depth01 in [0,1] (0 = shallow, 1 = abyss).
 * Linear between adjacent ramp stops — the world layer uses this so deeper
 * water grades darker.
 */
export function waterAt(depth01: number): number {
  const ramp = WATER_RAMP;
  const last = ramp.length - 1;
  const t = (depth01 < 0 ? 0 : depth01 > 1 ? 1 : depth01) * last;
  const i = Math.min(last - 1, Math.floor(t));
  return mix(ramp[i] ?? ramp[0]!, ramp[i + 1] ?? ramp[last]!, t - i);
}

// ---------------------------------------------------------------------------
// BEVEL / SHADE — given a base color, return the consistently-lit variants a
// renderer needs for a faux-3D solid: a top (lit) face, a side (shadow) face,
// and an outline. `facing01` (the dot of a face normal with LIGHT_DIR mapped
// to [0,1]) lets callers shade an arbitrary face; the named helpers cover the
// common top/side/outline cases so units & structures stay coherent.
// ---------------------------------------------------------------------------

export interface Shaded {
  /** Brightest, sun-facing face (deck tops, tower caps). */
  lit: number;
  /** Mid base tone (the object's "true" color in even light). */
  base: number;
  /** Shadowed face (hull sides facing away from the light). */
  shade: number;
  /** Crisp outline a touch brighter than base for high-contrast legibility. */
  outline: number;
}

/** Full shaded set for a base color under the global top-left light. */
export function shade(base: number): Shaded {
  return {
    lit: scale(base, BEVEL_LIT),
    base,
    // Shadow face: darkened, then floored back toward base by AMBIENT so the
    // team hue survives in shadow (never crushes to black).
    shade: mix(scale(base, BEVEL_SHADE), base, AMBIENT),
    outline: scale(base, 1.12),
  };
}

/**
 * Shade an arbitrary face by its screen-space normal. `nx,ny` need not be
 * normalized. Returns a color between the shadow and lit variants of `base`
 * by how much the face points at the light. Used for procedural prisms.
 */
export function shadeFace(base: number, nx: number, ny: number): number {
  const len = Math.hypot(nx, ny) || 1;
  const d = (nx / len) * LIGHT_DIR.x + (ny / len) * LIGHT_DIR.y; // [-1,1]
  const t = (d + 1) / 2; // 0 = away from light, 1 = toward light
  const lo = scale(base, BEVEL_SHADE);
  const hi = scale(base, BEVEL_LIT);
  // Floor the dark side at AMBIENT of base so hue/team color survives.
  const floored = mix(lo, base, AMBIENT);
  return mix(floored, hi, t);
}

// ===========================================================================
// DROP-SHADOW HELPER — pure geometry; the renderer feeds the result to a
// foreshortened ellipse fill. Keeps the light/shadow direction in ONE place.
// ===========================================================================

export interface ShadowEllipse {
  /** Center offset from the object footprint, in SCREEN px at zoom 1. */
  dx: number;
  dy: number;
  /** Ellipse radii in SCREEN px at zoom 1 (ry already foreshortened). */
  rx: number;
  ry: number;
  alpha: number;
  color: number;
  blur: number;
}

/**
 * Drop-shadow geometry for an object whose on-water footprint radius is
 * `footprintR` (world units) and whose logical height is `height` (world
 * units). Taller objects throw a longer, fainter shadow offset further from
 * the base — the shared cue that the object stands above the water.
 *
 * Returned offsets/radii are at zoom 1; callers multiply by camera zoom. The
 * y-radius is pre-foreshortened (FORESHORTEN) so the shadow lies flat on the
 * squashed water plane.
 */
export function dropShadow(footprintR: number, height = 0): ShadowEllipse {
  const heightScale = 1 + (height / HEIGHT_REF) * 0.6;
  const rx = footprintR * 0.95;
  return {
    dx: SHADOW.offsetX * heightScale,
    dy: SHADOW.offsetY * heightScale,
    rx,
    ry: rx * FORESHORTEN,
    // Taller, longer shadows are a little fainter (light scatters).
    alpha: SHADOW.alpha / heightScale,
    color: SHADOW.color,
    blur: SHADOW.blur,
  };
}

// ===========================================================================
// SHIP SHAPE SPEC — the recipe table that makes all 18 classes distinct.
//
// render-units reads `shipShape(typeId, spec)` to get a SILHOUETTE FAMILY +
// modifiers, then draws procedurally. The family decides the hull outline and
// superstructure; the numeric modifiers (lengthScale, beam, masts, accents)
// distinguish ships WITHIN a family (e.g. a 9400g Flagship vs a 9800g one,
// the two Submarines, the four Cruisers) without a bespoke function each.
// ===========================================================================

/**
 * Silhouette families. Each is a clearly different hull/superstructure so a
 * glance reads the class. (Names map loosely to the Classic ship names.)
 */
export type ShipFamily =
  | 'skiff' // tiny starter Battle Ship / open boat: stubby, one short mast
  | 'trader' // Trade Boat / Merchant Boat: tubby cargo hull, crates, derrick
  | 'frigate' // mid Battle Ships: classic warship hull, single gun mast
  | 'goblin' // Goblin Ship: angular riveted plating, smokestack, gear
  | 'cruiser' // Cruisers: long sleek warship, twin turrets, bridge tower
  | 'submarine' // Submarines: slim cigar hull, conning tower, periscope
  | 'flagship' // Flagships: tall command vessel, bridge stack, three masts
  | 'leviathan' // Leviathian: organic beast hull, dorsal spines, maw
  | 'royal'; // Royal/Pirate Ship: ornate galleon, gold trim, big sails

/**
 * Drawing recipe for one ship. All sizes are MULTIPLIERS over the gold-tier
 * base length from viz.hullSize so the existing hit-test radius stays the
 * single source of footprint truth — render-units must size its silhouette to
 * the same `entityVisualRadius` it already gets, then apply these shape
 * ratios within that footprint.
 */
export interface ShipShape {
  family: ShipFamily;
  /** Beam (width) as a fraction of hull length (overrides the viz default). */
  beam: number;
  /** Number of masts/turrets/stacks the family draws (0 for subs). */
  masts: number;
  /** Superstructure height as a fraction of hull length (drives the bevel
   *  highlight band + the standing-up offset via depth.ts). */
  deckHeight: number;
  /** Gold trim accent (royal/flagship tells); null = no special accent. */
  accent: number | null;
  /** A short distinguishing-mark tag the renderer switches on for class
   *  flavor (e.g. 'gear', 'periscope', 'maw', 'crates'); '' = none. */
  mark: string;
}

/**
 * Per-typeId overrides keyed by the Classic rawcodes (data/json/ships.json).
 * Anything not listed falls back to a family chosen from the name/gold via
 * `familyFromSpec`. Keeping the explicit table small and documented makes the
 * 18 classes auditable; the fallback keeps unknown/modded ships sane.
 *
 *   H000 Battle Ship 200   (starter)      H006 Cruiser 2400
 *   H003 Battle Ship 1000                 H008 Cruiser 5000
 *   H001 Battle Ship 1000  (true sight)   H009 Cruiser 5000
 *   H004 Battle Ship 1200                 H00V Submarine 6000
 *   H00Y Goblin Ship 1250                 H00W Submarine 8500 (= submerged)
 *   H007 Cruiser 2200                     H00L Flagship 9400
 *   H00K Flagship 9800                    H00X Leviathian 13250
 *   H00A Royal Ship 14450                 H00C Pirate Ship 16000
 *   H00D Trade Boat 300                   H005 Merchant Boat 4525
 */
const SHIP_SHAPES: Record<string, ShipShape> = {
  // --- starter / battle line ----------------------------------------------
  H000: { family: 'skiff', beam: 0.4, masts: 1, deckHeight: 0.22, accent: null, mark: '' },
  H003: { family: 'frigate', beam: 0.44, masts: 1, deckHeight: 0.26, accent: null, mark: '' },
  H001: { family: 'frigate', beam: 0.44, masts: 1, deckHeight: 0.28, accent: null, mark: 'spotter' },
  H004: { family: 'frigate', beam: 0.46, masts: 2, deckHeight: 0.28, accent: null, mark: '' },
  // --- goblin --------------------------------------------------------------
  H00Y: { family: 'goblin', beam: 0.5, masts: 1, deckHeight: 0.32, accent: 0xc8e84e, mark: 'gear' },
  // --- cruisers ------------------------------------------------------------
  H007: { family: 'cruiser', beam: 0.4, masts: 2, deckHeight: 0.3, accent: null, mark: '' },
  H006: { family: 'cruiser', beam: 0.4, masts: 2, deckHeight: 0.3, accent: null, mark: '' },
  H008: { family: 'cruiser', beam: 0.42, masts: 3, deckHeight: 0.34, accent: null, mark: 'bridge' },
  H009: { family: 'cruiser', beam: 0.42, masts: 3, deckHeight: 0.36, accent: null, mark: 'bridge' },
  // --- submarines (H00W is also the submergedTypeId) -----------------------
  H00V: { family: 'submarine', beam: 0.3, masts: 0, deckHeight: 0.2, accent: null, mark: 'periscope' },
  H00W: { family: 'submarine', beam: 0.28, masts: 0, deckHeight: 0.18, accent: null, mark: 'periscope' },
  // --- flagships -----------------------------------------------------------
  H00L: { family: 'flagship', beam: 0.46, masts: 3, deckHeight: 0.46, accent: GOLD, mark: 'stack' },
  H00K: { family: 'flagship', beam: 0.46, masts: 3, deckHeight: 0.5, accent: GOLD, mark: 'stack' },
  // --- leviathan -----------------------------------------------------------
  H00X: { family: 'leviathan', beam: 0.54, masts: 0, deckHeight: 0.4, accent: 0x9fe06a, mark: 'maw' },
  // --- royals --------------------------------------------------------------
  H00A: { family: 'royal', beam: 0.48, masts: 3, deckHeight: 0.52, accent: GOLD, mark: 'crown' },
  H00C: { family: 'royal', beam: 0.5, masts: 3, deckHeight: 0.5, accent: GOLD, mark: 'jollyroger' },
  // --- traders -------------------------------------------------------------
  H00D: { family: 'trader', beam: 0.58, masts: 1, deckHeight: 0.3, accent: null, mark: 'crates' },
  H005: { family: 'trader', beam: 0.6, masts: 1, deckHeight: 0.34, accent: null, mark: 'derrick' },
};

/** The slice of a ship spec the shape table needs (matches viz.ShipDisplaySpec). */
export interface ShipShapeInput {
  name: string;
  gold: number;
  isSub: boolean;
}

/** Name/gold heuristic for ships with no explicit table entry (mods). */
export function familyFromSpec(spec: ShipShapeInput): ShipFamily {
  if (spec.isSub) return 'submarine';
  const n = spec.name.toLowerCase();
  if (n.includes('trade') || n.includes('merchant')) return 'trader';
  if (n.includes('goblin')) return 'goblin';
  if (n.includes('leviath')) return 'leviathan';
  if (n.includes('royal') || n.includes('pirate')) return 'royal';
  if (n.includes('flagship')) return 'flagship';
  if (n.includes('cruiser')) return 'cruiser';
  if (n.includes('submarine')) return 'submarine';
  if (spec.gold <= 300) return 'skiff';
  return 'frigate';
}

/** Default shape for a family (used when no explicit typeId entry exists). */
const FAMILY_DEFAULT: Record<ShipFamily, Omit<ShipShape, 'family'>> = {
  skiff: { beam: 0.5, masts: 1, deckHeight: 0.22, accent: null, mark: '' },
  trader: { beam: 0.58, masts: 1, deckHeight: 0.3, accent: null, mark: 'crates' },
  frigate: { beam: 0.44, masts: 1, deckHeight: 0.27, accent: null, mark: '' },
  goblin: { beam: 0.5, masts: 1, deckHeight: 0.32, accent: 0xc8e84e, mark: 'gear' },
  cruiser: { beam: 0.41, masts: 2, deckHeight: 0.32, accent: null, mark: 'bridge' },
  submarine: { beam: 0.29, masts: 0, deckHeight: 0.19, accent: null, mark: 'periscope' },
  flagship: { beam: 0.46, masts: 3, deckHeight: 0.48, accent: GOLD, mark: 'stack' },
  leviathan: { beam: 0.54, masts: 0, deckHeight: 0.4, accent: 0x9fe06a, mark: 'maw' },
  royal: { beam: 0.49, masts: 3, deckHeight: 0.51, accent: GOLD, mark: 'crown' },
};

/**
 * Resolve the drawing recipe for a ship typeId. Explicit table first, then a
 * name/gold-derived family default — so every one of the 18 Classic ships is
 * distinct AND any modded/unknown hull still gets a sane silhouette.
 */
export function shipShape(typeId: string, spec: ShipShapeInput): ShipShape {
  const explicit = SHIP_SHAPES[typeId];
  if (explicit !== undefined) return explicit;
  const family = familyFromSpec(spec);
  const d = FAMILY_DEFAULT[family];
  return { family, beam: d.beam, masts: d.masts, deckHeight: d.deckHeight, accent: d.accent, mark: d.mark };
}

/** All ship typeIds that have an explicit recipe (the gallery iterates this). */
export const SHIP_SHAPE_IDS: readonly string[] = Object.keys(SHIP_SHAPES);
