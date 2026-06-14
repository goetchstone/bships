/**
 * render-world: the bottom of the scene — a layered, depth-shaded, gently
 * animated sea, a procedural coast/shoal ring so the playfield isn't a bare
 * rectangle, and ALL structures as elevated, beveled buildings with drop
 * shadows at correct scale (the giant-flag bug is fixed in structures.ts).
 *
 * The layer exposes the render-API the integrator wires into renderer.ts:
 *
 *   createWorld(renderer): {
 *     view: Container;                       // add to stage just above nothing
 *     update(sample, nowMs): void;           // per ticker frame
 *     resize(w, h): void;                    // forwarded from app resize
 *   }
 *
 * Internals:
 *  - WATER + COAST are redrawn each frame in SCREEN space from the camera's
 *    visible world rect (the cheap approach kept from the old water.ts), but
 *    now layered: a depth-graded base fill (waterAt by distance-from-edge),
 *    2-3 drifting foam wave-bands at different speeds/alphas (time from nowMs,
 *    never match state), a faint world-space grid, procedural shoals hugging
 *    the playable border + base regions, the map border, and an off-map abyss
 *    vignette. No external textures — all Graphics primitives.
 *  - STRUCTURES are pooled: one Container per structure id, static parts
 *    (shadow/footprint/body) redrawn only when the draw signature changes
 *    (role|team), cheap per-frame updates (screen position, zoom scale,
 *    zIndex, hp width). Destroyed and dropped from the pool on removal — no
 *    leaks. They live in a `sortableChildren` sub-container so they y-sort
 *    among themselves (north behind south) via depth.depthKey.
 *
 * Time-based animation only; all positions go through getCamera().worldToScreen
 * and all pixel sizes multiply by getCamera().zoom; heights go through
 * depth.heightOffsetPx — no raw world-unit screenY offsets anywhere here.
 */

import { Container, Graphics } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { SnapshotEntity, TeamId } from '@bships/core';

import { getCatalog } from '../catalog.js';
import type { WorldSample } from '../net/interpolation.js';
import { store } from '../net/store.js';
import { FORESHORTEN, getCamera, getViewportSize } from './camera.js';
import { depthKey, heightOffsetPx, overlayKey } from './depth.js';
import {
  ABYSS,
  COAST_ROCK,
  COAST_SAND,
  HP_BACK,
  HP_GREEN,
  HP_RED,
  HP_YELLOW,
  WATER_FOAM,
  mix,
  scale,
  waterAt,
} from './theme.js';
import { hpBarWidth, structureRadius } from './viz.js';
import type { StructureRole } from './structures.js';
import {
  ROLE_HEIGHT_RATIO,
  drawDropShadow,
  drawFootprint,
  drawStructureBody,
  structureHeight,
} from './structures.js';

// ---------------------------------------------------------------------------
// Water tuning constants (world units / time).
// ---------------------------------------------------------------------------

/** World-units spacing of the cosmetic depth grid. */
const GRID_STEP = 512;

/** Faint world-space grid line color (cool). */
const WATER_GRID = 0x9fd0ff;

/** Map-border stroke. */
const BORDER = 0x33597a;

/**
 * Distance from the playable edge (world units) over which water grades from
 * shallow (coast) to deep open sea. Beyond `COAST_BAND` it's full deep; the
 * abyss tint only appears at/outside the border itself.
 */
const COAST_BAND = 1400;

/** World-units cell size for scattered ambient whitecaps (one maybe-cap each). */
const WHITECAP_STEP = 300;

/** Deterministic [0,1) hash of an integer grid cell — stable in world space so
 * ambient detail is anchored to the sea, not the screen (no crawl on pan). */
function cellHash(ix: number, iy: number): number {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Three drifting foam wave-band layers: spacing, speed, height, alpha. */
const WAVE_LAYERS: readonly { step: number; speed: number; height: number; alpha: number }[] = [
  { step: 360, speed: 1 / 5200, height: 6, alpha: 0.1 },
  { step: 540, speed: 1 / 3400, height: 9, alpha: 0.08 },
  { step: 880, speed: 1 / 9000, height: 15, alpha: 0.06 },
];

// ---------------------------------------------------------------------------
// Water depth model (pure) — depth01 in [0,1], 0 shallow .. 1 abyss.
// ---------------------------------------------------------------------------

/**
 * Depth fraction at world y given the map bounds: shallowest near the N/S
 * edges (coast), deepest in the open middle. We grade by the smaller of the
 * two edge distances so both shores are shallow and the channel is deep. The
 * border itself reads as abyss (depth01 ~ 1) via a tiny boost at the very
 * edge. Pure + unit-tested.
 */
export function waterDepth01(
  worldY: number,
  bounds: { minY: number; maxY: number },
): number {
  const dEdge = Math.min(worldY - bounds.minY, bounds.maxY - worldY);
  if (dEdge <= 0) return 1; // at/over the border -> abyss
  // t: 0 at the shore, 1 once we're COAST_BAND units into open water. So
  // depth01 is SHALLOW (small) near the coast and DEEP (large) mid-channel,
  // but never quite abyss inside the playfield so open water reads "deep"
  // rather than "void".
  const t = Math.min(1, dEdge / COAST_BAND);
  // Open channel tops out at "deep sea" (~0.62), NOT abyss — the player sails
  // here, so it must read as bright sea-blue, not a black void. Only the very
  // edge (dEdge <= 0, handled above) hits true abyss.
  return 0.1 + 0.52 * t;
}

/** Base water fill color at a given world y (depth-graded). */
export function waterColorAt(worldY: number, bounds: { minY: number; maxY: number }): number {
  return waterAt(waterDepth01(worldY, bounds));
}

/**
 * Signature that captures everything the STATIC sea layer (base depth slabs +
 * grid + shoals + border + abyss vignette) depends on: the camera's visible
 * world rect, the zoom, and the viewport size. While this is unchanged the
 * static sea is pixel-identical, so the world layer skips the (expensive)
 * full-sea tessellation and re-uploads nothing. Rounded to whole world units /
 * px so sub-unit smoothing jitter doesn't force a rebuild every frame, yet any
 * visible pan/zoom/resize changes it. Pure — unit-tested.
 */
export function seaStaticSignature(
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
// Structure pooling.
// ---------------------------------------------------------------------------

interface StructView {
  root: Container;
  shadow: Graphics;
  footprint: Graphics;
  body: Graphics;
  hpBar: Graphics;
  /** Redraw signature: role|team. */
  sig: string;
  radius: number;
  /** Cached standing height (screen px at zoom 1) for the current sig. */
  hPx: number;
}

function hpColor(ratio: number): number {
  if (ratio > 0.6) return HP_GREEN;
  if (ratio > 0.3) return HP_YELLOW;
  return HP_RED;
}

export interface WorldLayer {
  view: Container;
  update(sample: WorldSample | null, nowMs: number): void;
  resize(w: number, h: number): void;
}

export function createWorld(renderer?: Renderer): WorldLayer {
  // The renderer handle is part of the contract (render-fx/fog use it for
  // render-textures); render-world keeps the cheap redraw-each-frame sea and
  // retains no render-texture, so it is intentionally unreferenced here.
  void renderer;
  const view = new Container();

  // Sea is split for performance (the per-frame full-sea tessellation was the
  // dominant render cost). `seaStatic` holds the depth-graded base, grid,
  // shoals, border and abyss vignette — everything that only depends on the
  // camera's visible rect + viewport + zoom, so it is rebuilt ONLY when that
  // signature changes (a pan/zoom/resize), not every frame. `seaFoam` holds
  // just the drifting foam wave-bands, the one thing that actually animates,
  // and is the sole per-frame sea redraw. Structures sit in their own
  // y-sortable container above both.
  const seaStatic = new Graphics();
  const seaFoam = new Graphics();
  const structureLayer = new Container();
  structureLayer.sortableChildren = true;
  view.addChild(seaStatic, seaFoam, structureLayer);

  /** Signature of the last static-sea build; '' forces a rebuild. */
  let seaStaticSig = '';

  const structs = new Map<number, StructView>();

  // -------------------------------------------------------------------------
  // WATER + COAST
  // -------------------------------------------------------------------------

  /**
   * Rebuild the STATIC sea (base depth slabs + grid + shoals + border + abyss
   * vignette) ONLY when the visible-rect / zoom / viewport signature changed.
   * This is the expensive tessellation; gating it on the signature removes the
   * full-sea rebuild + GPU re-upload from the steady-state (static-camera)
   * frame entirely. Returns the visible-rect screen extent the foam pass reuses.
   */
  function drawSeaStatic(): void {
    const cam = getCamera();
    const bounds = getCatalog().map.bounds;
    const { w: vw, h: vh } = getViewportSize();
    const rect = cam.viewportWorldRect();

    const sig = seaStaticSignature(rect, cam.zoom, vw, vh);
    if (sig === seaStaticSig) return; // unchanged — keep the cached geometry
    seaStaticSig = sig;

    seaStatic.clear();

    const minX = Math.max(rect.minX, bounds.minX);
    const maxX = Math.min(rect.maxX, bounds.maxX);
    const minY = Math.max(rect.minY, bounds.minY);
    const maxY = Math.min(rect.maxY, bounds.maxY);

    // Full-viewport abyss base first (covers off-map gutters + shows through).
    seaStatic.rect(0, 0, vw, vh).fill(ABYSS);

    if (minX < maxX && minY < maxY) {
      const tl = cam.worldToScreen(minX, maxY);
      const br = cam.worldToScreen(maxX, minY);
      const left = tl.x;
      const top = tl.y;
      const width = br.x - tl.x;

      // Depth-graded base: horizontal slabs from north edge to south edge so
      // the channel reads deeper than the shores. ~28 slabs is plenty smooth
      // and cheap.
      const SLABS = 28;
      for (let i = 0; i < SLABS; i++) {
        const y0 = maxY - ((maxY - minY) * i) / SLABS;
        const y1 = maxY - ((maxY - minY) * (i + 1)) / SLABS;
        const midY = (y0 + y1) / 2;
        const sy0 = cam.worldToScreen(0, y0).y;
        const sy1 = cam.worldToScreen(0, y1).y;
        seaStatic.rect(left, sy0, width, sy1 - sy0 + 1).fill(waterColorAt(midY, bounds));
      }

      // Faint world-space grid.
      const gx0 = Math.ceil(minX / GRID_STEP) * GRID_STEP;
      for (let wx = gx0; wx <= maxX; wx += GRID_STEP) {
        const sx = cam.worldToScreen(wx, 0).x;
        seaStatic.moveTo(sx, top).lineTo(sx, br.y);
      }
      const gy0 = Math.ceil(minY / GRID_STEP) * GRID_STEP;
      for (let wy = gy0; wy <= maxY; wy += GRID_STEP) {
        const sy = cam.worldToScreen(0, wy).y;
        seaStatic.moveTo(left, sy).lineTo(br.x, sy);
      }
      seaStatic.stroke({ width: 1, color: WATER_GRID, alpha: 0.045 });

      // Scattered whitecaps: one candidate per world cell, hashed so they are
      // anchored in the sea (no crawl on pan) and sparse (~22% of cells). Each
      // is a tiny foreshortened foam dash — open water only (skip the shores so
      // they never sit "on land"). Cheap: lives in the cached static layer.
      const cx0 = Math.floor(minX / WHITECAP_STEP);
      const cx1 = Math.ceil(maxX / WHITECAP_STEP);
      const cy0 = Math.floor(minY / WHITECAP_STEP);
      const cy1 = Math.ceil(maxY / WHITECAP_STEP);
      for (let ix = cx0; ix <= cx1; ix++) {
        for (let iy = cy0; iy <= cy1; iy++) {
          const h = cellHash(ix, iy);
          if (h > 0.26) continue; // density
          const wx = (ix + cellHash(ix + 7, iy)) * WHITECAP_STEP;
          const wy = (iy + cellHash(ix, iy + 7)) * WHITECAP_STEP;
          if (wx < minX || wx > maxX || wy < minY || wy > maxY) continue;
          if (waterDepth01(wy, bounds) < 0.22) continue; // keep off the shoals
          const p = cam.worldToScreen(wx, wy);
          const w = (6 + h * 22) * cam.zoom;
          const hgt = Math.max(1, w * 0.28 * FORESHORTEN);
          seaStatic
            .ellipse(p.x, p.y, w, hgt)
            .fill({ color: WATER_FOAM, alpha: 0.09 + h * 0.3 });
        }
      }

      // Procedural coastal shoal: a soft sand/rock band hugging the inside of
      // the N and S map edges, so the open sea meets "land" rather than a hard
      // line. Drawn as faint tapered strips — subtle, never over the lanes.
      drawShoals(cam, bounds, minX, maxX, left, width);
    }

    // Map border on the true bounds (may extend past the viewport).
    const btl = cam.worldToScreen(bounds.minX, bounds.maxY);
    const bbr = cam.worldToScreen(bounds.maxX, bounds.minY);
    seaStatic.rect(btl.x, btl.y, bbr.x - btl.x, bbr.y - btl.y).stroke({ width: 3, color: BORDER, alpha: 0.85 });

    // Off-map abyss vignette: darken the gutters outside the playable rect.
    if (btl.x > 0) seaStatic.rect(0, 0, btl.x, vh).fill({ color: ABYSS, alpha: 0.55 });
    if (bbr.x < vw) seaStatic.rect(bbr.x, 0, vw - bbr.x, vh).fill({ color: ABYSS, alpha: 0.55 });
    if (btl.y > 0) seaStatic.rect(0, 0, vw, btl.y).fill({ color: ABYSS, alpha: 0.55 });
    if (bbr.y < vh) seaStatic.rect(0, bbr.y, vw, vh - bbr.y).fill({ color: ABYSS, alpha: 0.55 });
  }

  /**
   * The ONLY per-frame sea redraw: the drifting foam wave-bands (time-based off
   * `nowMs`, never match state). A handful of thin strips — far cheaper than
   * re-tessellating the whole sea — so the water still animates at 60fps while
   * the heavy base/grid/coast geometry stays cached.
   */
  function drawSeaFoam(nowMs: number): void {
    const cam = getCamera();
    const bounds = getCatalog().map.bounds;
    const rect = cam.viewportWorldRect();
    seaFoam.clear();

    const minX = Math.max(rect.minX, bounds.minX);
    const maxX = Math.min(rect.maxX, bounds.maxX);
    const minY = Math.max(rect.minY, bounds.minY);
    const maxY = Math.min(rect.maxY, bounds.maxY);
    if (minX >= maxX || minY >= maxY) return;

    const tl = cam.worldToScreen(minX, maxY);
    const br = cam.worldToScreen(maxX, minY);
    const left = tl.x;
    const width = br.x - tl.x;

    for (const layer of WAVE_LAYERS) {
      const drift = (nowMs * layer.speed * layer.step) % layer.step;
      const start = Math.floor(minY / layer.step) * layer.step;
      const bandH = Math.max(1, layer.height * cam.zoom * FORESHORTEN);
      for (let wy = start; wy <= maxY; wy += layer.step) {
        const yy = wy + drift;
        if (yy < minY || yy > maxY) continue;
        const shimmer = layer.alpha * (0.6 + 0.4 * Math.sin(nowMs * layer.speed * 6 + yy * 0.004));
        const sy = cam.worldToScreen(0, yy).y;
        // Soft swell body...
        seaFoam.rect(left, sy, width, bandH).fill({ color: WATER_FOAM, alpha: shimmer });
        // ...with a brighter crest line on its lit (upper) edge so it reads as
        // a moving wave rather than a flat stripe.
        seaFoam
          .rect(left, sy, width, Math.max(1, bandH * 0.34))
          .fill({ color: WATER_FOAM, alpha: Math.min(0.5, shimmer * 2.2) });
      }
    }
  }

  /**
   * Procedural shoals: tapered sand+rock bands inside the N and S shores. A
   * handful of overlapping foreshortened arcs read as a soft coastline without
   * any external asset and without occluding the central lanes.
   */
  function drawShoals(
    cam: ReturnType<typeof getCamera>,
    bounds: { minX: number; maxX: number; minY: number; maxY: number },
    minX: number,
    maxX: number,
    left: number,
    width: number,
  ): void {
    const shoalDepth = COAST_BAND * 0.45;
    for (const edge of [bounds.maxY, bounds.minY] as const) {
      const inner = edge === bounds.maxY ? edge - shoalDepth : edge + shoalDepth;
      if (inner < bounds.minY || inner > bounds.maxY) continue;
      const sEdge = cam.worldToScreen(0, edge).y;
      const sInner = cam.worldToScreen(0, inner).y;
      const top = Math.min(sEdge, sInner);
      const h = Math.abs(sInner - sEdge);
      if (h < 1) continue;
      // Sand band fading inward (alpha taper via two stacked strips).
      seaStatic.rect(left, top, width, h).fill({ color: COAST_SAND, alpha: 0.1 });
      seaStatic.rect(left, edge === bounds.maxY ? sEdge - h * 0.4 : sEdge, width, h * 0.4).fill({
        color: mix(COAST_SAND, COAST_ROCK, 0.5),
        alpha: 0.14,
      });
    }
    // A few rock specks scrubbed along the corners for texture (deterministic
    // by position, not random — stable across frames).
    for (const cx of [bounds.minX + 600, bounds.maxX - 600]) {
      if (cx < minX || cx > maxX) continue;
      for (const cy of [bounds.minY + 500, bounds.maxY - 500]) {
        const p = cam.worldToScreen(cx, cy);
        seaStatic.ellipse(p.x, p.y, 26 * cam.zoom, 26 * cam.zoom * FORESHORTEN).fill({
          color: COAST_ROCK,
          alpha: 0.2,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // STRUCTURES
  // -------------------------------------------------------------------------

  function createStructView(): StructView {
    const root = new Container();
    const shadow = new Graphics();
    const footprint = new Graphics();
    const body = new Graphics();
    const hpBar = new Graphics();
    root.addChild(shadow, footprint, body, hpBar);
    structureLayer.addChild(root);
    return { root, shadow, footprint, body, hpBar, sig: '', radius: 0, hPx: 0 };
  }

  function redrawStruct(v: StructView, role: StructureRole, team: TeamId | null, nowMs: number): void {
    const r = structureRadius(role);
    const height = structureHeight(role);
    const hPx = heightOffsetPx(height, 1);
    v.radius = r;
    v.hPx = hPx;
    v.shadow.clear();
    v.footprint.clear();
    v.body.clear();
    drawDropShadow(v.shadow, r, height);
    drawFootprint(v.footprint, r, team);
    drawStructureBody(v.body, role, r, hPx, team, nowMs);
  }

  function drawStructHp(v: StructView, e: SnapshotEntity, selected: boolean): void {
    v.hpBar.clear();
    const ratio = e.maxHp > 0 ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 0;
    if (ratio >= 1 && !selected) return;
    const w = hpBarWidth(e.maxHp);
    const h = 7;
    // Sit the bar above the building top (footprint base minus the standing
    // height) plus a little gap — all in zoom-1 px (root carries the zoom).
    const y = -(v.hPx + 16);
    v.hpBar.rect(-w / 2 - 1, y - 1, w + 2, h + 2).fill({ color: HP_BACK, alpha: 0.8 });
    v.hpBar.rect(-w / 2, y, w * ratio, h).fill(hpColor(ratio));
  }

  function updateStructures(sample: WorldSample, nowMs: number): void {
    const cam = getCamera();
    const zoom = cam.zoom;
    const selectedId = store.ui.selectedEntityId;
    const seen = new Set<number>();

    for (const e of sample.entities) {
      if (e.kind !== 'structure') continue;
      seen.add(e.id);
      let v = structs.get(e.id);
      if (v === undefined) {
        v = createStructView();
        structs.set(e.id, v);
      }
      const role = (e.role ?? 'other') as StructureRole;
      const sig = `${role}|${e.team ?? ''}`;
      if (sig !== v.sig) {
        v.sig = sig;
        redrawStruct(v, role, e.team, nowMs);
      }

      const sp = cam.worldToScreen(e.x, e.y);
      v.root.position.set(sp.x, sp.y);
      v.root.scale.set(zoom);
      v.root.zIndex = depthKey(e.y, 'structure');

      const selected = e.id === selectedId;
      drawStructHp(v, e, selected);
      // HP bar should sort like an overlay even though it rides the root; the
      // root's single zIndex already keeps the whole building correctly N-S
      // sorted, and the bar is the last child so it paints over the body.
      v.hpBar.zIndex = overlayKey(e.y);
    }

    for (const [id, v] of structs) {
      if (!seen.has(id)) {
        v.root.destroy({ children: true });
        structs.delete(id);
      }
    }
  }

  function clearStructures(): void {
    if (structs.size === 0) return;
    for (const v of structs.values()) v.root.destroy({ children: true });
    structs.clear();
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  function update(sample: WorldSample | null, nowMs: number): void {
    // Static sea rebuilds only on a pan/zoom/resize (signature change); foam is
    // the sole per-frame sea redraw.
    drawSeaStatic();
    drawSeaFoam(nowMs);
    if (sample === null) {
      clearStructures();
      return;
    }
    updateStructures(sample, nowMs);
  }

  function resize(w: number, h: number): void {
    // The static sea is keyed off a signature that includes the viewport size
    // (via seaStaticSignature), so a resize is picked up on the next update.
    // Invalidate explicitly so the rebuild can't be missed if the camera's
    // setViewport hasn't propagated yet this frame.
    void w;
    void h;
    seaStaticSig = '';
  }

  return { view, update, resize };
}

// ---------------------------------------------------------------------------
// Re-exports so the gallery can import everything render-world owns from one
// module path if it prefers (drawStructure / drawWaterPatch are the contract
// names).
// ---------------------------------------------------------------------------

export { drawStructure } from './structures.js';
export { ROLE_HEIGHT_RATIO };

/**
 * drawWaterPatch — the contract draw helper for the gallery's water swatch /
 * depth-ramp strip. Renders one tile of animated, depth-shaded sea into `g`
 * for the given SCREEN rect, where `depth01` selects the base color and
 * `nowMs` drives the foam shimmer. Self-contained (no camera) so the gallery
 * can lay out swatches at any size.
 */
export function drawWaterPatch(
  g: Graphics,
  rect: { x: number; y: number; w: number; h: number },
  nowMs: number,
  depth01 = 0.6,
): void {
  g.rect(rect.x, rect.y, rect.w, rect.h).fill(waterAt(depth01));
  // A couple of horizontal foam ribbons drifting across the patch.
  for (const layer of WAVE_LAYERS) {
    const period = Math.max(8, layer.step * 0.06);
    const drift = (nowMs * layer.speed * period * 4) % period;
    for (let y = rect.y - period + drift; y < rect.y + rect.h; y += period) {
      if (y < rect.y || y > rect.y + rect.h) continue;
      const shimmer = layer.alpha * 3 * (0.6 + 0.4 * Math.sin(nowMs * layer.speed * 6 + y * 0.05));
      g.rect(rect.x, y, rect.w, Math.max(1, layer.height * 0.5)).fill({ color: WATER_FOAM, alpha: shimmer });
    }
  }
  // Subtle inner rim so the swatch reads as a contained tile.
  g.rect(rect.x, rect.y, rect.w, rect.h).stroke({ width: 1, color: scale(waterAt(depth01), 1.4), alpha: 0.4 });
}
