/**
 * render-land: the LAND masses, beaches and coastline carved out of the static
 * water mask (docs/TERRAIN.md §4). BattleShips Pro is water lanes cut through
 * land, not open sea — this layer paints the land BEHIND the units/structures
 * while world.ts keeps drawing the bright sea for the lanes. Together they read
 * as a 2.5D diorama: lit land top, a sand/rock coast band where land meets the
 * water, and a drop shadow the land casts onto the sea, all squashed by the
 * FORESHORTEN of the world plane.
 *
 * Ownership (docs/TERRAIN.md §4): world.ts owns the SEA + structures and is NOT
 * edited here. This module is self-contained and exposes the SAME lifecycle as
 * WorldLayer so the integrator can drop it into renderer.ts z-order between the
 * sea base and the foam/structure layers:
 *
 *   sea base  ->  LAND (this)  ->  foam / units / structures
 *
 *   createLand(): {
 *     view: Container;                  // add to the stage above the sea
 *     update(sample, nowMs): void;      // per ticker frame (sample unused —
 *                                       //   land is static data, presentation
 *                                       //   only; the arg keeps the lifecycle)
 *     resize(w, h): void;               // forwarded from app resize
 *   }
 *
 * Performance: the land geometry is CACHED exactly like world.ts's static sea.
 * A rebuild happens only when the camera visible-rect / zoom / viewport
 * signature changes (`landSignature`, the sibling of `seaStaticSignature`), not
 * every frame. The rebuild iterates ONLY the mask cells inside the visible
 * world rect and batches each row's run of land cells into a single world rect
 * (the mask is RLE-friendly), so a static camera uploads nothing.
 *
 * Determinism / boundaries: the mask is static data on the immutable Ruleset
 * (`getCatalog().map.waterMask`), queried via `isWater` from @bships/core — the
 * one transform everyone shares (docs/TERRAIN.md §1/§2). This is the CLIENT
 * access path: through the catalog ruleset, never a second terrain.json import.
 * Presentation only — no game logic here. All positions go through
 * `getCamera().worldToScreen` and all sizes multiply by `getCamera().zoom`; no
 * raw screen offsets.
 */

import { Container, Graphics } from 'pixi.js';
import type { WaterMask } from '@bships/core';
import { isWater } from '@bships/core';

import { getCatalog } from '../catalog.js';
import type { WorldSample } from '../net/interpolation.js';
import { FORESHORTEN, getCamera, getViewportSize } from './camera.js';
import { COAST_ROCK, COAST_SAND, SHADOW, mix, scale, shade } from './theme.js';

// ---------------------------------------------------------------------------
// Land look tuning (world units / fractions). Pseudo-3D matching world.ts:
// a lit land top, a sand+rock coast band hugging the waterline, and a drop
// shadow the land throws onto the sea (opposite the top-left key light).
// ---------------------------------------------------------------------------

/**
 * Base land color — the original's grass green, pushed YELLOW-green so it
 * separates by HUE from the cyan water ramp (theme.WATER_RAMP). With flat
 * fills and no texture, hue is the only thing telling shore from shoal.
 * The lit/shade variants come from theme.shade so the land obeys the same
 * top-left key light as every structure.
 */
export const LAND_BASE = 0x4d6b33;

/**
 * Width (world units) of the sand/rock coast band drawn along the waterline.
 * A cell is "coast" when it is land AND borders water; the band is the inner
 * edge of that cell facing the sea.
 */
export const COAST_BAND_UNITS = 22;

/** Drop-shadow the land casts onto the sea: screen-px offset (at zoom 1),
 * opposite the light (down-right), foreshortened on y like the water plane. */
export const LAND_SHADOW_DX = SHADOW.offsetX;
export const LAND_SHADOW_DY = SHADOW.offsetY;
export const LAND_SHADOW_ALPHA = 0.3;

// ---------------------------------------------------------------------------
// Cell <-> world transform (the INVERSE of the docs/TERRAIN.md §2 point query).
//
// The §2 query maps a world point to a cell:
//   col = floor((x - minX) / cellSizeX)   // col 0 = west / min-X
//   row = floor((maxY - y) / cellSizeY)    // row 0 = north / max-Y (no flip)
//
// The renderer needs the inverse — the WORLD RECT a cell (or a run of cells in
// one row) covers — so it can batch and draw. We derive it from the SAME
// formula; do not invent a second transform.
// ---------------------------------------------------------------------------

/** World rect (axis-aligned, +x east / +y north) covered by a run of land
 * cells `[colStart, colEnd]` (inclusive) in row `row` of the mask. */
export interface CellWorldRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * World rect for a run of cells `colStart..colEnd` (inclusive) in `row`.
 * Inverts §2: cell `col` spans world-X `[minX + col*cellSizeX, minX +
 * (col+1)*cellSizeX)`; row `row` spans world-Y `(maxY - (row+1)*cellSizeY,
 * maxY - row*cellSizeY]` (row 0 = the northernmost band, highest y). Pure +
 * unit-tested against the §2 point query.
 */
export function cellRunWorldRect(
  mask: WaterMask,
  row: number,
  colStart: number,
  colEnd: number,
): CellWorldRect {
  const { bounds, cellSizeX, cellSizeY } = mask;
  return {
    minX: bounds.minX + colStart * cellSizeX,
    maxX: bounds.minX + (colEnd + 1) * cellSizeX,
    // row 0 is the north (max-Y) band; larger row -> further south (lower y).
    maxY: bounds.maxY - row * cellSizeY,
    minY: bounds.maxY - (row + 1) * cellSizeY,
  };
}

/** Column index of the cell containing world-X `x` (the §2 col formula). */
export function colOf(mask: WaterMask, x: number): number {
  return Math.floor((x - mask.bounds.minX) / mask.cellSizeX);
}

/** Row index of the cell containing world-Y `y` (the §2 row formula). */
export function rowOf(mask: WaterMask, y: number): number {
  return Math.floor((mask.bounds.maxY - y) / mask.cellSizeY);
}

/** Clamp an integer to `[lo, hi]`. */
function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Visible-cell window: only iterate mask cells that intersect the visible
// world rect (intersected with the mask bounds). Returns inclusive cell
// ranges; an empty window (no land visible / off-map) has rowEnd < rowStart.
// ---------------------------------------------------------------------------

export interface CellWindow {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

/**
 * The inclusive cell range covering the intersection of `rect` (a visible
 * world rect from the camera) with the mask bounds. Pads by one cell each side
 * so coast detection on the window edge can look at the neighbor. An empty
 * intersection yields `rowEnd < rowStart` (caller draws nothing). Pure.
 */
export function visibleCellWindow(
  mask: WaterMask,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
): CellWindow {
  const { bounds, cols, rows } = mask;
  const minX = Math.max(rect.minX, bounds.minX);
  const maxX = Math.min(rect.maxX, bounds.maxX);
  const minY = Math.max(rect.minY, bounds.minY);
  const maxY = Math.min(rect.maxY, bounds.maxY);
  if (minX >= maxX || minY >= maxY) {
    return { rowStart: 1, rowEnd: 0, colStart: 1, colEnd: 0 }; // empty
  }
  // Lower-X -> smaller col; lower-Y -> larger row (no flip). Pad by 1 cell.
  const colStart = clampInt(colOf(mask, minX) - 1, 0, cols - 1);
  const colEnd = clampInt(colOf(mask, maxX) + 1, 0, cols - 1);
  const rowStart = clampInt(rowOf(mask, maxY) - 1, 0, rows - 1); // maxY = north = row 0-ish
  const rowEnd = clampInt(rowOf(mask, minY) + 1, 0, rows - 1);
  return { rowStart, rowEnd, colStart, colEnd };
}

// ---------------------------------------------------------------------------
// Rebuild-gate signature — the sibling of world.ts seaStaticSignature. While
// this is unchanged the cached land geometry is pixel-identical, so the layer
// skips the (expensive) mask scan + tessellation entirely.
// ---------------------------------------------------------------------------

/**
 * Signature capturing everything the land geometry depends on: the visible
 * world rect, the zoom, and the viewport size. Rounded to whole world units /
 * px (and zoom*1000) so sub-unit smoothing jitter does not force a rebuild
 * every frame, yet any visible pan/zoom/resize changes it. Mirrors
 * `world.seaStaticSignature` so the two cached layers invalidate in lockstep.
 * Pure — unit-tested.
 */
export function landSignature(
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  zoom: number,
  viewportW: number,
  viewportH: number,
): string {
  return [
    Math.round(rect.minX),
    Math.round(rect.minY),
    Math.round(rect.maxX),
    Math.round(rect.maxY),
    Math.round(zoom * 1000),
    Math.round(viewportW),
    Math.round(viewportH),
  ].join('|');
}

// ---------------------------------------------------------------------------
// Land run extraction — batch each row's contiguous land cells into runs so we
// draw one rect per run, not one per cell (the mask is RLE-friendly). A cell is
// land when `isWater` is false at its center; we sample the center so we share
// the §2 transform with the sim instead of re-reading the packed bytes.
// ---------------------------------------------------------------------------

/** One contiguous run of LAND cells in a single row (inclusive cols). */
export interface LandRun {
  row: number;
  colStart: number;
  colEnd: number;
}

/** Is cell `(row, col)` land? Samples the cell center through the shared
 * `isWater` transform so we never duplicate the §2 cell math. */
function cellIsLand(mask: WaterMask, row: number, col: number): boolean {
  const cx = mask.bounds.minX + (col + 0.5) * mask.cellSizeX;
  const cy = mask.bounds.maxY - (row + 0.5) * mask.cellSizeY;
  return !isWater(mask, cx, cy);
}

/**
 * Collect the contiguous LAND runs within a cell window, one row at a time.
 * Pure (no pixi) so it is unit-testable; the draw step turns each run into a
 * world rect via `cellRunWorldRect`.
 */
export function collectLandRuns(mask: WaterMask, win: CellWindow): LandRun[] {
  const runs: LandRun[] = [];
  for (let row = win.rowStart; row <= win.rowEnd; row++) {
    let runStart = -1;
    for (let col = win.colStart; col <= win.colEnd; col++) {
      if (cellIsLand(mask, row, col)) {
        if (runStart < 0) runStart = col;
      } else if (runStart >= 0) {
        runs.push({ row, colStart: runStart, colEnd: col - 1 });
        runStart = -1;
      }
    }
    if (runStart >= 0) runs.push({ row, colStart: runStart, colEnd: win.colEnd });
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export interface LandLayer {
  view: Container;
  update(sample: WorldSample | null, nowMs: number): void;
  resize(w: number, h: number): void;
}

/**
 * Create the land layer. No renderer handle is needed — land keeps no
 * render-texture (it redraws into plain Graphics, cached on the camera
 * signature like world.ts's static sea).
 */
export function createLand(): LandLayer {
  const view = new Container();

  // Three stacked Graphics so coast/shadow paint over the land body in the
  // right order WITHIN this layer (the layer as a whole sits behind units):
  //   shadow (on the sea)  ->  land body  ->  coast band (waterline trim).
  const shadow = new Graphics();
  const body = new Graphics();
  const coast = new Graphics();
  view.addChild(shadow, body, coast);

  /** Signature of the last land build; '' forces a rebuild. */
  let landSig = '';

  function rebuild(): void {
    const cam = getCamera();
    const mask = getCatalog().map.waterMask;
    const { w: vw, h: vh } = getViewportSize();
    const rect = cam.viewportWorldRect();

    const sig = landSignature(rect, cam.zoom, vw, vh);
    if (sig === landSig) return; // unchanged — keep the cached geometry
    landSig = sig;

    shadow.clear();
    body.clear();
    coast.clear();

    // Stub mask (terrain absent in a test harness): isWater is true
    // everywhere, so there is no land to draw — leave the sea bare.
    if (mask.cells.length === 0) return;

    const win = visibleCellWindow(mask, rect);
    if (win.rowEnd < win.rowStart || win.colEnd < win.colStart) return;

    const runs = collectLandRuns(mask, win);
    if (runs.length === 0) return;

    const s = shade(LAND_BASE);
    const zoom = cam.zoom;
    const shadowDx = LAND_SHADOW_DX * zoom;
    const shadowDy = LAND_SHADOW_DY * zoom;
    const coastBandPx = COAST_BAND_UNITS * zoom * FORESHORTEN;
    // Sand fading to rock toward the water — the same band world.ts uses for
    // its procedural shoals, here anchored to the real coastline.
    const coastColor = mix(COAST_SAND, COAST_ROCK, 0.35);

    for (const run of runs) {
      const wr = cellRunWorldRect(mask, run.row, run.colStart, run.colEnd);
      // Screen rect: NW corner (minX, maxY) is top-left after the +y flip.
      const tl = cam.worldToScreen(wr.minX, wr.maxY);
      const br = cam.worldToScreen(wr.maxX, wr.minY);
      const x = tl.x;
      const y = tl.y;
      const w = br.x - tl.x;
      const h = br.y - tl.y;
      // +1 px overdraw closes seams between adjacent row rects on the GPU.
      const w1 = w + 1;
      const h1 = h + 1;

      // Drop shadow on the sea (down-right, opposite the light). Drawn first so
      // the land body paints over its own near edge.
      shadow.rect(x + shadowDx, y + shadowDy, w1, h1).fill({
        color: SHADOW.color,
        alpha: LAND_SHADOW_ALPHA,
      });

      // Lit land top.
      body.rect(x, y, w1, h1).fill(s.lit);

      // Coast band on the SOUTH (lower, water-facing) edge — a thin sand/rock
      // strip at the waterline so land meets sea on a beach, not a hard line.
      // The land body always draws as one rect, but the beach is emitted only
      // over the contiguous COLUMN sub-spans of this run whose cell just south
      // is water. A per-cell south probe (rather than one midpoint sample) keeps
      // long horizontal coastlines accurate — a run can span the whole map width
      // (median ~14 cells but up to ~258), so a single sample would beach (or
      // bare) the entire edge on one cell. Still cheap: one rect per coast
      // sub-span, and bare south-locked spans cost nothing.
      const southRow = run.row + 1;
      const colCount = run.colEnd - run.colStart + 1;
      const colW = w / colCount; // screen px per cell column across the run
      const coastY = y + h - coastBandPx;
      const coastH = coastBandPx + 1;
      const sandH = Math.max(1, coastBandPx * 0.34);
      let spanStartCol = -1; // first col of the current water-facing sub-span
      for (let col = run.colStart; col <= run.colEnd + 1; col++) {
        const southIsWater =
          col <= run.colEnd && (southRow >= mask.rows || !cellIsLand(mask, southRow, col));
        if (southIsWater && spanStartCol < 0) {
          spanStartCol = col; // open a sub-span
        } else if (!southIsWater && spanStartCol >= 0) {
          // close + draw the sub-span [spanStartCol, col-1].
          const sx = x + (spanStartCol - run.colStart) * colW;
          const sw = (col - spanStartCol) * colW + 1;
          coast.rect(sx, coastY, sw, coastH).fill({ color: coastColor, alpha: 0.55 });
          // A faint lit sand line on top of the band for a touch of relief.
          coast.rect(sx, coastY, sw, sandH).fill({ color: scale(COAST_SAND, 1.15), alpha: 0.4 });
          spanStartCol = -1;
        }
      }
    }
  }

  function update(_sample: WorldSample | null, _nowMs: number): void {
    // Land is static map data: it depends only on the camera, never on the
    // match sample or time. Rebuild only on a pan/zoom/resize (signature).
    void _sample;
    void _nowMs;
    rebuild();
  }

  function resize(w: number, h: number): void {
    // Like world.ts: the signature includes the viewport, but invalidate
    // explicitly so a resize can't be missed if setViewport hasn't propagated.
    void w;
    void h;
    landSig = '';
  }

  return { view, update, resize };
}
