/**
 * render-world tests: PURE render math only (no pixi, no DOM). Locks the
 * contracts the world layer builds on:
 *  - role -> silhouette + height-ratio selection (every role resolves)
 *  - every role's logical height is finite and sane (under the giant-flag clamp)
 *  - structure footprints stay in the SAME size band as ships (HQ < 3x top ship)
 *  - depth ordering shadow < body < overlay at the same y
 *  - water depth grading: shallow at the shores, deep mid-channel, abyss at
 *    the border; color follows the ramp.
 *
 * The drawing functions in structures.ts/world.ts are pixi-bound and exercised
 * by the gallery (human QA); here we test the math + selection tables that
 * decide WHAT gets drawn and at WHAT scale.
 */

import { describe, expect, it } from 'vitest';

import { depthKey, overlayKey, HEIGHT_MAX_RATIO, logicalHeight } from '../src/render/depth.js';
import { WATER_RAMP, waterAt } from '../src/render/theme.js';
import { hullSize, structureRadius } from '../src/render/viz.js';
import { TEAM_COLOR, NEUTRAL_COLOR } from '../src/render/theme.js';
import type { StructureRole } from '../src/render/structures.js';
import {
  ROLE_HEIGHT_RATIO,
  STRUCTURE_ROLES,
  structureHeight,
  structureSilhouette,
  trimColor,
} from '../src/render/structures.js';
import { seaStaticSignature, waterColorAt, waterDepth01, seabedBandTint } from '../src/render/world.js';

const ALL_ROLES: StructureRole[] = [
  'hq',
  'spawnBuilding',
  'tower',
  'shop',
  'repair',
  'missileRamp',
  'other',
];

// ---------------------------------------------------------------------------
// Role selection tables
// ---------------------------------------------------------------------------

describe('structure role tables', () => {
  it('STRUCTURE_ROLES lists every sim role exactly once', () => {
    expect([...STRUCTURE_ROLES].sort()).toEqual([...ALL_ROLES].sort());
    expect(new Set(STRUCTURE_ROLES).size).toBe(STRUCTURE_ROLES.length);
  });

  it('every role maps to a known silhouette family', () => {
    const families = new Set(
      ['keep', 'harbor', 'watchtower', 'market', 'drydock', 'gantry', 'depot'],
    );
    for (const role of ALL_ROLES) {
      expect(families.has(structureSilhouette(role))).toBe(true);
    }
    // Distinct silhouettes per distinct role (no two roles collapse).
    const sils = ALL_ROLES.map(structureSilhouette);
    expect(new Set(sils).size).toBe(ALL_ROLES.length);
  });

  it('every role has a positive finite height ratio', () => {
    for (const role of ALL_ROLES) {
      const ratio = ROLE_HEIGHT_RATIO[role];
      expect(Number.isFinite(ratio)).toBe(true);
      expect(ratio).toBeGreaterThan(0);
    }
  });

  it('the tower is the tallest-for-its-width, the repair bay the lowest', () => {
    const ratios = ALL_ROLES.map((r) => ROLE_HEIGHT_RATIO[r]);
    expect(ROLE_HEIGHT_RATIO.tower).toBe(Math.max(...ratios));
    expect(ROLE_HEIGHT_RATIO.repair).toBe(Math.min(...ratios));
  });
});

// ---------------------------------------------------------------------------
// Height resolution + the giant-flag guard
// ---------------------------------------------------------------------------

describe('structure height resolution (giant-flag guard)', () => {
  it('every role resolves to a finite, positive, clamped logical height', () => {
    for (const role of ALL_ROLES) {
      const r = structureRadius(role);
      const h = structureHeight(role);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThan(0);
      // Hard clamp: never taller than HEIGHT_MAX_RATIO * footprint radius.
      expect(h).toBeLessThanOrEqual(r * HEIGHT_MAX_RATIO + 1e-6);
    }
  });

  it('structureHeight equals logicalHeight(radius, ratio)', () => {
    for (const role of ALL_ROLES) {
      const r = structureRadius(role);
      expect(structureHeight(role)).toBeCloseTo(logicalHeight(r, ROLE_HEIGHT_RATIO[role]), 6);
    }
  });

  it('the tower ratio (2.1) stays under the clamp so it is not flattened', () => {
    expect(ROLE_HEIGHT_RATIO.tower).toBeLessThan(HEIGHT_MAX_RATIO);
    const r = structureRadius('tower');
    // Not clamped: equals the raw product.
    expect(structureHeight('tower')).toBeCloseTo(r * ROLE_HEIGHT_RATIO.tower, 6);
  });
});

// ---------------------------------------------------------------------------
// Footprints stay in the ship size band
// ---------------------------------------------------------------------------

describe('structure footprints stay in the ship size band', () => {
  // Top-tier ship hull radius (gold > 10000 -> tier 5 -> length 154).
  const topShipR = hullSize(16000, false).length / 2;

  it('HQ is the biggest building but under 3x a top-tier ship hull', () => {
    const hqR = structureRadius('hq');
    expect(hqR).toBeGreaterThan(topShipR); // bigger than a ship...
    expect(hqR).toBeLessThan(topShipR * 3); // ...but not a screen-eater
  });

  it('a tower footprint is in the mid-tier ship band (~1x, not a giant)', () => {
    const towerR = structureRadius('tower');
    const midShipR = hullSize(2400, false).length / 2; // tier 2 = 50
    // Roughly a mid ship: between half and 1.5x its hull radius.
    expect(towerR).toBeGreaterThan(midShipR * 0.5);
    expect(towerR).toBeLessThan(midShipR * 1.5);
  });

  it('the HQ is the largest footprint of all roles', () => {
    const radii = ALL_ROLES.map(structureRadius);
    expect(structureRadius('hq')).toBe(Math.max(...radii));
  });

  it('no structure standing height exceeds ~3.5x a top-tier ship hull radius', () => {
    // Sanity ceiling: even the tower (tall, slim) must not loom absurdly.
    for (const role of ALL_ROLES) {
      expect(structureHeight(role)).toBeLessThan(topShipR * 3.5);
    }
  });
});

// ---------------------------------------------------------------------------
// Team trim color selection
// ---------------------------------------------------------------------------

describe('team trim color', () => {
  it('uses the team color for owned, neutral parchment for unowned', () => {
    expect(trimColor('south')).toBe(TEAM_COLOR.south);
    expect(trimColor('north')).toBe(TEAM_COLOR.north);
    expect(trimColor(null)).toBe(NEUTRAL_COLOR);
  });
});

// ---------------------------------------------------------------------------
// Depth ordering: shadow < body < overlay at one y
// ---------------------------------------------------------------------------

describe('structure depth ordering', () => {
  const y = 1234;

  it('shadow draws behind the structure body, body behind its overlay', () => {
    const shadow = depthKey(y, 'shadow');
    const body = depthKey(y, 'structure');
    const overlay = overlayKey(y);
    expect(shadow).toBeLessThan(body);
    expect(body).toBeLessThan(overlay);
  });

  it('a more-northern structure sorts behind a more-southern one', () => {
    // North = larger y -> should draw BEHIND (smaller zIndex).
    const north = depthKey(2000, 'structure');
    const south = depthKey(1000, 'structure');
    expect(north).toBeLessThan(south);
  });

  it('y separation dominates the per-kind bias (a structure just south of a unit still leads)', () => {
    // A structure 1 unit south of a unit must still draw in front of that unit
    // despite the unit having a higher kind bias.
    const structSouth = depthKey(999, 'structure');
    const unitNorth = depthKey(1000, 'unit');
    expect(structSouth).toBeGreaterThan(unitNorth);
  });
});

// ---------------------------------------------------------------------------
// Water depth grading
// ---------------------------------------------------------------------------

describe('water depth grading', () => {
  const bounds = { minY: -8192, maxY: 6656 };

  it('returns abyss (1) at or outside the border', () => {
    expect(waterDepth01(bounds.minY, bounds)).toBe(1);
    expect(waterDepth01(bounds.maxY, bounds)).toBe(1);
    expect(waterDepth01(bounds.minY - 500, bounds)).toBe(1);
  });

  it('is shallow near the shores and deep mid-channel', () => {
    const nearShore = waterDepth01(bounds.minY + 100, bounds);
    const midChannel = waterDepth01((bounds.minY + bounds.maxY) / 2, bounds);
    expect(nearShore).toBeGreaterThan(0);
    expect(nearShore).toBeLessThan(midChannel); // shallower than the deep middle
    expect(midChannel).toBeGreaterThan(0.6);
    expect(midChannel).toBeLessThan(1); // open water is deep but not abyss
  });

  it('is symmetric about the channel center', () => {
    const mid = (bounds.minY + bounds.maxY) / 2;
    const a = waterDepth01(mid - 1000, bounds);
    const b = waterDepth01(mid + 1000, bounds);
    expect(a).toBeCloseTo(b, 6);
  });

  it('stays within [0,1] across the whole span', () => {
    for (let y = bounds.minY - 200; y <= bounds.maxY + 200; y += 137) {
      const d = waterDepth01(y, bounds);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it('water color grades along the ramp (deeper = darker)', () => {
    const shallow = waterColorAt(bounds.minY + 100, bounds);
    const deep = waterColorAt((bounds.minY + bounds.maxY) / 2, bounds);
    // Both are valid ramp samples; deeper sits darker (lower) on the ramp.
    expect(shallow).toBe(waterAt(waterDepth01(bounds.minY + 100, bounds)));
    expect(deep).toBe(waterAt(waterDepth01((bounds.minY + bounds.maxY) / 2, bounds)));
    // Sum of channels: deeper water is overall darker than near-shore water.
    const chSum = (c: number) => ((c >> 16) & 0xff) + ((c >> 8) & 0xff) + (c & 0xff);
    expect(chSum(deep)).toBeLessThan(chSum(shallow));
  });

  it('the deepest in-bounds color sits at the dark end of the ramp', () => {
    const mid = (bounds.minY + bounds.maxY) / 2;
    const c = waterColorAt(mid, bounds);
    const chSum = (col: number) => ((col >> 16) & 0xff) + ((col >> 8) & 0xff) + (col & 0xff);
    // Darker than the shallowest ramp stop, no darker than the abyss stop.
    expect(chSum(c)).toBeLessThan(chSum(WATER_RAMP[0]!));
    expect(chSum(c)).toBeGreaterThanOrEqual(chSum(WATER_RAMP[WATER_RAMP.length - 1]!));
  });
});

// ---------------------------------------------------------------------------
// Static-sea cache signature (the per-frame full-sea rebuild guard)
// ---------------------------------------------------------------------------

describe('seaStaticSignature', () => {
  const rect = { minX: -1000, minY: -2000, maxX: 1000, maxY: 2000 };

  it('is stable for an unchanged visible rect / zoom / viewport', () => {
    expect(seaStaticSignature(rect, 1, 1600, 900)).toBe(seaStaticSignature(rect, 1, 1600, 900));
  });

  it('absorbs sub-unit jitter (rounded) so smoothing does not force a rebuild', () => {
    const a = seaStaticSignature(rect, 1, 1600, 900);
    const b = seaStaticSignature(
      { minX: -1000.3, minY: -2000.2, maxX: 1000.4, maxY: 2000.1 },
      1.0004,
      1600,
      900,
    );
    expect(a).toBe(b);
  });

  it('changes on a visible pan (rect shift)', () => {
    const a = seaStaticSignature(rect, 1, 1600, 900);
    const b = seaStaticSignature({ ...rect, minX: rect.minX + 50, maxX: rect.maxX + 50 }, 1, 1600, 900);
    expect(a).not.toBe(b);
  });

  it('changes on a zoom step and on a viewport resize', () => {
    const a = seaStaticSignature(rect, 1, 1600, 900);
    expect(a).not.toBe(seaStaticSignature(rect, 1.25, 1600, 900));
    expect(a).not.toBe(seaStaticSignature(rect, 1, 1280, 720));
  });
});

describe('seabed bands (the ORIGINAL per-cell depth the sea is painted from)', () => {
  it('land (band 0) paints nothing — land.ts owns it', () => {
    expect(seabedBandTint(0)).toBeNull();
  });

  it('every water band yields a visible, partially transparent tint', () => {
    for (const band of [1, 2, 3]) {
      const t = seabedBandTint(band);
      expect(t, `band ${band}`).not.toBeNull();
      expect(t!.alpha).toBeGreaterThan(0);
      expect(t!.alpha).toBeLessThan(1);
      expect(Number.isFinite(t!.color)).toBe(true);
    }
  });

  it('deep reads darker than shallow (the channel must contrast the shoals)', () => {
    const deep = seabedBandTint(1)!.color;
    const shallow = seabedBandTint(2)!.color;
    const lum = (c: number) => ((c >> 16) & 0xff) * 0.3 + ((c >> 8) & 0xff) * 0.59 + (c & 0xff) * 0.11;
    expect(lum(deep)).toBeLessThan(lum(shallow));
  });

  it('an unknown band degrades to no tint (forward-compatible)', () => {
    expect(seabedBandTint(9)).toBeNull();
  });
});
