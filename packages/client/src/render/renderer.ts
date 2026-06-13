/**
 * Renderer entry (docs/ARCH.md "Module: client-render"): creates the Pixi v8
 * Application inside #stage and runs the per-frame loop:
 *
 *   updateCamera(dt) -> sampleWorld(performance.now()) -> update layers
 *
 * Pure display: the world comes exclusively from client-net's sampleWorld
 * (frames are never read directly), commands leave via pointer.ts ->
 * sendCommand. Layer order bottom-up: water, entities (y-sorted),
 * projectiles, effects, fog (cosmetic multiply dim on top of the world).
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
import { createEntities } from './entities.js';
import { createEffects } from './effects.js';
import { createFog } from './fog.js';
import { attachPointer } from './pointer.js';
import { createProjectiles } from './projectiles.js';
import { createWater } from './water.js';

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

  const water = createWater();
  const entities = createEntities();
  const projectiles = createProjectiles();
  const effects = createEffects();
  const fog = createFog(app.renderer);
  app.stage.addChild(water.view, entities.view, projectiles.view, effects.view, fog.view);

  app.renderer.on('resize', (w: number, h: number) => {
    setViewport(w, h);
    fog.resize(w, h);
  });

  attachCameraInput(app.canvas);
  attachPointer(app.canvas);
  placeInitialCamera();

  app.ticker.add((ticker) => {
    updateCamera(ticker.deltaMS);
    const nowMs = performance.now();
    const sample = sampleWorld(nowMs);
    water.update(nowMs);
    entities.update(sample, nowMs);
    projectiles.update(sample, nowMs);
    effects.update(sample, nowMs);
    fog.update(sample);
  });
}
