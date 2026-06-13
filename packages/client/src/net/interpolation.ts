/**
 * Snapshot interpolation: server-clock estimation, keyframe+delta resolution
 * into full frames, and `sampleWorld` — the ONLY way client-render reads the
 * world (per docs/ARCH.md "Interpolation contract").
 *
 * - Every snapshot/delta arrival is stamped; an EWMA over
 *   `arrivalMs - tick * MS_PER_TICK` estimates the server clock so
 *   `serverTickAt(nowMs)` keeps advancing smoothly between messages.
 * - Frames are kept in a ring buffer of the last 64 RESOLVED frames
 *   (`{ tick, entities: Map, projectiles }`). Deltas chain off
 *   `lastAppliedTick`; a `baseTick` mismatch (only possible around a
 *   reconnect) drops deltas until the next keyframe (worst case ~1 s).
 * - `sampleWorld(nowMs)` renders RECOMMENDED_INTERP_DELAY_MS behind the
 *   estimated newest tick, lerping the two bracketing frames: entities in
 *   both frames lerp x/y and shortest-arc facing; newest-only entities snap
 *   to their newest position; older-only entities are omitted (render fades
 *   via death events). Projectiles likewise, matched by id.
 *
 * No game logic lives here: frames are verbatim server data, lerped.
 */

import { RECOMMENDED_INTERP_DELAY_MS, TICK_RATE, wrapAngle } from '@bships/core';
import type { SnapshotDeltaMessage, SnapshotEntity, SnapshotMessage, SnapshotProjectile } from '@bships/core';

export const MS_PER_TICK = 1000 / TICK_RATE;

/** Ring buffer length: 64 frames = 3.2 s at 20 ticks/s. */
const FRAME_BUFFER_SIZE = 64;

/** EWMA gain for the server-clock offset (per message, ~20/s in match). */
const CLOCK_ALPHA = 0.08;

/** EWMA gain for the arrival-jitter estimate. */
const JITTER_ALPHA = 0.1;

/** Offset jumps beyond this snap the clock instead of slewing (reconnects). */
const CLOCK_SNAP_MS = 1000;

export interface InterpFrame {
  tick: number;
  entities: Map<number, SnapshotEntity>;
  projectiles: SnapshotProjectile[];
}

/** One render-ready world sample; see docs/ARCH.md for field semantics. */
export interface WorldSample {
  /** Interpolated sim tick (also the HUD cooldown clock). */
  tickFloat: number;
  entities: SnapshotEntity[];
  projectiles: SnapshotProjectile[];
}

let frames: InterpFrame[] = [];
let lastAppliedTick: number | null = null;
/** True until the first keyframe, and again after a delta gap. */
let awaitingKeyframe = true;
/** EWMA of `arrivalMs - tick * MS_PER_TICK`; null until the first sample. */
let clockOffsetMs: number | null = null;
/** EWMA of |offset residual| — message arrival jitter in ms. */
let jitterMs = 0;

function updateClock(tick: number, arrivalMs: number): void {
  const sample = arrivalMs - tick * MS_PER_TICK;
  if (clockOffsetMs === null || Math.abs(sample - clockOffsetMs) > CLOCK_SNAP_MS) {
    clockOffsetMs = sample;
    jitterMs = 0;
    return;
  }
  const residual = sample - clockOffsetMs;
  clockOffsetMs += CLOCK_ALPHA * residual;
  jitterMs += JITTER_ALPHA * (Math.abs(residual) - jitterMs);
}

function pushFrame(frame: InterpFrame): void {
  const newest = frames[frames.length - 1];
  if (newest !== undefined && frame.tick <= newest.tick) {
    // Out-of-order tick can only mean a NEW match (sim restarts near 0) or a
    // resumed session — the incoming frame is authoritative, restart clean.
    frames = [];
    clockOffsetMs = null;
    jitterMs = 0;
  }
  frames.push(frame);
  if (frames.length > FRAME_BUFFER_SIZE) frames.splice(0, frames.length - FRAME_BUFFER_SIZE);
}

/** Full keyframe: always applicable, ends any delta-gap stall. */
export function ingestSnapshot(msg: SnapshotMessage, arrivalMs: number): void {
  const entities = new Map<number, SnapshotEntity>();
  for (const entity of msg.entities) entities.set(entity.id, entity);
  pushFrame({ tick: msg.tick, entities, projectiles: msg.projectiles });
  lastAppliedTick = msg.tick;
  awaitingKeyframe = false;
  updateClock(msg.tick, arrivalMs);
}

/**
 * Delta against `lastAppliedTick`. Returns false (and stalls until the next
 * keyframe) when the chain is broken — per protocol.ts the client must not
 * guess across a gap.
 */
export function ingestDelta(msg: SnapshotDeltaMessage, arrivalMs: number): boolean {
  if (awaitingKeyframe || msg.baseTick !== lastAppliedTick) {
    awaitingKeyframe = true;
    return false;
  }
  const base = frames[frames.length - 1];
  if (base === undefined) {
    awaitingKeyframe = true;
    return false;
  }
  const entities = new Map(base.entities);
  for (const entity of msg.upserts) entities.set(entity.id, entity);
  for (const id of msg.removed) entities.delete(id);
  pushFrame({ tick: msg.tick, entities, projectiles: msg.projectiles });
  lastAppliedTick = msg.tick;
  updateClock(msg.tick, arrivalMs);
  return true;
}

/** Estimated sim tick on the server at `nowMs` (performance.now domain). */
export function serverTickAt(nowMs: number): number {
  if (clockOffsetMs === null) return 0;
  return (nowMs - clockOffsetMs) / MS_PER_TICK;
}

/** The render-time tick: RECOMMENDED_INTERP_DELAY_MS behind the server. */
export function renderTickAt(nowMs: number): number {
  return serverTickAt(nowMs) - RECOMMENDED_INTERP_DELAY_MS / MS_PER_TICK;
}

/** EWMA arrival jitter in ms — feeds the connection-quality readout. */
export function clockJitterMs(): number {
  return jitterMs;
}

export function newestFrameTick(): number | null {
  const newest = frames[frames.length - 1];
  return newest === undefined ? null : newest.tick;
}

export function frameCount(): number {
  return frames.length;
}

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

/** Shortest-arc angular interpolation (facing is radians, CCW). */
function lerpFacing(a: number, b: number, alpha: number): number {
  return a + wrapAngle(b - a) * alpha;
}

/**
 * Sample the interpolated world at `nowMs`. Returns null before the first
 * keyframe. Render calls this once per rAF; the HUD reads `tickFloat` for
 * cooldown sweeps. Entries are fresh objects — callers may not mutate frame
 * data through them, and must not cache across frames.
 */
export function sampleWorld(nowMs: number): WorldSample | null {
  const oldest = frames[0];
  const newest = frames[frames.length - 1];
  if (oldest === undefined || newest === undefined) return null;

  let t = renderTickAt(nowMs);
  if (t < oldest.tick) t = oldest.tick;
  if (t > newest.tick) t = newest.tick;

  // Bracket: older = last frame with tick <= t, newer = the one after it.
  let older = oldest;
  let newer = newest;
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    if (frame !== undefined && frame.tick <= t) {
      older = frame;
      const next = frames[i + 1];
      newer = next ?? frame;
      break;
    }
  }

  const span = newer.tick - older.tick;
  const alpha = span === 0 ? 0 : (t - older.tick) / span;

  const entities: SnapshotEntity[] = [];
  for (const entity of newer.entities.values()) {
    const prev = older === newer ? undefined : older.entities.get(entity.id);
    if (prev === undefined) {
      // Just appeared (spawn or entered vision): newest position, no lerp.
      entities.push({ ...entity });
    } else {
      entities.push({
        ...entity,
        x: lerp(prev.x, entity.x, alpha),
        y: lerp(prev.y, entity.y, alpha),
        facing: lerpFacing(prev.facing, entity.facing, alpha),
      });
    }
  }

  const olderProjectiles = new Map<number, SnapshotProjectile>();
  if (older !== newer) {
    for (const projectile of older.projectiles) olderProjectiles.set(projectile.id, projectile);
  }
  const projectiles: SnapshotProjectile[] = [];
  for (const projectile of newer.projectiles) {
    const prev = olderProjectiles.get(projectile.id);
    if (prev === undefined) {
      projectiles.push({ ...projectile });
    } else {
      projectiles.push({
        ...projectile,
        x: lerp(prev.x, projectile.x, alpha),
        y: lerp(prev.y, projectile.y, alpha),
      });
    }
  }

  return { tickFloat: t, entities, projectiles };
}

/** Clear everything (match end / leave room / new match). */
export function resetInterpolation(): void {
  frames = [];
  lastAppliedTick = null;
  awaitingKeyframe = true;
  clockOffsetMs = null;
  jitterMs = 0;
}
