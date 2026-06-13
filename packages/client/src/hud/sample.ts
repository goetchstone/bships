/**
 * Thin HUD-side wrapper over client-net's interpolation sampler. The HUD
 * reads the world ONLY through this (shop proximity, minimap dots, cooldown
 * clock) — it never touches net's frame ring buffer directly.
 */

import type { SnapshotEntity, SnapshotProjectile } from '@bships/core';
import { sampleWorld } from '../net/interpolation.js';

export interface HudSample {
  /** Interpolated sim tick (the HUD's cooldown clock). */
  tickFloat: number;
  entities: SnapshotEntity[];
  projectiles: SnapshotProjectile[];
}

/**
 * Sample the interpolated world; null before the first snapshot. Normalizes
 * the entity collection to an array regardless of how net exposes it.
 */
export function hudSample(nowMs: number): HudSample | null {
  const raw = sampleWorld(nowMs) as unknown as {
    tickFloat?: number;
    entities?: SnapshotEntity[] | Map<number, SnapshotEntity>;
    projectiles?: SnapshotProjectile[];
  } | null;
  if (raw === null || raw === undefined || typeof raw.tickFloat !== 'number') return null;
  const entities =
    raw.entities instanceof Map ? [...raw.entities.values()] : (raw.entities ?? []);
  return { tickFloat: raw.tickFloat, entities, projectiles: raw.projectiles ?? [] };
}
