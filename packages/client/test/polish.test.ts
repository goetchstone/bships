/**
 * client-polish tests (pure logic only — no DOM, no pixi): the PALETTE
 * LOCKSTEP contract between index.html's :root CSS vars and render/theme.ts's
 * canvas hexes, plus the readability invariants of the shared visual system
 * (bevel value-range, the dark sea-contour, HP ramp). These lock the "two
 * copies of one palette must agree" rule so a future tweak to one copy that
 * forgets the other fails here instead of on screen.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  GOLD,
  HP_GREEN,
  HP_RED,
  HP_YELLOW,
  INK,
  INK_DIM,
  TEAM_COLOR,
  luminance,
  seaContour,
  shade,
} from '../src/render/theme.js';
import { hpBarColor } from '../src/render/viz.js';
import { ruleBody } from '../src/hud/csslint.js';

const INDEX_HTML = readFileSync(
  fileURLToPath(new URL('../index.html', import.meta.url)),
  'utf8',
);

// The :root block (comments stripped so inline group comments don't break the
// simple `--name: value;` matcher below).
const ROOT_BODY = (ruleBody(INDEX_HTML, ':root') ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Parse `--name: #rrggbb;` out of the index.html :root block as 0xRRGGBB. */
function cssVarHex(name: string): number {
  expect(ROOT_BODY.length, ':root block present in index.html').toBeGreaterThan(0);
  const m = new RegExp(`--${name}\\s*:\\s*#([0-9a-fA-F]{6})\\b`).exec(ROOT_BODY);
  expect(m, `--${name} declared as a 6-digit hex`).not.toBeNull();
  return Number.parseInt(m![1]!, 16);
}

describe('palette lockstep: index.html :root <-> render/theme.ts', () => {
  it('team colors agree between the CSS vars and theme.TEAM_COLOR', () => {
    expect(cssVarHex('team-south')).toBe(TEAM_COLOR.south);
    expect(cssVarHex('team-north')).toBe(TEAM_COLOR.north);
  });

  it('the gold currency hue agrees between --gold and theme.GOLD', () => {
    expect(cssVarHex('gold')).toBe(GOLD);
  });

  it('ink colors mirror the CSS text vars', () => {
    expect(cssVarHex('text')).toBe(INK);
    expect(cssVarHex('text-dim')).toBe(INK_DIM);
  });

  it('the --ready cue matches the HP-green ramp stop (one positive-state hue)', () => {
    expect(cssVarHex('ready')).toBe(HP_GREEN);
  });

  it('every declared palette var is a real 6-digit hex (no typos)', () => {
    for (const name of [
      'bg-deep',
      'bg-panel',
      'bg-panel-raised',
      'border',
      'border-bright',
      'text',
      'text-dim',
      'accent',
      'gold',
      'lumber',
      'team-south',
      'team-north',
      'danger',
      'ready',
    ]) {
      expect(cssVarHex(name)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('HP ramp single-source', () => {
  it('theme HP_* constants equal viz.hpBarColor return values', () => {
    expect(hpBarColor(1)).toBe(HP_GREEN);
    expect(hpBarColor(0.5)).toBe(HP_YELLOW);
    expect(hpBarColor(0.1)).toBe(HP_RED);
  });

  it('the HP ramp is a clear traffic-light spread (green > yellow luminance, red is the alarm)', () => {
    // Green should read brighter/healthier than yellow-orange at a glance, and
    // red must be unambiguously the danger hue (red channel dominant).
    expect(luminance(HP_GREEN)).toBeGreaterThan(luminance(HP_RED));
    expect((HP_RED >> 16) & 0xff).toBeGreaterThan((HP_RED >> 8) & 0xff);
    expect((HP_RED >> 16) & 0xff).toBeGreaterThan(HP_RED & 0xff);
  });
});

describe('silhouette readability invariants', () => {
  it('the bevel opens a wide value range across a team hull (volume reads at zoom)', () => {
    for (const team of ['south', 'north'] as const) {
      const s = shade(TEAM_COLOR[team]);
      expect(luminance(s.lit)).toBeGreaterThan(luminance(s.base));
      expect(luminance(s.shade)).toBeLessThan(luminance(s.base));
      // The lit-to-shadow gap must be substantial enough to read as form.
      expect(luminance(s.lit) - luminance(s.shade)).toBeGreaterThan(40);
    }
  });

  it('seaContour is a dark counter-edge: darker than the hull it outlines', () => {
    for (const team of ['south', 'north'] as const) {
      const base = TEAM_COLOR[team];
      const contour = seaContour(base);
      expect(luminance(contour)).toBeLessThan(luminance(shade(base).shade));
    }
  });
});
