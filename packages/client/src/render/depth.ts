/**
 * Shared DEPTH + HEIGHT model for the pseudo-3D renderer
 * (packages/client/docs/RENDER.md "Depth model"). Pure math — NO pixi.js,
 * NO DOM — so it is unit-testable and the world / units / fx modules all
 * agree on (a) what draws in front of what, and (b) how "tall" an object
 * appears to stand off the water.
 *
 * Two jobs:
 *
 *  1. Y-SORT KEY. The renderer puts every world object in one container with
 *     `sortableChildren = true` and sets `zIndex = depthKey(worldY[, kind])`.
 *     Higher zIndex draws ON TOP. North is +y, which the camera flips to the
 *     top of the screen, so a more-northern object must draw BEHIND a more-
 *     southern one -> its zIndex must be LOWER -> the key is monotonic in
 *     -worldY. A small per-kind bias keeps unambiguous layering when two
 *     objects share a y (flat water decals < structures-on-water < units <
 *     airborne fx), without ever letting the bias swamp real y separation.
 *
 *  2. HEIGHT PROJECTION. An object with logical HEIGHT (world units tall)
 *     should have its visual top pushed UP the screen (toward -screenY) so it
 *     reads as standing up, while its FOOTPRINT/shadow stays on the water at
 *     the true world position. `heightOffsetPx(height, zoom)` returns that
 *     upward screen offset; the world/unit renderers translate a unit's
 *     "superstructure" group up by it and leave the footprint + drop shadow at
 *     the base. This is what fixes the "giant flag" class of bug: heights are
 *     converted through ONE calibrated mapping instead of each silhouette
 *     picking raw world-unit offsets that balloon with the footprint radius.
 */

import { HEIGHT_TO_SCREEN } from './theme.js';

/**
 * Per-kind z bias. Each band is multiplied by Y_SPAN below to occupy a slice
 * of the key space that is LARGE relative to ties but SMALL relative to the
 * full map height, so within a band pure y-order dominates and only exact-tie
 * y values fall back to the band order. Order: lowest draws first (behind).
 */
export type DepthKind =
  | 'waterDecal' // wakes, foam, coast splashes painted on the sea surface
  | 'shadow' // drop shadows (under everything they belong to)
  | 'structure' // buildings sit on the water
  | 'unit' // ships / creeps / summons / wards
  | 'airborne' // arcing projectiles, pillars, rising explosions
  | 'overlay'; // hp bars / labels / selection — always on top of their owner

const KIND_BIAS: Record<DepthKind, number> = {
  waterDecal: 0,
  shadow: 1,
  structure: 2,
  unit: 3,
  airborne: 4,
  overlay: 5,
};

/**
 * Half-height of the playable world in y. The y-sort key is built so that one
 * full unit of worldY outweighs the entire per-kind bias band — i.e. y order
 * is authoritative and the bias only breaks exact ties. We scale worldY by a
 * factor far larger than the bias count so this always holds for the map's
 * ~15k-unit y span. Exposed for tests.
 */
export const Y_SCALE = 1000;

/**
 * Y-sort key for a world object. Larger = drawn in front (on top).
 *
 *   key = -worldY * Y_SCALE + bias(kind)
 *
 * -worldY: south (smaller y) -> larger key -> in front; north -> behind.
 * The kind bias (0..5) is tiny next to Y_SCALE, so it only orders objects at
 * the SAME y (e.g. a ship over the structure it floats past, an hp bar over
 * its ship). zIndex is fine as a float in Pixi v8.
 */
export function depthKey(worldY: number, kind: DepthKind = 'unit'): number {
  return -worldY * Y_SCALE + KIND_BIAS[kind];
}

/**
 * Convenience: the overlay key for an object at worldY — guaranteed to sort
 * just in front of that object's body at the same y (its hp bar / label).
 */
export function overlayKey(worldY: number): number {
  return depthKey(worldY, 'overlay');
}

/**
 * Upward SCREEN-px offset for an object's visual top given its logical height
 * (world units) and the camera zoom. Calibrated so `height === HEIGHT_REF`
 * yields `HEIGHT_REF * HEIGHT_TO_SCREEN * zoom` px — a single knob
 * (HEIGHT_TO_SCREEN in theme.ts) controls how aggressively things "stand up".
 * Returned value is POSITIVE; callers subtract it from screenY (y-down).
 */
export function heightOffsetPx(height: number, zoom: number): number {
  if (height <= 0) return 0;
  return height * HEIGHT_TO_SCREEN * zoom;
}

/**
 * The logical HEIGHT (world units) a renderer should give an object so its
 * standing-up offset is proportional to its footprint and class, clamped so
 * nothing looms absurdly tall (the giant-flag guard). `footprintR` is the
 * object's on-water radius (world units), `heightRatio` the class's
 * height-as-fraction-of-footprint (e.g. theme deckHeight for ships, a role
 * constant for structures). The clamp caps height at HEIGHT_MAX_RATIO times
 * the footprint radius so a tall feature can never project further up than a
 * sane multiple of its own base.
 */
export const HEIGHT_MAX_RATIO = 2.4;

export function logicalHeight(footprintR: number, heightRatio: number): number {
  const raw = footprintR * heightRatio;
  const cap = footprintR * HEIGHT_MAX_RATIO;
  return raw < 0 ? 0 : raw > cap ? cap : raw;
}

/**
 * Comparator for an explicit draw-order sort when a renderer batches into one
 * array instead of relying on Pixi's `sortableChildren`. Sorts back-to-front
 * (ascending key) so iterating the result paints correctly.
 */
export function byDepth<T>(
  items: readonly T[],
  keyOf: (item: T) => number,
): T[] {
  return [...items].sort((a, b) => keyOf(a) - keyOf(b));
}
