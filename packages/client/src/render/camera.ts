/**
 * The camera: the ONLY world<->screen transform code in the app
 * (docs/ARCH.md "Coordinate conventions", binding):
 *
 *   screenX = (worldX - cam.x) * zoom + viewport.w / 2
 *   screenY = (cam.y - worldY) * zoom * FORESHORTEN + viewport.h / 2
 *
 * +y north flips to screen-up; FORESHORTEN = 0.82 is the 2.5D vertical
 * squash of the world plane. Zoom clamps to [0.5, 2.0] with wheel
 * zoom-to-cursor (the world point under the cursor stays fixed across the
 * zoom). Pan: edge scroll (12 px window margins), middle-drag, and
 * panTo(...) from the HUD minimap. All camera motion converges via an
 * exponential lerp (~10/s) toward target values; targets are clamped to
 * getCatalog().map.bounds plus a small margin.
 *
 * No pixi.js imports — the transform math is pure and unit-tested; renderer
 * wires `attachCameraInput` to the canvas and calls `updateCamera` per rAF.
 */

import { getCatalog } from '../catalog.js';
import { FORESHORTEN } from './viz.js';

export { FORESHORTEN };

export const MIN_ZOOM = 0.32;
export const MAX_ZOOM = 3.0;

/** Default zoom when a match starts (close enough that your ship reads big). */
export const DEFAULT_ZOOM = 1.7;

/**
 * After a manual pan, the camera resumes following the player ship once the
 * player has left the camera alone for this long. "center and follow."
 */
const FOLLOW_RESUME_MS = 2500;

/** Exponential smoothing rate (per second) for x/y/zoom convergence. */
const SMOOTH_PER_S = 10;

/** Edge-scroll trigger margin (px from the window edge). */
const EDGE_MARGIN_PX = 12;

/** Edge-scroll speed in SCREEN px/s (world speed scales with 1/zoom). */
const EDGE_SPEED_PX_PER_S = 1100;

/** Wheel sensitivity: zoom factor = exp(-deltaY * this). */
const WHEEL_ZOOM_RATE = 0.0012;

/** Camera center may overshoot the map bounds by this many world units. */
const BOUNDS_MARGIN = 256;

/** Frozen API (docs/ARCH.md): HUD reads this read-mostly. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
  worldToScreen(x: number, y: number): { x: number; y: number };
  screenToWorld(sx: number, sy: number): { x: number; y: number };
  /** Smooth pan (minimap click); use snapCamera for instant placement. */
  panTo(worldX: number, worldY: number): void;
  viewportWorldRect(): { minX: number; minY: number; maxX: number; maxY: number };
}

interface CameraState {
  x: number;
  y: number;
  zoom: number;
  targetX: number;
  targetY: number;
  targetZoom: number;
  viewportW: number;
  viewportH: number;
  /** Last pointer position over the canvas (CSS px), for edge scroll. */
  pointer: { x: number; y: number } | null;
  /** Middle-drag in progress (suspends edge scroll). */
  dragging: boolean;
  inputAttached: boolean;
  /** World point the camera follows (own ship); null = nothing to follow. */
  followX: number | null;
  followY: number | null;
  /** Whether the camera is currently locked onto the follow target. */
  following: boolean;
  /** ms since the last manual camera input, for follow-resume. */
  idleMs: number;
  /** ms left in the opening establishing shot (0 = not playing an intro). */
  introMsLeft: number;
  /** zoom to ease into when the intro ends. */
  introFinalZoom: number;
}

const state: CameraState = {
  x: 0,
  y: 0,
  zoom: 1,
  targetX: 0,
  targetY: 0,
  targetZoom: 1,
  viewportW: typeof window === 'undefined' ? 1280 : window.innerWidth,
  viewportH: typeof window === 'undefined' ? 720 : window.innerHeight,
  pointer: null,
  dragging: false,
  inputAttached: false,
  followX: null,
  followY: null,
  following: true,
  idleMs: 0,
  introMsLeft: 0,
  introFinalZoom: 1,
};

/** Mark that the player just took manual camera control (pauses follow). */
function manualControl(): void {
  state.following = false;
  state.idleMs = 0;
  state.introMsLeft = 0; // any manual input cancels the establishing shot
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampTarget(): void {
  const b = getCatalog().map.bounds;
  state.targetX = clamp(state.targetX, b.minX - BOUNDS_MARGIN, b.maxX + BOUNDS_MARGIN);
  state.targetY = clamp(state.targetY, b.minY - BOUNDS_MARGIN, b.maxY + BOUNDS_MARGIN);
  state.targetZoom = clamp(state.targetZoom, MIN_ZOOM, MAX_ZOOM);
}

function worldToScreen(wx: number, wy: number): { x: number; y: number } {
  return {
    x: (wx - state.x) * state.zoom + state.viewportW / 2,
    y: (state.y - wy) * state.zoom * FORESHORTEN + state.viewportH / 2,
  };
}

function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - state.viewportW / 2) / state.zoom + state.x,
    y: state.y - (sy - state.viewportH / 2) / (state.zoom * FORESHORTEN),
  };
}

const cameraApi: Camera = {
  get x(): number {
    return state.x;
  },
  get y(): number {
    return state.y;
  },
  get zoom(): number {
    return state.zoom;
  },
  worldToScreen,
  screenToWorld,
  panTo(worldX: number, worldY: number): void {
    manualControl();
    state.targetX = worldX;
    state.targetY = worldY;
    clampTarget();
  },
  viewportWorldRect(): { minX: number; minY: number; maxX: number; maxY: number } {
    const halfW = state.viewportW / (2 * state.zoom);
    const halfH = state.viewportH / (2 * state.zoom * FORESHORTEN);
    return {
      minX: state.x - halfW,
      minY: state.y - halfH,
      maxX: state.x + halfW,
      maxY: state.y + halfH,
    };
  },
};

/** The camera singleton (frozen API — HUD minimap imports this). */
export function getCamera(): Camera {
  return cameraApi;
}

/** Current canvas size in CSS px (water/fog need it for full-screen draws). */
export function getViewportSize(): { w: number; h: number } {
  return { w: state.viewportW, h: state.viewportH };
}

/** Renderer calls this on init and every renderer resize. */
export function setViewport(w: number, h: number): void {
  state.viewportW = Math.max(1, w);
  state.viewportH = Math.max(1, h);
}

/** Instant placement (match start: center on own spawn). */
export function snapCamera(x: number, y: number, zoom?: number): void {
  state.targetX = x;
  state.targetY = y;
  if (zoom !== undefined) state.targetZoom = zoom;
  clampTarget();
  state.x = state.targetX;
  state.y = state.targetY;
  state.zoom = state.targetZoom;
  // Match start centers on the spawn and locks follow on.
  state.followX = x;
  state.followY = y;
  state.following = true;
  state.idleMs = 0;
}

/**
 * The renderer reports the player's own ship position every frame. The camera
 * keeps it centered while `following`; after a manual pan it resumes following
 * once the player has been idle for FOLLOW_RESUME_MS.
 */
export function setFollowTarget(x: number, y: number): void {
  state.followX = x;
  state.followY = y;
}

/** Re-engage follow immediately (bound to a recenter hotkey + minimap dbl). */
export function recenterOnPlayer(): void {
  state.following = true;
  state.idleMs = 0;
}

/**
 * Play an opening "establishing shot": snap to (cx, cy) at the wide
 * `introZoom` so the player sees the battlefield (land, lanes, their base),
 * hold for `holdMs`, then ease into `finalZoom` following their ship. Any
 * manual camera input cancels it. Match-start only.
 */
export function startIntro(
  cx: number,
  cy: number,
  introZoom: number,
  finalZoom: number,
  holdMs: number,
): void {
  snapCamera(cx, cy, introZoom);
  state.following = false; // hold the wide frame; don't chase the ship yet
  state.introMsLeft = holdMs;
  state.introFinalZoom = finalZoom;
}

/**
 * Zoom by `factor` keeping the world point under (sx, sy) fixed. Operates on
 * TARGET values; current values converge there, so the anchor point holds
 * once the smoothing settles (and visibly tracks during it).
 */
export function zoomAt(sx: number, sy: number, factor: number): void {
  const z0 = state.targetZoom;
  const z1 = clamp(z0 * factor, MIN_ZOOM, MAX_ZOOM);
  if (z1 === z0) return;
  // World point under the cursor in target space.
  const wx = (sx - state.viewportW / 2) / z0 + state.targetX;
  const wy = state.targetY - (sy - state.viewportH / 2) / (z0 * FORESHORTEN);
  state.targetZoom = z1;
  state.targetX = wx - (sx - state.viewportW / 2) / z1;
  state.targetY = wy + (sy - state.viewportH / 2) / (z1 * FORESHORTEN);
  clampTarget();
}

/**
 * Middle-drag pan by a screen-pixel delta: the world point under the
 * pointer follows the pointer 1:1, so this moves current AND target.
 */
export function dragBy(dxPx: number, dyPx: number): void {
  manualControl();
  state.targetX -= dxPx / state.zoom;
  state.targetY += dyPx / (state.zoom * FORESHORTEN);
  clampTarget();
  state.x = state.targetX;
  state.y = state.targetY;
}

/** Per-frame camera step: edge scroll + exponential convergence. */
export function updateCamera(dtMs: number): void {
  const dt = Math.min(100, Math.max(0, dtMs)) / 1000;

  // Opening establishing shot: hold the wide frame, then hand off to follow.
  if (state.introMsLeft > 0) {
    state.introMsLeft -= dtMs;
    if (state.introMsLeft > 0) {
      const ki = 1 - Math.exp(-SMOOTH_PER_S * dt);
      state.x += (state.targetX - state.x) * ki;
      state.y += (state.targetY - state.y) * ki;
      state.zoom += (state.targetZoom - state.zoom) * ki;
      return;
    }
    // Intro over: ease into the follow zoom and re-engage follow.
    state.targetZoom = state.introFinalZoom;
    state.following = true;
    state.idleMs = 0;
  }

  if (state.pointer !== null && !state.dragging) {
    const { x: px, y: py } = state.pointer;
    const speed = (EDGE_SPEED_PX_PER_S * dt) / state.zoom;
    let dx = 0;
    let dy = 0;
    if (px <= EDGE_MARGIN_PX) dx -= speed;
    else if (px >= state.viewportW - EDGE_MARGIN_PX) dx += speed;
    if (py <= EDGE_MARGIN_PX) dy += speed / FORESHORTEN;
    else if (py >= state.viewportH - EDGE_MARGIN_PX) dy -= speed / FORESHORTEN;
    if (dx !== 0 || dy !== 0) {
      manualControl();
      state.targetX += dx;
      state.targetY += dy;
      clampTarget();
    }
  }

  // Follow the player's ship. After a manual pan, resume following once the
  // player has left the camera idle for FOLLOW_RESUME_MS.
  if (!state.following && !state.dragging) {
    state.idleMs += dtMs;
    if (state.idleMs >= FOLLOW_RESUME_MS) state.following = true;
  }
  if (state.following && state.followX !== null && state.followY !== null) {
    state.targetX = state.followX;
    state.targetY = state.followY;
    clampTarget();
  }

  const k = 1 - Math.exp(-SMOOTH_PER_S * dt);
  state.x += (state.targetX - state.x) * k;
  state.y += (state.targetY - state.y) * k;
  state.zoom += (state.targetZoom - state.zoom) * k;
}

/**
 * Wire wheel zoom, middle-drag pan and edge-scroll pointer tracking to the
 * Pixi canvas. Canvas-only events per the DOM ownership contract; keyboard
 * stays with client-hud's keymap.
 */
export function attachCameraInput(canvas: HTMLCanvasElement): void {
  if (state.inputAttached) return;
  state.inputAttached = true;

  let lastDrag: { x: number; y: number } | null = null;

  const localPos = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      const pos = localPos(e);
      zoomAt(pos.x, pos.y, Math.exp(-e.deltaY * WHEEL_ZOOM_RATE));
    },
    { passive: false },
  );

  // Block the browser's middle-click autoscroll affordance.
  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  });

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    state.dragging = true;
    lastDrag = localPos(e);
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    const pos = localPos(e);
    state.pointer = pos;
    if (state.dragging && lastDrag !== null) {
      dragBy(pos.x - lastDrag.x, pos.y - lastDrag.y);
      lastDrag = pos;
    }
  });

  const endDrag = (e: PointerEvent): void => {
    if (e.button === 1 || e.type === 'pointercancel') {
      state.dragging = false;
      lastDrag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!state.dragging) state.pointer = null;
  });
}

/** Test helper: reset the singleton (viewport, position, zoom, input). */
export function resetCameraForTest(viewportW = 1600, viewportH = 900): void {
  state.viewportW = viewportW;
  state.viewportH = viewportH;
  state.x = 0;
  state.y = 0;
  state.zoom = 1;
  state.targetX = 0;
  state.targetY = 0;
  state.targetZoom = 1;
  state.pointer = null;
  state.dragging = false;
  state.followX = null;
  state.followY = null;
  state.following = true;
  state.idleMs = 0;
  state.introMsLeft = 0;
  state.introFinalZoom = 1;
}
