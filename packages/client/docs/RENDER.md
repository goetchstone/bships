# Graphics overhaul — visual spec & module contracts

Procedural pseudo-3D renderer for `packages/client`. This is the binding spec
for the overhaul. It complements `docs/ARCH.md` (which still describes the
canvas/HUD ownership and the camera contract — both unchanged) and
`docs/DESIGN.md` "Art direction". **Server / core / sim are frozen — read
only.** We edit `packages/client` only; every new file lives under `render/`
or `hud/` with a clear prefix and disjoint ownership.

## Goals (what "done" looks like)

1. **Ships read as 18 distinct vessels**, not crayons — class, team, facing,
   HP legible at gameplay zoom. Driven by the `theme.ts` ship shape spec.
2. **Structures are elevated beveled buildings at correct scale** with drop
   shadows; the "giant flag/marker" scale bug is gone.
3. **Water is layered, depth-shaded, gently animated** — alive, not flat.
4. **Combat reads**: muzzle flashes, projectile arcs, impact splashes,
   explosions on death, damage flashes — pooled, no leaks.
5. **HUD layout is fixed**: chat docked bottom-left, minimap in a corner not
   overlapping play, polished top bar / inventory / ability button.
6. **Performance**: ~150 entities at 60 fps. Pool/reuse Pixi objects; destroy
   on entity removal. Animations are time-based off the Pixi ticker, never
   match state (pure presentation, no determinism concerns).

## Foundation (DONE — architect-owned, do not rewrite)

- **`src/render/theme.ts`** — the shared visual system. Palette (team colors,
  water ramp, structure/UI colors, HP colors), pseudo-3D constants
  (`LIGHT_DIR`, `SHADOW`, `HEIGHT_REF`, `HEIGHT_TO_SCREEN`, bevel factors),
  color helpers (`mix`, `scale`, `desaturate`, `luminance`, `waterAt`),
  bevel/shade helpers (`shade(base) -> {lit,base,shade,outline}`,
  `shadeFace(base,nx,ny)`), the drop-shadow helper
  (`dropShadow(footprintR, height) -> ShadowEllipse`), and the **ship shape
  spec** (`shipShape(typeId, spec) -> ShipShape` with a `ShipFamily` +
  modifiers; `SHIP_SHAPE_IDS`, `familyFromSpec`). Pure — no pixi/DOM.
- **`src/render/depth.ts`** — the y-sort + height model.
  `depthKey(worldY, kind)` (larger = front; north behind; per-kind tie-break
  bias that never swamps real y separation), `overlayKey(worldY)`,
  `heightOffsetPx(height, zoom)` (upward screen offset for "standing up"),
  `logicalHeight(footprintR, ratio)` with the `HEIGHT_MAX_RATIO` clamp (the
  structural giant-flag guard), `byDepth(items, keyOf)`.
- **`src/render/viz.ts`** (pre-existing, KEEP) — still the source of footprint
  RADII and hit-testing (`entityVisualRadius`, `hullSize`, `structureRadius`,
  `hitTestEntities`). The new renderers must size silhouettes to the SAME
  radius `viz` reports so what you see is what you click. `theme.ts`
  re-exports `FORESHORTEN` from `viz` so there is one squash constant.

Tests for the foundation math live in `test/foundation.test.ts`
(architect-owned). Existing `test/render.test.ts` (camera + viz) stays green.

## Coordinate & camera contract (unchanged, binding)

- World: +x east, +y north; `facing` rad, 0 = east, CCW positive.
- Screen: Pixi y-down. `camera.ts` owns the ONLY world<->screen transform:
  `screenX = (wx - cam.x)*zoom + vw/2`,
  `screenY = (cam.y - wy)*zoom*FORESHORTEN + vh/2`, `FORESHORTEN = 0.82`,
  zoom clamp `[0.5, 2.0]`.
- **All renderers go through `getCamera().worldToScreen` for positions and
  multiply their own px sizes by `cam.zoom`.** Heights/standing-up offsets go
  through `heightOffsetPx(height, cam.zoom)` — never raw world units added to
  screenY, never a per-silhouette ad-hoc scale (that is the giant-flag bug).
- Y-sort: one sortable container per layer; `zIndex = depthKey(...)`.
- Sprite rotation for facing: `rotation = -facing`.

## The giant-flag / scale bug — root cause & the fix contract

The current `entities.ts` draws structure superstructure (HQ flag mast, tower
shaft) into an **unsquashed** `body` graphic using **raw world-unit offsets
relative to the structure radius** (e.g. an HQ flag at `y = -r*1.5` with
`r = 170` -> a ~255-unit pole), then scales the whole thing by `zoom`. Because
those upward offsets are not run through any calibrated height mapping and the
radius is large, the feature towers far above neighbouring 64-unit ships.

**Fix contract (render-world owns):** every structure's footprint comes from
`viz.structureRadius(role)`; its standing-up height comes from
`logicalHeight(footprintR, ROLE_HEIGHT_RATIO[role])` and is projected with
`heightOffsetPx(height, zoom)`. The clamp in `logicalHeight` (HEIGHT_MAX_RATIO)
guarantees no feature ever projects more than ~2.4x its footprint upward.
Structure footprints must stay in the SAME size band as ships (HQ the biggest
building, towers slim, shops small) — sanity target: an HQ footprint ≈ 2–3x a
top-tier ship hull, NOT 10x; a tower ≈ a mid ship; a flag pennant is a small
detail on top, never a screen-dominating marker.

## Depth model (how a scene composes)

Per frame, for each visible entity/structure/effect the owning renderer:

1. Computes its world `(x, y)` -> `screenBase = worldToScreen(x, y)`.
2. Draws its **drop shadow** at `screenBase + shadow.(dx,dy)*zoom` as a
   foreshortened ellipse (`dropShadow(footprintR, height)`), in the shadow
   sub-layer / behind the body.
3. Draws its **footprint/waterline** at `screenBase`.
4. Draws its **superstructure** translated UP by `heightOffsetPx(height,zoom)`
   (subtract from screenY) so it reads as standing; bevels lit per `LIGHT_DIR`.
5. Sets `zIndex = depthKey(y, kind)` so it sorts correctly N–S; overlays
   (hp bar, label) use `overlayKey(y)`.

This gives consistent shadows, one light direction, visible height, and
correct y-sorting across world + units + fx with no per-module fudging.

## Render API each module exposes to `renderer.ts` (INTEGRATOR wires these)

`renderer.ts` keeps its current shape: create each layer once, add views to
the stage bottom-up, call `layer.update(sample, nowMs)` per ticker frame.
Layer **view containers** are added in this bottom-up order:

```
water → world(structures+coast) → units → fx(projectiles+effects) → fog → (hud is DOM, separate)
```

Each module returns a `{ view: Container, update(...), destroy?() }` factory,
matching today's `create*` convention. Exact signatures:

```ts
// render-world (water + terrain + structures)
createWorld(renderer: Renderer): {
  view: Container;
  update(sample: WorldSample | null, nowMs: number): void;
  resize(w: number, h: number): void;     // if it keeps any render-texture
};

// render-units (ships, creeps, summons, wards)
createUnits(): {
  view: Container;
  update(sample: WorldSample | null, nowMs: number): void;
};

// render-fx (projectiles + transient effects; subscribes onEvent internally)
createFx(): {
  view: Container;
  update(sample: WorldSample | null, nowMs: number): void;
  destroy(): void;                          // unsubscribe onEvent
};
```

Internal per-object draw helpers (NOT exported to renderer, but the gallery
imports them directly to render static showcases without a match):

```ts
// render-units
drawShip(g: Graphics, typeId: string, team: TeamId | null, opts): number; // returns footprint r
drawCreep(g, typeId, team); drawSummon(g, typeId, team); drawWard(g, team);

// render-world
drawStructure(target: Container, role: StructureRole, team: TeamId | null): void;
drawWaterPatch(g, rect, nowMs);   // a tile of animated depth-shaded sea

// render-fx
spawnMuzzleFlash(fx, x, y, dir); spawnImpactSplash(fx, x, y);
spawnExplosion(fx, x, y, size);  spawnDamageFlash(unitView);   // pooled
```

The gallery (`gallery.ts`, INTEGRATOR) renders at a fixed camera by calling
these draw helpers + `theme`/`depth`, so each module MUST keep its per-object
drawing reachable as a named export, independent of `update()`.

## Module ownership (disjoint — strict; all NEW files)

| Module | Owns (new files) | Responsibility |
| --- | --- | --- |
| **render-world** | `src/render/world.ts`, `src/render/structures.ts`, `test/world.test.ts` | Layered animated depth-shaded water + procedural coast; ALL structures (hq/spawnBuilding/tower/shop/repair/missileRamp/other) as elevated beveled buildings with drop shadows at correct scale. Fixes the giant-flag bug via depth.ts. Replaces `water.ts` usage and the structure code path in `entities.ts` (see migration note). |
| **render-units** | `src/render/units.ts`, `src/render/shipdraw.ts`, `test/units.test.ts` | Ships (18 classes via `shipShape`), creeps, summons, wards — beveled hull, top-left light, drop shadow on water, bow wake when moving, team color, facing, HP bar, selection ring, name label placement, status tints/glyphs. Replaces the unit code path in `entities.ts`. |
| **render-fx** | `src/render/fx.ts`, `src/render/pool.ts`, `test/fx.test.ts` | Projectiles (cannonball arcs, missile trails, bolts), muzzle flashes, impact splashes/sparks, death explosions, damage flashes — all object-pooled. Replaces `projectiles.ts` + `effects.ts`. |
| **hud-polish** | edits its existing `src/hud/*` files + `test/hud.test.ts` | FIX layout (chat bottom-left, minimap corner no-overlap), polish top bar / inventory / ability `F` / cooldown sweeps. DOM overlay only. |
| **INTEGRATOR** | `gallery.html`, `src/gallery.ts`, edits `renderer.ts` | Wires the new layers into `renderer.ts` (the ONLY edit to an existing render file by the integrator); builds the standalone render gallery. |

**Migration note for `entities.ts` / `water.ts` / `projectiles.ts` /
`effects.ts`:** these existing files are superseded. To keep ownership clean,
the INTEGRATOR rewires `renderer.ts` to call `createWorld/createUnits/createFx`
instead of `createWater/createEntities/createProjectiles/createEffects`, and
**deletes the four superseded files in the same integration commit** once all
modules land. Implementers do NOT edit the old files; they write fresh ones so
diffs stay reviewable per module. `viz.ts`, `camera.ts`, `pointer.ts`,
`fog.ts` are KEPT (pointer + fog still consume `viz`/camera unchanged).

## render-world spec

- **Water**: keep the cheap "redraw the visible map rect each frame" approach
  but make it layered: base fill from `waterAt(depth01)` where `depth01`
  grades by distance from the nearest coast / map edge (deeper toward open
  sea and the abyss border); 2–3 drifting wave-band layers at different
  speeds/alphas (time from `nowMs`, NOT match state) using `WATER_FOAM`;
  retain the world-space grid faint; map border + off-map `ABYSS` vignette.
  Optional: a single small generated noise/caustics texture tiled and slowly
  scrolled (allowed — generated in code, no external asset).
- **Coast/terrain**: procedural shoals around the playable border and around
  base regions (read `getCatalog().map` regions if useful) so the sea isn't a
  bare rectangle. Subtle — must not hurt unit legibility.
- **Structures**: one `Container` per structure with shadow → footprint →
  beveled body (height via depth.ts) → team-trim → small upright detail
  (flag/crane/sign) → hp bar overlay. Roles get distinct silhouettes per
  `docs/ARCH.md`. Sizes from `viz.structureRadius`; heights from a
  `ROLE_HEIGHT_RATIO` table run through `logicalHeight`. Team color = trim
  only; neutral = `NEUTRAL_COLOR`. Pool views by entity id; destroy on
  removal.

## render-units spec

- One `Container` per unit (pool by id; destroy on removal). Sub-layers:
  shadow (foreshortened ellipse on the water) → hull (rotated `-facing`,
  squashed by FORESHORTEN so turning matches the plane) → superstructure
  (raised by `heightOffsetPx(logicalHeight(r, shape.deckHeight), zoom)`) →
  overlays (hp bar, selection ring, name label, status glyphs) at
  `overlayKey`.
- Hull built from `shipShape(typeId, spec)`: family chooses the outline +
  superstructure routine; `beam`/`masts`/`deckHeight`/`accent`/`mark`
  distinguish ships within a family. Bevel with `shade()`/`shadeFace()` so the
  lit side faces top-left. Clear bright bow wedge = unambiguous facing.
- Bow wake: a short fading foam V at the bow when the interpolated position
  changed since last frame (time-based fade). Subs: slim, dive-shaded +
  partial alpha when `submerged`. Creeps: smaller desaturated hulls. Summons:
  ghost-tinted, partial alpha. Wards: buoys.
- HP bar/label/selection: reuse the existing `viz` geometry helpers
  (`hpBarWidth`, `hpBarColor`) + `theme` HP colors; hidden at full HP unless
  selected; ward has none.

## render-fx spec

- **Pooling** (`pool.ts`): a generic `Pool<T extends Container>` (or a flat
  Graphics-batch with a free list) — acquire on spawn, release on expiry,
  reuse; never `destroy()` per particle in the hot path; destroy the pool only
  on layer teardown. Cap live particles; oldest recycled under pressure.
- **Projectiles** (lerped from `sample.projectiles`, matched by id): by
  `mechanic` — `nativeAttack` cannonball with a low arc + small launch/impact;
  `phoenixFire` orange dot + fading trail; `stormBolt` cyan oriented bolt;
  `kaboomMissile` missile body + flame + smoke puffs. Arc = a cosmetic
  parabolic screen-y lift over the tracer's recent path (time-based), shadow
  dot on the water beneath.
- **Effects** (from `onEvent`, resolved against the sample like today):
  `death` → explosion (expanding ring + flash + debris, sized by catalog
  maxHp); `hit` → impact splash/sparks at the target + a brief **damage
  flash** tint pulse the unit layer can read (expose a tiny shared signal,
  e.g. `fx.damageFlash(entityId, nowMs)` that `units.ts` queries, OR fx draws
  the flash itself — pick one and document it in fx.ts); `levelUp` → gold
  pillar; `respawn` → splash + muzzle-less sparkle. Muzzle flash on weapon
  fire: derive from new projectiles appearing (first frame a projectile id is
  seen at its origin) since there is no explicit "fired" event — document the
  heuristic in fx.ts.

## hud-polish spec

- DOM overlay only; `#hud` root stays `pointer-events:none`, interactive
  children opt back in. The renderer canvas (`#stage`) sits BELOW `#hud`
  (`z-index:10`) and OWNS all canvas pointer events; HUD interactive children
  must not cover the central play area (see z-order/pointer-events below).
- **Chat**: dock the whole chat block bottom-LEFT (`left:12px`), the log
  growing upward and the input row pinned at its bottom — never centered. Sits
  ABOVE the minimap (stack: minimap at the very bottom-left corner, chat just
  above it). Input row is the only pointer-events:auto part.
- **Minimap**: dock to a corner (bottom-left, below chat, OR bottom-right) with
  a fixed ~200–220px box and a panel frame; must not overlap the inventory bar
  or the central play space. Keep the linear `createMinimapTransform` math.
- **Top bar**: gold / lumber / level+XP / K/D / RTT dot — give it a proper
  raised panel, tabular nums, clear iconography (the current emoji-via-CSS is
  fine to keep or upgrade to small drawn glyphs).
- **Inventory**: 6 slots `W E R A S D` + `F` ability + stop/attack-move
  orders, docked bottom-center. Draw item icons (keep emoji placeholders or
  upgrade), keep the conic-gradient cooldown sweep driven by `readyAtTick` vs
  the interpolation tick, charges, armed-state highlight.
- Keep all `hudmath.ts` pure functions and their tests; only layout/visual CSS
  + minor wiring changes. Add tests for any NEW pure helper introduced.

### z-order & pointer-events contract (render canvas vs HUD)

- `#stage` (canvas) `z-index: 0/auto`, receives camera + game pointer events.
- `#hud` `z-index: 10`, `pointer-events: none`; only these children set
  `pointer-events: auto`: inventory bar, ability/order buttons, shop panel,
  minimap canvas, chat input row, scoreboard, end-screen back button. Chat LOG
  lines, kill feed, banners, top-bar text are display-only (no pointer
  capture) so clicks fall through to the game. Interactive children stay out
  of the central ~60% play rectangle so they never steal a game click.

## Render gallery (INTEGRATOR-owned — the human QA surface)

Because visual QA is done by a human (the agent cannot see the screen), the
gallery is a REQUIRED deliverable and the single screenshot/judge surface.

- **Files**: `packages/client/gallery.html` (a second Vite entry, reachable at
  `/gallery.html` via `npm run dev`) + `src/gallery.ts`. No server, no socket,
  no match — it imports `getCatalog()`, the per-object draw helpers from each
  render module, and `theme`/`depth`, and composes static showcases on a Pixi
  Application at a FIXED camera (use `snapCamera`/a fixed transform).
- **Contents (comprehensive, labeled):**
  1. **All 18 ship classes**, each in BOTH team colors, in a labeled grid —
     name + typeId + gold under each; one row of subs shown both surfaced and
     submerged.
  2. **Every structure role** (hq, spawnBuilding, tower, shop, repair,
     missileRamp, other) in both team colors + neutral, labeled, to-scale next
     to a reference ship so the relative scale is obviously sane.
  3. **Creeps + summons + wards**, labeled.
  4. **Each projectile/effect type**: nativeAttack, phoenixFire, stormBolt,
     kaboomMissile tracers; muzzle flash, impact splash, death explosion,
     damage flash, level-up pillar, respawn splash — animated in place.
  5. **Water** swatch strip showing the depth ramp + animated bands.
  6. **1–2 mock "scene" compositions**: a few ships of both teams + a couple
     of structures + in-flight projectiles + their shadows, at gameplay zoom,
     so depth, y-sorting, shadows, and scale are judgeable at a glance.
- Labels via Pixi `Text` (or DOM overlay on the gallery page). Animations
  off `app.ticker` time. A small legend explains the light direction + that
  team color = south red / north blue.

## Performance rules (all modules)

- Pool and REUSE Pixi display objects keyed by entity/projectile id; on
  removal, `destroy({ children: true })` and drop the map entry — no leaks.
- Particles use a free-list pool, not per-particle allocate/destroy.
- Redraw a unit's static graphics only when its draw signature changes
  (typeId|team|submerged|role|selected…), like the current `sig` guard; only
  cheap per-frame updates (position, rotation, tint, hp width, sweep) run
  every frame.
- Animations are time-based from `nowMs`/`app.ticker`, never from match tick
  state — keeps presentation decoupled and deterministic-irrelevant.
- Target ~150 entities at 60 fps; prefer a few batched `Graphics` over many
  tiny containers where it doesn't cost legibility.
```
