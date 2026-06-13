/**
 * render-units tests: the pure render math (ship recipe resolution, family
 * selection by typeId, footprint sizing == viz, color tinting, wake-trigger
 * from a position delta, overlay y-placement) plus a headless smoke pass that
 * draws every Classic ship class / creep / summon / ward into a real pixi
 * `Graphics` (no renderer, no DOM canvas) so a missing case or NaN geometry is
 * caught. No camera, no match, no time — presentation only.
 */

import { describe, expect, it } from 'vitest';
import { Graphics } from 'pixi.js';
import type { TeamId } from '@bships/core';

import { getCatalog } from '../src/catalog.js';
import { FORESHORTEN } from '../src/render/camera.js';
import {
  drawShip,
  drawShipHull,
  drawShipSuper,
  resolveShipDraw,
  shipBaseColor,
} from '../src/render/shipdraw.js';
import {
  HP_RATIO_STEPS,
  WAKE_MIN_DIST_SQ,
  drawCreep,
  drawSummon,
  drawWard,
  glyphSig,
  glyphsAnimate,
  hpBarSig,
  hpBarY,
  labelY,
  selectionRadius,
  shouldWake,
} from '../src/render/units.js';
import { TEAM_HEX, NEUTRAL_HEX, entityVisualRadius, hullSize } from '../src/render/viz.js';
import type { ShipFamily } from '../src/render/theme.js';

const TEAMS: (TeamId | null)[] = ['south', 'north', null];

/** The 18 Classic ship typeIds with their expected silhouette family. */
const CLASSIC_SHIPS: { id: string; family: ShipFamily }[] = [
  { id: 'H000', family: 'skiff' },
  { id: 'H003', family: 'frigate' },
  { id: 'H001', family: 'frigate' },
  { id: 'H004', family: 'frigate' },
  { id: 'H00Y', family: 'goblin' },
  { id: 'H007', family: 'cruiser' },
  { id: 'H006', family: 'cruiser' },
  { id: 'H008', family: 'cruiser' },
  { id: 'H009', family: 'cruiser' },
  { id: 'H00V', family: 'submarine' },
  { id: 'H00W', family: 'submarine' },
  { id: 'H00L', family: 'flagship' },
  { id: 'H00K', family: 'flagship' },
  { id: 'H00X', family: 'leviathan' },
  { id: 'H00A', family: 'royal' },
  { id: 'H00C', family: 'royal' },
  { id: 'H00D', family: 'trader' },
  { id: 'H005', family: 'trader' },
];

// ---------------------------------------------------------------------------
// Ship recipe resolution
// ---------------------------------------------------------------------------

describe('resolveShipDraw', () => {
  it('resolves a family + finite, positive footprint for every Classic typeId', () => {
    for (const { id, family } of CLASSIC_SHIPS) {
      const d = resolveShipDraw(id, 'south');
      expect(d.shape.family, `family of ${id}`).toBe(family);
      expect(Number.isFinite(d.footprintR), `footprintR finite ${id}`).toBe(true);
      expect(d.footprintR, `footprintR positive ${id}`).toBeGreaterThan(0);
      expect(d.len).toBe(d.footprintR);
      expect(d.beam).toBeGreaterThan(0);
      expect(Number.isFinite(d.beam)).toBe(true);
    }
  });

  it('footprint radius equals viz.entityVisualRadius and viz.hullSize/2', () => {
    const catalog = getCatalog();
    for (const { id } of CLASSIC_SHIPS) {
      const spec = catalog.ships[id]!;
      const d = resolveShipDraw(id, 'north');
      const vizR = entityVisualRadius(
        {
          id: 1,
          kind: 'ship',
          typeId: id,
          x: 0,
          y: 0,
          facing: 0,
          hp: 1,
          maxHp: 1,
          team: 'north',
          ownerSlot: null,
          statuses: [],
        },
        catalog,
      );
      expect(d.footprintR, `footprint vs viz for ${id}`).toBeCloseTo(vizR, 6);
      expect(d.footprintR).toBeCloseTo(hullSize(spec.gold, spec.isSub).length / 2, 6);
    }
  });

  it('beam tracks the shape beam ratio over the hull length', () => {
    const d = resolveShipDraw('H00V', 'south'); // a sub: narrow beam
    expect(d.beam).toBeCloseTo(d.len * d.shape.beam, 6);
    const royal = resolveShipDraw('H00A', 'south'); // royal: wide beam
    expect(royal.shape.beam).toBeGreaterThan(d.shape.beam);
  });

  it('tints the hull by team and dims when submerged', () => {
    const south = resolveShipDraw('H000', 'south');
    const north = resolveShipDraw('H000', 'north');
    const neutral = resolveShipDraw('H000', null);
    expect(south.color).toBe(TEAM_HEX.south);
    expect(north.color).toBe(TEAM_HEX.north);
    expect(neutral.color).toBe(NEUTRAL_HEX);

    const surfaced = resolveShipDraw('H00V', 'south', { submerged: false });
    const submerged = resolveShipDraw('H00V', 'south', { submerged: true });
    expect(submerged.submerged).toBe(true);
    // Submerged hull is darker than surfaced (scaled down toward black).
    expect(submerged.color).toBeLessThan(surfaced.color);
  });

  it('falls back to a sane family + footprint for an unknown typeId', () => {
    const d = resolveShipDraw('ZZZZ', 'south');
    expect(Number.isFinite(d.footprintR)).toBe(true);
    expect(d.footprintR).toBeGreaterThan(0);
    // Unknown -> mid gold/non-sub -> frigate default per familyFromSpec.
    expect(d.shape.family).toBe('frigate');
  });

  it('distinguishes ships within the cruiser family by mark/masts', () => {
    const light = resolveShipDraw('H007', 'south'); // 2200g cruiser
    const heavy = resolveShipDraw('H008', 'south'); // 5000g cruiser, bridge mark
    expect(light.shape.family).toBe('cruiser');
    expect(heavy.shape.family).toBe('cruiser');
    expect(heavy.shape.masts).toBeGreaterThan(light.shape.masts);
    expect(heavy.footprintR).toBeGreaterThan(light.footprintR);
  });

  it('distinguishes the two flagships and the two royals', () => {
    const fl1 = resolveShipDraw('H00L', 'south');
    const fl2 = resolveShipDraw('H00K', 'south');
    expect(fl1.shape.family).toBe('flagship');
    expect(fl2.shape.family).toBe('flagship');
    // 9800g flagship has a taller deck than the 9400g one.
    expect(fl2.shape.deckHeight).toBeGreaterThan(fl1.shape.deckHeight);

    const royal = resolveShipDraw('H00A', 'south');
    const pirate = resolveShipDraw('H00C', 'south');
    expect(royal.shape.mark).toBe('crown');
    expect(pirate.shape.mark).toBe('jollyroger');
  });
});

describe('shipBaseColor', () => {
  it('maps teams to the canvas team hues and neutral to parchment', () => {
    expect(shipBaseColor('south')).toBe(TEAM_HEX.south);
    expect(shipBaseColor('north')).toBe(TEAM_HEX.north);
    expect(shipBaseColor(null)).toBe(NEUTRAL_HEX);
  });
});

// ---------------------------------------------------------------------------
// Headless drawing smoke test — every silhouette draws without throwing/NaN
// ---------------------------------------------------------------------------

describe('silhouette drawing (headless Graphics)', () => {
  it('draws every Classic ship in both team colors + neutral, returning its footprint', () => {
    for (const { id } of CLASSIC_SHIPS) {
      for (const team of TEAMS) {
        const g = new Graphics();
        const r = drawShip(g, id, team);
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThan(0);
        g.destroy();
      }
    }
  });

  it('draws subs surfaced and submerged', () => {
    for (const id of ['H00V', 'H00W']) {
      for (const submerged of [false, true]) {
        const g = new Graphics();
        const r = drawShip(g, id, 'north', { submerged });
        expect(r).toBeGreaterThan(0);
        g.destroy();
      }
    }
  });

  it('hull and superstructure draw independently from the same recipe', () => {
    const d = resolveShipDraw('H00K', 'south');
    const hull = new Graphics();
    const sup = new Graphics();
    expect(() => drawShipHull(hull, d)).not.toThrow();
    expect(() => drawShipSuper(sup, d)).not.toThrow();
    hull.destroy();
    sup.destroy();
  });

  it('draws creeps, summons and wards, returning finite footprints', () => {
    for (const team of TEAMS) {
      const gc = new Graphics();
      const gs = new Graphics();
      const gw = new Graphics();
      expect(drawCreep(gc, 'nalb', team)).toBeGreaterThan(0);
      expect(drawSummon(gs, 'oeye', team)).toBeGreaterThan(0);
      expect(drawWard(gw, team)).toBeGreaterThan(0);
      gc.destroy();
      gs.destroy();
      gw.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Pure helpers: wake trigger + overlay placement math
// ---------------------------------------------------------------------------

describe('shouldWake', () => {
  it('fires once the move exceeds the jitter threshold', () => {
    const thresh = Math.sqrt(WAKE_MIN_DIST_SQ);
    expect(shouldWake(0, 0)).toBe(false);
    expect(shouldWake(thresh * 0.5, 0)).toBe(false);
    expect(shouldWake(thresh + 0.01, 0)).toBe(true);
    expect(shouldWake(0, thresh + 0.01)).toBe(true);
  });

  it('uses Euclidean distance, not per-axis', () => {
    const c = Math.sqrt(WAKE_MIN_DIST_SQ) / Math.SQRT2 + 0.01;
    // Each axis alone is below threshold, but the combined move is above it.
    expect(shouldWake(c, 0)).toBe(false);
    expect(shouldWake(c, c)).toBe(true);
  });

  it('is symmetric in sign', () => {
    const t = Math.sqrt(WAKE_MIN_DIST_SQ) + 0.1;
    expect(shouldWake(-t, 0)).toBe(true);
    expect(shouldWake(0, -t)).toBe(true);
  });
});

describe('overlay placement math', () => {
  it('hpBarY sits above the foreshortened footprint, higher for structures', () => {
    const r = 80;
    const ship = hpBarY(r, 'ship');
    const structure = hpBarY(r, 'structure');
    // Negative = above the unit (screen y-up is negative here).
    expect(ship).toBeLessThan(-(r * FORESHORTEN));
    // Structures lift their bar higher (more negative) than ships.
    expect(structure).toBeLessThan(ship);
  });

  it('hpBarY scales with footprint radius', () => {
    expect(hpBarY(160, 'ship')).toBeLessThan(hpBarY(40, 'ship'));
  });

  it('labelY sits above the hp-bar zone', () => {
    const r = 90;
    expect(labelY(r)).toBeLessThan(hpBarY(r, 'ship'));
  });

  it('selectionRadius is a touch larger than the footprint', () => {
    expect(selectionRadius(100)).toBeGreaterThan(100);
    expect(selectionRadius(100)).toBeLessThan(160);
  });
});

// ---------------------------------------------------------------------------
// Redraw-guard signatures: skip the per-frame clear+redraw when unchanged.
// ---------------------------------------------------------------------------

describe('hpBarSig', () => {
  it('is stable when the quantized ratio and selection are unchanged', () => {
    // Two ratios within one quantization step collapse to the same signature.
    const a = hpBarSig(500, 1000, false);
    const b = hpBarSig(500 + 1000 / HP_RATIO_STEPS / 4, 1000, false); // < 1 step
    expect(a).toBe(b);
  });

  it('changes when the ratio crosses a quantization step', () => {
    const a = hpBarSig(500, 1000, false);
    const b = hpBarSig(600, 1000, false);
    expect(a).not.toBe(b);
  });

  it('changes when selection toggles at the same hp', () => {
    expect(hpBarSig(500, 1000, false)).not.toBe(hpBarSig(500, 1000, true));
  });

  it('treats maxHp 0 as ratio 0 without dividing by zero', () => {
    expect(hpBarSig(0, 0, false)).toBe(hpBarSig(0, 1000, false));
  });

  it('clamps out-of-range hp into [0,1]', () => {
    expect(hpBarSig(2000, 1000, false)).toBe(hpBarSig(1000, 1000, false)); // over-full -> full
    expect(hpBarSig(-50, 1000, false)).toBe(hpBarSig(0, 1000, false)); // negative -> empty
  });
});

describe('glyphSig', () => {
  it('is empty for no glyphs', () => {
    expect(glyphSig([])).toBe('');
  });

  it('is order-independent (same set -> same signature)', () => {
    expect(glyphSig(['stunned', 'shielded'])).toBe(glyphSig(['shielded', 'stunned']));
  });

  it('distinguishes different glyph sets', () => {
    expect(glyphSig(['stunned'])).not.toBe(glyphSig(['shielded']));
    expect(glyphSig(['stunned'])).not.toBe(glyphSig(['stunned', 'shielded']));
  });
});

describe('glyphsAnimate', () => {
  it('is true for time-animated glyphs (stunned stars, goblin mine blink)', () => {
    expect(glyphsAnimate(['stunned'])).toBe(true);
    expect(glyphsAnimate(['goblinMine'])).toBe(true);
    expect(glyphsAnimate(['shielded', 'goblinMine'])).toBe(true);
  });

  it('is false for static glyphs and the empty set', () => {
    expect(glyphsAnimate([])).toBe(false);
    expect(glyphsAnimate(['shielded'])).toBe(false);
    expect(glyphsAnimate(['revealed'])).toBe(false);
    expect(glyphsAnimate(['shielded', 'revealed'])).toBe(false);
  });
});
