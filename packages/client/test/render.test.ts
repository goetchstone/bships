/**
 * client-render tests: camera transform math (the binding coordinate
 * contract incl. FORESHORTEN, zoom-to-cursor, clamping) and the pure visual
 * helpers in viz.ts (sizing tiers, HP bars, status visuals, hit-testing
 * through the foreshortened transform). No DOM, no pixi — camera.ts and
 * viz.ts are deliberately pixi-free so this runs in plain node.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SnapshotEntity } from '@bships/core';

import { getCatalog } from '../src/catalog.js';
import {
  DEFAULT_ZOOM,
  FORESHORTEN,
  MAX_ZOOM,
  MIN_ZOOM,
  dragBy,
  getCamera,
  getViewportSize,
  recenterOnPlayer,
  resetCameraForTest,
  setFollowTarget,
  snapCamera,
  updateCamera,
  zoomAt,
} from '../src/render/camera.js';
import {
  CREEP_HULL_LENGTH,
  entityVisualRadius,
  goldTier,
  hitTestEntities,
  hpBarColor,
  hpBarWidth,
  hullSize,
  isEnemyCombatant,
  mixColor,
  shipClassKey,
  spriteRotation,
  statusVisual,
  structureRadius,
} from '../src/render/viz.js';
import type { VizCatalog } from '../src/render/viz.js';

const W = 1600;
const H = 900;

/** Run the exponential smoothing to convergence. */
function converge(): void {
  for (let i = 0; i < 300; i++) updateCamera(50);
}

function makeEntity(
  id: number,
  x: number,
  y: number,
  overrides: Partial<SnapshotEntity> = {},
): SnapshotEntity {
  return {
    id,
    kind: 'ship',
    typeId: 'H000',
    x,
    y,
    facing: 0,
    hp: 100,
    maxHp: 100,
    team: 'south',
    ownerSlot: 2,
    statuses: [],
    ...overrides,
  };
}

const vizCatalog: VizCatalog = {
  ships: { H000: { name: 'Battle Ship', gold: 200, isSub: false } },
};

// ---------------------------------------------------------------------------
// Camera: coordinate contract
// ---------------------------------------------------------------------------

describe('camera transform', () => {
  beforeEach(() => resetCameraForTest(W, H));

  it('maps the camera center to the viewport center', () => {
    const sp = getCamera().worldToScreen(0, 0);
    expect(sp.x).toBe(W / 2);
    expect(sp.y).toBe(H / 2);
  });

  it('applies the binding transform: +x east, +y north flips up, FORESHORTEN on y', () => {
    const sp = getCamera().worldToScreen(100, 200);
    expect(sp.x).toBeCloseTo(W / 2 + 100, 6);
    expect(sp.y).toBeCloseTo(H / 2 - 200 * FORESHORTEN, 6);
  });

  it('screenToWorld inverts worldToScreen', () => {
    snapCamera(321, -654, 1.37);
    const cam = getCamera();
    const sp = cam.worldToScreen(123.5, -456.25);
    const wp = cam.screenToWorld(sp.x, sp.y);
    expect(wp.x).toBeCloseTo(123.5, 6);
    expect(wp.y).toBeCloseTo(-456.25, 6);
  });

  it('foreshortens vertical screen distances by 0.82 * zoom', () => {
    snapCamera(0, 0, 2);
    const cam = getCamera();
    const a = cam.worldToScreen(0, 0);
    const b = cam.worldToScreen(0, 100);
    expect(a.y - b.y).toBeCloseTo(100 * 2 * FORESHORTEN, 6);
  });

  it('reports the viewport world rect (taller than wide-ratio due to foreshorten)', () => {
    const rect = getCamera().viewportWorldRect();
    expect(rect.minX).toBeCloseTo(-W / 2, 6);
    expect(rect.maxX).toBeCloseTo(W / 2, 6);
    expect(rect.maxY).toBeCloseTo(H / (2 * FORESHORTEN), 4);
    expect(rect.minY).toBeCloseTo(-H / (2 * FORESHORTEN), 4);
  });

  it('tracks setViewport via getViewportSize', () => {
    expect(getViewportSize()).toEqual({ w: W, h: H });
  });
});

describe('camera zoom', () => {
  beforeEach(() => resetCameraForTest(W, H));

  it('clamps zoom to [MIN_ZOOM, MAX_ZOOM]', () => {
    zoomAt(W / 2, H / 2, 1000);
    converge();
    expect(getCamera().zoom).toBeCloseTo(MAX_ZOOM, 5);
    zoomAt(W / 2, H / 2, 0.00001);
    converge();
    expect(getCamera().zoom).toBeCloseTo(MIN_ZOOM, 5);
  });

  it('keeps the world point under the cursor fixed (zoom-to-cursor)', () => {
    const cursor = { x: 1200, y: 300 };
    const cam = getCamera();
    const before = cam.screenToWorld(cursor.x, cursor.y);
    zoomAt(cursor.x, cursor.y, 1.5);
    converge();
    const after = cam.screenToWorld(cursor.x, cursor.y);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
    expect(cam.zoom).toBeCloseTo(1.5, 5);
  });

  it('zooming out then in returns to the same view', () => {
    const cursor = { x: 200, y: 700 };
    zoomAt(cursor.x, cursor.y, 0.8);
    zoomAt(cursor.x, cursor.y, 1 / 0.8);
    converge();
    const cam = getCamera();
    expect(cam.x).toBeCloseTo(0, 3);
    expect(cam.y).toBeCloseTo(0, 3);
    expect(cam.zoom).toBeCloseTo(1, 5);
  });
});

describe('camera follow (center + follow the player)', () => {
  beforeEach(() => resetCameraForTest(W, H));

  it('snapCamera centers on the spawn at DEFAULT_ZOOM and engages follow', () => {
    snapCamera(800, -1200, DEFAULT_ZOOM);
    const cam = getCamera();
    expect(cam.x).toBeCloseTo(800, 5);
    expect(cam.y).toBeCloseTo(-1200, 5);
    expect(cam.zoom).toBeCloseTo(DEFAULT_ZOOM, 5);
  });

  it('keeps the camera centered on the moving follow target each frame', () => {
    snapCamera(0, 0, DEFAULT_ZOOM);
    // The ship sails: the renderer reports its position every frame.
    let tx = 0;
    let ty = 0;
    for (let i = 0; i < 200; i++) {
      tx = i * 10;
      ty = i * 6;
      setFollowTarget(tx, ty);
      updateCamera(16);
    }
    const cam = getCamera();
    // The smoothed camera trails a constantly-moving target by a small lag,
    // but stays locked on (within ~100 world units) — it is following.
    expect(Math.hypot(cam.x - tx, cam.y - ty)).toBeLessThan(100);
    expect(cam.x).toBeGreaterThan(1800);
  });

  it('a manual pan suspends follow, which resumes after the idle window', () => {
    snapCamera(0, 0, DEFAULT_ZOOM);
    setFollowTarget(3000, 3000);
    // Manual drag detaches follow: camera does NOT jump to the ship.
    dragBy(40, 40);
    for (let i = 0; i < 5; i++) {
      setFollowTarget(3000, 3000);
      updateCamera(16);
    }
    expect(getCamera().x).toBeLessThan(1000);
    // After ~2.5s idle, follow re-engages and the camera converges on the ship.
    for (let i = 0; i < 400; i++) {
      setFollowTarget(3000, 3000);
      updateCamera(16);
    }
    expect(getCamera().x).toBeCloseTo(3000, -1);
    expect(getCamera().y).toBeCloseTo(3000, -1);
  });

  it('recenterOnPlayer re-engages follow immediately', () => {
    snapCamera(0, 0, DEFAULT_ZOOM);
    dragBy(100, 0);
    setFollowTarget(2000, 0);
    recenterOnPlayer();
    for (let i = 0; i < 200; i++) {
      setFollowTarget(2000, 0);
      updateCamera(16);
    }
    expect(getCamera().x).toBeCloseTo(2000, -1);
  });
});

describe('camera pan + clamping', () => {
  beforeEach(() => resetCameraForTest(W, H));

  it('panTo converges smoothly to the target', () => {
    getCamera().panTo(1000, -2000);
    updateCamera(50);
    const mid = getCamera().x;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1000);
    converge();
    expect(getCamera().x).toBeCloseTo(1000, 2);
    expect(getCamera().y).toBeCloseTo(-2000, 2);
  });

  it('clamps the camera center to map bounds plus margin', () => {
    const bounds = getCatalog().map.bounds;
    getCamera().panTo(1e9, -1e9);
    converge();
    expect(getCamera().x).toBeLessThanOrEqual(bounds.maxX + 256 + 0.01);
    expect(getCamera().y).toBeGreaterThanOrEqual(bounds.minY - 256 - 0.01);
  });

  it('middle-drag moves the world 1:1 with the pointer (and instantly)', () => {
    dragBy(100, 50);
    const cam = getCamera();
    // Content follows pointer: dragging right/down moves the camera west/north.
    expect(cam.x).toBeCloseTo(-100, 6);
    expect(cam.y).toBeCloseTo(50 / FORESHORTEN, 4);
  });

  it('snapCamera places the camera instantly and clamps', () => {
    snapCamera(500, 600, 3.5);
    const cam = getCamera();
    expect(cam.x).toBe(500);
    expect(cam.y).toBe(600);
    expect(cam.zoom).toBe(MAX_ZOOM);
  });
});

// ---------------------------------------------------------------------------
// viz: sizing tiers
// ---------------------------------------------------------------------------

describe('viz sizing', () => {
  it('gold tiers cover the Classic price spread monotonically', () => {
    const prices = [200, 1000, 2400, 5000, 9800, 16000];
    const tiers = prices.map(goldTier);
    expect(tiers).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('hull length grows with gold tier; subs are slimmer', () => {
    expect(hullSize(16000).length).toBeGreaterThan(hullSize(200).length);
    expect(hullSize(6000, true).width).toBeLessThan(hullSize(6000, false).width);
  });

  it('derives class-distinct silhouette keys from the catalog spec', () => {
    expect(shipClassKey({ name: 'Submarine', gold: 6000, isSub: true })).toBe('sub');
    expect(shipClassKey({ name: 'Trade Boat', gold: 300, isSub: false })).toBe('merchant');
    expect(shipClassKey({ name: 'Pirate Ship', gold: 16000, isSub: false })).toBe('royal');
    expect(shipClassKey({ name: 'Flagship', gold: 9800, isSub: false })).toBe('flagship');
    expect(shipClassKey({ name: 'Cruiser', gold: 2400, isSub: false })).toBe('cruiser');
    expect(shipClassKey({ name: 'Leviathian', gold: 13250, isSub: false })).toBe('leviathan');
    expect(shipClassKey({ name: 'Goblin Ship', gold: 1250, isSub: false })).toBe('goblin');
    expect(shipClassKey({ name: 'Battle Ship', gold: 200, isSub: false })).toBe('starter');
    expect(shipClassKey({ name: 'Battle Ship', gold: 1000, isSub: false })).toBe('battle');
  });

  it('creeps render smaller than the smallest player hull', () => {
    expect(CREEP_HULL_LENGTH).toBeLessThan(hullSize(200).length);
  });

  it('structure radii are role-distinct with hq largest', () => {
    expect(structureRadius('hq')).toBeGreaterThan(structureRadius('spawnBuilding'));
    expect(structureRadius('spawnBuilding')).toBeGreaterThan(structureRadius('tower'));
    expect(structureRadius(undefined)).toBe(structureRadius('other'));
  });

  it('entityVisualRadius scales ships by catalog gold and falls back sanely', () => {
    const ship = makeEntity(1, 0, 0);
    expect(entityVisualRadius(ship, vizCatalog)).toBeCloseTo(hullSize(200).length / 2, 6);
    const unknown = makeEntity(2, 0, 0, { typeId: 'HZZZ' });
    expect(entityVisualRadius(unknown, vizCatalog)).toBeGreaterThan(0);
    const creep = makeEntity(3, 0, 0, { kind: 'creep', typeId: 'h00B' });
    expect(entityVisualRadius(creep, vizCatalog)).toBeCloseTo(CREEP_HULL_LENGTH / 2, 6);
  });
});

// ---------------------------------------------------------------------------
// viz: HP bars + status visuals
// ---------------------------------------------------------------------------

describe('viz HP bars', () => {
  it('colors green above 60%, yellow above 30%, red below', () => {
    expect(hpBarColor(1)).toBe(0x52d273);
    expect(hpBarColor(0.61)).toBe(0x52d273);
    expect(hpBarColor(0.5)).toBe(0xe8c84e);
    expect(hpBarColor(0.31)).toBe(0xe8c84e);
    expect(hpBarColor(0.1)).toBe(0xe0524e);
  });

  it('widths scale with maxHp and clamp for readability', () => {
    expect(hpBarWidth(0)).toBe(34);
    expect(hpBarWidth(1_000_000)).toBe(96);
    expect(hpBarWidth(5000)).toBeGreaterThan(hpBarWidth(500));
  });
});

describe('viz status visuals', () => {
  it('returns identity for no statuses', () => {
    const sv = statusVisual([], 0);
    expect(sv.tint).toBe(0xffffff);
    expect(sv.alpha).toBe(1);
    expect(sv.glyphs).toEqual([]);
  });

  it('returns a shared frozen singleton for the no-status fast path (no per-frame alloc)', () => {
    const a = statusVisual([], 0);
    const b = statusVisual([], 999);
    // Same object reused across calls (the steady-state hot-loop allocation we
    // eliminated); both share one frozen empty glyph array.
    expect(a).toBe(b);
    expect(a.glyphs).toBe(b.glyphs);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.glyphs)).toBe(true);
    // A non-empty call must NOT return the singleton (it allocates a real set).
    const c = statusVisual(['stunned'], 0);
    expect(c).not.toBe(a);
  });

  it('invisible halves alpha (own team only by construction)', () => {
    expect(statusVisual(['invisible'], 0).alpha).toBe(0.5);
  });

  it('slowed tints blue-ward; burning flickers over time', () => {
    expect(statusVisual(['slowed'], 0).tint).not.toBe(0xffffff);
    const a = statusVisual(['burning'], 0).tint;
    const b = statusVisual(['burning'], 35).tint;
    expect(a).not.toBe(b);
  });

  it('collects glyph statuses (stunned stars, shield ring)', () => {
    const sv = statusVisual(['stunned', 'shielded'], 0);
    expect(sv.glyphs).toContain('stunned');
    expect(sv.glyphs).toContain('shielded');
  });

  it('mixColor midpoint of black and white is mid gray', () => {
    expect(mixColor(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });

  it('sprite rotation negates sim facing (y-flip)', () => {
    expect(spriteRotation(1.25)).toBe(-1.25);
  });
});

// ---------------------------------------------------------------------------
// viz: hit-testing through the camera transform
// ---------------------------------------------------------------------------

describe('viz hit-testing', () => {
  beforeEach(() => resetCameraForTest(W, H));

  it('hits an entity at its foreshortened screen position', () => {
    const cam = getCamera();
    const e = makeEntity(7, 0, 100);
    const sp = cam.worldToScreen(0, 100);
    expect(sp.y).toBeCloseTo(H / 2 - 100 * FORESHORTEN, 6);
    const hit = hitTestEntities([e], sp.x, sp.y, cam, vizCatalog);
    expect(hit?.id).toBe(7);
  });

  it('applies FORESHORTEN to the hit ellipse: wider than tall', () => {
    const cam = getCamera();
    const e = makeEntity(7, 0, 0);
    const sp = cam.worldToScreen(0, 0);
    // H000 radius 32 -> rx = 40 px, ry = 32*0.82+8 = 34.24 px (with slack).
    expect(hitTestEntities([e], sp.x + 38, sp.y, cam, vizCatalog)?.id).toBe(7);
    expect(hitTestEntities([e], sp.x, sp.y + 38, cam, vizCatalog)).toBeNull();
  });

  it('misses empty water', () => {
    const cam = getCamera();
    const e = makeEntity(7, 0, 0);
    expect(hitTestEntities([e], 100, 100, cam, vizCatalog)).toBeNull();
  });

  it('prefers units over structures on overlap', () => {
    const cam = getCamera();
    const ship = makeEntity(1, 0, 0);
    const structure = makeEntity(2, 0, 0, {
      kind: 'structure',
      typeId: 'n001',
      role: 'shop',
      team: null,
      ownerSlot: null,
    });
    const sp = cam.worldToScreen(0, 0);
    const hit = hitTestEntities([structure, ship], sp.x, sp.y, cam, vizCatalog);
    expect(hit?.id).toBe(1);
  });

  it('scales hit areas with zoom', () => {
    snapCamera(0, 0, MIN_ZOOM);
    const cam = getCamera();
    const e = makeEntity(7, 0, 0);
    const sp = cam.worldToScreen(0, 0);
    // r*zoom = 16 px + 8 slack: 22 px right still hits at min zoom.
    expect(hitTestEntities([e], sp.x + 22, sp.y, cam, vizCatalog)?.id).toBe(7);
    expect(hitTestEntities([e], sp.x + 60, sp.y, cam, vizCatalog)).toBeNull();
  });
});

describe('viz enemy combatant filter', () => {
  it('matches enemy ships/creeps/structures, never wards or allies', () => {
    const enemyShip = makeEntity(1, 0, 0, { team: 'north' });
    const ownShip = makeEntity(2, 0, 0, { team: 'south' });
    const enemyWard = makeEntity(3, 0, 0, { kind: 'ward', team: 'north' });
    const neutral = makeEntity(4, 0, 0, { kind: 'structure', team: null, role: 'shop' });
    const enemyTower = makeEntity(5, 0, 0, { kind: 'structure', team: 'north', role: 'tower' });
    expect(isEnemyCombatant(enemyShip, 'south')).toBe(true);
    expect(isEnemyCombatant(ownShip, 'south')).toBe(false);
    expect(isEnemyCombatant(enemyWard, 'south')).toBe(false);
    expect(isEnemyCombatant(neutral, 'south')).toBe(false);
    expect(isEnemyCombatant(enemyTower, 'south')).toBe(true);
    expect(isEnemyCombatant(enemyShip, null)).toBe(false);
  });
});
