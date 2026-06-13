/**
 * Object pools for the FX layer (packages/client/docs/RENDER.md "render-fx
 * spec" -> Pooling). Particles, projectile tracers, and effect sprites churn
 * fast; allocating + `destroy()`ing a fresh Pixi object per spawn thrashes the
 * GC and leaks GPU buffers. Instead every short-lived display object is drawn
 * from a free-list pool: `acquire()` reuses a parked instance (or makes one
 * once), `release()` parks it for reuse, and only `destroy()` (layer teardown)
 * ever actually frees the GPU resources.
 *
 * Two pieces:
 *
 *  1. `Pool<T extends Container>` — a typed free-list keyed on a `create`
 *     factory + `reset` hook. The pool keeps its own parent Container so the
 *     caller adds `pool.view` to the stage once; acquire attaches a child and
 *     makes it visible, release detaches+hides it. A `cap` bounds the number
 *     of LIVE (acquired) instances: under pressure `acquire` recycles the
 *     OLDEST live instance instead of growing without bound, so a runaway
 *     spawn rate can never balloon the particle count (the perf guard from the
 *     spec). Parked (free) instances are unbounded only up to the high-water
 *     mark of simultaneous live ones, which `cap` already bounds.
 *
 *  2. `TrackingPool<T>` — a thin convenience over `Pool` for the common case
 *     of "spawn, live for a fixed lifetime, auto-release on expiry". It owns
 *     the live set and an `update(nowMs, drawFn)` that ages every live entry
 *     and releases the expired ones, so fx.ts effect families don't each
 *     re-implement the same age/cull loop.
 *
 * NO DOM imports; only `pixi.js`. The aging/expiry math is pure and tested
 * directly; the pixi parts are exercised against real (headless-constructable)
 * Container instances.
 */

import { Container } from 'pixi.js';

/** Default ceiling on simultaneously-live instances per pool. */
export const DEFAULT_POOL_CAP = 256;

export interface PoolOptions<T extends Container> {
  /** Build a brand-new instance (called at most `cap` times over a lifetime). */
  create(): T;
  /**
   * Reset an instance to a clean, invisible state when it is released back to
   * the free list (clear Graphics, reset alpha/scale/tint). Optional.
   */
  reset?(item: T): void;
  /** Max simultaneously-live instances; oldest live recycled under pressure. */
  cap?: number;
}

/**
 * A free-list object pool over Pixi display objects. The pool owns a `view`
 * Container that the FX layer mounts once; acquired children are visible in
 * it, released children are detached and hidden.
 */
export class Pool<T extends Container> {
  /** Mount this once on the stage; acquired instances live here. */
  readonly view: Container;

  private readonly factory: () => T;
  private readonly resetItem: ((item: T) => void) | undefined;
  private readonly cap: number;

  /** Parked, reusable instances (detached from view). */
  private readonly free: T[] = [];
  /** Currently-acquired instances, oldest first (recycle order). */
  private readonly live: T[] = [];
  /** Total instances ever constructed (live + free) — for tests/metrics. */
  private created = 0;

  constructor(opts: PoolOptions<T>) {
    this.view = new Container();
    this.factory = opts.create;
    this.resetItem = opts.reset;
    this.cap = opts.cap ?? DEFAULT_POOL_CAP;
  }

  /** Live (acquired) instance count. */
  get liveCount(): number {
    return this.live.length;
  }

  /** Parked (reusable) instance count. */
  get freeCount(): number {
    return this.free.length;
  }

  /** Total constructed so far — should plateau once steady-state is reached. */
  get createdCount(): number {
    return this.created;
  }

  /**
   * Take an instance from the free list (or build one if none free and the
   * cap allows). At cap, recycle the OLDEST live instance: it is reset and
   * handed back as a fresh acquisition so the live count never exceeds `cap`.
   */
  acquire(): T {
    let item = this.free.pop();
    if (item === undefined) {
      if (this.live.length >= this.cap) {
        // Pressure: steal the oldest live instance instead of growing.
        const oldest = this.live.shift()!;
        if (this.resetItem !== undefined) this.resetItem(oldest);
        item = oldest;
      } else {
        item = this.factory();
        this.created += 1;
        this.view.addChild(item);
      }
    }
    item.visible = true;
    this.live.push(item);
    return item;
  }

  /**
   * Park an instance back on the free list. Idempotent: releasing an instance
   * that is not currently live is a no-op (so double-release is safe).
   */
  release(item: T): void {
    const idx = this.live.indexOf(item);
    if (idx === -1) return;
    this.live.splice(idx, 1);
    if (this.resetItem !== undefined) this.resetItem(item);
    item.visible = false;
    this.free.push(item);
  }

  /** Release every live instance (e.g. on sample === null / match reset). */
  releaseAll(): void {
    // Iterate a copy because release mutates `live`.
    for (const item of [...this.live]) this.release(item);
  }

  /**
   * Tear the pool down for good: destroy every instance (live + free) and the
   * owning view. Call ONLY on layer teardown — never per particle.
   */
  destroy(): void {
    for (const item of this.live) item.destroy({ children: true });
    for (const item of this.free) item.destroy({ children: true });
    this.live.length = 0;
    this.free.length = 0;
    this.view.destroy({ children: true });
  }
}

/**
 * One live, time-bounded entry in a TrackingPool: the pooled display object
 * plus its spawn time, lifetime, and an arbitrary `data` payload the draw
 * callback reads (world position, size, direction, ...).
 */
export interface TrackedEntry<T extends Container, D> {
  item: T;
  bornMs: number;
  durationMs: number;
  data: D;
}

/**
 * Normalized age of an entry in [0, 1]; >= 1 means expired. Pure — the core
 * of the cull loop, tested directly.
 */
export function ageOf(bornMs: number, durationMs: number, nowMs: number): number {
  if (durationMs <= 0) return 1;
  const t = (nowMs - bornMs) / durationMs;
  return t < 0 ? 0 : t;
}

/**
 * A Pool plus a live-entry list with automatic expiry. `spawn` acquires an
 * instance and records its lifetime + payload; `update` ages every entry,
 * calls `draw(item, t01, data, nowMs)` for the survivors, and releases the
 * expired ones back to the pool. This is the shared spine for every transient
 * fx family (muzzle flash, splash, explosion, pillar, ...).
 */
export class TrackingPool<T extends Container, D> {
  readonly pool: Pool<T>;
  private readonly entries: TrackedEntry<T, D>[] = [];

  constructor(opts: PoolOptions<T>) {
    this.pool = new Pool<T>(opts);
  }

  get view(): Container {
    return this.pool.view;
  }

  /** Number of currently-live (un-expired) entries. */
  get liveCount(): number {
    return this.entries.length;
  }

  /** Spawn a tracked instance; returns it in case the caller wants to seed it. */
  spawn(bornMs: number, durationMs: number, data: D): T {
    const item = this.pool.acquire();
    // If the pool recycled an instance that was tracked here, drop the stale
    // entry so we never double-track one display object.
    const stale = this.entries.findIndex((e) => e.item === item);
    if (stale !== -1) this.entries.splice(stale, 1);
    this.entries.push({ item, bornMs, durationMs, data });
    return item;
  }

  /**
   * Age every entry; draw survivors via `draw`, release the expired. `draw`
   * receives the normalized age t01 in [0,1) so animations are time-based.
   */
  update(
    nowMs: number,
    draw: (item: T, t01: number, data: D, nowMs: number) => void,
  ): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      const t = ageOf(e.bornMs, e.durationMs, nowMs);
      if (t >= 1) {
        this.entries.splice(i, 1);
        this.pool.release(e.item);
        continue;
      }
      draw(e.item, t, e.data, nowMs);
    }
  }

  /** Drop + release every live entry (match reset). */
  clear(): void {
    this.entries.length = 0;
    this.pool.releaseAll();
  }

  destroy(): void {
    this.entries.length = 0;
    this.pool.destroy();
  }
}
