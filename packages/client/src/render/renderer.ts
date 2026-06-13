/**
 * Renderer entry (docs/ARCH.md "Module: client-render"): creates the Pixi v8
 * Application inside #stage and runs the per-frame loop:
 *
 *   updateCamera(dt) -> sampleWorld(performance.now()) -> update layers
 *
 * Pure display: the world comes exclusively from client-net's sampleWorld
 * (frames are never read directly), commands leave via pointer.ts ->
 * sendCommand. The pseudo-3D scene composes bottom-up (docs/RENDER.md):
 *
 *   world (layered depth-shaded sea + coast + elevated y-sorted structures)
 *     -> units (ships/creeps/summons/wards, shadows + raised superstructure)
 *     -> fx    (projectile tracers + pooled combat effects)
 *     -> fog   (cosmetic multiply dim outside friendly vision)
 *
 * Each world object carries its own drop shadow and y-sorts via depth.depthKey
 * inside its layer; cross-layer order is fixed by the addChild order above
 * (structures on the water < units floating on it < airborne fx < fog on top).
 * Heights/standing-up come from depth.heightOffsetPx — never raw world-unit
 * screenY offsets (that was the giant-flag bug, now fixed in structures.ts).
 *
 * The renderer is started once per page (first snapshot) and stays alive
 * across matches: when interpolation resets (back to lobby), sampleWorld
 * returns null and every layer empties itself.
 */

import { Application } from 'pixi.js';

import { getCatalog } from '../catalog.js';
import { sampleWorld } from '../net/interpolation.js';
import { store } from '../net/store.js';
import { attachCameraInput, setViewport, snapCamera, updateCamera } from './camera.js';
import { createFog } from './fog.js';
import { createFx } from './fx.js';
import { attachPointer } from './pointer.js';
import { createUnits } from './units.js';
import { createWorld } from './world.js';

let initialized = false;

/** Center the camera on this client's spawn (fallback: map center). */
function placeInitialCamera(): void {
  const map = getCatalog().map;
  const slot = store.match.mySlot;
  const start = slot === null ? undefined : map.playerStarts[slot];
  if (start !== undefined) {
    snapCamera(start.x, start.y, 1);
  } else {
    const b = map.bounds;
    snapCamera((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 1);
  }
}

export async function initRenderer(opts: { mount: HTMLElement }): Promise<void> {
  if (initialized) return;
  initialized = true;

  const app = new Application();
  await app.init({
    resizeTo: opts.mount,
    background: 0x050d16,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  opts.mount.appendChild(app.canvas);

  setViewport(app.screen.width, app.screen.height);

  // Layers, bottom-up. world owns the sea + coast + all structures; units the
  // ships/creeps/summons/wards; fx the projectiles + combat effects; fog the
  // cosmetic vision dim on top.
  const world = createWorld(app.renderer);
  const units = createUnits();
  const fx = createFx();
  const fog = createFog(app.renderer);
  app.stage.addChild(world.view, units.view, fx.view, fog.view);

  app.renderer.on('resize', (w: number, h: number) => {
    setViewport(w, h);
    world.resize(w, h);
    fog.resize(w, h);
  });

  attachCameraInput(app.canvas);
  attachPointer(app.canvas);
  placeInitialCamera();

  app.ticker.add((ticker) => {
    updateCamera(ticker.deltaMS);
    const nowMs = performance.now();
    const sample = sampleWorld(nowMs);
    world.update(sample, nowMs);
    units.update(sample, nowMs);
    fx.update(sample, nowMs);
    fog.update(sample);
  });
}
