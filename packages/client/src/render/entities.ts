/**
 * Entity rendering: procedural placeholder silhouettes (real sprites later).
 *
 * - Ships: team-colored hull polygon with a clear bow, class-distinct shape
 *   from the catalog (size scales with gold tier), subs slim and dive-shaded
 *   when submerged. Creeps are smaller desaturated hulls, summons
 *   ghost-tinted, wards buoys.
 * - Structures: distinct silhouettes per role (hq/tower/harbor/shop/repair/
 *   missileRamp) with team-color trim; neutral = parchment gray.
 * - Overlays: HP bar (hidden at full unless selected), player name labels,
 *   selection ring, status tints/glyphs.
 *
 * 2.5D: flat-on-water shapes live in a child container squashed by
 * FORESHORTEN (so turning hulls match the plane); structures draw their
 * footprints as ellipses and keep masts/towers upright (unsquashed).
 * Y-sort: container zIndex = -worldY. Hull rotation = -facing.
 */

import { Container, Graphics, Text } from 'pixi.js';
import type { SnapshotEntity, StructureEntity, TeamId } from '@bships/core';

import { getCatalog } from '../catalog.js';
import type { WorldSample } from '../net/interpolation.js';
import { store } from '../net/store.js';
import { FORESHORTEN, getCamera } from './camera.js';
import {
  NEUTRAL_HEX,
  TEAM_HEX,
  desaturate,
  entityVisualRadius,
  hpBarColor,
  hpBarWidth,
  hullSize,
  mixColor,
  scaleColor,
  shipClassKey,
  statusVisual,
  structureRadius,
} from './viz.js';

const NAME_FILL = 0xd8e6f2;
const STONE = 0x55677a;
const STONE_DARK = 0x3a4a5c;

interface EntityView {
  root: Container;
  /** Selection ring (world-plane ellipse), behind everything. */
  ring: Graphics;
  /** Squashed world-plane group; `hull` rotates by -facing inside it. */
  plane: Container;
  hull: Graphics;
  /** Unsquashed body for structures/wards (upright silhouettes). */
  body: Graphics;
  statusG: Graphics;
  hpBar: Graphics;
  label: Text | null;
  labelName: string | null;
  /** Redraw signature: typeId|team|submerged|role. */
  sig: string;
  radius: number;
}

export interface EntityLayer {
  view: Container;
  update(sample: WorldSample | null, nowMs: number): void;
}

function teamColor(team: TeamId | null): number {
  return team === null ? NEUTRAL_HEX : TEAM_HEX[team];
}

// ---------------------------------------------------------------------------
// Hull / silhouette drawing (all coordinates in world units, +x = bow)
// ---------------------------------------------------------------------------

function drawHullPolygon(g: Graphics, length: number, width: number, color: number): void {
  const l = length / 2;
  const w = width / 2;
  g.poly([l * 1.1, 0, l * 0.36, w, -l, w * 0.8, -l * 1.1, 0, -l, -w * 0.8, l * 0.36, -w])
    .fill(scaleColor(color, 0.55))
    .stroke({ width: 3, color: scaleColor(color, 1.05) });
  // Deck inset.
  g.poly([l * 0.8, 0, l * 0.25, w * 0.6, -l * 0.78, w * 0.5, -l * 0.78, -w * 0.5, l * 0.25, -w * 0.6])
    .fill({ color: scaleColor(color, 0.78), alpha: 0.9 });
  // Bow wedge: the unambiguous facing cue.
  g.poly([l * 1.1, 0, l * 0.55, w * 0.45, l * 0.55, -w * 0.45]).fill({
    color: 0xffffff,
    alpha: 0.85,
  });
}

function drawMast(g: Graphics, x: number, r: number, color: number): void {
  g.circle(x, 0, r)
    .fill(scaleColor(color, 0.35))
    .stroke({ width: 2, color: scaleColor(color, 1.2) });
}

function drawShip(
  g: Graphics,
  typeId: string,
  team: TeamId | null,
  submerged: boolean,
): number {
  const catalog = getCatalog();
  const spec = catalog.ships[typeId];
  const gold = spec?.gold ?? 2400;
  const isSub = spec?.isSub ?? false;
  const cls = spec !== undefined ? shipClassKey(spec) : 'battle';
  const { length, width } = hullSize(gold, isSub);
  const color = submerged ? scaleColor(teamColor(team), 0.6) : teamColor(team);
  const l = length / 2;
  const w = width / 2;

  if (cls === 'sub') {
    // Slim cigar hull + conning tower fin; shaded darker when submerged.
    g.ellipse(0, 0, l, w)
      .fill(scaleColor(color, submerged ? 0.4 : 0.5))
      .stroke({ width: 3, color: scaleColor(color, 1.0) });
    g.rect(-l * 0.25, -w * 0.55, l * 0.4, w * 1.1).fill(scaleColor(color, 0.75));
    g.poly([l, 0, l * 0.6, w * 0.5, l * 0.6, -w * 0.5]).fill({ color: 0xffffff, alpha: 0.8 });
    return l;
  }

  if (cls === 'merchant') {
    // Tubby rounded hull.
    g.ellipse(0, 0, l, w * 1.1)
      .fill(scaleColor(color, 0.55))
      .stroke({ width: 3, color: scaleColor(color, 1.05) });
    g.ellipse(-l * 0.15, 0, l * 0.55, w * 0.7).fill({ color: scaleColor(color, 0.8), alpha: 0.9 });
    g.poly([l * 1.05, 0, l * 0.55, w * 0.5, l * 0.55, -w * 0.5]).fill({
      color: 0xffffff,
      alpha: 0.85,
    });
    drawMast(g, 0, w * 0.3, color);
    return l;
  }

  drawHullPolygon(g, length, width, color);

  switch (cls) {
    case 'battle':
      drawMast(g, -l * 0.1, w * 0.32, color);
      break;
    case 'cruiser':
      drawMast(g, l * 0.25, w * 0.3, color);
      drawMast(g, -l * 0.35, w * 0.3, color);
      break;
    case 'flagship':
      drawMast(g, l * 0.35, w * 0.26, color);
      drawMast(g, -l * 0.05, w * 0.34, color);
      drawMast(g, -l * 0.45, w * 0.26, color);
      break;
    case 'royal':
      drawMast(g, l * 0.3, w * 0.3, color);
      drawMast(g, -l * 0.4, w * 0.3, color);
      // Gold trim: the top-tier tell.
      g.poly([l * 1.1, 0, l * 0.36, w, -l, w * 0.8, -l * 1.1, 0, -l, -w * 0.8, l * 0.36, -w]).stroke({
        width: 2,
        color: 0xf2c14e,
        alpha: 0.9,
      });
      break;
    case 'leviathan':
      // Spiky dorsal ridges.
      for (let i = -2; i <= 2; i++) {
        const x = i * l * 0.3;
        g.poly([x - 8, 0, x, -w * 0.9, x + 8, 0]).fill(scaleColor(color, 1.15));
      }
      break;
    case 'goblin':
      // Angular jagged plating + gear dot.
      g.poly([l * 0.5, -w * 0.2, l * 0.2, w * 0.4, -l * 0.2, -w * 0.4, -l * 0.6, w * 0.2]).stroke({
        width: 2,
        color: 0xc8e84e,
        alpha: 0.8,
      });
      g.circle(-l * 0.1, 0, w * 0.28).stroke({ width: 3, color: 0xc8e84e });
      break;
    case 'starter':
    default:
      break;
  }
  return l;
}

function drawSmallHull(g: Graphics, length: number, color: number): void {
  const l = length / 2;
  const w = length * 0.21;
  g.poly([l, 0, l * 0.3, w, -l, w * 0.75, -l, -w * 0.75, l * 0.3, -w])
    .fill(scaleColor(color, 0.55))
    .stroke({ width: 2, color: scaleColor(color, 1.05) });
  g.poly([l, 0, l * 0.45, w * 0.5, l * 0.45, -w * 0.5]).fill({ color: 0xffffff, alpha: 0.75 });
}

function drawWard(g: Graphics, team: TeamId | null, radius: number): void {
  const color = teamColor(team);
  // Floating buoy: footprint ellipse + body + mast + light.
  g.ellipse(0, radius * 0.35, radius, radius * 0.5 * FORESHORTEN).fill({
    color: 0x000000,
    alpha: 0.25,
  });
  g.circle(0, 0, radius * 0.6)
    .fill(scaleColor(color, 0.5))
    .stroke({ width: 2, color: scaleColor(color, 1.1) });
  g.moveTo(0, -radius * 0.5).lineTo(0, -radius * 1.4).stroke({ width: 2, color: 0xdddddd });
  g.circle(0, -radius * 1.5, radius * 0.22).fill(0xfff2a0);
}

// ---------------------------------------------------------------------------
// Structures — distinct silhouettes per role, team trim, upright features
// ---------------------------------------------------------------------------

function drawFootprint(g: Graphics, r: number): void {
  g.ellipse(0, 0, r, r * FORESHORTEN).fill({ color: 0x000000, alpha: 0.28 });
}

function drawStructure(g: Graphics, role: StructureEntity['role'] | undefined, team: TeamId | null): number {
  const r = structureRadius(role);
  const accent = teamColor(team);
  drawFootprint(g, r);

  switch (role) {
    case 'hq': {
      // Large bastion: hexagonal walls, inner keep, flag mast.
      const pts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        pts.push(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9 * FORESHORTEN);
      }
      g.poly(pts).fill(STONE).stroke({ width: 5, color: accent });
      g.ellipse(0, -r * 0.1, r * 0.45, r * 0.45 * FORESHORTEN)
        .fill(STONE_DARK)
        .stroke({ width: 3, color: scaleColor(accent, 0.8) });
      g.moveTo(0, -r * 0.3).lineTo(0, -r * 1.5).stroke({ width: 4, color: 0xcccccc });
      g.poly([0, -r * 1.5, r * 0.5, -r * 1.32, 0, -r * 1.14]).fill(accent);
      break;
    }
    case 'tower': {
      // Slim turret: tall shaft + crenellated cap + accent band.
      g.rect(-r * 0.5, -r * 2.4, r, r * 2.4 + r * 0.4 * FORESHORTEN)
        .fill(STONE)
        .stroke({ width: 2, color: STONE_DARK });
      g.rect(-r * 0.62, -r * 2.7, r * 1.24, r * 0.45).fill(STONE_DARK);
      for (let i = -1; i <= 1; i++) {
        g.rect(i * r * 0.45 - r * 0.12, -r * 2.95, r * 0.24, r * 0.3).fill(STONE_DARK);
      }
      g.rect(-r * 0.5, -r * 1.1, r, r * 0.28).fill(accent);
      break;
    }
    case 'spawnBuilding': {
      // Harbor: pier planks + warehouse + crane.
      g.rect(-r, -r * 0.15 * FORESHORTEN, r * 2, r * 0.62 * FORESHORTEN)
        .fill(0x6b5234)
        .stroke({ width: 2, color: 0x4a3a26 });
      for (let i = -3; i <= 3; i++) {
        g.moveTo(i * r * 0.28, -r * 0.15 * FORESHORTEN)
          .lineTo(i * r * 0.28, r * 0.47 * FORESHORTEN)
          .stroke({ width: 1, color: 0x4a3a26, alpha: 0.8 });
      }
      g.rect(-r * 0.75, -r * 0.95, r * 0.9, r * 0.85)
        .fill(STONE)
        .stroke({ width: 3, color: accent });
      g.poly([-r * 0.8, -r * 0.95, -r * 0.3, -r * 1.3, r * 0.2, -r * 0.95]).fill(scaleColor(accent, 0.7));
      // Crane: mast + jib + hook line.
      g.moveTo(r * 0.45, 0).lineTo(r * 0.45, -r * 1.35).stroke({ width: 4, color: 0x8a8a8a });
      g.moveTo(r * 0.45, -r * 1.35).lineTo(r * 1.05, -r * 0.95).stroke({ width: 3, color: 0x8a8a8a });
      g.moveTo(r * 1.05, -r * 0.95).lineTo(r * 1.05, -r * 0.45).stroke({ width: 1, color: 0xbbbbbb });
      break;
    }
    case 'shop': {
      // Market tent: striped awning + sign post.
      g.poly([-r * 0.85, r * 0.3 * FORESHORTEN, 0, -r * 1.05, r * 0.85, r * 0.3 * FORESHORTEN])
        .fill(0x8a6f4a)
        .stroke({ width: 2, color: 0x5c4a30 });
      for (let i = 0; i < 4; i++) {
        const x0 = -r * 0.85 + (i * r * 1.7) / 4;
        g.poly([x0, r * 0.3 * FORESHORTEN, x0 + r * 0.21, r * 0.3 * FORESHORTEN, 0, -r * 1.05]).fill({
          color: i % 2 === 0 ? accent : 0xe8e0cc,
          alpha: 0.55,
        });
      }
      g.moveTo(r * 0.75, r * 0.2).lineTo(r * 0.75, -r * 0.7).stroke({ width: 3, color: 0x5c4a30 });
      g.circle(r * 0.75, -r * 0.82, r * 0.18).fill(0xf2c14e);
      break;
    }
    case 'repair': {
      // Dry dock: two rails + cradle braces, wrench-gold accent.
      g.rect(-r * 0.95, -r * 0.5, r * 1.9, r * 0.22).fill(STONE).stroke({ width: 2, color: accent });
      g.rect(-r * 0.95, r * 0.28, r * 1.9, r * 0.22).fill(STONE).stroke({ width: 2, color: accent });
      for (let i = -2; i <= 2; i++) {
        g.moveTo(i * r * 0.4, -r * 0.4)
          .lineTo(i * r * 0.4, r * 0.4)
          .stroke({ width: 3, color: 0x8a8a8a });
      }
      g.circle(0, -r * 0.9, r * 0.22).stroke({ width: 4, color: 0xf2c14e });
      break;
    }
    case 'missileRamp': {
      // Inclined launch rail + base + missile silhouette.
      g.rect(-r * 0.7, -r * 0.2, r * 1.4, r * 0.5 * FORESHORTEN)
        .fill(STONE_DARK)
        .stroke({ width: 2, color: accent });
      g.moveTo(-r * 0.55, r * 0.05).lineTo(r * 0.8, -r * 1.2).stroke({ width: 6, color: 0x8a8a8a });
      g.ellipse(r * 0.35, -r * 0.75, r * 0.42, r * 0.14)
        .fill(0xcccccc)
        .stroke({ width: 1, color: 0x666666 });
      g.poly([r * 0.77, -r * 0.89, r * 0.95, -r * 0.75, r * 0.7, -r * 0.62]).fill(accent);
      break;
    }
    default: {
      // Generic block + roof.
      g.rect(-r * 0.7, -r * 0.8, r * 1.4, r * 0.8)
        .fill(STONE)
        .stroke({ width: 2, color: accent });
      g.poly([-r * 0.75, -r * 0.8, 0, -r * 1.15, r * 0.75, -r * 0.8]).fill(STONE_DARK);
      break;
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export function createEntities(): EntityLayer {
  const view = new Container();
  view.sortableChildren = true;
  const views = new Map<number, EntityView>();

  function createView(): EntityView {
    const root = new Container();
    const ring = new Graphics();
    const plane = new Container();
    plane.scale.y = FORESHORTEN;
    const hull = new Graphics();
    plane.addChild(hull);
    const body = new Graphics();
    const statusG = new Graphics();
    const hpBar = new Graphics();
    root.addChild(ring, plane, body, statusG, hpBar);
    view.addChild(root);
    return {
      root,
      ring,
      plane,
      hull,
      body,
      statusG,
      hpBar,
      label: null,
      labelName: null,
      sig: '',
      radius: 0,
    };
  }

  function redraw(v: EntityView, e: SnapshotEntity): void {
    v.hull.clear();
    v.body.clear();
    switch (e.kind) {
      case 'ship':
        drawShip(v.hull, e.typeId, e.team, e.submerged === true);
        break;
      case 'creep':
        drawSmallHull(v.hull, 52, desaturate(teamColor(e.team), 0.55));
        break;
      case 'summon':
        drawSmallHull(v.hull, 48, mixColor(teamColor(e.team), 0x9ff5ff, 0.45));
        break;
      case 'ward':
        drawWard(v.body, e.team, 22);
        break;
      case 'structure':
        drawStructure(v.body, e.role, e.team);
        break;
    }
    v.radius = entityVisualRadius(e, getCatalog());
  }

  function ensureLabel(v: EntityView, name: string): void {
    if (v.label !== null && v.labelName === name) return;
    if (v.label !== null) v.label.destroy();
    const label = new Text({
      text: name,
      style: {
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        fontSize: 13,
        fill: NAME_FILL,
        stroke: { color: 0x000000, width: 3 },
      },
    });
    label.resolution = 2;
    label.anchor.set(0.5, 1);
    v.root.addChild(label);
    v.label = label;
    v.labelName = name;
  }

  function drawHpBar(v: EntityView, e: SnapshotEntity, selected: boolean): void {
    v.hpBar.clear();
    const full = e.hp >= e.maxHp;
    if (e.kind === 'ward' || (full && !selected)) return;
    const w = hpBarWidth(e.maxHp);
    const h = 7;
    const y = -(v.radius * FORESHORTEN + (e.kind === 'structure' ? v.radius * 1.2 : v.radius * 0.6) + 18);
    const ratio = e.maxHp > 0 ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 0;
    v.hpBar.rect(-w / 2 - 1, y - 1, w + 2, h + 2).fill({ color: 0x000000, alpha: 0.7 });
    v.hpBar.rect(-w / 2, y, w * ratio, h).fill(hpBarColor(ratio));
  }

  function drawStatusGlyphs(v: EntityView, glyphs: readonly string[], nowMs: number): void {
    v.statusG.clear();
    if (glyphs.length === 0) return;
    const top = -(v.radius * FORESHORTEN + 10);
    for (const glyph of glyphs) {
      if (glyph === 'stunned') {
        // Orbiting stars.
        for (let i = 0; i < 3; i++) {
          const a = nowMs / 250 + (i * Math.PI * 2) / 3;
          v.statusG
            .circle(Math.cos(a) * v.radius * 0.55, top - 8 + Math.sin(a) * 5, 3.5)
            .fill(0xffe066);
        }
      } else if (glyph === 'shielded') {
        v.statusG
          .ellipse(0, 0, v.radius * 1.15, v.radius * 1.15 * FORESHORTEN)
          .stroke({ width: 2.5, color: 0x9fd0ff, alpha: 0.8 });
      } else if (glyph === 'goblinMine') {
        const blink = Math.sin(nowMs / 120) > 0;
        if (blink) v.statusG.circle(v.radius * 0.5, top, 4).fill(0xff3030);
      } else if (glyph === 'revealed') {
        v.statusG
          .ellipse(0, 0, v.radius * 1.05, v.radius * 1.05 * FORESHORTEN)
          .stroke({ width: 2, color: 0xe080ff, alpha: 0.7 });
      }
    }
  }

  function update(sample: WorldSample | null, nowMs: number): void {
    if (sample === null) {
      if (views.size > 0) {
        for (const v of views.values()) v.root.destroy({ children: true });
        views.clear();
      }
      return;
    }

    const cam = getCamera();
    const zoom = cam.zoom;
    const selectedId = store.ui.selectedEntityId;
    const names = new Map<number, string>();
    for (const p of store.match.players) names.set(p.slot, p.name);

    const seen = new Set<number>();
    for (const e of sample.entities) {
      seen.add(e.id);
      let v = views.get(e.id);
      if (v === undefined) {
        v = createView();
        views.set(e.id, v);
      }

      const sig = `${e.kind}|${e.typeId}|${e.team ?? ''}|${e.submerged === true}|${e.role ?? ''}`;
      if (sig !== v.sig) {
        v.sig = sig;
        redraw(v, e);
      }

      const sp = cam.worldToScreen(e.x, e.y);
      v.root.position.set(sp.x, sp.y);
      v.root.scale.set(zoom);
      v.root.zIndex = -e.y;
      v.hull.rotation = -e.facing;

      const sv = statusVisual(e.statuses, nowMs);
      v.hull.tint = sv.tint;
      v.body.tint = sv.tint;
      let alpha = sv.alpha;
      if (e.kind === 'ship' && e.submerged === true) alpha = Math.min(alpha, 0.65);
      if (e.kind === 'summon') alpha = Math.min(alpha, 0.8);
      v.root.alpha = alpha;

      const selected = e.id === selectedId;
      v.ring.clear();
      if (selected) {
        const rr = v.radius * 1.3;
        v.ring
          .ellipse(0, 0, rr, rr * FORESHORTEN)
          .stroke({ width: 3, color: 0xffffff, alpha: 0.9 });
        v.ring
          .ellipse(0, 0, rr + 4, (rr + 4) * FORESHORTEN)
          .stroke({ width: 1.5, color: 0xffffff, alpha: 0.35 });
      }

      drawHpBar(v, e, selected);
      drawStatusGlyphs(v, sv.glyphs, nowMs);

      if (e.kind === 'ship' && e.ownerSlot !== null) {
        const name = names.get(e.ownerSlot);
        if (name !== undefined) {
          ensureLabel(v, name);
          if (v.label !== null) {
            v.label.position.set(0, -(v.radius * FORESHORTEN + v.radius * 0.6 + 22));
            v.label.visible = true;
          }
        }
      } else if (v.label !== null) {
        v.label.visible = false;
      }
    }

    for (const [id, v] of views) {
      if (!seen.has(id)) {
        v.root.destroy({ children: true });
        views.delete(id);
      }
    }
  }

  return { view, update };
}
