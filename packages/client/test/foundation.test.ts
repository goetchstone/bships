/**
 * Foundation render-math tests (architect-owned): the shared visual system in
 * src/render/theme.ts and the depth/height model in src/render/depth.ts. Pure
 * functions only — no pixi, no DOM. Implementer modules add their own tests
 * for their drawing code; these lock the CONTRACTS those modules build on.
 */

import { describe, expect, it } from 'vitest';

import {
  byDepth,
  depthKey,
  heightOffsetPx,
  HEIGHT_MAX_RATIO,
  logicalHeight,
  overlayKey,
  Y_SCALE,
} from '../src/render/depth.js';
import {
  dropShadow,
  familyFromSpec,
  HEIGHT_REF,
  mix,
  NEUTRAL_COLOR,
  scale,
  shade,
  shadeFace,
  shipShape,
  SHIP_SHAPE_IDS,
  TEAM_COLOR,
  waterAt,
  WATER_RAMP,
} from '../src/render/theme.js';

// ---------------------------------------------------------------------------
// theme: palette + color helpers
// ---------------------------------------------------------------------------

describe('theme palette', () => {
  it('team colors mirror the HUD CSS variables', () => {
    expect(TEAM_COLOR.south).toBe(0xff5c5c);
    expect(TEAM_COLOR.north).toBe(0x5c8aff);
    expect(NEUTRAL_COLOR).toBe(0xc8bda0);
  });

  it('mix is linear and clamps t', () => {
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mix(0x102030, 0xffffff, -1)).toBe(0x102030);
    expect(mix(0x102030, 0xffffff, 2)).toBe(0xffffff);
  });

  it('scale darkens below 1 and brightens above, clamped to 0xff', () => {
    expect(scale(0x808080, 0.5)).toBe(0x404040);
    expect(scale(0x808080, 100)).toBe(0xffffff);
    expect(scale(0xffffff, 0)).toBe(0x000000);
  });

  it('water ramp grades darker from shallow to abyss', () => {
    const shallow = waterAt(0);
    const abyss = waterAt(1);
    expect(shallow).toBe(WATER_RAMP[0]);
    expect(abyss).toBe(WATER_RAMP[WATER_RAMP.length - 1]);
    // Luminance must be monotonically non-increasing across the ramp samples.
    const samples = [0, 0.25, 0.5, 0.75, 1].map(waterAt);
    const lum = (c: number): number =>
      0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff);
    for (let i = 1; i < samples.length; i++) {
      expect(lum(samples[i]!)).toBeLessThanOrEqual(lum(samples[i - 1]!) + 0.001);
    }
  });
});

describe('theme bevel / shade', () => {
  it('lit face is brighter than base, shadow face darker, hue preserved', () => {
    const base = TEAM_COLOR.south;
    const s = shade(base);
    const lum = (c: number): number =>
      0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff);
    expect(lum(s.lit)).toBeGreaterThan(lum(s.base));
    expect(lum(s.shade)).toBeLessThan(lum(s.base));
    // Red team color stays red-dominant even in shadow (channel hue check).
    expect((s.shade >> 16) & 0xff).toBeGreaterThan((s.shade >> 8) & 0xff);
  });

  it('shadeFace lights faces pointing toward the top-left light', () => {
    const base = 0x808080;
    const towardLight = shadeFace(base, -0.55, -0.83); // == LIGHT_DIR
    const awayLight = shadeFace(base, 0.55, 0.83);
    const lum = (c: number): number => (c >> 16) & 0xff; // gray: any channel
    expect(lum(towardLight)).toBeGreaterThan(lum(awayLight));
  });
});

describe('theme drop shadow', () => {
  it('taller objects cast a longer, fainter, further-offset shadow', () => {
    const flat = dropShadow(80, 0);
    const tall = dropShadow(80, HEIGHT_REF * 2);
    expect(tall.dx).toBeGreaterThan(flat.dx);
    expect(tall.dy).toBeGreaterThan(flat.dy);
    expect(tall.alpha).toBeLessThan(flat.alpha);
  });

  it('shadow y-radius is foreshortened relative to x-radius', () => {
    const s = dropShadow(100, 0);
    expect(s.ry).toBeLessThan(s.rx);
  });
});

// ---------------------------------------------------------------------------
// theme: ship shape spec — all 18 classes distinct & resolvable
// ---------------------------------------------------------------------------

describe('theme ship shapes', () => {
  it('has an explicit recipe for every Classic ship typeId', () => {
    expect(SHIP_SHAPE_IDS).toHaveLength(18);
  });

  it('maps each Classic class to its expected silhouette family', () => {
    const fam = (id: string): string =>
      shipShape(id, { name: '', gold: 0, isSub: false }).family;
    expect(fam('H000')).toBe('skiff'); // 200g starter
    expect(fam('H003')).toBe('frigate'); // mid battle ship
    expect(fam('H00Y')).toBe('goblin');
    expect(fam('H006')).toBe('cruiser');
    expect(fam('H00V')).toBe('submarine');
    expect(fam('H00W')).toBe('submarine'); // also the submerged form
    expect(fam('H00L')).toBe('flagship');
    expect(fam('H00X')).toBe('leviathan');
    expect(fam('H00A')).toBe('royal');
    expect(fam('H00C')).toBe('royal'); // pirate ship
    expect(fam('H00D')).toBe('trader');
    expect(fam('H005')).toBe('trader');
  });

  it('the two flagships and two submarines differ within their family', () => {
    const fl1 = shipShape('H00L', { name: '', gold: 0, isSub: false });
    const fl2 = shipShape('H00K', { name: '', gold: 0, isSub: false });
    expect(fl1.family).toBe(fl2.family);
    expect(fl1.deckHeight).not.toBe(fl2.deckHeight);
    const s1 = shipShape('H00V', { name: '', gold: 0, isSub: true });
    const s2 = shipShape('H00W', { name: '', gold: 0, isSub: true });
    expect(s1.beam).not.toBe(s2.beam);
  });

  it('royals and flagships carry a gold accent; mid battle ships do not', () => {
    expect(shipShape('H00A', { name: '', gold: 0, isSub: false }).accent).not.toBeNull();
    expect(shipShape('H00L', { name: '', gold: 0, isSub: false }).accent).not.toBeNull();
    expect(shipShape('H003', { name: '', gold: 0, isSub: false }).accent).toBeNull();
  });

  it('falls back to a name/gold family for unknown (modded) typeIds', () => {
    const shape = shipShape('HZZZ', { name: 'Cruiser', gold: 5000, isSub: false });
    expect(shape.family).toBe('cruiser');
    expect(familyFromSpec({ name: 'Mystery Hull', gold: 250, isSub: false })).toBe('skiff');
    expect(familyFromSpec({ name: 'Mystery Hull', gold: 9000, isSub: false })).toBe('frigate');
    expect(familyFromSpec({ name: 'Stealth', gold: 6000, isSub: true })).toBe('submarine');
  });
});

// ---------------------------------------------------------------------------
// depth: y-sort key + per-kind bias
// ---------------------------------------------------------------------------

describe('depth y-sort key', () => {
  it('more-northern (larger y) objects get a LOWER key (draw behind)', () => {
    expect(depthKey(500)).toBeLessThan(depthKey(-500));
    expect(depthKey(0)).toBeGreaterThan(depthKey(1));
  });

  it('per-kind bias only breaks ties at the same y', () => {
    // Same y: unit draws in front of structure draws in front of shadow.
    expect(depthKey(0, 'unit')).toBeGreaterThan(depthKey(0, 'structure'));
    expect(depthKey(0, 'structure')).toBeGreaterThan(depthKey(0, 'shadow'));
    expect(depthKey(0, 'overlay')).toBeGreaterThan(depthKey(0, 'airborne'));
  });

  it('real y separation outweighs the kind bias (no z-fighting across the map)', () => {
    // A structure 1 world-unit south of a unit still draws in front of it,
    // despite the unit's higher kind bias — y order is authoritative.
    expect(depthKey(-1, 'structure')).toBeGreaterThan(depthKey(0, 'unit'));
    expect(Y_SCALE).toBeGreaterThan(10); // bias band (0..5) << one y unit
  });

  it("overlayKey sorts in front of its owner's body at the same y", () => {
    expect(overlayKey(123)).toBeGreaterThan(depthKey(123, 'unit'));
  });

  it('byDepth orders back-to-front for painter iteration', () => {
    const ys = [-200, 600, 0, 600.0001];
    const sorted = byDepth(ys, (y) => depthKey(y));
    // Ascending key == descending priority == back (north) first.
    expect(sorted[0]).toBe(600.0001);
    expect(sorted[sorted.length - 1]).toBe(-200);
  });
});

// ---------------------------------------------------------------------------
// depth: height projection + giant-flag clamp
// ---------------------------------------------------------------------------

describe('depth height model', () => {
  it('zero/negative height projects to zero offset', () => {
    expect(heightOffsetPx(0, 1)).toBe(0);
    expect(heightOffsetPx(-50, 2)).toBe(0);
  });

  it('offset is linear in height and scales with zoom', () => {
    const a = heightOffsetPx(HEIGHT_REF, 1);
    const b = heightOffsetPx(HEIGHT_REF, 2);
    const c = heightOffsetPx(HEIGHT_REF * 2, 1);
    expect(b).toBeCloseTo(a * 2, 6);
    expect(c).toBeCloseTo(a * 2, 6);
    expect(a).toBeGreaterThan(0);
  });

  it('logicalHeight scales with footprint and class ratio', () => {
    expect(logicalHeight(100, 0.5)).toBeCloseTo(50, 6);
    expect(logicalHeight(60, 0.3)).toBeCloseTo(18, 6);
  });

  it('clamps height to a sane multiple of footprint (the giant-flag guard)', () => {
    // A would-be 10x-footprint feature is capped, so it can never loom.
    expect(logicalHeight(80, 10)).toBe(80 * HEIGHT_MAX_RATIO);
    expect(logicalHeight(80, HEIGHT_MAX_RATIO - 0.4)).toBeLessThan(80 * HEIGHT_MAX_RATIO);
  });
});
