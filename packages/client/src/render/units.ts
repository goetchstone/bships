/**
 * render-units: the pseudo-3D UNIT layer — ships (all 18 Classic classes via
 * `shipShape`/`shipdraw`), creeps, summons, and wards. Replaces the unit code
 * path in the superseded `entities.ts`.
 *
 * Per-unit composition (matches docs/RENDER.md "render-units spec"):
 *
 *   root  (positioned at worldToScreen(x,y), scaled by zoom, zIndex = depthKey)
 *    ├─ shadow   — foreshortened ellipse on the water, offset down-right
 *    ├─ wake     — fading foam V at the bow when the unit moved this frame
 *    ├─ plane    — squashed by FORESHORTEN; `hull` rotates by -facing inside it
 *    │    └─ hull — flat-on-water silhouette + bright bow wedge (facing cue)
 *    ├─ super    — superstructure, RAISED up the screen by heightOffsetPx so it
 *    │            reads as standing above the deck (masts/turrets/bridge/mark)
 *    └─ overlay  — selection ring, status glyphs, hp bar, name label
 *
 * Heights go through `depth.logicalHeight` + `depth.heightOffsetPx` (NEVER raw
 * world units added to screenY — that was the giant-flag bug). Static graphics
 * redraw only when the draw signature changes (kind|typeId|team|submerged|
 * selected), like the old `sig` guard; per-frame work is just position /
 * rotation / tint / hp width / wake fade. Animations are time-based off
 * `nowMs`. Views are pooled by entity id and `destroy({children:true})` on
 * removal — no leaks.
 *
 * Pure helpers (`shouldWake`, `hpBarY`, `labelY`, `selectionRadius`) are
 * exported and unit-tested without pixi.
 *
 * Overlay sorting note: the contract calls for overlays at `overlayKey(y)`.
 * Because the contract ALSO mandates one pooled Container per unit id, each
 * unit's overlays (hp bar / label / status / ring) are CHILDREN of that unit's
 * root and so always draw above that unit's own body. They share the unit's
 * `depthKey(y,'unit')` zIndex for cross-unit ordering; since one world-y unit
 * dwarfs the whole per-kind bias band (see depth.ts), N–S order between units
 * still dominates and overlaps at an exact-tie y are vanishingly rare. (A
 * single shared overlay sub-layer keyed by `overlayKey(y)` would be the only
 * alternative, but it breaks the per-unit pool the contract requires.)
 */

import { Container, Graphics, Text } from 'pixi.js';
import type { SnapshotEntity, TeamId } from '@bships/core';

import { getCatalog } from '../catalog.js';
import type { WorldSample } from '../net/interpolation.js';
import { store } from '../net/store.js';
import { FORESHORTEN, getCamera } from './camera.js';
import { depthKey, heightOffsetPx, logicalHeight } from './depth.js';
import {
  HP_BACK,
  INK,
  INK_OUTLINE,
  desaturate as desatTheme,
  dropShadow,
  mix,
  shade,
} from './theme.js';
import {
  CREEP_HULL_LENGTH,
  SUMMON_HULL_LENGTH,
  WARD_RADIUS,
  entityVisualRadius,
  hpBarColor,
  hpBarWidth,
  statusVisual,
} from './viz.js';
import { NEUTRAL_HEX, TEAM_HEX } from './viz.js';
import {
  drawShipHull,
  drawShipSuper,
  resolveShipDraw,
  type ShipDrawData,
} from './shipdraw.js';

function teamColor(team: TeamId | null): number {
  return team === null ? NEUTRAL_HEX : TEAM_HEX[team];
}

// ---------------------------------------------------------------------------
// Pure placement / trigger math (pixi-free; unit-tested in units.test.ts).
// ---------------------------------------------------------------------------

/** Squared distance a unit must move between frames to kick a fresh bow wake. */
export const WAKE_MIN_DIST_SQ = 0.6 * 0.6;

/**
 * True when the interpolated position moved enough since last frame to warrant
 * a bow wake. World-unit deltas; the threshold rejects sub-pixel jitter so a
 * stationary ship never foams.
 */
export function shouldWake(dx: number, dy: number): boolean {
  return dx * dx + dy * dy >= WAKE_MIN_DIST_SQ;
}

/**
 * Screen-y (in the root's local, zoom-1 space, y-up is negative) where the top
 * of an overlay HP bar sits: above the footprint ellipse, lifted further for
 * tall things. `footprintR` world units; everything stays in the root's
 * pre-zoom local frame (the root is scaled by zoom).
 */
export function hpBarY(footprintR: number, kind: SnapshotEntity['kind']): number {
  const lift = kind === 'structure' ? footprintR * 1.0 : footprintR * 0.55;
  return -(footprintR * FORESHORTEN + lift + 16);
}

/** Local screen-y for the player name label (just above the hp bar zone). */
export function labelY(footprintR: number): number {
  return -(footprintR * FORESHORTEN + footprintR * 0.55 + 30);
}

/** Selection-ring radius in world units for a footprint (a touch larger). */
export function selectionRadius(footprintR: number): number {
  return footprintR * 1.28;
}

/** Number of distinct hp-ratio steps the bar redraw quantizes to (sub-pixel
 *  ratio jitter below one step never re-tessellates the bar). */
export const HP_RATIO_STEPS = 100;

/**
 * Redraw signature for a unit's HP bar. Two frames with the same signature
 * produce a pixel-identical bar, so the renderer can skip the clear+redraw.
 * Quantizes the ratio so interpolation jitter under 1% never re-tessellates.
 * Pure (no pixi); unit-tested.
 */
export function hpBarSig(hp: number, maxHp: number, selected: boolean): string {
  const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const q = Math.round(ratio * HP_RATIO_STEPS);
  return `${q}|${selected ? 1 : 0}`;
}

/** Glyphs whose drawing animates over time and therefore must redraw per frame. */
const ANIMATED_GLYPHS: ReadonlySet<string> = new Set(['stunned', 'goblinMine']);

/** True when a glyph set contains a glyph that animates (needs per-frame redraw). */
export function glyphsAnimate(glyphs: readonly string[]): boolean {
  for (const g of glyphs) if (ANIMATED_GLYPHS.has(g)) return true;
  return false;
}

/** Order-independent signature for a glyph set (skips redraw when unchanged). */
export function glyphSig(glyphs: readonly string[]): string {
  if (glyphs.length === 0) return '';
  if (glyphs.length === 1) return glyphs[0]!;
  return [...glyphs].sort().join(',');
}

// ---------------------------------------------------------------------------
// Creep / summon / ward silhouettes (named exports for the gallery).
// ---------------------------------------------------------------------------

/** A small generic boat hull (creeps + summons reuse this, recolored). */
function drawSmallHull(g: Graphics, length: number, color: number): void {
  const l = length / 2;
  const w = length * 0.2;
  const s = shade(color);
  g.poly([l, 0, l * 0.32, w, -l, w * 0.74, -l, -w * 0.74, l * 0.32, -w])
    .fill(s.shade)
    .stroke({ width: 2, color: s.outline });
  g.poly([l, 0, l * 0.32, -w, -l, -w * 0.74]).fill({ color: s.lit, alpha: 0.85 });
  g.poly([l, 0, l * 0.46, w * 0.5, l * 0.46, -w * 0.5]).fill({ color: 0xffffff, alpha: 0.75 });
}

/** Creep: a smaller, desaturated hull (empire raiders). */
export function drawCreep(g: Graphics, _typeId: string, team: TeamId | null): number {
  drawSmallHull(g, CREEP_HULL_LENGTH, desatTheme(teamColor(team), 0.55));
  return CREEP_HULL_LENGTH / 2;
}

/** Summon: ghost-tinted, partial-alpha small hull (alpha applied by the layer). */
export function drawSummon(g: Graphics, _typeId: string, team: TeamId | null): number {
  drawSmallHull(g, SUMMON_HULL_LENGTH, mix(teamColor(team), 0x9ff5ff, 0.5));
  return SUMMON_HULL_LENGTH / 2;
}

/** Ward: a floating buoy (footprint + body + mast + warning light). */
export function drawWard(g: Graphics, team: TeamId | null): number {
  const r = WARD_RADIUS;
  const color = teamColor(team);
  const s = shade(color);
  // Buoy body.
  g.circle(r * 0.18, r * 0.18, r * 0.62).fill(s.shade);
  g.circle(0, 0, r * 0.6).fill(s.base).stroke({ width: 2, color: s.outline });
  g.circle(-r * 0.2, -r * 0.2, r * 0.3).fill({ color: s.lit, alpha: 0.85 });
  // Mast + warning lamp.
  g.moveTo(0, -r * 0.5).lineTo(0, -r * 1.4).stroke({ width: 2, color: 0xdddddd });
  g.circle(0, -r * 1.5, r * 0.22).fill(0xfff2a0);
  return r;
}

// ---------------------------------------------------------------------------
// View pool
// ---------------------------------------------------------------------------

interface UnitView {
  root: Container;
  ring: Graphics;
  shadow: Graphics;
  wake: Graphics;
  /** Squashed world-plane group; `hull` rotates by -facing inside it. */
  plane: Container;
  hull: Graphics;
  /** Raised, upright superstructure (also squashed, rotates with facing). */
  super: Graphics;
  /** A second squashed+rotated plane carrying `super` so it turns with the hull. */
  superPlane: Container;
  statusG: Graphics;
  hpBar: Graphics;
  label: Text | null;
  labelName: string | null;
  /** Redraw signature: kind|typeId|team|submerged|selected. */
  sig: string;
  /** World footprint radius (== entityVisualRadius). */
  radius: number;
  /** Ship-only resolved draw data (height ratio for the super lift). */
  shipDraw: ShipDrawData | null;
  /** Last interpolated world position (for the wake-move test). */
  lastX: number;
  lastY: number;
  /** nowMs when the bow wake last fired (drives the time-based fade). */
  wakeStartMs: number;
  /** Last drawn hp-bar signature (quantized ratio | selected) — '' = none yet. */
  hpSig: string;
  /** Last drawn status-glyph signature (sorted glyph set) — '' = none yet. */
  glyphSig: string;
  /** Whether the last glyph set contains an animated glyph (needs per-frame redraw). */
  glyphAnimated: boolean;
  /** Last drawn selection-ring signature (selected|radius) — '' = none yet. */
  selSig: string;
}

export interface UnitLayer {
  view: Container;
  update(sample: WorldSample | null, nowMs: number): void;
}

/** Wake fade duration (ms). */
const WAKE_FADE_MS = 520;

export function createUnits(): UnitLayer {
  const view = new Container();
  view.sortableChildren = true;
  const views = new Map<number, UnitView>();

  function createView(): UnitView {
    const root = new Container();
    const ring = new Graphics();
    const shadow = new Graphics();
    // Wake lives in its own foreshortened plane so it lies flat on the water;
    // its Graphics rotates with -facing so the foam V trails the moving bow.
    const wakePlane = new Container();
    wakePlane.scale.y = FORESHORTEN;
    const wake = new Graphics();
    wakePlane.addChild(wake);
    const plane = new Container();
    plane.scale.y = FORESHORTEN;
    const hull = new Graphics();
    plane.addChild(hull);
    const superPlane = new Container();
    superPlane.scale.y = FORESHORTEN;
    const superG = new Graphics();
    superPlane.addChild(superG);
    const statusG = new Graphics();
    const hpBar = new Graphics();
    // Draw order within root (back to front): shadow, ring, wake, hull plane,
    // raised super, status, hp bar.
    root.addChild(shadow, ring, wakePlane, plane, superPlane, statusG, hpBar);
    view.addChild(root);
    return {
      root,
      ring,
      shadow,
      wake,
      plane,
      hull,
      super: superG,
      superPlane,
      statusG,
      hpBar,
      label: null,
      labelName: null,
      sig: '',
      radius: 0,
      shipDraw: null,
      lastX: 0,
      lastY: 0,
      wakeStartMs: -1e9,
      hpSig: '',
      glyphSig: '',
      glyphAnimated: false,
      selSig: '',
    };
  }

  function redraw(v: UnitView, e: SnapshotEntity): void {
    v.hull.clear();
    v.super.clear();
    v.shipDraw = null;
    switch (e.kind) {
      case 'ship': {
        const d = resolveShipDraw(e.typeId, e.team, { submerged: e.submerged === true });
        drawShipHull(v.hull, d);
        drawShipSuper(v.super, d);
        v.shipDraw = d;
        break;
      }
      case 'creep':
        drawCreep(v.hull, e.typeId, e.team);
        break;
      case 'summon':
        drawSummon(v.hull, e.typeId, e.team);
        break;
      case 'ward':
        drawWard(v.super, e.team);
        break;
      case 'structure':
        // Structures are render-world's job; units never draws them.
        break;
    }
    const prevRadius = v.radius;
    v.radius = entityVisualRadius(e, getCatalog());
    // The footprint radius drives hp-bar / glyph placement; if it changed (a
    // different class for this id — rare but possible), force those overlays to
    // re-render at the new radius rather than trusting the cached signature.
    if (v.radius !== prevRadius) {
      v.hpSig = '';
      v.glyphSig = '';
    }

    // Drop shadow on the water — sized by footprint + standing-up height.
    const heightRatio = v.shipDraw !== null ? v.shipDraw.shape.deckHeight : 0.18;
    const h = logicalHeight(v.radius, heightRatio);
    const sh = dropShadow(v.radius, h);
    v.shadow.clear();
    if (e.kind !== 'ward') {
      v.shadow.ellipse(sh.dx, sh.dy, sh.rx, sh.ry).fill({ color: sh.color, alpha: sh.alpha });
    }
    // The hull/super radius may have changed; force the ring to redraw at the
    // new radius next time it's evaluated (it has its own selection guard).
    v.selSig = '';
  }

  /**
   * Selection ring (world-plane ellipse, foreshortened). Split out of `redraw`
   * so toggling selection re-tessellates ONLY this small ring, not the whole
   * hull + superstructure — `selected` is no longer part of the hull redraw
   * signature. Guarded so an unchanged selection state never re-clears it.
   */
  function drawRing(v: UnitView, selected: boolean): void {
    const sig = selected ? `1|${v.radius}` : '0';
    if (sig === v.selSig) return;
    v.selSig = sig;
    v.ring.clear();
    if (selected) {
      const rr = selectionRadius(v.radius);
      v.ring.ellipse(0, 0, rr, rr * FORESHORTEN).stroke({ width: 3, color: 0xffffff, alpha: 0.9 });
      v.ring.ellipse(0, 0, rr + 5, (rr + 5) * FORESHORTEN).stroke({ width: 1.5, color: 0xffffff, alpha: 0.35 });
    }
  }

  function ensureLabel(v: UnitView, name: string): void {
    if (v.label !== null && v.labelName === name) return;
    if (v.label !== null) v.label.destroy();
    const label = new Text({
      text: name,
      style: {
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        fontSize: 13,
        fill: INK,
        stroke: { color: INK_OUTLINE, width: 3 },
      },
    });
    label.resolution = 2;
    label.anchor.set(0.5, 1);
    v.root.addChild(label);
    v.label = label;
    v.labelName = name;
  }

  function drawHpBar(v: UnitView, e: SnapshotEntity, selected: boolean): void {
    const full = e.hp >= e.maxHp;
    // Wards never show a bar; a full-hp unselected unit shows nothing. Skip the
    // clear entirely when the bar is already empty so we don't dirty the
    // geometry of an unchanged, full-hp ship every frame.
    if (e.kind === 'ward' || (full && !selected)) {
      if (v.hpSig !== '') {
        v.hpBar.clear();
        v.hpSig = '';
      }
      return;
    }
    const sig = hpBarSig(e.hp, e.maxHp, selected);
    if (sig === v.hpSig) return; // pixel-identical to last frame — keep geometry
    v.hpSig = sig;
    v.hpBar.clear();
    const w = hpBarWidth(e.maxHp);
    const h = 7;
    const y = hpBarY(v.radius, e.kind);
    const ratio = e.maxHp > 0 ? Math.max(0, Math.min(1, e.hp / e.maxHp)) : 0;
    v.hpBar.rect(-w / 2 - 1, y - 1, w + 2, h + 2).fill({ color: HP_BACK, alpha: 0.78 });
    v.hpBar.rect(-w / 2, y, w * ratio, h).fill(hpBarColor(ratio));
  }

  function drawStatusGlyphs(v: UnitView, glyphs: readonly string[], nowMs: number): void {
    const sig = glyphSig(glyphs);
    const animated = sig !== '' && glyphsAnimate(glyphs);
    // Skip the redraw (and the clear) when the glyph set is unchanged AND none
    // of the glyphs animate. A status-free unit (the common case) keeps an
    // already-empty Graphics untouched.
    if (sig === v.glyphSig && !animated && !v.glyphAnimated) return;
    v.glyphSig = sig;
    v.glyphAnimated = animated;
    v.statusG.clear();
    if (glyphs.length === 0) return;
    const top = -(v.radius * FORESHORTEN + 12);
    for (const glyph of glyphs) {
      if (glyph === 'stunned') {
        for (let i = 0; i < 3; i++) {
          const a = nowMs / 250 + (i * Math.PI * 2) / 3;
          v.statusG.circle(Math.cos(a) * v.radius * 0.55, top - 8 + Math.sin(a) * 5, 3.5).fill(0xffe066);
        }
      } else if (glyph === 'shielded') {
        v.statusG
          .ellipse(0, 0, v.radius * 1.18, v.radius * 1.18 * FORESHORTEN)
          .stroke({ width: 2.5, color: 0x9fd0ff, alpha: 0.8 });
      } else if (glyph === 'goblinMine') {
        if (Math.sin(nowMs / 120) > 0) v.statusG.circle(v.radius * 0.5, top, 4).fill(0xff3030);
      } else if (glyph === 'revealed') {
        v.statusG
          .ellipse(0, 0, v.radius * 1.06, v.radius * 1.06 * FORESHORTEN)
          .stroke({ width: 2, color: 0xe080ff, alpha: 0.7 });
      }
    }
  }

  function drawWake(v: UnitView, nowMs: number): void {
    const age = nowMs - v.wakeStartMs;
    if (age >= WAKE_FADE_MS) {
      if (v.wake.alpha !== 0) v.wake.alpha = 0;
      return;
    }
    const t = age / WAKE_FADE_MS; // 0 -> 1
    v.wake.alpha = (1 - t) * 0.6;
    // Static V geometry; only alpha animates per frame -> redraw once on fire.
    if (age <= 16) {
      v.wake.clear();
      const r = v.radius;
      // Foam V trailing the bow (bow is +x in the rotated plane, but the wake
      // lives in the root frame oriented to the hull via the plane rotation).
      v.wake.poly([r * 0.7, 0, -r * 0.2, r * 0.5, -r * 0.1, 0, -r * 0.2, -r * 0.5])
        .fill({ color: 0xbfe3ff, alpha: 0.5 });
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
      if (e.kind === 'structure') continue; // render-world owns structures
      seen.add(e.id);
      let v = views.get(e.id);
      const fresh = v === undefined;
      if (v === undefined) {
        v = createView();
        v.lastX = e.x;
        v.lastY = e.y;
        views.set(e.id, v);
      }

      const selected = e.id === selectedId;
      // `selected` is intentionally NOT in the hull/super redraw signature: the
      // selection ring is drawn separately (drawRing) so toggling selection
      // re-tessellates only the small ring, never the whole hull.
      const sig = `${e.kind}|${e.typeId}|${e.team ?? ''}|${e.submerged === true}`;
      if (sig !== v.sig) {
        v.sig = sig;
        redraw(v, e);
      }
      drawRing(v, selected);

      const sp = cam.worldToScreen(e.x, e.y);
      v.root.position.set(sp.x, sp.y);
      v.root.scale.set(zoom);
      v.root.zIndex = depthKey(e.y, 'unit');

      // Hull + super + wake share the facing rotation (turn with the ship).
      v.hull.rotation = -e.facing;
      v.super.rotation = -e.facing;
      v.wake.rotation = -e.facing;

      // Raise the superstructure up the screen so it stands above the deck.
      // heightOffsetPx(h, 1) returns the lift at zoom 1 in the root's pre-zoom
      // local frame; the root then applies `zoom`, so the on-screen lift scales
      // with zoom exactly as depth.ts specifies, without double-counting it.
      if (v.shipDraw !== null) {
        const h = logicalHeight(v.radius, v.shipDraw.shape.deckHeight);
        v.superPlane.position.y = -heightOffsetPx(h, 1);
      } else {
        // Creeps/summons/wards keep their detail at deck level (no raise).
        v.superPlane.position.y = 0;
      }

      const sv = statusVisual(e.statuses, nowMs);
      v.hull.tint = sv.tint;
      v.super.tint = sv.tint;
      let alpha = sv.alpha;
      if (e.kind === 'ship' && e.submerged === true) alpha = Math.min(alpha, 0.55);
      if (e.kind === 'summon') alpha = Math.min(alpha, 0.8);
      v.root.alpha = alpha;

      // Bow wake: fire when the interpolated position moved (ships/creeps).
      if (!fresh && (e.kind === 'ship' || e.kind === 'creep' || e.kind === 'summon')) {
        if (shouldWake(e.x - v.lastX, e.y - v.lastY)) v.wakeStartMs = nowMs;
      }
      drawWake(v, nowMs);
      v.lastX = e.x;
      v.lastY = e.y;

      drawHpBar(v, e, selected);
      drawStatusGlyphs(v, sv.glyphs, nowMs);

      // Name labels for player ships only; placed above the overlay zone.
      if (e.kind === 'ship' && e.ownerSlot !== null) {
        const name = names.get(e.ownerSlot);
        if (name !== undefined) {
          ensureLabel(v, name);
          if (v.label !== null) {
            v.label.position.set(0, labelY(v.radius));
            v.label.visible = true;
          }
        } else if (v.label !== null) {
          v.label.visible = false;
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
