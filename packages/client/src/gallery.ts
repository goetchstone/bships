/**
 * RENDER GALLERY (the human art-QA surface). A standalone Vite entry served at
 * /gallery.html that renders — with NO server, NO socket, NO match — a labeled
 * static + animated showcase of everything the procedural renderer draws:
 *
 *   1. All 18 ship classes, both team colors (+ a subs-surfaced/submerged row).
 *   2. Every structure role (hq/spawnBuilding/tower/shop/repair/missileRamp/
 *      other) in south / north / neutral, to scale next to a reference ship.
 *   3. Creeps, summons, wards.
 *   4. Each projectile + combat effect, animated in place.
 *   5. The water depth ramp + animated foam bands.
 *   6. Two mock scene compositions at gameplay zoom so depth / shadows /
 *      y-sorting / scale are judgeable at a glance.
 *
 * It composes by calling the SAME per-object draw helpers the in-match
 * renderer uses (`drawShip`/`drawShipHull`/`drawShipSuper`, `drawStructure`,
 * `drawCreep`/`drawSummon`/`drawWard`, the `spawn*` fx entry points,
 * `drawWaterPatch`) plus `theme`/`depth`/`camera`, so the gallery is faithful
 * to what ships in a real match. Static silhouettes are placed with plain Pixi
 * transforms; the animated fx and mock scenes drive the SHARED camera singleton
 * via `snapCamera` to a fixed world transform and redraw off `app.ticker` time.
 */

import { Application, Container, Graphics, Text } from 'pixi.js';
import type { SnapshotProjectile, TeamId } from '@bships/core';

import { getCatalog } from './catalog.js';
import { resetCameraForTest, setViewport, snapCamera } from './render/camera.js';
import { FORESHORTEN } from './render/viz.js';
import { depthKey, heightOffsetPx, logicalHeight } from './render/depth.js';
import {
  ABYSS,
  GOLD,
  INK,
  INK_DIM,
  INK_OUTLINE,
  dropShadow,
} from './render/theme.js';
import {
  drawShipHull,
  drawShipSuper,
  resolveShipDraw,
} from './render/shipdraw.js';
import { drawCreep, drawSummon, drawWard } from './render/units.js';
import { drawStructure, STRUCTURE_ROLES, structureHeight } from './render/structures.js';
import type { StructureRole } from './render/structures.js';
import { drawWaterPatch } from './render/world.js';
import {
  createFx,
  spawnDamageFlash,
  spawnExplosion,
  spawnImpactSplash,
  spawnLevelUpPillar,
  spawnMuzzleFlash,
  spawnRespawnSplash,
  deathRingRadius,
} from './render/fx.js';

// ---------------------------------------------------------------------------
// Layout grid (page is one tall scrolling canvas).
// ---------------------------------------------------------------------------

const PAGE_W = 1280;
const PAD = 28;
const CELL_W = 150;
const CELL_H = 138;
const COLS = 8;

const TEAMS: readonly (TeamId | null)[] = ['south', 'north', null];

const layout = { y: 0 };

function teamName(team: TeamId | null): string {
  return team === null ? 'neutral' : team;
}

// ---------------------------------------------------------------------------
// Text helpers (Pixi Text — crisp at resolution 2).
// ---------------------------------------------------------------------------

function makeText(
  text: string,
  size: number,
  color: number,
  weight: 'normal' | 'bold' = 'normal',
): Text {
  const t = new Text({
    text,
    style: {
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      fontSize: size,
      fill: color,
      fontWeight: weight,
      align: 'center',
      stroke: { color: INK_OUTLINE, width: 3 },
    },
  });
  t.resolution = 2;
  return t;
}

function sectionTitle(stage: Container, title: string, subtitle = ''): void {
  layout.y += 18;
  const bar = new Graphics();
  bar.rect(PAD - 8, layout.y - 4, PAGE_W - PAD * 2 + 16, 34).fill({ color: 0x0d2236, alpha: 0.9 });
  bar.rect(PAD - 8, layout.y - 4, 4, 34).fill(GOLD);
  stage.addChild(bar);
  const t = makeText(title, 18, INK, 'bold');
  t.position.set(PAD + 6, layout.y);
  stage.addChild(t);
  if (subtitle !== '') {
    const s = makeText(subtitle, 13, INK_DIM);
    s.resolution = 2;
    s.anchor.set(1, 0);
    s.position.set(PAGE_W - PAD, layout.y + 4);
    stage.addChild(s);
  }
  layout.y += 44;
}

/** A bordered cell with a label, returns the inner content origin (centered). */
function cell(
  stage: Container,
  col: number,
  row: number,
  baseY: number,
  label: string,
  sub = '',
): { cx: number; cy: number; container: Container } {
  const x = PAD + col * CELL_W;
  const y = baseY + row * CELL_H;
  const frame = new Graphics();
  frame.roundRect(x + 4, y + 4, CELL_W - 8, CELL_H - 8, 8).fill({ color: 0x0a1826, alpha: 0.55 });
  frame.roundRect(x + 4, y + 4, CELL_W - 8, CELL_H - 8, 8).stroke({ width: 1, color: 0x24405a });
  stage.addChild(frame);

  const cx = x + CELL_W / 2;
  const cy = y + CELL_H / 2 - 8;
  const content = new Container();
  content.sortableChildren = true;
  content.position.set(cx, cy);
  stage.addChild(content);

  const lbl = makeText(label, 12, INK, 'bold');
  lbl.anchor.set(0.5, 1);
  lbl.position.set(cx, y + CELL_H - 18);
  stage.addChild(lbl);
  if (sub !== '') {
    const s = makeText(sub, 10, INK_DIM);
    s.anchor.set(0.5, 0);
    s.position.set(cx, y + CELL_H - 16);
    stage.addChild(s);
  }
  return { cx, cy, container: content };
}

// ---------------------------------------------------------------------------
// Static pseudo-3D unit preview — mirrors the live units.ts composition so the
// gallery shows the SAME drop shadow + foreshortened hull + RAISED super the
// match renders, at a chosen display scale.
// ---------------------------------------------------------------------------

function previewShip(
  parent: Container,
  typeId: string,
  team: TeamId | null,
  displayScale: number,
  submerged = false,
): void {
  const d = resolveShipDraw(typeId, team, { submerged });

  const root = new Container();
  root.scale.set(displayScale);

  // Drop shadow on the water (foreshortened ellipse, offset by the light).
  const h = logicalHeight(d.footprintR, d.shape.deckHeight);
  const sh = dropShadow(d.footprintR, h);
  const shadow = new Graphics();
  shadow.ellipse(sh.dx, sh.dy, sh.rx, sh.ry).fill({ color: sh.color, alpha: sh.alpha });
  root.addChild(shadow);

  // Hull on the squashed water plane (facing +x = bow toward east-ish, tilted
  // a touch so the bow wedge + beam both read in the preview).
  const plane = new Container();
  plane.scale.y = FORESHORTEN;
  const hull = new Graphics();
  hull.rotation = -0.35; // gentle 3/4 view so depth + bow read
  drawShipHull(hull, d);
  plane.addChild(hull);
  root.addChild(plane);

  // Raised superstructure (stands up the screen by heightOffsetPx).
  const superPlane = new Container();
  superPlane.scale.y = FORESHORTEN;
  superPlane.position.y = -heightOffsetPx(h, 1);
  const superG = new Graphics();
  superG.rotation = -0.35;
  drawShipSuper(superG, d);
  superPlane.addChild(superG);
  root.addChild(superPlane);

  if (submerged) root.alpha = 0.6;

  parent.addChild(root);
}

// ---------------------------------------------------------------------------
// SECTION 1 — all 18 ship classes, both teams.
// ---------------------------------------------------------------------------

/**
 * One shared world-units -> cell-px scale for ALL ships, so relative hull size
 * reads honestly across the grid (the biggest hull is ~77 world r; fit it with
 * headroom for the raised super + label).
 */
const SHIP_DISPLAY_SCALE = (CELL_W * 0.42) / 77;

function buildShips(stage: Container): void {
  const catalog = getCatalog();
  const ships = Object.entries(catalog.ships);
  sectionTitle(
    stage,
    `Ships — ${ships.length} classes`,
    'top: SOUTH (red) · bottom: NORTH (blue) · relative scale honest',
  );

  const baseY = layout.y;
  let col = 0;
  let rowPair = 0;
  for (const [typeId, spec] of ships) {
    const s = spec as { name: string; properName?: string };
    const name = s.properName ?? s.name;
    const gold = (spec as { gold: number }).gold;

    // South on the upper half-row, North on the lower half-row of one band.
    const south = cell(stage, col, rowPair * 2, baseY, `${name}`, `${typeId} · ${gold}g`);
    previewShip(south.container, typeId, 'south', SHIP_DISPLAY_SCALE);
    const north = cell(stage, col, rowPair * 2 + 1, baseY, `${name}`, `${typeId} · ${gold}g`);
    previewShip(north.container, typeId, 'north', SHIP_DISPLAY_SCALE);

    col++;
    if (col >= COLS) {
      col = 0;
      rowPair++;
    }
  }
  const rows = (col === 0 ? rowPair : rowPair + 1) * 2;
  layout.y = baseY + rows * CELL_H;

  // Submarine surfaced vs submerged row.
  sectionTitle(stage, 'Submarines — surfaced vs submerged', 'submerged = dimmed + low alpha');
  const subY = layout.y;
  const subIds = ships.filter(([, s]) => (s as { isSub?: boolean }).isSub).map(([id]) => id);
  let sc = 0;
  for (const id of subIds) {
    const nm = (catalog.ships[id] as { name: string; properName?: string }).properName ?? (catalog.ships[id] as { name: string }).name;
    const surf = cell(stage, sc, 0, subY, `${nm}`, 'surfaced');
    previewShip(surf.container, id, 'south', SHIP_DISPLAY_SCALE, false);
    const sub = cell(stage, sc + 1, 0, subY, `${nm}`, 'submerged');
    previewShip(sub.container, id, 'south', SHIP_DISPLAY_SCALE, true);
    sc += 2;
  }
  layout.y = subY + CELL_H;
}

// ---------------------------------------------------------------------------
// SECTION 2 — structures, every role, all teams, to scale next to a ship.
// ---------------------------------------------------------------------------

/**
 * ONE shared scale across structures + the reference ship so relative size is
 * honest. Largest footprint is the HQ (r=170); its body stands ~121px tall.
 * Fit r=170 + that standing height inside the cell band.
 */
const STRUCTURE_DISPLAY_SCALE = (CELL_W * 0.34) / 170;

function previewStructure(
  parent: Container,
  role: StructureRole,
  team: TeamId | null,
  scale: number,
): void {
  const root = new Container();
  root.scale.set(scale);
  drawStructure(root, role, team, 0);
  parent.addChild(root);
}

function buildStructures(stage: Container): void {
  sectionTitle(
    stage,
    'Structures — every role',
    'south / north / neutral · last column: reference ship to scale',
  );
  const scale = STRUCTURE_DISPLAY_SCALE;
  const baseY = layout.y;
  // Each role is a row; columns are south, north, neutral, + a ref ship.
  let row = 0;
  for (const role of STRUCTURE_ROLES) {
    let col = 0;
    for (const team of TEAMS) {
      const c = cell(stage, col, row, baseY, role, teamName(team));
      previewStructure(c.container, role, team, scale);
      col++;
    }
    // Reference: a top-tier cruiser at the SAME scale so HQ-vs-ship is obvious.
    const refTypeId = 'H006'; // Cruiser, gold 2400
    const ref = cell(stage, col, row, baseY, 'ref: Cruiser', `h≈${Math.round(structureHeight(role))}u`);
    previewShip(ref.container, refTypeId, 'south', scale);
    row++;
  }
  layout.y = baseY + row * CELL_H;
}

// ---------------------------------------------------------------------------
// SECTION 3 — creeps, summons, wards.
// ---------------------------------------------------------------------------

function buildMisc(stage: Container): void {
  sectionTitle(stage, 'Creeps · Summons · Wards', 'desaturated raiders · ghost summons · buoy wards');
  const baseY = layout.y;
  const scale = (CELL_W * 0.42) / 60;

  const defs: { label: string; sub: string; draw: (g: Graphics, team: TeamId | null) => void }[] = [
    { label: 'Creep', sub: 'south', draw: (g, t) => void drawCreep(g, 'creep', t) },
    { label: 'Creep', sub: 'neutral', draw: (g) => void drawCreep(g, 'creep', null) },
    { label: 'Summon', sub: 'south', draw: (g, t) => void drawSummon(g, 'summon', t) },
    { label: 'Summon', sub: 'north', draw: (g) => void drawSummon(g, 'summon', 'north') },
    { label: 'Ward', sub: 'south', draw: (g, t) => void drawWard(g, t) },
    { label: 'Ward', sub: 'north', draw: (g) => void drawWard(g, 'north') },
  ];
  let col = 0;
  for (const def of defs) {
    const team: TeamId | null = def.sub === 'north' ? 'north' : def.sub === 'neutral' ? null : 'south';
    const c = cell(stage, col, 0, baseY, def.label, def.sub);
    const g = new Graphics();
    g.scale.set(scale);
    // Summons render at partial alpha in match; show that here.
    if (def.label === 'Summon') g.alpha = 0.8;
    def.draw(g, team);
    c.container.addChild(g);
    col++;
  }
  layout.y = baseY + CELL_H;
}

// ---------------------------------------------------------------------------
// SECTION 4 — water depth ramp + animated foam (drawWaterPatch).
// ---------------------------------------------------------------------------

interface WaterSwatch {
  g: Graphics;
  rect: { x: number; y: number; w: number; h: number };
  depth01: number;
}

function buildWater(stage: Container): WaterSwatch[] {
  sectionTitle(stage, 'Water — depth ramp + animated foam', 'shallow (coast) → deep (channel) → abyss');
  const baseY = layout.y;
  const n = 6;
  const gap = 10;
  const w = (PAGE_W - PAD * 2 - gap * (n - 1)) / n;
  const h = 96;
  const swatches: WaterSwatch[] = [];
  for (let i = 0; i < n; i++) {
    const depth01 = i / (n - 1);
    const g = new Graphics();
    const rect = { x: PAD + i * (w + gap), y: baseY, w, h };
    stage.addChild(g);
    swatches.push({ g, rect, depth01 });
    const lbl = makeText(depth01 === 0 ? 'shallow' : depth01 === 1 ? 'deep' : `depth ${depth01.toFixed(1)}`, 11, INK);
    lbl.anchor.set(0.5, 0);
    lbl.position.set(rect.x + w / 2, baseY + h + 6);
    stage.addChild(lbl);
  }
  layout.y = baseY + h + 28;
  return swatches;
}

// ---------------------------------------------------------------------------
// SECTION 5 — projectiles + combat effects, animated in place (live fx layer).
// ---------------------------------------------------------------------------

interface FxDemo {
  /** Section content origin (screen px, the gallery's static page space). */
  cx: number;
  cy: number;
  /** World coords the demo lives at (gallery uses a fixed unit-scale camera). */
  wx: number;
  wy: number;
  kind: 'projectile' | 'effect';
  mechanic?: SnapshotProjectile['mechanic'];
  effect?: 'muzzle' | 'splash' | 'explosion' | 'damage' | 'levelUp' | 'respawn';
  label: string;
}

function buildFx(stage: Container): { demos: FxDemo[]; baseY: number } {
  sectionTitle(stage, 'Projectiles & combat effects', 'animated live by the pooled fx layer');
  const baseY = layout.y;
  const demos: FxDemo[] = [];
  const items: { label: string; kind: FxDemo['kind']; mechanic?: SnapshotProjectile['mechanic']; effect?: FxDemo['effect'] }[] = [
    { label: 'nativeAttack', kind: 'projectile', mechanic: 'nativeAttack' },
    { label: 'phoenixFire', kind: 'projectile', mechanic: 'phoenixFire' },
    { label: 'stormBolt', kind: 'projectile', mechanic: 'stormBolt' },
    { label: 'kaboomMissile', kind: 'projectile', mechanic: 'kaboomMissile' },
    { label: 'muzzle flash', kind: 'effect', effect: 'muzzle' },
    { label: 'impact splash', kind: 'effect', effect: 'splash' },
    { label: 'death explosion', kind: 'effect', effect: 'explosion' },
    { label: 'damage flash', kind: 'effect', effect: 'damage' },
    { label: 'level-up pillar', kind: 'effect', effect: 'levelUp' },
    { label: 'respawn splash', kind: 'effect', effect: 'respawn' },
  ];
  let col = 0;
  let row = 0;
  for (const it of items) {
    const c = cell(stage, col, row, baseY, it.label, it.kind);
    demos.push({
      cx: c.cx,
      cy: c.cy,
      // Map each cell's screen center to a unique world point at zoom 1, no
      // pan: worldToScreen(wx,wy) = (wx*1+0)+vw/2 etc. We instead keep the fx
      // camera at a FIXED transform and place each demo by solving for world.
      wx: 0,
      wy: 0,
      kind: it.kind,
      mechanic: it.mechanic,
      effect: it.effect,
      label: it.label,
    });
    col++;
    if (col >= 5) {
      col = 0;
      row++;
    }
  }
  layout.y = baseY + (row + 1) * CELL_H;
  return { demos, baseY };
}

// ---------------------------------------------------------------------------
// SECTION 6 — mock scene compositions (depth / shadows / y-sort / scale).
// ---------------------------------------------------------------------------

interface SceneEntity {
  typeId: string;
  team: TeamId | null;
  kind: 'ship' | 'structure';
  role?: StructureRole;
  wx: number;
  wy: number;
  facing: number;
}

interface SceneSpec {
  label: string;
  /** Screen rect of the scene viewport in page space. */
  rect: { x: number; y: number; w: number; h: number };
  /** World center the fixed camera frames. */
  camX: number;
  camY: number;
  zoom: number;
  entities: SceneEntity[];
}

function buildScenes(stage: Container): SceneSpec[] {
  sectionTitle(stage, 'Mock scenes — depth, shadows, y-sort, scale', 'at gameplay zoom');
  const baseY = layout.y;
  const sceneW = (PAGE_W - PAD * 2 - 24) / 2;
  const sceneH = 340;

  const scenes: SceneSpec[] = [
    {
      label: 'Skirmish at the channel mouth',
      rect: { x: PAD, y: baseY, w: sceneW, h: sceneH },
      camX: 0,
      camY: 0,
      zoom: 1.15,
      entities: [
        { kind: 'structure', role: 'hq', team: 'south', typeId: 's', wx: -260, wy: -260, facing: 0 },
        { kind: 'structure', role: 'tower', team: 'south', typeId: 's', wx: 60, wy: -200, facing: 0 },
        { kind: 'ship', typeId: 'H006', team: 'south', wx: -120, wy: -40, facing: 0.4 },
        { kind: 'ship', typeId: 'H00A', team: 'south', wx: 40, wy: 30, facing: 0.1 },
        { kind: 'ship', typeId: 'H00X', team: 'north', wx: -40, wy: 120, facing: -2.6 },
        { kind: 'ship', typeId: 'H00K', team: 'north', wx: 150, wy: 180, facing: -2.2 },
        { kind: 'structure', role: 'shop', team: null, typeId: 's', wx: 250, wy: 240, facing: 0 },
      ],
    },
    {
      label: 'Harbor & fleet (scale check)',
      rect: { x: PAD + sceneW + 24, y: baseY, w: sceneW, h: sceneH },
      camX: 0,
      camY: 0,
      zoom: 1.0,
      entities: [
        { kind: 'structure', role: 'spawnBuilding', team: 'north', typeId: 's', wx: -220, wy: -220, facing: 0 },
        { kind: 'structure', role: 'missileRamp', team: 'north', typeId: 's', wx: 120, wy: -240, facing: 0 },
        { kind: 'structure', role: 'repair', team: 'north', typeId: 's', wx: -280, wy: 40, facing: 0 },
        { kind: 'ship', typeId: 'H000', team: 'north', wx: 0, wy: -60, facing: -1.2 },
        { kind: 'ship', typeId: 'H00Y', team: 'north', wx: 90, wy: 40, facing: -0.8 },
        { kind: 'ship', typeId: 'H00V', team: 'south', wx: -60, wy: 130, facing: 0.3 },
        { kind: 'ship', typeId: 'H00C', team: 'south', wx: 160, wy: 210, facing: 2.4 },
        { kind: 'structure', role: 'other', team: null, typeId: 's', wx: 250, wy: -40, facing: 0 },
      ],
    },
  ];

  for (const s of scenes) {
    const frame = new Graphics();
    frame.roundRect(s.rect.x, s.rect.y, s.rect.w, s.rect.h, 8).fill(ABYSS);
    frame.roundRect(s.rect.x, s.rect.y, s.rect.w, s.rect.h, 8).stroke({ width: 1.5, color: 0x33597a });
    stage.addChild(frame);
    const lbl = makeText(s.label, 13, INK, 'bold');
    lbl.position.set(s.rect.x + 10, s.rect.y + 8);
    stage.addChild(lbl);
  }
  layout.y = baseY + sceneH + 24;
  return scenes;
}

/**
 * Render one mock scene into its own Container using a LOCAL fixed transform
 * (not the shared camera, so scenes don't fight the fx camera). Y-sorted by
 * depthKey. Each entity gets shadow + foreshortened hull + raised super, the
 * same composition the live layer uses.
 */
function renderScene(parent: Container, s: SceneSpec): void {
  const root = new Container();
  root.sortableChildren = true;
  // Clip the scene to its frame via a mask.
  const mask = new Graphics();
  mask.roundRect(s.rect.x, s.rect.y, s.rect.w, s.rect.h, 8).fill(0xffffff);
  parent.addChild(mask);
  root.mask = mask;

  const ox = s.rect.x + s.rect.w / 2;
  const oy = s.rect.y + s.rect.h / 2 + 30;
  const toScreen = (wx: number, wy: number): { x: number; y: number } => ({
    x: ox + (wx - s.camX) * s.zoom,
    y: oy - (wy - s.camY) * s.zoom * FORESHORTEN,
  });

  // Water bed for the scene (a couple of depth bands).
  const bed = new Graphics();
  for (let i = 0; i < 6; i++) {
    const top = s.rect.y + (s.rect.h * i) / 6;
    const depth01 = 0.2 + 0.6 * (i / 5);
    drawWaterPatch(bed, { x: s.rect.x, y: top, w: s.rect.w, h: s.rect.h / 6 + 1 }, 0, depth01);
  }
  bed.zIndex = -1e9;
  bed.mask = mask;
  parent.addChild(bed);

  for (const e of s.entities) {
    const sp = toScreen(e.wx, e.wy);
    const ec = new Container();
    ec.position.set(sp.x, sp.y);
    ec.scale.set(s.zoom);
    ec.zIndex = depthKey(e.wy, e.kind === 'structure' ? 'structure' : 'unit');

    if (e.kind === 'structure' && e.role !== undefined) {
      drawStructure(ec, e.role, e.team, 0);
    } else {
      const d = resolveShipDraw(e.typeId, e.team, {});
      const h = logicalHeight(d.footprintR, d.shape.deckHeight);
      const sh = dropShadow(d.footprintR, h);
      const shadow = new Graphics();
      shadow.ellipse(sh.dx, sh.dy, sh.rx, sh.ry).fill({ color: sh.color, alpha: sh.alpha });
      ec.addChild(shadow);
      const plane = new Container();
      plane.scale.y = FORESHORTEN;
      const hull = new Graphics();
      hull.rotation = -e.facing;
      drawShipHull(hull, d);
      plane.addChild(hull);
      ec.addChild(plane);
      const superPlane = new Container();
      superPlane.scale.y = FORESHORTEN;
      superPlane.position.y = -heightOffsetPx(h, 1);
      const superG = new Graphics();
      superG.rotation = -e.facing;
      drawShipSuper(superG, d);
      superPlane.addChild(superG);
      ec.addChild(superPlane);
    }
    root.addChild(ec);
  }
  parent.addChild(root);
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mount = document.getElementById('gallery');
  if (mount === null) throw new Error('no #gallery mount');

  const app = new Application();
  await app.init({
    width: PAGE_W,
    height: 100, // grown after layout
    background: 0x07111c,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  mount.appendChild(app.canvas);

  // Fix the SHARED camera to a 1:1, no-pan transform for the fx layer + scenes.
  // The fx layer reads the live camera each frame; with the camera centered at
  // world (0,0) at zoom 1, worldToScreen(wx,wy) = (wx + vw/2, -wy*F + vh/2).
  resetCameraForTest(PAGE_W, 100);

  const stage = app.stage;

  layout.y = PAD;
  buildShips(stage);
  buildStructures(stage);
  buildMisc(stage);
  const water = buildWater(stage);
  const fxSection = buildFx(stage);
  const scenes = buildScenes(stage);

  // Now that the page height is known, size the renderer + camera viewport.
  const pageH = Math.ceil(layout.y + PAD);
  app.renderer.resize(PAGE_W, pageH);
  setViewport(PAGE_W, pageH);
  snapCamera(0, 0, 1);

  // Render scenes (static, but they read the page-space transform we computed).
  for (const s of scenes) renderScene(stage, s);

  // The fx layer composites in SCREEN space via the shared camera. To place a
  // demo at a given page-screen point (cx, cy), invert worldToScreen at the
  // fixed camera: wx = cx - vw/2, wy = (vh/2 - cy) / FORESHORTEN.
  const fx = createFx();
  stage.addChild(fx.view);
  const screenToFixedWorld = (cx: number, cy: number): { x: number; y: number } => ({
    x: cx - PAGE_W / 2,
    y: (pageH / 2 - cy) / FORESHORTEN,
  });
  for (const d of fxSection.demos) {
    const w = screenToFixedWorld(d.cx, d.cy);
    d.wx = w.x;
    d.wy = w.y;
  }

  // Animated projectiles: keep a small fleet of synthetic projectiles moving
  // back and forth across each projectile cell so the tracer + arc + trail are
  // visible and looping. We hand-build SnapshotProjectiles and feed the fx
  // layer a synthetic WorldSample each frame.
  const projDemos = fxSection.demos.filter((d) => d.kind === 'projectile');
  const projIdBase = 1000;

  // Effect re-spawn cadence (ms) per effect demo, so each replays on a loop.
  const effectDemos = fxSection.demos.filter((d) => d.kind === 'effect');
  const lastSpawn = new Map<string, number>();
  const RESPAWN_MS = 1400;

  let startMs = -1;
  app.ticker.add(() => {
    const nowMs = performance.now();
    if (startMs < 0) startMs = nowMs;
    const t = nowMs - startMs;

    // Animate water foam.
    for (const sw of water) {
      sw.g.clear();
      drawWaterPatch(sw.g, sw.rect, nowMs, sw.depth01);
    }

    // Build synthetic projectiles sweeping across their cells (left<->right).
    const projectiles: SnapshotProjectile[] = [];
    projDemos.forEach((d, i) => {
      const span = CELL_W * 0.32;
      const phase = (t / 1400 + i * 0.13) % 1;
      const dir = Math.floor(t / 1400 + i * 0.13) % 2 === 0 ? 1 : -1;
      const wx = d.wx + (phase - 0.5) * 2 * span * dir;
      projectiles.push({
        id: projIdBase + i,
        weaponId: 'demo',
        mechanic: d.mechanic ?? 'nativeAttack',
        x: wx,
        y: d.wy,
        team: i % 2 === 0 ? 'south' : 'north',
      });
    });

    // Replay each transient effect on a loop.
    for (const d of effectDemos) {
      const last = lastSpawn.get(d.label) ?? -1e9;
      if (nowMs - last >= RESPAWN_MS) {
        lastSpawn.set(d.label, nowMs);
        switch (d.effect) {
          case 'muzzle':
            spawnMuzzleFlash(fx, d.wx, d.wy, 0.4, 'south');
            break;
          case 'splash':
            spawnImpactSplash(fx, d.wx, d.wy, 18);
            break;
          case 'explosion':
            spawnExplosion(fx, d.wx, d.wy, deathRingRadius('H006'), 'south');
            break;
          case 'damage':
            spawnDamageFlash(fx, d.wx, d.wy, 30);
            break;
          case 'levelUp':
            spawnLevelUpPillar(fx, d.wx, d.wy);
            break;
          case 'respawn':
            spawnRespawnSplash(fx, d.wx, d.wy);
            break;
        }
      }
    }

    fx.update({ tickFloat: 0, entities: [], projectiles }, nowMs);
  });
}

void main();
