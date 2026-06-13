/**
 * render-fx: projectiles + transient combat effects, all object-pooled
 * (packages/client/docs/RENDER.md "render-fx spec"). Replaces the superseded
 * projectiles.ts + effects.ts. Owns one root Container with sub-pools per
 * effect family; the integrator mounts `createFx().view` between the units and
 * fog layers and calls `update(sample, nowMs)` every ticker frame.
 *
 * What lives here:
 *   - PROJECTILE tracers, lerped from `sample.projectiles` (matched by id like
 *     today). Per `mechanic`:
 *       nativeAttack   cannonball + cosmetic low parabolic screen-y arc over
 *                      its recent path + a shadow dot on the water beneath.
 *       phoenixFire    orange dot + fading trail.
 *       stormBolt      cyan oriented bolt (FORESHORTEN folded into the heading).
 *       kaboomMissile  missile body + flame tail + smoke puffs.
 *     All projectile drawing is into ONE batched Graphics redrawn per frame
 *     (projectiles are few — a dozen at most — so a per-frame clear is cheaper
 *     than pooling here; the pooling spec targets the high-churn PARTICLE
 *     effects below).
 *   - EFFECTS from `store.onEvent`, resolved against the sample with the same
 *     pending-queue pattern as the old effects.ts:
 *       death    explosion (expanding ring + flash + debris, sized by catalog
 *                maxHp via deathRingRadius).
 *       hit      impact splash/sparks at the target + a brief DAMAGE FLASH.
 *       levelUp  gold pillar.
 *       respawn  splash ring + sparkle.
 *     Each family is a TrackingPool of pooled Graphics (acquire on spawn,
 *     release on expiry; oldest recycled under cap pressure — no leaks).
 *   - MUZZLE FLASH: there is no "fired" sim event, so it is DERIVED — see the
 *     heuristic note below.
 *
 * DAMAGE-FLASH OWNERSHIP (decision, documented per the contract): fx OWNS the
 * damage flash and draws it itself, as a short additive tint pulse layered at
 * the unit's screen position. This keeps units.ts fully decoupled from the
 * event stream (no circular import, no shared mutable signal). `hit` events
 * already carry the target entity id; the pending-queue resolves the target's
 * interpolated position from the sample, exactly like the old hit tick, and
 * spawns BOTH an impact splash and a damage-flash pulse there.
 *
 * MUZZLE-FLASH HEURISTIC (decision, documented per the contract): the protocol
 * has no explicit weapon-fire event. We treat the FIRST FRAME a projectile id
 * is observed in `sample.projectiles` as its launch: on that frame we spawn a
 * one-shot muzzle flash at the projectile's then-position, oriented along its
 * initial heading (estimated from the next sample's motion, falling back to no
 * orientation on the very first frame). A projectile id is only ever "first
 * seen" once because ids are monotonic and `sampleWorld` reuses them while in
 * flight; once an id disappears it is forgotten so a recycled id (new match)
 * re-triggers correctly. Native cannonballs and missiles get the flash; the
 * channelled phoenixFire/stormBolt mechanics also flash on first sight (a tiny
 * spark reads fine as a cast cue).
 *
 * All animation is time-based off `nowMs` (the Pixi ticker clock), never match
 * tick state. Positions via `getCamera().worldToScreen`; pixel sizes * zoom;
 * tracer/effect ellipses foreshortened so they lie flat on the water plane.
 * zIndex for the airborne layer uses depth.depthKey(y, 'airborne').
 */

import { Container, Graphics } from 'pixi.js';
import type { SimEvent, SnapshotEntity, SnapshotProjectile, TeamId } from '@bships/core';

import { getCatalog } from '../catalog.js';
import type { WorldSample } from '../net/interpolation.js';
import { onEvent } from '../net/store.js';
import { FORESHORTEN, getCamera } from './camera.js';
import { depthKey } from './depth.js';
import { TrackingPool } from './pool.js';
import { GOLD, mix, TEAM_COLOR, WATER_FOAM } from './theme.js';

// ===========================================================================
// Tunables
// ===========================================================================

/** Recent-position trail length kept per projectile (heading + trails). */
const TRAIL_MAX = 8;

/** Missile smoke cadence + lifetime. */
const SMOKE_EVERY_MS = 70;
const SMOKE_LIFE_MS = 650;

/** Pending event queue TTL (target not yet visible -> retry until this). */
const PENDING_TTL_MS = 1000;

/** Cosmetic cannonball arc: peak screen-y LIFT (px at zoom 1) at mid-flight. */
const CANNON_ARC_PEAK_PX = 26;

/** Per-family particle caps (live instances; oldest recycled under pressure). */
const CAP = {
  muzzle: 48,
  splash: 96,
  explosion: 64,
  pillar: 16,
  damageFlash: 96,
} as const;

/** Effect lifetimes (ms). */
const LIFE = {
  muzzle: 160,
  splash: 380,
  explosion: 700,
  pillar: 900,
  respawn: 600,
  damageFlash: 240,
} as const;

// ===========================================================================
// Pure math (unit-tested; no pixi)
// ===========================================================================

/** Smooth 0..1 ease used by rings/pillars (matches the old easeOutCubic). */
export function easeOutCubic(t: number): number {
  const u = 1 - (t < 0 ? 0 : t > 1 ? 1 : t);
  return 1 - u * u * u;
}

/**
 * Cosmetic parabolic LIFT (screen-px, BEFORE zoom) for a cannonball given its
 * progress p in [0,1] along a flight. Zero at the ends, `peak` at the middle:
 * `4 * peak * p * (1 - p)`. Purely a screen-y offset stacked on the lerped
 * ground position so a cannonball reads as arcing over the water; it carries
 * NO gameplay meaning (the sim position is unchanged).
 */
export function cannonArcLift(p: number, peak = CANNON_ARC_PEAK_PX): number {
  const u = p < 0 ? 0 : p > 1 ? 1 : p;
  return 4 * peak * u * (1 - u);
}

/**
 * Flight progress estimate for a tracked projectile from how far it has
 * travelled along its recent trail. We don't know the true launch/impact
 * points, so progress is approximated as the fraction of a nominal flight
 * `nominalDist` (world units) the projectile has covered since first seen,
 * clamped to [0,1]. Good enough for a believable arc that flattens near the
 * target. Pure.
 */
export function flightProgress(distTravelled: number, nominalDist: number): number {
  if (nominalDist <= 0) return 1;
  const p = distTravelled / nominalDist;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/**
 * Screen rotation of a world heading with the plane squash folded in, matching
 * the old projectiles.ts: `-atan2(sin(h)*FORESHORTEN, cos(h))`. So a tracer
 * aligns with its APPARENT (foreshortened) motion on screen. Pure.
 */
export function screenHeading(worldHeadingRad: number, foreshorten = FORESHORTEN): number {
  return -Math.atan2(Math.sin(worldHeadingRad) * foreshorten, Math.cos(worldHeadingRad));
}

/** World-space heading from a motion delta (+x east, +y north). */
export function worldHeading(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  return Math.atan2(dy, dx);
}

/**
 * Death-explosion base radius (world units) from the victim's catalog maxHp —
 * identical mapping to the old effects.ts deathRingRadius so death blasts keep
 * a consistent scale. Falls back to a mid value for unknown typeIds.
 */
export function deathRingRadius(entityTypeId: string): number {
  const catalog = getCatalog();
  const maxHp =
    catalog.ships[entityTypeId]?.maxHp ?? catalog.unitTypes[entityTypeId]?.maxHp ?? 500;
  const r = 24 + Math.sqrt(maxHp) * 1.6;
  return Math.min(170, Math.max(36, r));
}

/** Impact-splash radius (world units) from a hit `amount` (clamped). */
export function impactRadius(amount: number): number {
  return Math.min(20, 8 + Math.sqrt(Math.max(0, amount)) * 0.7);
}

// ===========================================================================
// Internal state shapes
// ===========================================================================

interface Tracked {
  /** Recent world positions (newest last), for heading + trails + arc. */
  trail: { x: number; y: number }[];
  /** Cumulative world distance travelled since first seen (arc progress). */
  dist: number;
  lastSmokeMs: number;
  /** Set false after the launch frame so muzzle flash fires exactly once. */
  fresh: boolean;
}

interface Smoke {
  x: number;
  y: number;
  bornMs: number;
}

/** Payloads carried by each TrackingPool entry. */
interface MuzzleData {
  x: number;
  y: number;
  rot: number;
  color: number;
  zoomAtSpawn: number;
}
interface SplashData {
  x: number;
  y: number;
  rWorld: number;
}
interface ExplosionData {
  x: number;
  y: number;
  rWorld: number;
  color: number;
  seed: number;
}
interface PillarData {
  x: number;
  y: number;
  respawn: boolean;
}
interface DamageFlashData {
  x: number;
  y: number;
  rWorld: number;
}

interface PendingEvent {
  event: SimEvent;
  bornMs: number;
}

export interface FxLayer {
  view: Container;
  update(sample: WorldSample | null, nowMs: number): void;
  destroy(): void;
}

// ===========================================================================
// Pool factory helpers (each family is a TrackingPool of bare Graphics).
// ===========================================================================

function graphicsPool<D>(cap: number): TrackingPool<Graphics, D> {
  return new TrackingPool<Graphics, D>({
    create: () => new Graphics(),
    reset: (g) => {
      g.clear();
      g.alpha = 1;
      g.scale.set(1);
      g.rotation = 0;
    },
    cap,
  });
}

// ===========================================================================
// Factory
// ===========================================================================

export function createFx(): FxLayer {
  const view = new Container();
  view.sortableChildren = true;

  // One batched Graphics for projectile tracers (cleared+redrawn per frame).
  const projectileGfx = new Graphics();
  projectileGfx.zIndex = depthKey(0, 'airborne');

  // Pooled transient-effect families.
  const muzzle = graphicsPool<MuzzleData>(CAP.muzzle);
  const splash = graphicsPool<SplashData>(CAP.splash);
  const explosion = graphicsPool<ExplosionData>(CAP.explosion);
  const pillar = graphicsPool<PillarData>(CAP.pillar);
  const damage = graphicsPool<DamageFlashData>(CAP.damageFlash);

  // Smoke uses the batched Graphics (cheap, no pooling needed) like before.
  let smoke: Smoke[] = [];

  view.addChild(
    projectileGfx,
    muzzle.view,
    splash.view,
    explosion.view,
    damage.view,
    pillar.view,
  );

  const tracked = new Map<number, Tracked>();
  let pending: PendingEvent[] = [];

  // Per-frame entity index, reused across frames (cleared + refilled) so the
  // pending-event resolver does O(1) id/ownerSlot lookups instead of O(n)
  // Array.find per pending event — matters during a busy teamfight when many
  // hit events are pending at once. Only built when there is pending work.
  const byId = new Map<number, SnapshotEntity>();
  const byOwnerSlot = new Map<number, SnapshotEntity>();

  // --- event intake --------------------------------------------------------
  const unsubscribe = onEvent((event: SimEvent) => {
    const bornMs = performance.now();
    switch (event.type) {
      case 'death':
        spawnExplosion(api, event.x, event.y, deathRingRadius(event.entityTypeId));
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

  // --- pending-event resolution (needs entity positions from the sample) ---
  function resolvePending(sample: WorldSample, nowMs: number): void {
    if (pending.length === 0) return;
    // Index this frame's entities once (O(n)) so each pending event resolves in
    // O(1) instead of O(n) Array.find. levelUp needs an ownerSlot->ship map; we
    // only fill it when a levelUp is actually pending.
    const needOwner = pending.some((p) => p.event.type === 'levelUp');
    byId.clear();
    if (needOwner) byOwnerSlot.clear();
    for (const en of sample.entities) {
      byId.set(en.id, en);
      if (needOwner && en.kind === 'ship' && en.ownerSlot !== null) {
        // First ship per slot wins (a slot has at most one live ship).
        if (!byOwnerSlot.has(en.ownerSlot)) byOwnerSlot.set(en.ownerSlot, en);
      }
    }

    const keep: PendingEvent[] = [];
    for (const p of pending) {
      if (nowMs - p.bornMs > PENDING_TTL_MS) continue;
      const e = p.event;
      if (e.type === 'hit') {
        const target = byId.get(e.targetEntityId);
        if (target === undefined) {
          keep.push(p);
          continue;
        }
        spawnImpactSplash(api, target.x, target.y, impactRadius(e.amount));
        spawnDamageFlash(api, target.x, target.y);
      } else if (e.type === 'levelUp') {
        const owner = byOwnerSlot.get(e.player);
        if (owner === undefined) {
          keep.push(p);
          continue;
        }
        spawnPillar(api, owner.x, owner.y, false);
      } else if (e.type === 'respawn') {
        const target = byId.get(e.entityId);
        if (target === undefined) {
          keep.push(p);
          continue;
        }
        spawnPillar(api, target.x, target.y, true);
      }
    }
    pending = keep;
  }

  // --- projectiles ---------------------------------------------------------
  function headingOf(t: Tracked, p: SnapshotProjectile): number {
    const prev = t.trail.length >= 2 ? t.trail[t.trail.length - 2] : undefined;
    if (prev === undefined) return 0;
    return worldHeading(p.x - prev.x, p.y - prev.y);
  }

  function drawProjectiles(sample: WorldSample, nowMs: number): void {
    const cam = getCamera();
    const zoom = cam.zoom;
    const g = projectileGfx;
    g.clear();

    const seen = new Set<number>();
    for (const p of sample.projectiles) {
      seen.add(p.id);
      let t = tracked.get(p.id);
      const isNew = t === undefined;
      if (t === undefined) {
        t = { trail: [], dist: 0, lastSmokeMs: nowMs, fresh: true };
        tracked.set(p.id, t);
      }
      const last = t.trail[t.trail.length - 1];
      if (last === undefined || last.x !== p.x || last.y !== p.y) {
        if (last !== undefined) t.dist += Math.hypot(p.x - last.x, p.y - last.y);
        t.trail.push({ x: p.x, y: p.y });
        if (t.trail.length > TRAIL_MAX) t.trail.shift();
      }

      const team = TEAM_COLOR[p.team];
      const h = headingOf(t, p);
      const rot = screenHeading(h);
      const sp = cam.worldToScreen(p.x, p.y);

      // Muzzle flash on the first frame this id is seen (the launch heuristic).
      if (t.fresh && !isNew) {
        // We waited one frame so we have a heading; flash at the trail origin.
        const origin = t.trail[0] ?? { x: p.x, y: p.y };
        const so = cam.worldToScreen(origin.x, origin.y);
        muzzle.spawn(nowMs, LIFE.muzzle, {
          x: so.x,
          y: so.y,
          rot,
          color: mix(0xffffff, team, 0.35),
          zoomAtSpawn: zoom,
        });
        t.fresh = false;
      }

      drawTracer(g, p, t, sp, rot, team, zoom, nowMs);
    }

    // Forget vanished projectiles (id recycled in a new match re-triggers).
    for (const id of [...tracked.keys()]) if (!seen.has(id)) tracked.delete(id);

    // Smoke puffs outlive their missiles, fading out (batched).
    const alive: Smoke[] = [];
    for (const s of smoke) {
      const age = (nowMs - s.bornMs) / SMOKE_LIFE_MS;
      if (age >= 1) continue;
      alive.push(s);
      const ss = cam.worldToScreen(s.x, s.y);
      g.circle(ss.x, ss.y, (3 + age * 7) * zoom).fill({
        color: 0x777788,
        alpha: 0.28 * (1 - age),
      });
    }
    smoke = alive;
  }

  function drawTracer(
    g: Graphics,
    p: SnapshotProjectile,
    t: Tracked,
    sp: { x: number; y: number },
    rot: number,
    team: number,
    zoom: number,
    nowMs: number,
  ): void {
    switch (p.mechanic) {
      case 'phoenixFire': {
        for (let i = 0; i < t.trail.length - 1; i++) {
          const seg = t.trail[i];
          if (seg === undefined) continue;
          const ss = getCamera().worldToScreen(seg.x, seg.y);
          const a = (i + 1) / t.trail.length;
          g.circle(ss.x, ss.y, 2.2 * zoom * a).fill({ color: 0xffb35c, alpha: 0.35 * a });
        }
        g.circle(sp.x, sp.y, 4 * zoom).fill(0xffd28a);
        g.circle(sp.x, sp.y, 2 * zoom).fill(0xfff2d0);
        break;
      }
      case 'stormBolt': {
        const len = 16 * zoom;
        const wHalf = 3 * zoom;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const px = -sin * wHalf;
        const py = cos * wHalf;
        g.poly([
          sp.x + cos * len, sp.y + sin * len,
          sp.x + px, sp.y + py,
          sp.x - cos * len * 0.6, sp.y - sin * len * 0.6,
          sp.x - px, sp.y - py,
        ]).fill({ color: 0xbfe8ff, alpha: 0.95 });
        g.circle(sp.x, sp.y, 5 * zoom).fill({ color: 0x9fd0ff, alpha: 0.35 });
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
        g.poly([
          sp.x + cos * len * 1.4, sp.y + sin * len * 1.4,
          sp.x + px, sp.y + py,
          sp.x - cos * len, sp.y - sin * len,
          sp.x - px, sp.y - py,
        ])
          .fill(mix(0x884444, team, 0.35))
          .stroke({ width: 1.5, color: 0x331818 });
        g.circle(sp.x - cos * len * 1.25, sp.y - sin * len * 1.25, 3.5 * zoom).fill({
          color: 0xffa040,
          alpha: 0.9,
        });
        break;
      }
      case 'nativeAttack': {
        // Cosmetic low parabolic arc: lift the ball off the water by progress,
        // and drop a shadow dot at the true ground position beneath it.
        const lift = cannonArcLift(flightProgress(t.dist, 900)) * zoom;
        const bx = sp.x;
        const by = sp.y - lift;
        // Shadow on the water (foreshortened, fades up as the ball rises).
        g.ellipse(sp.x, sp.y, 3.4 * zoom, 3.4 * zoom * FORESHORTEN).fill({
          color: 0x05121e,
          alpha: 0.3 * (1 - lift / (CANNON_ARC_PEAK_PX * zoom + 1)) + 0.08,
        });
        g.circle(bx, by, 3 * zoom).fill({ color: mix(0xffffff, team, 0.4), alpha: 0.95 });
        g.circle(bx - 0.8 * zoom, by - 0.8 * zoom, 1.3 * zoom).fill({
          color: 0xffffff,
          alpha: 0.8,
        });
        break;
      }
    }
  }

  // --- per-family draw callbacks (pooled) ----------------------------------
  function drawMuzzle(g: Graphics, t01: number, d: MuzzleData): void {
    const a = 1 - t01;
    const z = d.zoomAtSpawn;
    const cos = Math.cos(d.rot);
    const sin = Math.sin(d.rot);
    const len = (10 + 8 * t01) * z;
    const wHalf = 5 * z * a;
    const px = -sin * wHalf;
    const py = cos * wHalf;
    g.clear();
    // Forward cone of flame.
    g.poly([
      d.x + cos * len, d.y + sin * len,
      d.x + px, d.y + py,
      d.x - px, d.y - py,
    ]).fill({ color: mix(0xfff2c0, d.color, 0.25), alpha: 0.85 * a });
    // Hot core.
    g.circle(d.x, d.y, 4 * z * a).fill({ color: 0xffffff, alpha: 0.9 * a });
  }

  function drawSplash(g: Graphics, t01: number, d: SplashData): void {
    const cam = getCamera();
    const zoom = cam.zoom;
    const sp = cam.worldToScreen(d.x, d.y);
    const a = 1 - t01;
    const r = d.rWorld * easeOutCubic(t01) * zoom;
    g.clear();
    g.ellipse(sp.x, sp.y, r, r * FORESHORTEN).stroke({
      width: 2 * a + 0.5,
      color: WATER_FOAM,
      alpha: 0.85 * a,
    });
    // A few sparks/droplets thrown up.
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + 0.4;
      const dr = r * 1.1;
      g.circle(sp.x + Math.cos(ang) * dr, sp.y + Math.sin(ang) * dr * FORESHORTEN, 1.8 * zoom).fill({
        color: 0xfff2c0,
        alpha: 0.7 * a,
      });
    }
  }

  function drawExplosion(g: Graphics, t01: number, d: ExplosionData): void {
    const cam = getCamera();
    const zoom = cam.zoom;
    const sp = cam.worldToScreen(d.x, d.y);
    const a = 1 - t01;
    g.clear();
    // Expanding shock ring.
    const r = d.rWorld * easeOutCubic(t01) * zoom;
    g.ellipse(sp.x, sp.y, r, r * FORESHORTEN).stroke({
      width: Math.max(1.5, 5 * a),
      color: 0xffffff,
      alpha: 0.8 * a,
    });
    // Bright flash, brief.
    if (t01 < 0.35) {
      const fa = (1 - t01 / 0.35) * 0.8;
      const fr = d.rWorld * 0.55 * zoom;
      g.ellipse(sp.x, sp.y, fr, fr * FORESHORTEN).fill({ color: mix(0xffd28a, d.color, 0.2), alpha: fa });
    }
    // Debris specks flung outward (deterministic from seed, time-based travel).
    const n = 7;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + d.seed;
      const dr = r * (0.7 + 0.5 * ((d.seed * (i + 1)) % 1));
      g.circle(
        sp.x + Math.cos(ang) * dr,
        sp.y + Math.sin(ang) * dr * FORESHORTEN,
        (2.4 - 1.6 * t01) * zoom,
      ).fill({ color: i % 2 === 0 ? 0xffa040 : 0x6a5234, alpha: 0.85 * a });
    }
  }

  function drawDamageFlash(g: Graphics, t01: number, d: DamageFlashData): void {
    const cam = getCamera();
    const zoom = cam.zoom;
    const sp = cam.worldToScreen(d.x, d.y);
    // Quick bright pulse that fades; sits over the unit at airborne layer.
    const pulse = 1 - t01;
    const r = d.rWorld * zoom;
    g.clear();
    g.ellipse(sp.x, sp.y, r, r * FORESHORTEN).fill({
      color: 0xffd0d0,
      alpha: 0.5 * pulse * pulse,
    });
  }

  function drawPillar(g: Graphics, t01: number, d: PillarData): void {
    const cam = getCamera();
    const zoom = cam.zoom;
    const sp = cam.worldToScreen(d.x, d.y);
    g.clear();
    if (d.respawn) {
      // Respawn: blue splash ring + rising sparkle.
      const a = 1 - t01;
      const r = 55 * easeOutCubic(t01) * zoom;
      g.ellipse(sp.x, sp.y, r, r * FORESHORTEN).stroke({
        width: 3 * a + 1,
        color: 0x9fd0ff,
        alpha: 0.8 * a,
      });
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2 + 0.5;
        const dr = r * 1.15;
        g.circle(sp.x + Math.cos(ang) * dr, sp.y + Math.sin(ang) * dr * FORESHORTEN, 2.5 * zoom).fill({
          color: WATER_FOAM,
          alpha: 0.7 * a,
        });
      }
      return;
    }
    // Level-up: gold pillar that rises then fades.
    const a = t01 < 0.7 ? 1 : (1 - t01) / 0.3;
    const h = 120 * zoom * easeOutCubic(Math.min(1, t01 * 2));
    const w = 30 * zoom * (1 - t01 * 0.4);
    g.rect(sp.x - w / 2, sp.y - h, w, h).fill({ color: GOLD, alpha: 0.35 * a });
    g.rect(sp.x - w / 6, sp.y - h, w / 3, h).fill({ color: 0xfff2d0, alpha: 0.55 * a });
    g.ellipse(sp.x, sp.y, w * 0.9, w * 0.9 * FORESHORTEN).stroke({
      width: 2,
      color: GOLD,
      alpha: 0.7 * a,
    });
  }

  function drawPooledEffects(nowMs: number): void {
    muzzle.update(nowMs, drawMuzzle);
    splash.update(nowMs, drawSplash);
    explosion.update(nowMs, drawExplosion);
    damage.update(nowMs, drawDamageFlash);
    pillar.update(nowMs, drawPillar);
  }

  function update(sample: WorldSample | null, nowMs: number): void {
    if (sample === null) {
      // Match reset: clear everything, no leaks.
      projectileGfx.clear();
      tracked.clear();
      smoke = [];
      pending = [];
      muzzle.clear();
      splash.clear();
      explosion.clear();
      damage.clear();
      pillar.clear();
      return;
    }
    resolvePending(sample, nowMs);
    drawProjectiles(sample, nowMs);
    drawPooledEffects(nowMs);
  }

  const api: FxLayer & FxSpawners = {
    view,
    update,
    destroy(): void {
      unsubscribe();
      tracked.clear();
      smoke = [];
      pending = [];
      muzzle.destroy();
      splash.destroy();
      explosion.destroy();
      damage.destroy();
      pillar.destroy();
      projectileGfx.destroy();
    },
    _muzzle: muzzle,
    _splash: splash,
    _explosion: explosion,
    _pillar: pillar,
    _damage: damage,
  };

  return api;
}

// ===========================================================================
// Named spawners (gallery-callable; also used internally by the event intake)
//
// These take an FxLayer produced by createFx and push into its pools. They are
// the public entry points the gallery uses to animate each effect in place
// without a running match. World coords in; the per-family draw callback reads
// the live camera each frame so the gallery's fixed camera Just Works.
// ===========================================================================

/** Internal handle the spawners reach through (set on the createFx return). */
interface FxSpawners {
  _muzzle: TrackingPool<Graphics, MuzzleData>;
  _splash: TrackingPool<Graphics, SplashData>;
  _explosion: TrackingPool<Graphics, ExplosionData>;
  _pillar: TrackingPool<Graphics, PillarData>;
  _damage: TrackingPool<Graphics, DamageFlashData>;
}

function asSpawners(fx: FxLayer): FxSpawners {
  return fx as FxLayer & FxSpawners;
}

/**
 * Muzzle flash at world (x,y) oriented along `dir` (world heading rad). Used
 * by the gallery; in-match flashes are derived from new projectiles (see the
 * heuristic note in the module header).
 */
export function spawnMuzzleFlash(
  fx: FxLayer,
  x: number,
  y: number,
  dir: number,
  team: TeamId = 'south',
): void {
  const cam = getCamera();
  const sp = cam.worldToScreen(x, y);
  asSpawners(fx)._muzzle.spawn(performance.now(), LIFE.muzzle, {
    x: sp.x,
    y: sp.y,
    rot: screenHeading(dir),
    color: mix(0xffffff, TEAM_COLOR[team], 0.35),
    zoomAtSpawn: cam.zoom,
  });
}

/** Water impact splash + sparks at world (x,y). `rWorld` defaults to a tick. */
export function spawnImpactSplash(fx: FxLayer, x: number, y: number, rWorld = 12): void {
  asSpawners(fx)._splash.spawn(performance.now(), LIFE.splash, { x, y, rWorld });
}

/**
 * Explosion at world (x,y); `size` is the base ring radius in WORLD units
 * (pass deathRingRadius(typeId) for a death blast). Includes flash + debris.
 */
export function spawnExplosion(
  fx: FxLayer,
  x: number,
  y: number,
  size: number,
  team: TeamId | null = null,
): void {
  const color = team === null ? 0xffd28a : TEAM_COLOR[team];
  asSpawners(fx)._explosion.spawn(performance.now(), LIFE.explosion, {
    x,
    y,
    rWorld: size,
    color,
    // A stable per-instance pseudo-random seed for debris angles/sizes.
    seed: ((x * 0.013 + y * 0.029) % 1 + 1) % 1,
  });
}

/**
 * Damage flash: a brief additive red pulse drawn at world (x,y). fx OWNS this
 * (units.ts stays decoupled — see the module header). `rWorld` is the unit's
 * footprint radius so the pulse hugs the hull.
 */
export function spawnDamageFlash(fx: FxLayer, x: number, y: number, rWorld = 28): void {
  asSpawners(fx)._damage.spawn(performance.now(), LIFE.damageFlash, { x, y, rWorld });
}

/** Level-up gold pillar at world (x,y). */
export function spawnLevelUpPillar(fx: FxLayer, x: number, y: number): void {
  asSpawners(fx)._pillar.spawn(performance.now(), LIFE.pillar, { x, y, respawn: false });
}

/** Respawn splash ring + sparkle at world (x,y). */
export function spawnRespawnSplash(fx: FxLayer, x: number, y: number): void {
  asSpawners(fx)._pillar.spawn(performance.now(), LIFE.respawn, { x, y, respawn: true });
}

// Internal aliases so the event intake / pending resolver read clearly.
function spawnPillar(fx: FxLayer, x: number, y: number, respawn: boolean): void {
  if (respawn) spawnRespawnSplash(fx, x, y);
  else spawnLevelUpPillar(fx, x, y);
}
