/**
 * shop-access tests — pure logic only (no DOM, no canvas), matching the rest
 * of client-hud's test style. Covers:
 *   - own-side shop selection (picks the player's base shops by team)
 *   - nearest-shop selection
 *   - the cue gate (shows only when OUTSIDE interactRadius)
 *   - minimap marker data (own-side shop -> minimap coords) against the real
 *     compiled catalog, incl. the reported "spawn ~760u from nearest shop,
 *     off-screen, no marker" bug.
 */

import { describe, expect, it } from 'vitest';

import {
  cueLabel,
  cueState,
  distanceLabel,
  nearestOwnSideShop,
  ownSideShops,
  shopInteractRadius,
} from '../src/hud/shopcue.js';
import type { SideShop } from '../src/hud/shopcue.js';
import { createMinimapTransform } from '../src/hud/hudmath.js';
import { getCatalog } from '../src/catalog.js';

const SOUTH_SHOP: SideShop = { id: 's', typeId: 'n002', x: -1664, y: -6528, shopSide: 'south' };

const struct = (
  instanceKey: string,
  role: string,
  x: number,
  y: number,
  shopSide: 'south' | 'north' | null,
): { instanceKey: string; typeId: string; role: string; x: number; y: number; shopSide: 'south' | 'north' | null } => ({
  instanceKey,
  typeId: 'n002',
  role,
  x,
  y,
  shopSide,
});

describe('shopcue: ownSideShops', () => {
  const structures = [
    struct('a', 'shop', -1664, -6528, 'south'),
    struct('b', 'shop', -2048, -6656, 'south'),
    struct('c', 'shop', -256, 5760, 'north'),
    struct('d', 'shop', 4768, 5024, null), // mid-map neutral shop, no side
    struct('e', 'tower', -2048, -6656, 'south'), // not a shop
  ];

  it('returns the south base shops for a south player', () => {
    const shops = ownSideShops(structures, 'south');
    expect(shops.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('returns the north base shops for a north player', () => {
    const shops = ownSideShops(structures, 'north');
    expect(shops.map((s) => s.id)).toEqual(['c']);
  });

  it('returns nothing for a teamless (spectator/pre-slot) viewer', () => {
    expect(ownSideShops(structures, null)).toEqual([]);
  });
});

describe('shopcue: nearestOwnSideShop', () => {
  it('picks the nearest own-side shop', () => {
    const near = nearestOwnSideShop({ x: -1700, y: -6500 }, [SOUTH_SHOP, { ...SOUTH_SHOP, id: 'far', x: 3000, y: -6500 }]);
    expect(near?.id).toBe('s');
  });

  it('returns null when there are no own-side shops', () => {
    expect(nearestOwnSideShop({ x: 0, y: 0 }, [])).toBeNull();
  });
});

describe('shopcue: interactRadius lookup', () => {
  const specs = { n002: { interactRadius: 450 }, n000: { interactRadius: 400 } };

  it('reads the per-shop interactRadius', () => {
    expect(shopInteractRadius(specs, 'n002')).toBe(450);
    expect(shopInteractRadius(specs, 'n000')).toBe(400);
  });

  it('falls back when a shop typeId has no ShopSpec', () => {
    expect(shopInteractRadius(specs, 'n009')).toBe(450);
    expect(shopInteractRadius(specs, 'n009', 300)).toBe(300);
  });
});

describe('shopcue: cueState gate (shows only when OUTSIDE interactRadius)', () => {
  const specs = { n002: { interactRadius: 450 } };

  it('hides when there is no ship', () => {
    expect(cueState(null, [SOUTH_SHOP], specs).show).toBe(false);
  });

  it('hides when there are no own-side shops', () => {
    expect(cueState({ x: 0, y: 0 }, [], specs).show).toBe(false);
  });

  it('shows with an arrow target when the ship is OUTSIDE the radius', () => {
    // ~760u away (the reported spawn distance) -> well outside the 450 radius.
    const cs = cueState({ x: SOUTH_SHOP.x + 760, y: SOUTH_SHOP.y }, [SOUTH_SHOP], specs);
    expect(cs.show).toBe(true);
    expect(cs.shop?.id).toBe('s');
    expect(Math.round(cs.distance)).toBe(760);
  });

  it('hides when the ship is INSIDE the radius (hands off to the press-B pill)', () => {
    const cs = cueState({ x: SOUTH_SHOP.x + 449, y: SOUTH_SHOP.y }, [SOUTH_SHOP], specs);
    expect(cs.show).toBe(false);
    expect(cs.shop?.id).toBe('s'); // still resolves the shop, just not shown
  });

  it('is exclusive on the boundary with shop.ts (radius is in-range, cue off)', () => {
    // shop.ts treats distSq <= radius^2 as IN range; the cue must NOT also show
    // at exactly the radius, or both would render at once.
    const cs = cueState({ x: SOUTH_SHOP.x + 450, y: SOUTH_SHOP.y }, [SOUTH_SHOP], specs);
    expect(cs.show).toBe(false);
  });
});

describe('shopcue: distanceLabel', () => {
  it('rounds to a whole-unit string', () => {
    expect(distanceLabel(759.6)).toBe('760');
    expect(distanceLabel(0)).toBe('0');
  });
});

describe('shopcue: cueLabel', () => {
  it('formats the arrow label as "Shop  <distance>"', () => {
    expect(cueLabel(759.6)).toBe('Shop  760');
    expect(cueLabel(0)).toBe('Shop  0');
  });
});

describe('shopcue: minimap marker data against the real catalog', () => {
  const catalog = getCatalog();
  const structures = catalog.map.structures as unknown as Parameters<typeof ownSideShops>[0];

  it('the map ships 16 shop structures, split into north/south base clusters', () => {
    const shops = structures.filter((s) => s.role === 'shop');
    expect(shops.length).toBe(16);
    expect(ownSideShops(structures, 'south').length).toBeGreaterThan(0);
    expect(ownSideShops(structures, 'north').length).toBeGreaterThan(0);
  });

  it('south base shops sit at negative y (south = -y per the geometry note)', () => {
    for (const s of ownSideShops(structures, 'south')) expect(s.y).toBeLessThan(0);
    for (const s of ownSideShops(structures, 'north')) expect(s.y).toBeGreaterThan(0);
  });

  it('own-side shops map to in-bounds minimap pixels (markers will render)', () => {
    const t = createMinimapTransform(catalog.map.bounds, 220);
    const south = ownSideShops(structures, 'south');
    expect(south.length).toBeGreaterThan(0);
    for (const s of south) {
      const m = t.toMini(s.x, s.y);
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.x).toBeLessThanOrEqual(t.width);
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeLessThanOrEqual(t.height);
    }
  });

  it('the cue fires at match start: a south spawn is outside every base shop radius', () => {
    // South HQ/spawn ~ (-896, -6912). Confirm the nearest own-side shop is
    // beyond its interactRadius from there, so the cue would show on spawn.
    const cs = cueState({ x: -896, y: -6912 }, ownSideShops(structures, 'south'), catalog.shops);
    expect(cs.show).toBe(true);
    expect(cs.shop).not.toBeNull();
  });
});
