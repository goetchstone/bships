/**
 * Projectile tracers, lerped by client-net (sampleWorld matches them by id).
 * Per mechanic (docs/ARCH.md):
 *   - phoenixFire:   orange dot + fading trail
 *   - stormBolt:     cyan elongated bolt oriented along its heading
 *   - kaboomMissile: large missile body + flame tail + smoke puffs
 *   - nativeAttack:  small plain shot
 * One Graphics redrawn per frame in screen space; per-projectile state is
 * only the recent world-position trail (for heading + trails + smoke).
 */

import { Graphics } from 'pixi.js';
import type { SnapshotProjectile } from '@bships/core';

import type { WorldSample } from '../net/interpolation.js';
import { FORESHORTEN, getCamera } from './camera.js';
import { TEAM_HEX, headingRad, mixColor } from './viz.js';

const TRAIL_MAX = 8;
const SMOKE_LIFE_MS = 650;
const SMOKE_EVERY_MS = 70;

interface Tracked {
  trail: { x: number; y: number }[];
  lastSmokeMs: number;
}

interface Smoke {
  x: number;
  y: number;
  bornMs: number;
}

export interface ProjectileLayer {
  view: Graphics;
  update(sample: WorldSample | null, nowMs: number): void;
}

export function createProjectiles(): ProjectileLayer {
  const view = new Graphics();
  const tracked = new Map<number, Tracked>();
  let smoke: Smoke[] = [];

  function heading(t: Tracked, p: SnapshotProjectile): number {
    const prev = t.trail.length >= 2 ? t.trail[t.trail.length - 2] : undefined;
    if (prev === undefined) return 0;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    if (dx === 0 && dy === 0) return 0;
    return headingRad(dx, dy);
  }

  function update(sample: WorldSample | null, nowMs: number): void {
    view.clear();
    if (sample === null) {
      tracked.clear();
      smoke = [];
      return;
    }

    const cam = getCamera();
    const zoom = cam.zoom;
    const seen = new Set<number>();

    for (const p of sample.projectiles) {
      seen.add(p.id);
      let t = tracked.get(p.id);
      if (t === undefined) {
        t = { trail: [], lastSmokeMs: nowMs };
        tracked.set(p.id, t);
      }
      const last = t.trail[t.trail.length - 1];
      if (last === undefined || last.x !== p.x || last.y !== p.y) {
        t.trail.push({ x: p.x, y: p.y });
        if (t.trail.length > TRAIL_MAX) t.trail.shift();
      }

      const sp = cam.worldToScreen(p.x, p.y);
      const team = TEAM_HEX[p.team];
      // Screen rotation of the world heading (y-flip negates the angle), with
      // the plane squash folded in so tracers align with apparent motion.
      const h = heading(t, p);
      const rot = -Math.atan2(Math.sin(h) * FORESHORTEN, Math.cos(h));

      switch (p.mechanic) {
        case 'phoenixFire': {
          for (let i = 0; i < t.trail.length - 1; i++) {
            const seg = t.trail[i];
            if (seg === undefined) continue;
            const ss = cam.worldToScreen(seg.x, seg.y);
            const a = (i + 1) / t.trail.length;
            view.circle(ss.x, ss.y, 2.2 * zoom * a).fill({ color: 0xffb35c, alpha: 0.35 * a });
          }
          view.circle(sp.x, sp.y, 4 * zoom).fill(0xffd28a);
          view.circle(sp.x, sp.y, 2 * zoom).fill(0xfff2d0);
          break;
        }
        case 'stormBolt': {
          const len = 16 * zoom;
          const wHalf = 3 * zoom;
          const cos = Math.cos(rot);
          const sin = Math.sin(rot);
          const px = -sin * wHalf;
          const py = cos * wHalf;
          view
            .poly([
              sp.x + cos * len, sp.y + sin * len,
              sp.x + px, sp.y + py,
              sp.x - cos * len * 0.6, sp.y - sin * len * 0.6,
              sp.x - px, sp.y - py,
            ])
            .fill({ color: 0xbfe8ff, alpha: 0.95 });
          view.circle(sp.x, sp.y, 5 * zoom).fill({ color: 0x9fd0ff, alpha: 0.35 });
          break;
        }
        case 'kaboomMissile': {
          if (nowMs - t.lastSmokeMs >= SMOKE_EVERY_MS) {
            t.lastSmokeMs = nowMs;
            smoke.push({ x: p.x, y: p.y, bornMs: nowMs });
          }
          const len = 11 * zoom;
          const wHalf = 4 * zoom;
          const cos = Math.cos(rot);
          const sin = Math.sin(rot);
          const px = -sin * wHalf;
          const py = cos * wHalf;
          view
            .poly([
              sp.x + cos * len * 1.4, sp.y + sin * len * 1.4,
              sp.x + px, sp.y + py,
              sp.x - cos * len, sp.y - sin * len,
              sp.x - px, sp.y - py,
            ])
            .fill(mixColor(0x884444, TEAM_HEX[p.team], 0.35))
            .stroke({ width: 1.5, color: 0x331818 });
          // Flame tail.
          view
            .circle(sp.x - cos * len * 1.25, sp.y - sin * len * 1.25, 3.5 * zoom)
            .fill({ color: 0xffa040, alpha: 0.9 });
          break;
        }
        case 'nativeAttack': {
          view.circle(sp.x, sp.y, 3 * zoom).fill({ color: mixColor(0xffffff, team, 0.4), alpha: 0.9 });
          break;
        }
      }
    }

    for (const id of tracked.keys()) {
      if (!seen.has(id)) tracked.delete(id);
    }

    // Smoke puffs outlive their missiles, fading out.
    const alive: Smoke[] = [];
    for (const s of smoke) {
      const age = (nowMs - s.bornMs) / SMOKE_LIFE_MS;
      if (age >= 1) continue;
      alive.push(s);
      const ss = cam.worldToScreen(s.x, s.y);
      view
        .circle(ss.x, ss.y, (3 + age * 7) * zoom)
        .fill({ color: 0x777788, alpha: 0.28 * (1 - age) });
    }
    smoke = alive;
  }

  return { view, update };
}
