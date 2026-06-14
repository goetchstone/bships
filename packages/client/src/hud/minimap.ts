/**
 * Minimap: ~220 px canvas bottom-left. Linear transform from
 * getCatalog().map.bounds — y flipped, NO foreshortening (the camera's 2.5D
 * squash is a render-only effect). Structures draw as role glyphs, newest-
 * frame units as team dots, the camera's viewportWorldRect as a rectangle;
 * click/drag pans via getCamera().panTo.
 */

import type { SnapshotEntity, TeamId } from '@bships/core';
import { isWater } from '@bships/core';
import { getCamera } from '../render/camera.js';
import {
  contestedBandFromLanes,
  contestedRect,
  lanePolyline,
  traderRoutePath,
} from '../render/fieldoverlay.js';
import { store } from '../net/store.js';
import type { HudContext } from './context.js';
import { cssVar, el } from './context.js';
import { hudSample } from './sample.js';
import { createMinimapTransform } from './hudmath.js';
import { ownSideShops } from './shopcue.js';

export function initMinimap(ctx: HudContext): void {
  const transform = createMinimapTransform(ctx.catalog.map.bounds, 220);
  // Own-side base shops are static catalog data; recompute only when the
  // player's team settles (slot assignment can land after init).
  let ownShopTeam: string | null | undefined;
  let ownShopMini: { x: number; y: number }[] = [];

  const wrap = el('div', 'bh-minimap', ctx.root);
  const canvas = el('canvas', undefined, wrap);
  canvas.width = transform.width;
  canvas.height = transform.height;
  const g = canvas.getContext('2d');
  if (g === null) return;

  const colors = {
    water: cssVar('--bg-deep', '#07111c'),
    land: '#55623a',
    landLit: '#6c7a48',
    seaTile: '#16486a',
    border: cssVar('--border', '#2a4a66'),
    south: cssVar('--team-south', '#ff5c5c'),
    north: cssVar('--team-north', '#5c8aff'),
    neutral: cssVar('--text-dim', '#7d96ab'),
    self: cssVar('--text', '#d8e6f2'),
    view: cssVar('--accent', '#36a3ff'),
    shop: cssVar('--gold', '#f2c14e'),
  };

  function teamColor(team: string | null): string {
    if (team === 'south') return colors.south;
    if (team === 'north') return colors.north;
    return colors.neutral;
  }

  // The player's team can settle after init; the lane ribbons brighten the own
  // team and the trader routes pick the own-team deliver zone, so rebuild the
  // static structure backdrop when the team changes (cheap, blitted each frame).
  let bgTeam: TeamId | null | undefined;

  /**
   * Paint the STATIC map structure — lane ribbons (own team brighter), the
   * contested-centre tint, and dashed trader-route hints — into `tg` (the
   * terrain backdrop) so they sit BEHIND the live unit dots and are always
   * visible. Pure map data from the catalog; mirrors render/fieldoverlay.ts so
   * the field and minimap read the same. The same world->mini transform the
   * dots use keeps everything aligned.
   */
  function drawStructureOverlay(tg: CanvasRenderingContext2D): void {
    const map = ctx.catalog.map;
    if (map.lanes.length === 0) return; // open-sea stub
    const myTeam = store.match.myTeam;

    // Contested centre: faint gold-bordered tint (the shared objective band).
    const band = contestedRect(map.regions) ?? contestedBandFromLanes(map.lanes, map.bounds);
    if (band !== null) {
      const a = transform.toMini(band.minX, band.maxY);
      const b = transform.toMini(band.maxX, band.minY);
      tg.fillStyle = colors.shop;
      tg.globalAlpha = 0.07;
      tg.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      tg.globalAlpha = 0.28;
      tg.strokeStyle = colors.shop;
      tg.lineWidth = 1;
      tg.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
      tg.globalAlpha = 1;
    }

    // Lane ribbons: own team a touch brighter so the player reads their lanes.
    tg.lineCap = 'round';
    tg.lineJoin = 'round';
    for (const lane of map.lanes) {
      const own = myTeam !== null && lane.team === myTeam;
      const poly = lanePolyline(lane);
      if (poly.length < 2) continue;
      tg.strokeStyle = teamColor(lane.team);
      tg.globalAlpha = own ? 0.5 : 0.28;
      tg.lineWidth = own ? 2.5 : 1.75;
      tg.beginPath();
      const p0 = transform.toMini(poly[0]!.x, poly[0]!.y);
      tg.moveTo(p0.x, p0.y);
      for (let i = 1; i < poly.length; i++) {
        const p = transform.toMini(poly[i]!.x, poly[i]!.y);
        tg.lineTo(p.x, p.y);
      }
      tg.stroke();
    }
    tg.globalAlpha = 1;

    // Trader routes: dashed gold supply lines for the viewer's runnable routes.
    const routeTeam: TeamId = myTeam ?? 'south';
    tg.strokeStyle = colors.shop;
    tg.globalAlpha = 0.32;
    tg.lineWidth = 1;
    tg.setLineDash([2.5, 2.5]);
    for (const route of ctx.catalog.contracts.tradeRoutes) {
      if (route.team !== null && route.team !== routeTeam) continue;
      const path = traderRoutePath(route, map.regions, routeTeam);
      if (path.length < 2) continue;
      const a = transform.toMini(path[0]!.x, path[0]!.y);
      const b = transform.toMini(path[1]!.x, path[1]!.y);
      tg.beginPath();
      tg.moveTo(a.x, a.y);
      tg.lineTo(b.x, b.y);
      tg.stroke();
    }
    tg.setLineDash([]);
    tg.globalAlpha = 1;
  }

  // Static terrain backdrop: sample the water mask once per minimap pixel so
  // the land/water shape (the lanes-through-land map) is ALWAYS visible, even
  // before the first snapshot. Built once (the mask is immutable) and blitted
  // each frame — far cheaper than re-sampling per draw.
  const terrainBg: HTMLCanvasElement = document.createElement('canvas');
  terrainBg.width = transform.width;
  terrainBg.height = transform.height;
  function buildTerrainBg(): void {
    const tg = terrainBg.getContext('2d');
    const mask = ctx.catalog.map.waterMask;
    if (tg === null) return;
    bgTeam = store.match.myTeam;
    tg.clearRect(0, 0, terrainBg.width, terrainBg.height);
    tg.fillStyle = colors.seaTile;
    tg.fillRect(0, 0, terrainBg.width, terrainBg.height);
    if (mask.cells.length > 0) {
      for (let py = 0; py < terrainBg.height; py++) {
        for (let px = 0; px < terrainBg.width; px++) {
          const w = transform.toWorld(px + 0.5, py + 0.5);
          if (!isWater(mask, w.x, w.y)) {
            // North-lit land: a touch brighter on the upper rows reads as relief.
            tg.fillStyle = py < terrainBg.height * 0.5 ? colors.landLit : colors.land;
            tg.fillRect(px, py, 1, 1);
          }
        }
      }
    }
    // Lanes / contested centre / trader routes on top of the terrain, behind
    // the live unit dots the per-frame draw paints (see drawStructureOverlay).
    drawStructureOverlay(tg);
  }
  buildTerrainBg();

  function drawStructure(en: SnapshotEntity): void {
    if (g === null) return;
    const { x, y } = transform.toMini(en.x, en.y);
    g.fillStyle = teamColor(en.team);
    switch (en.role) {
      case 'hq': {
        // diamond
        g.beginPath();
        g.moveTo(x, y - 5);
        g.lineTo(x + 5, y);
        g.lineTo(x, y + 5);
        g.lineTo(x - 5, y);
        g.closePath();
        g.fill();
        break;
      }
      case 'tower': {
        g.beginPath();
        g.moveTo(x, y - 4);
        g.lineTo(x + 3.5, y + 3);
        g.lineTo(x - 3.5, y + 3);
        g.closePath();
        g.fill();
        break;
      }
      case 'shop': {
        // Prominent gold marker (bag/market) so the 16 shops stand out from
        // team structures and read at a glance over the dark water.
        g.fillStyle = colors.shop;
        g.beginPath();
        g.arc(x, y, 4, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = colors.water;
        g.lineWidth = 1.5;
        g.stroke();
        // A tiny dark "$" tick to read as a shop, not just a dot.
        g.fillStyle = colors.water;
        g.fillRect(x - 0.6, y - 2.5, 1.2, 5);
        break;
      }
      case 'repair': {
        g.fillRect(x - 3, y - 1, 6, 2);
        g.fillRect(x - 1, y - 3, 2, 6);
        break;
      }
      case 'missileRamp': {
        g.fillRect(x - 4, y - 1.5, 8, 3);
        break;
      }
      case 'spawnBuilding': {
        g.fillRect(x - 3, y - 3, 6, 6);
        break;
      }
      default: {
        g.fillRect(x - 2, y - 2, 4, 4);
        break;
      }
    }
  }

  /** Recompute own-side base-shop minimap positions when the team settles. */
  function ownShopMarkers(): { x: number; y: number }[] {
    const team = store.match.myTeam;
    if (team !== ownShopTeam) {
      ownShopTeam = team;
      ownShopMini = ownSideShops(
        ctx.catalog.map.structures as unknown as Parameters<typeof ownSideShops>[0],
        team,
      ).map((s) => transform.toMini(s.x, s.y));
    }
    return ownShopMini;
  }

  function draw(nowMs: number): void {
    if (g === null) return;
    // Rebuild the static backdrop once the player's team settles, so own lanes
    // brighten and the trader routes pick the own-team deliver zone.
    if (store.match.myTeam !== bgTeam) buildTerrainBg();
    g.clearRect(0, 0, canvas.width, canvas.height);
    // Static land/water terrain backdrop (lanes-through-land + map structure).
    g.drawImage(terrainBg, 0, 0);

    const sample = hudSample(nowMs);
    if (sample !== null) {
      const mySlot = store.match.mySlot;
      // Structures first (under unit dots).
      for (const en of sample.entities) {
        if (en.kind === 'structure') drawStructure(en);
      }
      for (const en of sample.entities) {
        if (en.kind === 'structure') continue;
        const { x, y } = transform.toMini(en.x, en.y);
        const isSelf = en.kind === 'ship' && en.ownerSlot !== null && en.ownerSlot === mySlot;
        const r = en.kind === 'ship' ? 2.5 : en.kind === 'ward' ? 1.5 : 2;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fillStyle = teamColor(en.team);
        g.fill();
        if (isSelf) {
          g.strokeStyle = colors.self;
          g.lineWidth = 1.5;
          g.stroke();
        }
      }
    }

    // Always-on "SHOPS" cue at the player's own-side base: a gold halo ring +
    // label around the base-shop cluster so the player always knows where to
    // resupply, even before the first snapshot reveals the structures.
    const ownShops = ownShopMarkers();
    if (ownShops.length > 0) {
      let cx = 0;
      let cy = 0;
      for (const m of ownShops) {
        cx += m.x;
        cy += m.y;
      }
      cx /= ownShops.length;
      cy /= ownShops.length;
      g.strokeStyle = colors.shop;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(cx, cy, 9, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = colors.shop;
      g.font = 'bold 8px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = cy < canvas.height / 2 ? 'top' : 'bottom';
      const ty = cy < canvas.height / 2 ? cy + 11 : cy - 11;
      g.fillText('SHOPS', cx, ty);
    }

    // Camera viewport rectangle.
    const rect = getCamera().viewportWorldRect();
    const a = transform.toMini(rect.minX, rect.maxY);
    const b = transform.toMini(rect.maxX, rect.minY);
    g.strokeStyle = colors.view;
    g.lineWidth = 1;
    g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);

    // Map border.
    g.strokeStyle = colors.border;
    g.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  }

  ctx.onFrame(draw);

  // -- click / drag to pan ---------------------------------------------------
  let dragging = false;

  function panToEvent(e: PointerEvent): void {
    const box = canvas.getBoundingClientRect();
    const mx = ((e.clientX - box.left) / box.width) * canvas.width;
    const my = ((e.clientY - box.top) / box.height) * canvas.height;
    const world = transform.toWorld(mx, my);
    getCamera().panTo(world.x, world.y);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    panToEvent(e);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) panToEvent(e);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointercancel', () => {
    dragging = false;
  });
}
