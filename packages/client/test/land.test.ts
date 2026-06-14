/**
 * render-land tests: the PURE land geometry helpers (no DOM, no camera) plus a
 * headless pixi smoke pass. Locks the contracts the land layer builds on:
 *  - cell->world rect math is the exact INVERSE of the docs/TERRAIN.md §2
 *    point query (a point inside the returned rect maps back to that cell)
 *  - the visible-cell window only covers cells inside the visible∩bounds rect
 *  - land runs batch contiguous land cells per row (RLE-friendly)
 *  - the landSignature gates rebuilds (stable on jitter, changes on pan/zoom/
 *    resize) and mirrors world.seaStaticSignature
 *  - createLand draws into real pixi Graphics without throwing (smoke), and a
 *    stub (all-water) mask leaves the land bare.
 *
 * The mask transform is owned by @bships/core's `isWater`; these tests build a
 * tiny synthetic WaterMask so they stand alone from the real terrain.json.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { Container } from 'pixi.js';
import type { WaterMask } from '@bships/core';
import { isWater } from '@bships/core';

import { resetCameraForTest, snapCamera } from '../src/render/camera.js';
import { seaStaticSignature } from '../src/render/world.js';
import {
  cellRunWorldRect,
  collectLandRuns,
  colOf,
  createLand,
  landSignature,
  rowOf,
  visibleCellWindow,
} from '../src/render/land.js';

// ---------------------------------------------------------------------------
// Synthetic masks (so the tests don't depend on the real terrain.json).
// ---------------------------------------------------------------------------

/**
 * Build a WaterMask from a `cols`×`rows` grid where `landFn(row, col)` decides
 * land (returns true) vs water. Uses the real BSP bounds + native cell sizes
 * so the §2 transform behaves exactly as in production.
 */
function makeMask(
  cols: number,
  rows: number,
  landFn: (row: number, col: number) => boolean,
): WaterMask {
  const cells = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells[r * cols + c] = landFn(r, c) ? 0 : 1; // 1 = water, 0 = land
    }
  }
  return {
    bounds: { minX: -5536, minY: -8192, maxX: 5312, maxY: 6656 },
    cols,
    rows,
    cellSizeX: 28.25,
    cellSizeY: 29,
    cells,
  };
}

/** All-water mask (no land). */
function allWater(cols: number, rows: number): WaterMask {
  return makeMask(cols, rows, () => false);
}

/** The empty STUB mask the test harnesses produce when terrain is absent. */
function stubMask(): WaterMask {
  return {
    bounds: { minX: -5536, minY: -8192, maxX: 5312, maxY: 6656 },
    cols: 384,
    rows: 512,
    cellSizeX: 28.25,
    cellSizeY: 29,
    cells: new Uint8Array(0),
  };
}

// ---------------------------------------------------------------------------
// cell <-> world rect: the inverse of the §2 transform
// ---------------------------------------------------------------------------

describe('cellRunWorldRect (inverse of TERRAIN.md §2)', () => {
  const mask = makeMask(384, 512, () => false);

  it("a single cell's rect maps its center back to the same cell", () => {
    for (const [row, col] of [
      [0, 0],
      [5, 17],
      [256, 200],
      [511, 383],
    ] as const) {
      const r = cellRunWorldRect(mask, row, col, col);
      const cx = (r.minX + r.maxX) / 2;
      const cy = (r.minY + r.maxY) / 2;
      // §2 point query on the center recovers (col, row).
      expect(colOf(mask, cx)).toBe(col);
      expect(rowOf(mask, cy)).toBe(row);
    }
  });

  it('row 0 is the NORTH band (highest y); larger row is further south', () => {
    const north = cellRunWorldRect(mask, 0, 10, 10);
    const south = cellRunWorldRect(mask, 100, 10, 10);
    expect(north.maxY).toBe(mask.bounds.maxY); // top row touches the north edge
    expect(north.minY).toBeGreaterThan(south.maxY); // north band sits above
  });

  it('col 0 is the WEST band (min-X); a run spans colStart..colEnd inclusive', () => {
    const run = cellRunWorldRect(mask, 3, 4, 9);
    expect(run.minX).toBeCloseTo(mask.bounds.minX + 4 * mask.cellSizeX, 6);
    expect(run.maxX).toBeCloseTo(mask.bounds.minX + 10 * mask.cellSizeX, 6);
    // Width is exactly the number of cells in the run.
    expect(run.maxX - run.minX).toBeCloseTo(6 * mask.cellSizeX, 6);
  });

  it('rect edges agree with the §2 boundaries (every corner re-queries inward)', () => {
    const r = cellRunWorldRect(mask, 50, 100, 100);
    const eps = 1e-3;
    // A nudge inward from each edge stays in the cell.
    expect(colOf(mask, r.minX + eps)).toBe(100);
    expect(colOf(mask, r.maxX - eps)).toBe(100);
    expect(rowOf(mask, r.maxY - eps)).toBe(50);
    expect(rowOf(mask, r.minY + eps)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// visible-cell window
// ---------------------------------------------------------------------------

describe('visibleCellWindow', () => {
  const mask = makeMask(384, 512, () => false);

  it('clamps to the mask cell bounds for a view larger than the map', () => {
    const win = visibleCellWindow(mask, {
      minX: -1e6,
      minY: -1e6,
      maxX: 1e6,
      maxY: 1e6,
    });
    expect(win.colStart).toBe(0);
    expect(win.colEnd).toBe(mask.cols - 1);
    expect(win.rowStart).toBe(0);
    expect(win.rowEnd).toBe(mask.rows - 1);
  });

  it('covers only the cells the visible rect overlaps (a small window)', () => {
    // A small rect near the map center.
    const cx = (mask.bounds.minX + mask.bounds.maxX) / 2;
    const cy = (mask.bounds.minY + mask.bounds.maxY) / 2;
    const win = visibleCellWindow(mask, {
      minX: cx - 100,
      maxX: cx + 100,
      minY: cy - 100,
      maxY: cy + 100,
    });
    // The window (padded by 1) must contain the center cell and be far from
    // covering the whole grid.
    expect(win.colStart).toBeLessThanOrEqual(colOf(mask, cx));
    expect(win.colEnd).toBeGreaterThanOrEqual(colOf(mask, cx));
    expect(win.rowStart).toBeLessThanOrEqual(rowOf(mask, cy));
    expect(win.rowEnd).toBeGreaterThanOrEqual(rowOf(mask, cy));
    // Way smaller than the full grid (the point of the window).
    expect(win.colEnd - win.colStart).toBeLessThan(30);
    expect(win.rowEnd - win.rowStart).toBeLessThan(30);
  });

  it('returns an empty window (rowEnd < rowStart) for a view fully off-map', () => {
    const win = visibleCellWindow(mask, {
      minX: mask.bounds.maxX + 1000,
      maxX: mask.bounds.maxX + 2000,
      minY: mask.bounds.minY - 2000,
      maxY: mask.bounds.minY - 1000,
    });
    expect(win.rowEnd).toBeLessThan(win.rowStart);
  });
});

// ---------------------------------------------------------------------------
// land run batching
// ---------------------------------------------------------------------------

describe('collectLandRuns', () => {
  it('returns no runs for an all-water mask', () => {
    const mask = allWater(20, 20);
    const win = visibleCellWindow(mask, mask.bounds);
    expect(collectLandRuns(mask, win)).toEqual([]);
  });

  it('batches a contiguous block of land into one run per row', () => {
    // Land in cols 5..9 on every row; water elsewhere.
    const mask = makeMask(20, 4, (_r, c) => c >= 5 && c <= 9);
    const win = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 19 };
    const runs = collectLandRuns(mask, win);
    expect(runs.length).toBe(4); // one run per row
    for (const run of runs) {
      expect(run.colStart).toBe(5);
      expect(run.colEnd).toBe(9);
    }
  });

  it('splits a row into multiple runs across water gaps', () => {
    // Row pattern: land 1..2, water, land 6..6, water, land 10..12.
    const mask = makeMask(16, 1, (_r, c) =>
      (c >= 1 && c <= 2) || c === 6 || (c >= 10 && c <= 12),
    );
    const runs = collectLandRuns(mask, { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 15 });
    expect(runs).toEqual([
      { row: 0, colStart: 1, colEnd: 2 },
      { row: 0, colStart: 6, colEnd: 6 },
      { row: 0, colStart: 10, colEnd: 12 },
    ]);
  });

  it('a land run that reaches the window edge is closed at the edge', () => {
    const mask = makeMask(16, 1, (_r, c) => c >= 12); // land 12..15
    const runs = collectLandRuns(mask, { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 15 });
    expect(runs).toEqual([{ row: 0, colStart: 12, colEnd: 15 }]);
  });

  it('every cell of a reported run is actually land per isWater', () => {
    const mask = makeMask(24, 6, (r, c) => (r + c) % 3 === 0);
    const win = visibleCellWindow(mask, mask.bounds);
    for (const run of mask.cells.length ? collectLandRuns(mask, win) : []) {
      for (let col = run.colStart; col <= run.colEnd; col++) {
        const cx = mask.bounds.minX + (col + 0.5) * mask.cellSizeX;
        const cy = mask.bounds.maxY - (run.row + 0.5) * mask.cellSizeY;
        expect(isWater(mask, cx, cy)).toBe(false); // land, by construction
      }
    }
  });
});

// ---------------------------------------------------------------------------
// rebuild-gate signature (sibling of seaStaticSignature)
// ---------------------------------------------------------------------------

describe('landSignature', () => {
  const rect = { minX: -1000, minY: -2000, maxX: 1000, maxY: 2000 };

  it('is stable for an unchanged visible rect / zoom / viewport', () => {
    expect(landSignature(rect, 1, 1600, 900)).toBe(landSignature(rect, 1, 1600, 900));
  });

  it('absorbs sub-unit jitter (rounded) so smoothing does not force a rebuild', () => {
    const a = landSignature(rect, 1, 1600, 900);
    const b = landSignature(
      { minX: -1000.3, minY: -2000.2, maxX: 1000.4, maxY: 2000.1 },
      1.0004,
      1600,
      900,
    );
    expect(a).toBe(b);
  });

  it('changes on a visible pan, a zoom step, and a viewport resize', () => {
    const a = landSignature(rect, 1, 1600, 900);
    expect(a).not.toBe(landSignature({ ...rect, minX: rect.minX + 50, maxX: rect.maxX + 50 }, 1, 1600, 900));
    expect(a).not.toBe(landSignature(rect, 1.25, 1600, 900));
    expect(a).not.toBe(landSignature(rect, 1, 1280, 720));
  });

  it('matches world.seaStaticSignature for the same inputs (lockstep invalidation)', () => {
    // The two cached layers must invalidate on exactly the same camera changes.
    expect(landSignature(rect, 1.3, 1600, 900)).toBe(seaStaticSignature(rect, 1.3, 1600, 900));
  });
});

// ---------------------------------------------------------------------------
// Pixi smoke pass — createLand draws without throwing.
// ---------------------------------------------------------------------------

describe('createLand (pixi smoke)', () => {
  beforeEach(() => resetCameraForTest(1600, 900));

  it('exposes the WorldLayer lifecycle shape', () => {
    const land = createLand();
    expect(land.view).toBeInstanceOf(Container);
    expect(typeof land.update).toBe('function');
    expect(typeof land.resize).toBe('function');
    land.view.destroy({ children: true });
  });

  it('updates and resizes without throwing (real terrain catalog)', () => {
    snapCamera(0, 0, 1);
    const land = createLand();
    expect(() => land.update(null, 0)).not.toThrow();
    // A pan should trigger a rebuild via the signature.
    snapCamera(1000, -2000, 1.5);
    expect(() => land.update(null, 16)).not.toThrow();
    expect(() => land.resize(1280, 720)).not.toThrow();
    expect(() => land.update(null, 32)).not.toThrow();
    land.view.destroy({ children: true });
  });
});

// ---------------------------------------------------------------------------
// Stub mask: terrain absent -> no land drawn (open sea, legacy behavior).
// ---------------------------------------------------------------------------

describe('stub mask (terrain absent)', () => {
  it('isWater reports open sea everywhere on the empty stub', () => {
    const mask = stubMask();
    expect(isWater(mask, 0, 0)).toBe(true);
    expect(isWater(mask, 1234, -5678)).toBe(true);
    // collectLandRuns finds no land on a stub (every cell reads water).
    const win = visibleCellWindow(mask, mask.bounds);
    expect(collectLandRuns(mask, win)).toEqual([]);
  });
});
