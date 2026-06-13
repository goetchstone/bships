/**
 * Water background: deep-navy base over the map bounds, a subtle
 * world-space grid, slow-drifting wave bands, and a visible map border.
 * One Graphics redrawn per frame in screen space from the camera's visible
 * world rect — cheap (a few dozen primitives) and always crisp under zoom.
 */

import { Graphics } from 'pixi.js';

import { getCatalog } from '../catalog.js';
import { FORESHORTEN, getCamera, getViewportSize } from './camera.js';

const WATER_DEEP = 0x0a2034;
const WATER_GRID = 0x9fd0ff;
const WAVE_BAND = 0xbfe3ff;
const BORDER = 0x2a4a66;

/** World-units spacing of the cosmetic grid. */
const GRID_STEP = 512;

/** World-units spacing/height of the drifting wave bands. */
const WAVE_STEP = 384;
const WAVE_HEIGHT = 7;

export interface WaterLayer {
  view: Graphics;
  update(nowMs: number): void;
}

export function createWater(): WaterLayer {
  const view = new Graphics();

  function update(nowMs: number): void {
    const cam = getCamera();
    const bounds = getCatalog().map.bounds;
    const { w: vw, h: vh } = getViewportSize();
    const rect = cam.viewportWorldRect();

    view.clear();

    // Visible portion of the map, in world units.
    const minX = Math.max(rect.minX, bounds.minX);
    const maxX = Math.min(rect.maxX, bounds.maxX);
    const minY = Math.max(rect.minY, bounds.minY);
    const maxY = Math.min(rect.maxY, bounds.maxY);
    if (minX >= maxX || minY >= maxY) return; // map fully off-screen

    // The camera transform is axis-aligned, so the map rect stays a rect.
    const tl = cam.worldToScreen(minX, maxY);
    const br = cam.worldToScreen(maxX, minY);
    view.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y).fill(WATER_DEEP);

    // Wave bands: horizontal stripes drifting with a slow sine shimmer.
    const waveStart = Math.floor(minY / WAVE_STEP) * WAVE_STEP;
    for (let wy = waveStart; wy <= maxY; wy += WAVE_STEP) {
      if (wy < minY) continue;
      const phase = nowMs / 4000 + wy * 0.003;
      const shimmer = 0.02 + 0.015 * Math.sin(phase);
      const sy = cam.worldToScreen(0, wy).y;
      const bandH = Math.max(1, WAVE_HEIGHT * cam.zoom * FORESHORTEN);
      view.rect(tl.x, sy, br.x - tl.x, bandH).fill({ color: WAVE_BAND, alpha: shimmer });
    }

    // World-space grid.
    const gx0 = Math.ceil(minX / GRID_STEP) * GRID_STEP;
    for (let wx = gx0; wx <= maxX; wx += GRID_STEP) {
      const sx = cam.worldToScreen(wx, 0).x;
      view.moveTo(sx, tl.y).lineTo(sx, br.y);
    }
    const gy0 = Math.ceil(minY / GRID_STEP) * GRID_STEP;
    for (let wy = gy0; wy <= maxY; wy += GRID_STEP) {
      const sy = cam.worldToScreen(0, wy).y;
      view.moveTo(tl.x, sy).lineTo(br.x, sy);
    }
    view.stroke({ width: 1, color: WATER_GRID, alpha: 0.05 });

    // Map border (drawn on the true bounds, may extend past the viewport).
    const btl = cam.worldToScreen(bounds.minX, bounds.maxY);
    const bbr = cam.worldToScreen(bounds.maxX, bounds.minY);
    view
      .rect(btl.x, btl.y, bbr.x - btl.x, bbr.y - btl.y)
      .stroke({ width: 3, color: BORDER, alpha: 0.9 });

    // Subtle vignette of off-map abyss when the edge is on screen.
    if (btl.x > 0) view.rect(0, 0, btl.x, vh).fill({ color: 0x000000, alpha: 0.35 });
    if (bbr.x < vw) view.rect(bbr.x, 0, vw - bbr.x, vh).fill({ color: 0x000000, alpha: 0.35 });
    if (btl.y > 0) view.rect(0, 0, vw, btl.y).fill({ color: 0x000000, alpha: 0.35 });
    if (bbr.y < vh) view.rect(0, bbr.y, vw, vh - bbr.y).fill({ color: 0x000000, alpha: 0.35 });
  }

  return { view, update };
}
