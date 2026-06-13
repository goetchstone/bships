/**
 * COSMETIC fog dim (docs/ARCH.md): multiply ~0.55 over world areas outside
 * any friendly entity's sightRadius circle in the CURRENT frame. The server
 * already vision-filters every snapshot — this layer reveals and hides
 * nothing; it only communicates "you have no eyes here".
 *
 * Implementation: a coarse offscreen RenderTexture (1/8 screen resolution)
 * is cleared to 55% gray, friendly sight circles are stamped white
 * (foreshortened to ellipses), and the texture is composited over the world
 * with 'multiply'. Linear filtering on the upscale gives soft edges free.
 */

import { Graphics, RenderTexture, Sprite } from 'pixi.js';
import type { Renderer } from 'pixi.js';

import { getCatalog } from '../catalog.js';
import type { WorldSample } from '../net/interpolation.js';
import { store } from '../net/store.js';
import { FORESHORTEN, getCamera } from './camera.js';

/** Screen px per fog texel. */
const COARSE = 8;

/** Multiply dim outside vision: 0x8c = 140/255 = 0.55. */
const DIM_GRAY = 0x8c8c8c;

const FALLBACK_SIGHT = 900;

export interface FogLayer {
  view: Sprite;
  update(sample: WorldSample | null): void;
  resize(w: number, h: number): void;
}

function sightRadiusOf(typeId: string): number {
  const catalog = getCatalog();
  return (
    catalog.ships[typeId]?.sightRadius ?? catalog.unitTypes[typeId]?.sightRadius ?? FALLBACK_SIGHT
  );
}

/**
 * Cheap signature of everything the fog texture depends on: the camera
 * transform and the set + positions of friendly (own-team) entities. While
 * this is unchanged the fog texture is identical, so the per-frame
 * scene-rebuild + render-to-texture pass can be skipped. Positions are rounded
 * to texel granularity (COARSE px) so sub-texel interpolation jitter doesn't
 * defeat the cache; fog is cosmetic and already lags the sim, so this is safe.
 * Pure (camera passed in) — unit-tested.
 */
export function fogSignature(
  sample: WorldSample | null,
  myTeam: string | null,
  cam: { x: number; y: number; zoom: number },
): string {
  if (sample === null || myTeam === null) return 'clear';
  let h = `${Math.round(cam.x)},${Math.round(cam.y)},${Math.round(cam.zoom * 1000)}`;
  for (const e of sample.entities) {
    if (e.team !== myTeam) continue;
    h += `;${e.id}:${Math.round(e.x / COARSE)},${Math.round(e.y / COARSE)}`;
  }
  return h;
}

export function createFog(renderer: Renderer): FogLayer {
  let texW = Math.max(2, Math.ceil(renderer.screen.width / COARSE));
  let texH = Math.max(2, Math.ceil(renderer.screen.height / COARSE));
  const texture = RenderTexture.create({ width: texW, height: texH });
  const scene = new Graphics();
  const view = new Sprite(texture);
  view.blendMode = 'multiply';
  view.scale.set(COARSE);

  /** Signature of the last rendered fog; '' forces a render (e.g. resize). */
  let lastSig = '';

  function update(sample: WorldSample | null): void {
    const myTeam = store.match.myTeam;
    const cam = getCamera();
    const sig = fogSignature(sample, myTeam, cam);
    if (sig === lastSig) return; // camera + friendly vision unchanged — reuse texture
    lastSig = sig;

    scene.clear();
    if (sample === null || myTeam === null) {
      // No data: no dimming (full white = multiply identity).
      scene.rect(0, 0, texW, texH).fill(0xffffff);
    } else {
      scene.rect(0, 0, texW, texH).fill(DIM_GRAY);
      for (const e of sample.entities) {
        if (e.team !== myTeam) continue;
        const sight = sightRadiusOf(e.typeId);
        const sp = cam.worldToScreen(e.x, e.y);
        scene
          .ellipse(
            sp.x / COARSE,
            sp.y / COARSE,
            (sight * cam.zoom) / COARSE,
            (sight * cam.zoom * FORESHORTEN) / COARSE,
          )
          .fill(0xffffff);
      }
    }
    renderer.render({ container: scene, target: texture, clear: true });
  }

  function resize(w: number, h: number): void {
    texW = Math.max(2, Math.ceil(w / COARSE));
    texH = Math.max(2, Math.ceil(h / COARSE));
    texture.resize(texW, texH);
    lastSig = ''; // viewport changed — force a re-render next update
  }

  return { view, update, resize };
}
