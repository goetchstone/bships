/**
 * render-fieldoverlay: a cosmetic, READ-ONLY map-legibility layer painted on
 * the water — the 2 combat lanes per team, the contested centre, the trader
 * routes — so the structure of the map is obvious at a glance even with simple
 * graphics (CLAUDE.md "LANES + CENTER + TRADER ROUTES legibility").
 *
 * OWNERSHIP / boundaries (this is the LEGIBILITY module's render half):
 *  - Self-contained layer with the SAME lifecycle as render/land.ts, so the
 *    integrator drops it into renderer.ts z-order with one addChild. The
 *    architect has ALREADY wired it in (see renderer.ts: above land + sea,
 *    BELOW units, so lane ribbons sit on the water under the ships).
 *  - Presentation only: every position comes from the STATIC catalog
 *    (getCatalog().map.lanes / .regions / .bounds and the contracts'
 *    .tradeRoutes) — never from sim state, never any game logic. The `sample`
 *    arg is unused (kept for the lifecycle); the overlay is static map data, so
 *    like land.ts it rebuilds only on a camera signature change. The ONLY live
 *    read is store.match.myTeam (own lanes a touch brighter), folded into the
 *    rebuild signature so a slot-settle re-tints without a per-frame redraw.
 *  - All world->screen goes through getCamera().worldToScreen and all pixel
 *    sizes multiply by getCamera().zoom; no raw screen offsets (matches
 *    world.ts / land.ts).
 *  - Team colors come from theme.TEAM_COLOR; the contested centre + trader
 *    routes use theme.GOLD / a neutral tint so they read as "shared".
 *  - Faint by design: low alpha, thin ribbons — it must never fight the
 *    ships/structures for attention.
 *
 * The pure geometry helpers (lanePolyline / contestedRect /
 * contestedBandFromLanes / traderRoutePath) are DOM-/pixi-free so they are
 * unit-tested in test/fieldoverlay.test.ts; createFieldOverlay wires them to
 * Graphics.
 *
 * NOTE on the contested centre: the Classic map has NO region literally named
 * "center"/"contested" — the two teams' lanes simply CONVERGE in the central
 * waters between the harbour clusters. `contestedRect` resolves an explicitly
 * named centre region when one exists (returns null otherwise, e.g. open-sea
 * stub), and `contestedBandFromLanes` derives the central band from the lane
 * geometry for maps (like Classic) that have no such region. The layer prefers
 * the named region and falls back to the lane-derived band.
 */

import { Container, Graphics } from 'pixi.js';
import type { LaneSpec, MapSpec, NavField, RegionRect, TradeRouteSpec, TeamId, WaterMask } from '@bships/core';
import { isWater, navStepToward } from '@bships/core';

import { getCatalog } from '../catalog.js';
import { store } from '../net/store.js';
import type { WorldSample } from '../net/interpolation.js';
import { getCamera, getViewportSize } from './camera.js';
import { seaStaticSignature } from './world.js';
import { GOLD, NEUTRAL_COLOR, TEAM_COLOR } from './theme.js';

// ---------------------------------------------------------------------------
// Pure geometry (DOM-/pixi-free, unit-tested in test/fieldoverlay.test.ts)
// ---------------------------------------------------------------------------

/** A 2D world-space point. */
export interface Pt {
  x: number;
  y: number;
}

/**
 * The lane's RAW vertex polyline: spawn followed by each waypoint, in order.
 * This is the order-issue skeleton, NOT the sailed route — its waypoints are
 * just `[enemyHarborCenter, enemyHQ]`, so a straight stroke of it cuts across
 * the central LAND. Kept for tests / fallbacks; the legibility layer strokes
 * `traceLaneWaterPath` instead (see below). Pure.
 */
export function lanePolyline(lane: LaneSpec): Pt[] {
  return [{ x: lane.spawnX, y: lane.spawnY }, ...lane.waypoints.map((wp) => ({ x: wp.x, y: wp.y }))];
}

/**
 * The world-space polyline the creeps actually SAIL: the winding navigable-
 * water channel from the lane spawn, around the central landmass, to the enemy
 * base. The straight `lanePolyline` cuts across land; this traces the REAL
 * route by repeatedly stepping DOWN the compiled nav gradient (`navStepToward`,
 * the same field movement.ts uses to steer creeps through the chokepoints), so
 * the ribbon hugs the water.
 *
 * Deterministic + cheap: a fixed-step walk of the static field (no RNG/time/
 * trig), keeping every `sampleEvery`-th cell (default 1 — adjacent water cells,
 * so the chord between consecutive points can never skip a land sliver at a
 * channel bend) and hard-capped at `maxPoints`/`maxSteps`, then the lane's
 * final raw waypoints (enemy harbour + HQ) are appended so the ribbon connects
 * to the goal even when the gradient bottoms out in the base basin
 * (navStepToward returns null within its local-goal radius). Falls back to the
 * raw `lanePolyline` when there is no real field (stub mask). Pure — the caller
 * caches it (compute once per catalog).
 *
 * `field` must be the lane TEAM's enemy-base field (catalog.map.navByTeam[team]).
 */
export function traceLaneWaterPath(
  lane: LaneSpec,
  field: NavField,
  options: { sampleEvery?: number; maxPoints?: number; maxSteps?: number } = {},
): Pt[] {
  const sampleEvery = options.sampleEvery ?? 1;
  const maxPoints = options.maxPoints ?? 1200;
  const maxSteps = options.maxSteps ?? 6000;

  // No compiled field (open-sea stub) -> nothing to trace; raw skeleton.
  if (field.dist.length === 0) return lanePolyline(lane);

  const pts: Pt[] = [{ x: lane.spawnX, y: lane.spawnY }];
  let x = lane.spawnX;
  let y = lane.spawnY;
  // Use a small local-goal radius so the gradient walk runs almost all the way
  // into the base basin before falling through to the appended waypoints.
  for (let step = 0; step < maxSteps && pts.length < maxPoints; step++) {
    const next = navStepToward(field, x, y, 2);
    if (next === null) break; // reached the goal basin / a local minimum
    x = next.x;
    y = next.y;
    if (step % sampleEvery === 0) pts.push({ x, y });
  }

  // Append the lane's raw waypoints (enemy harbour centre, enemy HQ) so the
  // ribbon always terminates AT the objective — the gradient stops a few cells
  // short inside the base, and the last leg into the exact HQ is open water.
  for (const wp of lane.waypoints) pts.push({ x: wp.x, y: wp.y });
  return pts;
}

/** Is every vertex of `pts` on navigable water? (test/debug helper). Pure. */
export function polylineStaysOnWater(pts: readonly Pt[], mask: WaterMask): boolean {
  for (const p of pts) {
    if (!isWater(mask, p.x, p.y)) return false;
  }
  return true;
}

/**
 * Cached water-following lane polylines, keyed by lane id. The trace is static
 * map data (depends only on the immutable nav field), so it is computed ONCE
 * and shared by the field overlay and the minimap ribbons — both call this.
 */
const laneWaterPathCache = new Map<string, Pt[]>();

/**
 * The cached sailed-route polyline for a lane against the given map (uses
 * `map.navByTeam[lane.team]`). Falls back to the raw `lanePolyline` when the
 * map ships no compiled nav field (open-sea stub). The same `map` is used for
 * the whole client session, so caching purely by lane id is safe.
 */
export function laneWaterPath(lane: LaneSpec, map: MapSpec): Pt[] {
  const cached = laneWaterPathCache.get(lane.id);
  if (cached !== undefined) return cached;
  const field = map.navByTeam[lane.team];
  const path = field === undefined ? lanePolyline(lane) : traceLaneWaterPath(lane, field);
  laneWaterPathCache.set(lane.id, path);
  return path;
}

/**
 * Candidate region names that, when present, mark an explicit contested centre.
 * Classic has none of these (its lanes just converge); other maps/mods might.
 */
const CENTRE_REGION_NAMES: readonly string[] = ['Contested', 'Center', 'Centre', 'Mid', 'Middle'];

/**
 * The contested-centre rect from an explicitly NAMED centre region, if the map
 * ships one. Returns the union of any matching regions, or null when none are
 * named (the Classic case — use `contestedBandFromLanes` instead). Pure.
 */
export function contestedRect(regions: Record<string, RegionRect>): RegionRect | null {
  let acc: RegionRect | null = null;
  for (const name of CENTRE_REGION_NAMES) {
    const r = regions[name];
    if (r === undefined) continue;
    acc = acc === null ? r : unionRect(acc, r);
  }
  return acc;
}

/** Axis-aligned union of two region rects (recomputed centre). */
function unionRect(a: RegionRect, b: RegionRect): RegionRect {
  const minX = Math.min(a.minX, b.minX);
  const minY = Math.min(a.minY, b.minY);
  const maxX = Math.max(a.maxX, b.maxX);
  const maxY = Math.max(a.maxY, b.maxY);
  return {
    name: `${a.name}+${b.name}`,
    minX,
    minY,
    maxX,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/**
 * Derive the contested CENTRE band from the lane geometry, for maps (Classic)
 * with no explicitly named centre region. The lanes run the full length of the
 * map and converge in the middle; the contested zone is the central vertical
 * band where BOTH teams' lanes are present. We take it as the world-Y span
 * around the map's mid-Y bounded by the lanes' horizontal extent, sized to a
 * fraction of the map so it reads as "the middle" without swamping the field.
 *
 * Returns null when there are no lanes (open-sea stub).
 */
export function contestedBandFromLanes(
  lanes: readonly LaneSpec[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  bandFraction = 0.34,
): RegionRect | null {
  if (lanes.length === 0) return null;

  // Horizontal extent: span of every lane vertex (spawn + waypoints), so the
  // band hugs the lane corridor rather than the whole map width.
  let minX = Infinity;
  let maxX = -Infinity;
  for (const lane of lanes) {
    for (const p of lanePolyline(lane)) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
  }
  // Vertical: a centred band of the map height (the lanes cross here).
  const midY = (bounds.minY + bounds.maxY) / 2;
  const halfH = ((bounds.maxY - bounds.minY) * bandFraction) / 2;

  return {
    name: 'ContestedCentre',
    minX,
    minY: midY - halfH,
    maxX,
    maxY: midY + halfH,
    centerX: (minX + maxX) / 2,
    centerY: midY,
  };
}

/**
 * The world-space path a trade route runs: pickup region centre -> the OWN-team
 * deliver region centre (the team's reward zone). Resolved against the region
 * table; returns [] when a referenced region is missing. `team` selects which
 * team's deliver region to draw — pass the viewer's team so the route reads as
 * "carry it home". Pure.
 */
export function traderRoutePath(
  route: TradeRouteSpec,
  regions: Record<string, RegionRect>,
  team: TeamId,
): Pt[] {
  const pickup = regions[route.pickupRegion];
  const deliverName = route.deliverRegionByTeam[team];
  const deliver = deliverName === undefined ? undefined : regions[deliverName];
  if (pickup === undefined || deliver === undefined) return [];
  return [
    { x: pickup.centerX, y: pickup.centerY },
    { x: deliver.centerX, y: deliver.centerY },
  ];
}

// ---------------------------------------------------------------------------
// Layer (browser only — never invoked by the pure tests)
// ---------------------------------------------------------------------------

export interface FieldOverlayLayer {
  /** Add to the stage ABOVE land/sea and BELOW units (see renderer.ts). */
  view: Container;
  /** Per ticker frame. `sample` is unused (static map data); kept for parity. */
  update(sample: WorldSample | null, nowMs: number): void;
  /** Forwarded from the app resize (invalidate the cached geometry). */
  resize(w: number, h: number): void;
}

// --- look tuning (all faint so the field overlay never fights the units) ----
const LANE_ALPHA = 0.16;
const LANE_OWN_ALPHA = 0.26; // own lanes a touch brighter
const LANE_WIDTH_UNITS = 220; // ribbon half-width in WORLD units (scales w/ zoom)
const CENTRE_ALPHA = 0.07;
const CENTRE_BORDER_ALPHA = 0.22;
const ROUTE_ALPHA = 0.16;
const ROUTE_DASH_PX = 10; // dash length at zoom 1
const ROUTE_GAP_PX = 9;

/**
 * Stroke a world-space polyline as a connected screen path on `g`. Each segment
 * goes through the camera so the ribbon obeys the 2.5D squash like everything
 * else. Returns without drawing for <2 points.
 */
function strokePolyline(
  g: Graphics,
  pts: readonly Pt[],
  cam: ReturnType<typeof getCamera>,
  width: number,
  color: number,
  alpha: number,
): void {
  if (pts.length < 2) return;
  const first = cam.worldToScreen(pts[0]!.x, pts[0]!.y);
  g.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const s = cam.worldToScreen(pts[i]!.x, pts[i]!.y);
    g.lineTo(s.x, s.y);
  }
  g.stroke({ width, color, alpha, cap: 'round', join: 'round' });
}

/**
 * Stroke a world-space polyline as a DASHED screen path (PixiJS v8 has no
 * native line dash, so we emit alternating segments). Used for trader routes so
 * they read as "supply lines", distinct from the solid lane ribbons.
 */
function strokeDashed(
  g: Graphics,
  pts: readonly Pt[],
  cam: ReturnType<typeof getCamera>,
  width: number,
  color: number,
  alpha: number,
  dashPx: number,
  gapPx: number,
): void {
  if (pts.length < 2) return;
  const period = dashPx + gapPx;
  for (let i = 1; i < pts.length; i++) {
    const a = cam.worldToScreen(pts[i - 1]!.x, pts[i - 1]!.y);
    const b = cam.worldToScreen(pts[i]!.x, pts[i]!.y);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    const ux = dx / len;
    const uy = dy / len;
    for (let d = 0; d < len; d += period) {
      const e = Math.min(d + dashPx, len);
      g.moveTo(a.x + ux * d, a.y + uy * d);
      g.lineTo(a.x + ux * e, a.y + uy * e);
    }
  }
  g.stroke({ width, color, alpha, cap: 'round' });
}

/**
 * Create the field-legibility overlay. Caches the geometry like
 * world.ts/land.ts: a single rebuild only when the camera visible-rect / zoom /
 * viewport signature (plus the player's team) changes; a static camera uploads
 * nothing.
 */
export function createFieldOverlay(): FieldOverlayLayer {
  const view = new Container();

  // Z-order WITHIN the layer: centre tint (lowest) -> lane ribbons -> trader
  // routes (dashed, on top so they read as supply lines over the lanes).
  const centre = new Graphics();
  const lanes = new Graphics();
  const routes = new Graphics();
  view.addChild(centre, lanes, routes);

  let sig = '';

  function rebuild(): void {
    const cam = getCamera();
    const { w: vw, h: vh } = getViewportSize();
    const rect = cam.viewportWorldRect();
    const myTeam = store.match.myTeam;

    // Fold the team into the signature so an own-lane re-tint happens when the
    // slot settles, but we still skip the redraw on a static camera.
    const next = `${seaStaticSignature(rect, cam.zoom, vw, vh)}|${myTeam ?? ''}`;
    if (next === sig) return;
    sig = next;

    centre.clear();
    lanes.clear();
    routes.clear();

    const map = getCatalog().map;
    if (map.lanes.length === 0) return; // open-sea stub: nothing to overlay

    const zoom = cam.zoom;

    // --- contested centre: tint + faint border (neutral/gold "shared zone") --
    const band = contestedRect(map.regions) ?? contestedBandFromLanes(map.lanes, map.bounds);
    if (band !== null) {
      const tl = cam.worldToScreen(band.minX, band.maxY);
      const br = cam.worldToScreen(band.maxX, band.minY);
      const x = tl.x;
      const y = tl.y;
      const w = br.x - tl.x;
      const h = br.y - tl.y;
      centre.rect(x, y, w, h).fill({ color: NEUTRAL_COLOR, alpha: CENTRE_ALPHA });
      centre.rect(x, y, w, h).stroke({ width: 1.5, color: GOLD, alpha: CENTRE_BORDER_ALPHA });
    }

    // --- lane ribbons: each lane's SAILED water route, own team brighter -----
    // laneWaterPath traces the winding navigable channel (around the central
    // land, through the tower chokepoints) instead of the straight skeleton.
    const widthPx = Math.max(2, LANE_WIDTH_UNITS * zoom);
    for (const lane of map.lanes) {
      const own = myTeam !== null && lane.team === myTeam;
      strokePolyline(
        lanes,
        laneWaterPath(lane, map),
        cam,
        widthPx,
        TEAM_COLOR[lane.team],
        own ? LANE_OWN_ALPHA : LANE_ALPHA,
      );
    }

    // --- trader routes: dashed pickup->own-team deliver supply lines --------
    // Drawn for the viewer's team (carry it home); when teamless, draw south's
    // so the routes are still legible to a spectator.
    const routeTeam: TeamId = myTeam ?? 'south';
    const routeWidth = Math.max(1, 2.2 * zoom);
    for (const route of getCatalog().contracts.tradeRoutes) {
      // Team-restricted routes only exist for that team; skip the others so the
      // overlay shows what THIS player can actually run.
      if (route.team !== null && route.team !== routeTeam) continue;
      const path = traderRoutePath(route, map.regions, routeTeam);
      strokeDashed(routes, path, cam, routeWidth, GOLD, ROUTE_ALPHA, ROUTE_DASH_PX * zoom, ROUTE_GAP_PX * zoom);
    }
  }

  function update(sample: WorldSample | null, nowMs: number): void {
    // Static map data: depends only on the camera + the player's team, never on
    // the match sample or time. Rebuild only on a signature change.
    void sample;
    void nowMs;
    rebuild();
  }

  function resize(w: number, h: number): void {
    void w;
    void h;
    sig = ''; // force a rebuild on the next frame (viewport changed)
  }

  return { view, update, resize };
}
