/**
 * Transient effects, driven by the store's SimEvent fan-out (docs/ARCH.md):
 *   - death:   expanding ring + flash, sized by the victim's catalog maxHp
 *   - hit:     small impact tick at the target's current position
 *   - levelUp: golden pillar on the leveling player's ship
 *   - respawn: splash ring at the revived ship
 *
 * Events that need an entity position (hit/levelUp/respawn) are queued and
 * resolved against the next frame's sample; unresolvable ones (target not
 * visible) expire quietly after a second. Everything draws into one
 * screen-space Graphics per frame.
 */

import { Graphics } from 'pixi.js';
import type { SimEvent } from '@bships/core';

import { getCatalog } from '../catalog.js';
import type { WorldSample } from '../net/interpolation.js';
import { onEvent } from '../net/store.js';
import { FORESHORTEN, getCamera } from './camera.js';

const PENDING_TTL_MS = 1000;

type EffectKind = 'deathRing' | 'hitTick' | 'levelUpPillar' | 'respawnSplash';

interface Effect {
  kind: EffectKind;
  x: number;
  y: number;
  bornMs: number;
  durationMs: number;
  /** World-unit base radius (death ring scale) or generic size. */
  size: number;
}

interface PendingEvent {
  event: SimEvent;
  bornMs: number;
}

export interface EffectsLayer {
  view: Graphics;
  update(sample: WorldSample | null, nowMs: number): void;
  destroy(): void;
}

/** Death visual scale from the victim's catalog maxHp (event has no hp). */
function deathRingRadius(entityTypeId: string): number {
  const catalog = getCatalog();
  const maxHp =
    catalog.ships[entityTypeId]?.maxHp ?? catalog.unitTypes[entityTypeId]?.maxHp ?? 500;
  const r = 24 + Math.sqrt(maxHp) * 1.6;
  return Math.min(170, Math.max(36, r));
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export function createEffects(): EffectsLayer {
  const view = new Graphics();
  let effects: Effect[] = [];
  let pending: PendingEvent[] = [];

  const unsubscribe = onEvent((event: SimEvent) => {
    const bornMs = performance.now();
    switch (event.type) {
      case 'death':
        effects.push({
          kind: 'deathRing',
          x: event.x,
          y: event.y,
          bornMs,
          durationMs: 700,
          size: deathRingRadius(event.entityTypeId),
        });
        break;
      case 'hit':
      case 'levelUp':
      case 'respawn':
        pending.push({ event, bornMs });
        break;
      default:
        break;
    }
  });

  function resolvePending(sample: WorldSample, nowMs: number): void {
    const keep: PendingEvent[] = [];
    for (const p of pending) {
      if (nowMs - p.bornMs > PENDING_TTL_MS) continue;
      const e = p.event;
      let entityId: number | null = null;
      let kind: EffectKind = 'hitTick';
      let durationMs = 220;
      let size = 9;
      if (e.type === 'hit') {
        entityId = e.targetEntityId;
        size = Math.min(16, 7 + Math.sqrt(Math.max(0, e.amount)) * 0.6);
      } else if (e.type === 'levelUp') {
        kind = 'levelUpPillar';
        durationMs = 900;
        size = 30;
        const owner = sample.entities.find(
          (en) => en.kind === 'ship' && en.ownerSlot === e.player,
        );
        entityId = owner?.id ?? null;
      } else if (e.type === 'respawn') {
        kind = 'respawnSplash';
        durationMs = 600;
        size = 55;
        entityId = e.entityId;
      }
      if (entityId === null) {
        keep.push(p);
        continue;
      }
      const target = sample.entities.find((en) => en.id === entityId);
      if (target === undefined) {
        keep.push(p); // not visible yet — retry until TTL
        continue;
      }
      effects.push({ kind, x: target.x, y: target.y, bornMs: nowMs, durationMs, size });
    }
    pending = keep;
  }

  function draw(nowMs: number): void {
    const cam = getCamera();
    const zoom = cam.zoom;
    const alive: Effect[] = [];
    for (const fx of effects) {
      const t = (nowMs - fx.bornMs) / fx.durationMs;
      if (t >= 1) continue;
      alive.push(fx);
      const sp = cam.worldToScreen(fx.x, fx.y);
      switch (fx.kind) {
        case 'deathRing': {
          const r = fx.size * easeOutCubic(t) * zoom;
          view
            .ellipse(sp.x, sp.y, r, r * FORESHORTEN)
            .stroke({ width: Math.max(1.5, 5 * (1 - t)), color: 0xffffff, alpha: 0.8 * (1 - t) });
          if (t < 0.3) {
            const flashA = (1 - t / 0.3) * 0.7;
            view
              .ellipse(sp.x, sp.y, fx.size * 0.55 * zoom, fx.size * 0.55 * zoom * FORESHORTEN)
              .fill({ color: 0xffd28a, alpha: flashA });
          }
          break;
        }
        case 'hitTick': {
          const a = 1 - t;
          const r = fx.size * zoom;
          for (let i = 0; i < 3; i++) {
            const ang = -Math.PI / 2 + (i - 1) * 0.9;
            view
              .moveTo(sp.x + Math.cos(ang) * r * 0.35, sp.y + Math.sin(ang) * r * 0.35)
              .lineTo(sp.x + Math.cos(ang) * r, sp.y + Math.sin(ang) * r)
              .stroke({ width: 2, color: 0xfff2c0, alpha: a });
          }
          break;
        }
        case 'levelUpPillar': {
          const a = t < 0.7 ? 1 : (1 - t) / 0.3;
          const h = 120 * zoom * easeOutCubic(Math.min(1, t * 2));
          const w = fx.size * zoom * (1 - t * 0.4);
          view
            .rect(sp.x - w / 2, sp.y - h, w, h)
            .fill({ color: 0xf2c14e, alpha: 0.35 * a });
          view
            .rect(sp.x - w / 6, sp.y - h, w / 3, h)
            .fill({ color: 0xfff2d0, alpha: 0.55 * a });
          view
            .ellipse(sp.x, sp.y, w * 0.9, w * 0.9 * FORESHORTEN)
            .stroke({ width: 2, color: 0xf2c14e, alpha: 0.7 * a });
          break;
        }
        case 'respawnSplash': {
          const r = fx.size * easeOutCubic(t) * zoom;
          view
            .ellipse(sp.x, sp.y, r, r * FORESHORTEN)
            .stroke({ width: 3 * (1 - t) + 1, color: 0x9fd0ff, alpha: 0.8 * (1 - t) });
          for (let i = 0; i < 5; i++) {
            const ang = (i / 5) * Math.PI * 2 + 0.5;
            const dr = r * 1.15;
            view
              .circle(sp.x + Math.cos(ang) * dr, sp.y + Math.sin(ang) * dr * FORESHORTEN, 2.5 * zoom)
              .fill({ color: 0xbfe3ff, alpha: 0.7 * (1 - t) });
          }
          break;
        }
      }
    }
    effects = alive;
  }

  function update(sample: WorldSample | null, nowMs: number): void {
    view.clear();
    if (sample !== null) resolvePending(sample, nowMs);
    else pending = [];
    draw(nowMs);
  }

  return {
    view,
    update,
    destroy(): void {
      unsubscribe();
      effects = [];
      pending = [];
    },
  };
}
