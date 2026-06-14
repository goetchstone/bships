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
import {
  attachCameraInput,
  DEFAULT_ZOOM,
  setFollowTarget,
  setViewport,
  startIntro,
  updateCamera,
} from './camera.js';
import { createFieldOverlay } from './fieldoverlay.js';
import { createFog } from './fog.js';
import { createFx } from './fx.js';
import { createLand } from './land.js';
import { attachPointer } from './pointer.js';
import { createUnits } from './units.js';
import { createWorld } from './world.js';

let initialized = false;

/** Establishing shot of the player's base + lanes/land ahead, then ease into
 *  the follow zoom — so the player sees the battlefield (and that there IS
 *  land) at match start instead of spawning blind in their home water pocket. */
function placeInitialCamera(): void {
  const map = getCatalog().map;
  const slot = store.match.mySlot;
  const start = slot === null ? undefined : map.playerStarts[slot];
  const b = map.bounds;
  const cx = start !== undefined ? start.x : (b.minX + b.maxX) / 2;
  const cy = start !== undefined ? start.y : (b.minY + b.maxY) / 2;
  // Pull the framing toward the map centre so the lanes + central land are in
  // shot alongside the base.
  const mapCenterY = (b.minY + b.maxY) / 2;
  const towardCentreY = cy + Math.sign(mapCenterY - cy) * 1800;
  startIntro(cx, towardCentreY, 0.42, DEFAULT_ZOOM, 2600);
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
  const land = createLand();
  const fieldOverlay = createFieldOverlay();
  const units = createUnits();
  const fx = createFx();
  const fog = createFog(app.renderer);
  // Land sits inside world.view, above the sea + foam and below the structures
  // (so coastal towers/HQ/shops stay visible on top of the land masses).
  world.addLandLayer(land.view);
  // fieldOverlay (lane ribbons / contested centre / trader routes) sits ON the
  // water, ABOVE world+land and BELOW units, so the legibility lines read under
  // the ships without occluding them. Owned by the LEGIBILITY module.
  app.stage.addChild(world.view, fieldOverlay.view, units.view, fx.view, fog.view);

  app.renderer.on('resize', (w: number, h: number) => {
    setViewport(w, h);
    world.resize(w, h);
    land.resize(w, h);
    fieldOverlay.resize(w, h);
    fog.resize(w, h);
  });

  attachCameraInput(app.canvas);
  attachPointer(app.canvas);
  placeInitialCamera();

  app.ticker.add((ticker) => {
    const nowMs = performance.now();
    const sample = sampleWorld(nowMs);
    // Keep the camera centered on the player's own ship (center + follow).
    if (sample !== null) {
      const mySlot = store.match.mySlot;
      if (mySlot !== null) {
        const own = sample.entities.find(
          (e) => e.kind === 'ship' && e.ownerSlot === mySlot,
        );
        if (own !== undefined) setFollowTarget(own.x, own.y);
      }
    }
    updateCamera(ticker.deltaMS);
    world.update(sample, nowMs);
    land.update(sample, nowMs);
    fieldOverlay.update(sample, nowMs);
    units.update(sample, nowMs);
    fx.update(sample, nowMs);
    fog.update(sample);
  });
}
