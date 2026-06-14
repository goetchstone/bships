/**
 * Shop proximity cue — "head to a shop" affordance (docs/TERRAIN.md §4).
 *
 * The player spawns ~760u from the nearest shop and the base shops sit
 * off-screen at the 1.7x follow zoom (camera.ts DEFAULT_ZOOM), with the map
 * now carved into land lanes. This panel surfaces the player's OWN-SIDE base
 * shop: an on-screen arrow pointing toward it whenever the own ship is OUTSIDE
 * the shop's interactRadius, with the distance, that doubles as a click target
 * to frame the base (getCamera().panTo). Once the ship is in range, shop.ts's
 * "press B" pill takes over and this cue hides.
 *
 * Own-side shop positions come from the static catalog map (they never move and
 * carry the `shopSide` zone tag the snapshot entities lack); the own ship comes
 * from the interpolated sample via store.match.mySlot/myTeam. Presentation-only.
 *
 * The pure selection/geometry helpers below are DOM-free and unit-tested in
 * test/shopcue.test.ts; initShopCue wires them to the DOM + camera.
 */

import type { Ruleset, TeamId } from '@bships/core';
import { getCamera } from '../render/camera.js';
import { store } from '../net/store.js';
import type { HudContext } from './context.js';
import { el } from './context.js';
import { hudSample } from './sample.js';

// ---------------------------------------------------------------------------
// Pure logic (DOM-free, unit-tested)
// ---------------------------------------------------------------------------

/** A base shop the cue can point at: position + which base it sits in. */
export interface SideShop {
  id: string;
  typeId: string;
  x: number;
  y: number;
  shopSide: TeamId | null;
}

/** Minimal shape of a catalog map structure for shop selection. */
interface MapStructureLike {
  instanceKey: string;
  typeId: string;
  role: string;
  x: number;
  y: number;
  shopSide: TeamId | null;
}

/**
 * The player's own-side base shops, in catalog order. A shop counts as
 * own-side when its `shopSide` zone matches the player's team. With a null
 * team (spectator / pre-slot) nothing is own-side.
 */
export function ownSideShops(
  structures: readonly MapStructureLike[],
  myTeam: TeamId | null,
): SideShop[] {
  if (myTeam === null) return [];
  const out: SideShop[] = [];
  for (const s of structures) {
    if (s.role !== 'shop' || s.shopSide !== myTeam) continue;
    out.push({ id: s.instanceKey, typeId: s.typeId, x: s.x, y: s.y, shopSide: s.shopSide });
  }
  return out;
}

/** The own-side shop nearest the ship (squared distance), or null if none. */
export function nearestOwnSideShop(
  ship: { x: number; y: number },
  shops: readonly SideShop[],
): SideShop | null {
  let best: SideShop | null = null;
  let bestDistSq = Infinity;
  for (const s of shops) {
    const dx = s.x - ship.x;
    const dy = s.y - ship.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = s;
    }
  }
  return best;
}

/** interactRadius for a shop typeId; falls back to `fallback` (default 450). */
export function shopInteractRadius(
  shops: Record<string, { interactRadius: number }>,
  typeId: string,
  fallback = 450,
): number {
  return shops[typeId]?.interactRadius ?? fallback;
}

export interface CueState {
  /** Whether the "head to a shop" cue should be visible. */
  show: boolean;
  /** The targeted own-side shop (null when none / in range). */
  shop: SideShop | null;
  /** Straight-line world distance ship->shop (0 when no shop). */
  distance: number;
}

/**
 * Decide the cue: shows only when the ship is OUTSIDE the nearest own-side
 * shop's interactRadius (matching shop.ts's in-range gate, so the arrow hands
 * off cleanly to the "press B" pill at the threshold).
 */
export function cueState(
  ship: { x: number; y: number } | null,
  shops: readonly SideShop[],
  shopSpecs: Record<string, { interactRadius: number }>,
): CueState {
  if (ship === null) return { show: false, shop: null, distance: 0 };
  const shop = nearestOwnSideShop(ship, shops);
  if (shop === null) return { show: false, shop: null, distance: 0 };
  const dx = shop.x - ship.x;
  const dy = shop.y - ship.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const radius = shopInteractRadius(shopSpecs, shop.typeId);
  return { show: distance > radius, shop, distance };
}

/** Whole-unit distance label, e.g. "760". */
export function distanceLabel(distance: number): string {
  return String(Math.round(distance));
}

/**
 * The full cue label shown next to the arrow, e.g. "Shop  760". A small,
 * pure formatter so the panel text is consistent and unit-tested (the arrow
 * itself is rotated separately toward the shop's screen position).
 */
export function cueLabel(distance: number): string {
  return `Shop  ${distanceLabel(distance)}`;
}

// ---------------------------------------------------------------------------
// DOM panel (browser only — never invoked by the pure tests)
// ---------------------------------------------------------------------------

/** Read the own-side base shops once from the static catalog. */
function catalogSideShops(catalog: Ruleset, myTeam: TeamId | null): SideShop[] {
  const structures = catalog.map.structures as unknown as MapStructureLike[];
  return ownSideShops(structures, myTeam);
}

export function initShopCue(ctx: HudContext): void {
  // A small clickable cue anchored bottom-center, above the inventory bar. It
  // shows an arrow rotated toward the off-screen shop plus the distance, and
  // frames the base on click. pointer-events:auto so the click lands.
  const cue = el('button', 'bh-shopcue', ctx.root);
  cue.type = 'button';
  cue.hidden = true;
  const arrow = el('span', 'bh-shopcue-arrow', cue);
  arrow.textContent = '➤'; // heavy right arrow, rotated to point at the shop
  const label = el('span', 'bh-shopcue-label', cue);

  let target: SideShop | null = null;

  cue.addEventListener('click', () => {
    if (target !== null) getCamera().panTo(target.x, target.y);
  });

  // Own-side shops depend on the player's team, which can settle after init;
  // recompute lazily when the team changes.
  let cachedTeam: TeamId | null | undefined;
  let sideShops: SideShop[] = [];

  ctx.onFrame((nowMs) => {
    const myTeam = store.match.myTeam;
    if (myTeam !== cachedTeam) {
      cachedTeam = myTeam;
      sideShops = catalogSideShops(ctx.catalog, myTeam);
    }

    const mySlot = store.match.mySlot;
    const sample = hudSample(nowMs);
    let ship: { x: number; y: number } | null = null;
    if (sample !== null && mySlot !== null) {
      const found = sample.entities.find((en) => en.kind === 'ship' && en.ownerSlot === mySlot);
      if (found !== undefined) ship = { x: found.x, y: found.y };
    }

    const cs = cueState(ship, sideShops, ctx.catalog.shops);
    if (!cs.show || cs.shop === null || ship === null) {
      cue.hidden = true;
      target = null;
      return;
    }
    target = cs.shop;
    cue.hidden = false;

    // Point the arrow from the player's current screen position toward the
    // shop's screen position (the camera owns the only world->screen math).
    const cam = getCamera();
    const from = cam.worldToScreen(ship.x, ship.y);
    const to = cam.worldToScreen(cs.shop.x, cs.shop.y);
    const angleDeg = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
    arrow.style.transform = `rotate(${angleDeg.toFixed(1)}deg)`;
    label.textContent = cueLabel(cs.distance);
  });
}
