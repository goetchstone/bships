/**
 * render-fx tests. Two halves:
 *
 *  - PURE MATH (no pixi, no DOM): the parabola/arc, flight-progress, screen
 *    heading squash, death/impact sizing, easing, and the pool aging helper.
 *  - POOLING + FX BEHAVIOUR: exercised against real (headless-constructable)
 *    Pixi Container/Graphics instances and the live camera singleton. Covers
 *    acquire/release/reuse identity, the cap recycling the OLDEST live
 *    instance (no unbounded growth), TrackingPool expiry, and the
 *    muzzle-flash spawn heuristic (first frame a projectile id is seen) plus
 *    the death-event -> explosion intake and damage-flash on hit.
 *
 * The camera and store are module singletons; each pooling test resets them.
 */

import { Container, Graphics } from 'pixi.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SimEvent, SnapshotEntity, SnapshotProjectile } from '@bships/core';

import type { WorldSample } from '../src/net/interpolation.js';
import { resetStoreForTest } from '../src/net/store.js';
import { applyServerMessage } from '../src/net/store.js';
import { FORESHORTEN, resetCameraForTest, snapCamera } from '../src/render/camera.js';
import {
  cannonArcLift,
  createFx,
  deathRingRadius,
  easeOutCubic,
  flightProgress,
  impactRadius,
  screenHeading,
  spawnDamageFlash,
  spawnExplosion,
  spawnImpactSplash,
  spawnLevelUpPillar,
  spawnMuzzleFlash,
  spawnRespawnSplash,
  worldHeading,
} from '../src/render/fx.js';
import { Pool, TrackingPool, ageOf } from '../src/render/pool.js';

// ===========================================================================
// Pure math
// ===========================================================================

describe('fx arc / parabola math', () => {
  it('cannonArcLift is a parabola: zero at the ends, peak at the middle', () => {
    expect(cannonArcLift(0)).toBe(0);
    expect(cannonArcLift(1)).toBe(0);
    expect(cannonArcLift(0.5, 26)).toBeCloseTo(26, 6);
    // Symmetric about the midpoint.
    expect(cannonArcLift(0.25, 40)).toBeCloseTo(cannonArcLift(0.75, 40), 6);
    // Monotonic up to the peak.
    expect(cannonArcLift(0.4, 20)).toBeGreaterThan(cannonArcLift(0.2, 20));
    expect(cannonArcLift(0.5, 20)).toBeGreaterThan(cannonArcLift(0.4, 20));
  });

  it('cannonArcLift clamps progress to [0,1]', () => {
    expect(cannonArcLift(-1, 30)).toBe(0);
    expect(cannonArcLift(2, 30)).toBe(0);
  });

  it('flightProgress is the clamped travelled/nominal ratio', () => {
    expect(flightProgress(0, 1000)).toBe(0);
    expect(flightProgress(500, 1000)).toBeCloseTo(0.5, 6);
    expect(flightProgress(2000, 1000)).toBe(1);
    expect(flightProgress(50, 0)).toBe(1); // degenerate nominal distance
  });

  it('easeOutCubic is 0..1 monotone increasing and clamps', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-5)).toBe(0);
    expect(easeOutCubic(5)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5); // ease-OUT front-loads
  });
});

describe('fx heading math', () => {
  it('worldHeading returns 0 for no motion and atan2 otherwise', () => {
    expect(worldHeading(0, 0)).toBe(0);
    expect(worldHeading(1, 0)).toBeCloseTo(0, 6); // east
    expect(worldHeading(0, 1)).toBeCloseTo(Math.PI / 2, 6); // north
  });

  it('screenHeading folds FORESHORTEN into the heading and flips y', () => {
    // Due east: cos>0, sin=0 -> screen rotation 0 regardless of foreshorten.
    expect(screenHeading(0)).toBeCloseTo(0, 6);
    // Due north (world +y): y-flip makes it point screen-up (negative).
    expect(screenHeading(Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 6);
    // A 45° world heading is squashed toward the horizontal on screen, so the
    // magnitude of the screen angle is LESS than 45° (foreshorten < 1).
    const s = Math.abs(screenHeading(Math.PI / 4));
    expect(s).toBeLessThan(Math.PI / 4);
    expect(s).toBeCloseTo(Math.atan2(Math.sin(Math.PI / 4) * FORESHORTEN, Math.cos(Math.PI / 4)), 6);
  });
});

describe('fx sizing from catalog', () => {
  it('deathRingRadius grows with maxHp and is clamped to a sane band', () => {
    const small = deathRingRadius('H000'); // 200g starter, low hp
    const big = deathRingRadius('H00C'); // 16000g pirate, high hp
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThanOrEqual(36);
    expect(big).toBeLessThanOrEqual(170);
  });

  it('deathRingRadius falls back to a mid value for unknown typeIds', () => {
    const r = deathRingRadius('ZZZZ');
    expect(r).toBeGreaterThanOrEqual(36);
    expect(r).toBeLessThanOrEqual(170);
  });

  it('impactRadius grows with damage amount, clamped', () => {
    expect(impactRadius(0)).toBeCloseTo(8, 6);
    expect(impactRadius(100)).toBeGreaterThan(impactRadius(10));
    expect(impactRadius(100000)).toBeLessThanOrEqual(20);
    expect(impactRadius(-50)).toBe(8); // negative clamped to 0 damage
  });
});

// ===========================================================================
// pool.ts — Pool aging + acquire/release/reuse + cap
// ===========================================================================

describe('pool ageOf', () => {
  it('is 0 before birth-window start, ramps to 1 at duration end', () => {
    expect(ageOf(100, 200, 100)).toBe(0);
    expect(ageOf(100, 200, 200)).toBeCloseTo(0.5, 6);
    expect(ageOf(100, 200, 300)).toBeCloseTo(1, 6);
    expect(ageOf(100, 200, 50)).toBe(0); // before born -> clamped to 0
  });

  it('treats a non-positive duration as already expired', () => {
    expect(ageOf(0, 0, 0)).toBe(1);
    expect(ageOf(0, -10, 5)).toBe(1);
  });
});

describe('Pool acquire / release / reuse', () => {
  it('reuses the SAME instance after release (no new allocation)', () => {
    const pool = new Pool<Graphics>({ create: () => new Graphics() });
    const a = pool.acquire();
    expect(pool.liveCount).toBe(1);
    expect(pool.createdCount).toBe(1);
    pool.release(a);
    expect(pool.liveCount).toBe(0);
    expect(pool.freeCount).toBe(1);
    const b = pool.acquire();
    expect(b).toBe(a); // reused identity
    expect(pool.createdCount).toBe(1); // no new instance built
  });

  it('mounts acquired children under view and toggles visibility', () => {
    const pool = new Pool<Graphics>({ create: () => new Graphics() });
    const g = pool.acquire();
    expect(pool.view.children).toContain(g);
    expect(g.visible).toBe(true);
    pool.release(g);
    expect(g.visible).toBe(false);
    // Released instances stay parented (reused in place) — only hidden.
    expect(pool.view.children).toContain(g);
  });

  it('release is idempotent and ignores foreign instances', () => {
    const pool = new Pool<Graphics>({ create: () => new Graphics() });
    const g = pool.acquire();
    pool.release(g);
    pool.release(g); // double release: no-op
    expect(pool.freeCount).toBe(1);
    pool.release(new Graphics()); // never acquired: no-op
    expect(pool.freeCount).toBe(1);
  });

  it('caps LIVE instances and recycles the OLDEST under pressure', () => {
    let resets = 0;
    const pool = new Pool<Graphics>({
      create: () => new Graphics(),
      reset: () => {
        resets += 1;
      },
      cap: 3,
    });
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect(pool.liveCount).toBe(3);
    expect(pool.createdCount).toBe(3);
    // Fourth acquire at cap: recycles the OLDEST live (a), no growth.
    const d = pool.acquire();
    expect(pool.liveCount).toBe(3); // never exceeds cap
    expect(pool.createdCount).toBe(3); // no new instance built
    expect(d).toBe(a); // oldest recycled and handed back
    expect(resets).toBe(1); // recycled instance was reset once
    // b and c are still live; d (==a) is now the newest.
    expect(b).not.toBe(d);
    expect(c).not.toBe(d);
  });

  it('runaway spawns never grow beyond cap (no unbounded growth)', () => {
    const pool = new Pool<Graphics>({ create: () => new Graphics(), cap: 8 });
    for (let i = 0; i < 1000; i++) pool.acquire();
    expect(pool.liveCount).toBe(8);
    expect(pool.createdCount).toBe(8);
    expect(pool.view.children.length).toBe(8);
  });

  it('releaseAll parks every live instance for reuse', () => {
    const pool = new Pool<Graphics>({ create: () => new Graphics(), cap: 8 });
    pool.acquire();
    pool.acquire();
    pool.acquire();
    pool.releaseAll();
    expect(pool.liveCount).toBe(0);
    expect(pool.freeCount).toBe(3);
    // Subsequent acquires reuse, not allocate.
    pool.acquire();
    expect(pool.createdCount).toBe(3);
  });
});

describe('TrackingPool expiry', () => {
  it('releases entries back to the pool when their lifetime elapses', () => {
    const tp = new TrackingPool<Graphics, { v: number }>({ create: () => new Graphics() });
    tp.spawn(0, 100, { v: 1 });
    tp.spawn(0, 100, { v: 2 });
    expect(tp.liveCount).toBe(2);
    expect(tp.pool.liveCount).toBe(2);

    let drawn = 0;
    tp.update(50, () => {
      drawn += 1;
    });
    expect(drawn).toBe(2); // both still alive at t=0.5
    expect(tp.liveCount).toBe(2);

    drawn = 0;
    tp.update(100, () => {
      drawn += 1;
    });
    // At t>=1 both expire: released, not drawn.
    expect(drawn).toBe(0);
    expect(tp.liveCount).toBe(0);
    expect(tp.pool.liveCount).toBe(0);
    expect(tp.pool.freeCount).toBe(2); // reusable

    // Reuse: a fresh spawn pulls from the free list, no new allocation.
    tp.spawn(200, 100, { v: 3 });
    expect(tp.pool.createdCount).toBe(2);
  });

  it('passes the normalized age and payload to the draw callback', () => {
    const tp = new TrackingPool<Graphics, { v: number }>({ create: () => new Graphics() });
    tp.spawn(1000, 200, { v: 42 });
    let seenT = -1;
    let seenV = -1;
    tp.update(1100, (_g, t01, data) => {
      seenT = t01;
      seenV = data.v;
    });
    expect(seenT).toBeCloseTo(0.5, 6);
    expect(seenV).toBe(42);
  });
});

// ===========================================================================
// createFx — projectiles, muzzle-flash heuristic, event intake
// ===========================================================================

function sample(
  entities: SnapshotEntity[],
  projectiles: SnapshotProjectile[],
): WorldSample {
  return { tickFloat: 0, entities, projectiles };
}

function projectile(
  id: number,
  x: number,
  y: number,
  mechanic: SnapshotProjectile['mechanic'] = 'nativeAttack',
): SnapshotProjectile {
  return { id, weaponId: 'w', mechanic, x, y, team: 'south' };
}

function ship(id: number, x: number, y: number, ownerSlot = 2): SnapshotEntity {
  return {
    id,
    kind: 'ship',
    typeId: 'H000',
    x,
    y,
    facing: 0,
    hp: 500,
    maxHp: 500,
    team: 'south',
    ownerSlot,
    statuses: [],
  };
}

describe('createFx projectiles + muzzle-flash heuristic', () => {
  beforeEach(() => {
    resetCameraForTest(1600, 900);
    snapCamera(0, 0, 1);
    resetStoreForTest();
  });

  it('mounts a sortable view and survives a null sample (match reset)', () => {
    const fx = createFx();
    expect(fx.view).toBeInstanceOf(Container);
    expect(fx.view.sortableChildren).toBe(true);
    // Should not throw and should clear cleanly.
    fx.update(null, 0);
    fx.update(sample([], []), 16);
    fx.update(null, 32);
    fx.destroy();
  });

  it('does NOT flash on the very first frame a projectile is seen (no heading yet)', () => {
    const fx = createFx() as ReturnType<typeof createFx> & {
      _muzzle: TrackingPool<Graphics, unknown>;
    };
    // Frame 1: projectile appears. We have no heading, so defer the flash.
    fx.update(sample([], [projectile(1, 100, 0)]), 16);
    expect(fx._muzzle.liveCount).toBe(0);
  });

  it('flashes exactly once on the SECOND frame (first frame with a heading)', () => {
    const fx = createFx() as ReturnType<typeof createFx> & {
      _muzzle: TrackingPool<Graphics, unknown>;
    };
    fx.update(sample([], [projectile(1, 100, 0)]), 16);
    // Frame 2: projectile moved -> heading known -> exactly one flash.
    fx.update(sample([], [projectile(1, 140, 0)]), 32);
    expect(fx._muzzle.liveCount).toBe(1);
    // Frame 3: still in flight, must NOT flash again.
    fx.update(sample([], [projectile(1, 180, 0)]), 48);
    expect(fx._muzzle.liveCount).toBe(1);
  });

  it('forgets a projectile id when it vanishes (a recycled id re-triggers)', () => {
    const fx = createFx() as ReturnType<typeof createFx> & {
      _muzzle: TrackingPool<Graphics, unknown>;
    };
    fx.update(sample([], [projectile(1, 100, 0)]), 16);
    fx.update(sample([], [projectile(1, 140, 0)]), 32);
    expect(fx._muzzle.liveCount).toBe(1);
    // Projectile gone; let the muzzle flash expire.
    fx.update(sample([], []), 400);
    expect(fx._muzzle.liveCount).toBe(0);
    // A NEW projectile reusing id 1 (next match) flashes again.
    fx.update(sample([], [projectile(1, 0, 0)]), 416);
    fx.update(sample([], [projectile(1, 40, 0)]), 432);
    expect(fx._muzzle.liveCount).toBe(1);
  });
});

describe('createFx event intake', () => {
  beforeEach(() => {
    resetCameraForTest(1600, 900);
    snapCamera(0, 0, 1);
    resetStoreForTest();
  });

  it('spawns an explosion on a death event', () => {
    const fx = createFx() as ReturnType<typeof createFx> & {
      _explosion: TrackingPool<Graphics, unknown>;
    };
    const ev: SimEvent = {
      type: 'death',
      tick: 1,
      entityId: 9,
      entityTypeId: 'H000',
      victimPlayer: 2,
      killerPlayer: 7,
      x: 200,
      y: -50,
    };
    // Route through the store's event fan-out exactly like a live snapshot.
    deliver(ev);
    expect(fx._explosion.liveCount).toBe(1);
    fx.update(sample([], []), 16);
    expect(fx._explosion.liveCount).toBe(1); // still mid-animation
  });

  it('spawns an impact splash AND a damage flash on a hit, once the target resolves', () => {
    const fx = createFx() as ReturnType<typeof createFx> & {
      _splash: TrackingPool<Graphics, unknown>;
      _damage: TrackingPool<Graphics, unknown>;
    };
    const ev: SimEvent = {
      type: 'hit',
      tick: 1,
      targetEntityId: 9,
      attackerPlayer: 7,
      weaponId: 'w',
      amount: 80,
    };
    deliver(ev);
    // Before the target is visible nothing is spawned (queued, pending).
    expect(fx._splash.liveCount).toBe(0);
    // Resolve against a sample containing the target.
    fx.update(sample([ship(9, 120, 30)], []), 16);
    expect(fx._splash.liveCount).toBe(1);
    expect(fx._damage.liveCount).toBe(1);
  });

  it('resolves a levelUp to a pillar on the leveling player ship', () => {
    const fx = createFx() as ReturnType<typeof createFx> & {
      _pillar: TrackingPool<Graphics, unknown>;
    };
    deliver({ type: 'levelUp', tick: 1, player: 2, level: 2 });
    fx.update(sample([ship(9, 0, 0, 2)], []), 16);
    expect(fx._pillar.liveCount).toBe(1);
  });

  it('resolves a respawn to a pillar/splash on the revived entity', () => {
    const fx = createFx() as ReturnType<typeof createFx> & {
      _pillar: TrackingPool<Graphics, unknown>;
    };
    deliver({ type: 'respawn', tick: 1, player: 2, entityId: 9 });
    fx.update(sample([ship(9, 0, 0, 2)], []), 16);
    expect(fx._pillar.liveCount).toBe(1);
  });

  it('resolves many pending events in one frame via the per-frame entity index', () => {
    const fx = createFx() as ReturnType<typeof createFx> & {
      _splash: TrackingPool<Graphics, unknown>;
      _damage: TrackingPool<Graphics, unknown>;
      _pillar: TrackingPool<Graphics, unknown>;
    };
    // A teamfight burst: several hits + a levelUp + a respawn queued together.
    deliver({ type: 'hit', tick: 1, targetEntityId: 9, attackerPlayer: 7, weaponId: 'w', amount: 40 });
    deliver({ type: 'hit', tick: 1, targetEntityId: 10, attackerPlayer: 7, weaponId: 'w', amount: 40 });
    deliver({ type: 'hit', tick: 1, targetEntityId: 11, attackerPlayer: 7, weaponId: 'w', amount: 40 });
    deliver({ type: 'levelUp', tick: 1, player: 2, level: 2 });
    deliver({ type: 'respawn', tick: 1, player: 5, entityId: 12 });
    // One update resolves all of them against the same indexed sample.
    fx.update(
      sample(
        [ship(9, 10, 0), ship(10, 20, 0), ship(11, 30, 0), ship(8, 0, 0, 2), ship(12, 40, 0)],
        [],
      ),
      16,
    );
    expect(fx._splash.liveCount).toBe(3); // one per hit
    expect(fx._damage.liveCount).toBe(3);
    expect(fx._pillar.liveCount).toBe(2); // levelUp + respawn share the pool
  });
});

describe('createFx named spawners (gallery-callable)', () => {
  beforeEach(() => {
    resetCameraForTest(1600, 900);
    snapCamera(0, 0, 1);
    resetStoreForTest();
  });

  it('each spawner pushes one entry into its family pool', () => {
    const fx = createFx() as ReturnType<typeof createFx> & {
      _muzzle: TrackingPool<Graphics, unknown>;
      _splash: TrackingPool<Graphics, unknown>;
      _explosion: TrackingPool<Graphics, unknown>;
      _damage: TrackingPool<Graphics, unknown>;
      _pillar: TrackingPool<Graphics, unknown>;
    };
    spawnMuzzleFlash(fx, 10, 20, 0, 'north');
    spawnImpactSplash(fx, 30, 40);
    spawnExplosion(fx, 50, 60, 80, 'south');
    spawnDamageFlash(fx, 70, 80);
    spawnLevelUpPillar(fx, 0, 0);
    spawnRespawnSplash(fx, 0, 0);
    expect(fx._muzzle.liveCount).toBe(1);
    expect(fx._splash.liveCount).toBe(1);
    expect(fx._explosion.liveCount).toBe(1);
    expect(fx._damage.liveCount).toBe(1);
    expect(fx._pillar.liveCount).toBe(2); // pillar + respawn share the pool
    // Drawing them does not throw (real Graphics, live camera).
    fx.update(sample([], []), 16);
  });
});

// ---------------------------------------------------------------------------
// Helper: deliver a SimEvent through the store fan-out (createFx subscribes
// via onEvent in its constructor, so we route a snapshot through applyServer).
// ---------------------------------------------------------------------------
function deliver(event: SimEvent): void {
  applyServerMessage(
    {
      type: 'snapshot',
      tick: 1,
      you: {
        slot: 2,
        team: 'south',
      } as never,
      entities: [],
      projectiles: [],
      events: [event],
      players: [],
    },
    performance.now(),
  );
}
