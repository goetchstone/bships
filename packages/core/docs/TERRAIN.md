# Terrain / water-mask contract

Map-fidelity work: BattleShips Pro is water lanes carved through land, not open
sea. This is the shared contract for the static land/water mask + the three
gameplay fixes it enables (land collision, creep-hold-at-tower, shop access).
Read this before touching any of the four owned file-sets below.

Architect-owned scaffold (already landed, do not re-edit):
`packages/core/src/sim/types.ts` (`WaterMask`, `isWater`, `RawTerrainFile`,
`RawDataFiles.terrain`), `packages/core/src/sim/ruleset.ts`
(`compileWaterMask`, wired into `compileMap`), the terrain load in
`packages/server/src/data.ts` + `packages/client/src/catalog.ts`, and the
serializability-test note in `packages/core/test/ruleset.test.ts`.

---

## 1. The data and how it threads through

- **Source**: `data/json/terrain.json`, emitted by `tools/extractor/terrain.py`.
  Water is the map's OWN embedded minimap `data/reference/war3mapMap.png` (the
  literal picture WC3 draws, **owner-confirmed correct**) CLASSIFIED per terrain
  tile by the owner's **confirmed colour key**: SAILABLE WATER = **NON-BLUE**
  (yellow deep + green shallow + pink passable), LAND = **only the blue-dominant**
  ridge pixels. `war3map.w3e` is read only for the grid GEOMETRY (97×129
  tilepoints at 128 u spacing; the emitted grid is the playable sub-rectangle,
  **81×113** — the camera-bounds crop with the WEST bound extended 3 cells west so
  the Goblin Potion Dealer shop sits off the grid edge on a sail-around island,
  see PLAYABLE CROP below). The minimap is BOTH the source and the fidelity
  target — we classify it directly, so land-vs-water agreement with it is ~0.99.
  - **WATER RULE (NON-BLUE = sailable water)**: a terrain tile is water when its
    3×3 minimap pixel patch (sampled at the tile's world centre via the letterbox-
    aware registration below) classifies NON-BLUE by majority. Excluding the white
    letterbox (`R>238 AND G>238 AND B>238`), a content pixel is **LAND iff
    blue-dominant** (`B>R`) and **WATER otherwise** (yellow + green + pink). The
    prior version was WRONG: it classified ONLY the yellow as water (~0.29) and
    called the green + pink LAND — far too dry. Re-classifying NON-BLUE = water
    gives the owner's ~half-water silhouette: over the playable crop ~0.66, vs the
    ~0.535 measured over the WHOLE minimap content box (which still includes the
    land-heavy outer borders the playable rectangle excludes). For RENDER metadata
    only (sailability is purely water-vs-land) water sub-classifies into a depth
    band — DEEP (`R−B>35 AND R≥G`, yellow/tan), PINK (`R>150 AND B>120 AND R−G>15`,
    magenta), else SHALLOW (green) — emitted as the OPTIONAL `depth` RLE the sim
    IGNORES. The green shallow water RINGS the blue ridge cores, so the west
    sail-around loops emerge naturally. The earlier w3e-channel rule + wpm-pathing
    additions are GONE: deriving FROM the minimap is simpler and pure-stdlib.
  - **MINIMAP REGISTRATION** (letterbox-aware, calibrated on dock coords): the
    256×256 PNG's non-white content box (cols 32..223, rows 0..255, aspect 0.75 =
    97/129) maps to the FULL w3e tile-edge extent `x[−6144,6144] y[−8192,8192]`,
    north = top. For world (x,y): `fx=(x+6144)/12288`, `fy=(8192−y)/16384`,
    `px=32+fx·191`, `py=fy·255`. Calibrated so the docks the owner said read water
    — Harbor2(256,−5952), Harbor3(−2304,5248), Harbor4(128,5248) — classify
    NON-BLUE water; the HQ footprints read green-grey (base platform) and are
    added back below.
  - **MINIMAL CONNECTIVITY NECKS** (the ONLY additions on top of the raw trace):
    (1) drop size-1 water components (classifier speckle on the land); (2)
    base-platform addback — every HQ/Harbour/ship-spawn/lane-spawn tilepoint is a
    base-platform footprint the minimap draws green-grey, so set those cells water
    and thread each to the main sea; (3) base-to-base — ensure the two HQ water
    cells share one 4-connected network; (4) shop necks — for each shop not within
    `ACCESS_CELLS`(=2) of the main sea, carve the shortest navigable neck from the
    sea to its access ring via a Dijkstra (cost 1 per water cell, 30 per land
    cell). Under the NON-BLUE key most shops are already sea-reachable, so few
    necks fire. **(5) west sail-around island loops** (owner-approved): the two
    far-west shops (Swedish Lumber Mill, Goblin Potion Dealer) sit on ISLANDS you
    SAIL AROUND through a SINGLE narrow entrance. The green shallow water already
    rings the blue cores, so the loops largely emerge naturally; this step
    GUARANTEES the closed moat — a compact
    5×5 (25-cell) LAND core, ringed by a thin 1-cell navigable water moat (a closed
    4-connected cycle, length 24), sealed by an outer land wall, connected to the
    main sea by EXACTLY ONE entrance (deterministic Dijkstra; extra mouths
    re-landed). The anchor is picked deterministically so the whole ring lands
    on-grid AND the shop stays within ACCESS_CELLS of the moat, preferring the shop
    on the land core. After the WEST-bound extension (3 cells, see PLAYABLE CROP)
    BOTH west shops sit at grid col ≥ 3 == the minimum island-anchor col (R+1, R=2),
    so BOTH land **ON the 25-cell land core** (island land you sail around): the
    Lumber Mill shop at grid col 6, the Goblin Potion Dealer shop at grid col 3 (its
    moat ring's west side lands on grid col 0; the outer wall at col −1 is off-grid =
    boundary, which seals that side of the moat exactly like a land wall). BOTH are
    true sail-around islands (a 25-cell water-enclosed core, a closed 24-cell loop,
    ONE entrance — proven by an entrance-removal isolation test that cuts the moat
    off from the main sea). Net effect: water fraction (playable crop) **0.656**
    (the NON-BLUE classification + a handful of 1-cell necks + the two carved
    moats), minimap land-vs-water agreement ~0.990.
  - **PLAYABLE CROP**: the full w3e extent has an ASYMMETRIC unplayable border
    (8 tiles N, 4 S, 5 W, 6 E per war3map.w3i). The mask is cropped to the w3i
    **camera bounds** `x[-4992,4864] y[-7424,6912]`, then the WEST bound is extended
    `WEST_EXTEND_CELLS`=**3** whole cells (384 u) further west to `minX=-5440`
    (owner-approved). The camera-bounds crop alone placed the Goblin Potion Dealer
    (world x=−4960) on grid col 0 — the west edge — so it could NOT be a sail-around
    island (no map west of it); the minimap content + w3e tile-edge extent reach west
    to x=−6144, so there is real minimap content west of the camera bound. The new
    west columns get their water from the SAME minimap trace. Only `minX`/`cols`
    change (`minY`/`maxX`/`maxY`/`rows`/`cellSize` unchanged). Final crop = the
    tilepoints whose center lies in `x[-5440,4864] y[-7424,6912]`: cols 6..86 → **81
    wide**, rows 6..118 → 113 tall. This rect matches the embedded minimap content
    and is the single source of truth for `MapSpec.bounds` (camera, client minimap,
    movement clamp) — see §1 bounds note below. The emitted `bounds` pad that rect by
    half a cell on each side so the sim's floor() transform lands on the nearest
    tilepoint.
  - `yOrientation` top-down: the minimap is north-up; tiles are sampled at their
    world centres, emit row 0 = north (matching the sim `isWater` transform).
  - **GATES** (fail-loud in the extractor, all PASS): 2/2 HQs, 4/4 harbours,
    12/12 player spawns + 4/4 lane spawns ON water; south HQ ↔ north HQ
    4-connected by water; **16/16 shops sea-reachable** (a main-sea water cell
    within 2 cells — the trader can sail to every shop, both sides, N + S);
    water fraction in [0.55,0.70] (NON-BLUE classification + necks + moats 0.656;
    depth split land/deep/shallow/pink = 0.344/0.291/0.356/0.009); the two west
    islands are sail-around loops (closed water cycle length 24 with a SINGLE
    entrance each, verified by an entrance-removal isolation test); the east
    north→brewery wrap and the winding bottom-right are present. G2 minimap
    land-vs-water agreement ≥ 0.90 (here 0.990 — we classify the minimap directly
    by the owner's colour key). The
    extractor also writes the 3-panel `data/reference/colorkey-compare.png` (real
    minimap | rebuilt 4-shade mask + 16 green shop dots | land-vs-water diff, ≤440px) and the zoomed
    `data/reference/westedge-compare.png` (≤440px: [before | after] of the west
    corner showing BOTH sail-around island rings — Lumber Mill + Goblin — with a
    single entrance each and green shop dots on the AFTER panel). Regenerate with
    `make terrain` / `python3 tools/extractor/terrain.py` (pure stdlib; reads the
    committed minimap PNG + w3e via a pure-stdlib PNG decoder, no venv / no .w3x;
    byte-identical run to run). The minimap PNG itself is reproduced from
    `war3mapMap.blp` by `extract.py` (guarded Pillow import for the BLP1-JPEG
    decode — that step is NOT part of `make terrain`).
  - **AI shop-nav caveat**: even on the ~half-water NON-BLUE mask a shop's dock
    can sit behind a short land peninsula, so the AI brain's straight-line
    dockside re-supply (coast-slide, no A*) can stall short of a base shop instead
    of threading the channel around it. The AI economy LADDER is
    proven on the open-sea stub mask (core `ai.test.ts`); on the real mask the
    server `ai-match.test.ts` asserts the durable signals (creep funnel engages
    towers, lane churn, determinism) rather than completed buys. Reliable AI shop
    docking on the real mask is a movement/AI follow-up (have the brain follow the
    lane nav field back to a shop), NOT a terrain-mask defect.
  - **BOUNDS SOURCE**: when terrain is loaded, `compileMap` sets `MapSpec.bounds`
    to the terrain mask bounds (the playable rect), NOT the editor
    `mapBounds.playableArea` (which still includes part of the unplayable border
    and is kept only for provenance / region math). The open-sea stub path (no
    terrain) still uses `playableArea`, so the legacy harnesses are unchanged.
- **Raw shape**: `RawTerrainFile` (types.ts) — `bounds`, `cols`, `rows`,
  `cellSizeX`, `cellSizeY`, `yOrientation`, and `water` = per-row RLE
  (`water[r] = [leadingValue, run0, run1, ...]`, runs alternate from
  `leadingValue` `0=land`/`1=water`, sum to `cols`).
- **Compiled shape**: `WaterMask` on `Ruleset.map.waterMask`, decoded once by
  `compileWaterMask` into a packed `cells: Uint8Array` (`1`=water, `0`=land),
  length `cols*rows`, row-major. `compileWaterMask` fails loud on a malformed
  file (bad row count, runs not summing to `cols`, wrong orientation).
- **Loading**: server `data.ts` and client `catalog.ts` both pass
  `terrain: loadJson('terrain.json')` into `RawDataFiles`. `terrain` is
  **optional**: when omitted (the many test harnesses that build
  `RawDataFiles` by hand), `compileWaterMask` returns an empty stub mask and
  `isWater` reports open sea — so legacy behavior is unchanged and all 981
  existing tests stay valid.

### Client access path (decided)

The client reaches the mask through the **existing catalog ruleset**, NOT a
second `terrain.json` import:

```ts
import { getCatalog } from '../catalog.js';
import { isWater } from '@bships/core';
const mask = getCatalog().map.waterMask;
isWater(mask, worldX, worldY); // true => navigable water
```

`@bships/core` re-exports `isWater` and `WaterMask` (via `sim/types.js`).
`catalog.ts` already compiles the same ruleset the server uses, now with
terrain wired in, so client and server query an identical mask. Do **not** add
a raw `terrain.json` fetch/import in a render module — go through the catalog.

---

## 2. The query API (the one signature everyone consumes)

```ts
// packages/core/src/sim/types.ts
export function isWater(mask: WaterMask, x: number, y: number): boolean;
```

- Pure arithmetic against the static mask — **no RNG, no time, no trig**. Safe
  to call from the deterministic sim (movement) and the client land renderer.
- Returns `false` for points outside `mask.bounds` (off-map gutter = land, so
  the coastline reads closed).
- **STUB STATE**: while `mask.cells.length === 0` (terrain absent) it returns
  `true` everywhere. With the real `terrain.json` loaded (server + client) it
  is the live lookup. The body already implements the live transform; nothing
  to change there.

### Coordinate transform (proven by the extractor — no flip)

```
col = floor((x - bounds.minX) / cellSizeX)   // 0 .. cols-1, col 0 = min-X (west)
row = floor((bounds.maxY - y) / cellSizeY)    // 0 .. rows-1, row 0 = max-Y (north)
cell = cells[row * cols + col]                // 1 = water, 0 = land
```

`cellSizeX == cellSizeY == 128` (the WC3 tile spacing; the mask grid is the w3e
tilepoint grid). This transform lives **only** inside `isWater`. Anyone needing
cell coordinates (e.g. the land renderer iterating cells for batching) must use
the same formula; do not invent a second one.

---

## 3. Determinism rules (binding, all core work)

- The mask is **static data on the immutable Ruleset**, never in `SimState`,
  never hashed by `hashState`, never serialized per-match. That is why
  `cells` may be a `Uint8Array` (an intentional non-JSON node in a Ruleset;
  `deepClone` has a typed-array fast-path so Balanced patches keep a working
  mask). A match still replays bit-identically: querying a fixed array with
  `Math.floor`/integer indexing is deterministic arithmetic.

### Lane navigation field (integrator addition — `NavField`)

SEMANTICS §3 assumed "straight-line + coast-slide, no A*" because it was written
for open water. The REAL lanes are tortuous water channels (a straight south-
spawn→north-base line is ~90% land), so straight-line + greedy coast-follow
traps a unit in the first concave bay and it never crosses. The fix is a
**static lane-navigation field** (`types.ts NavField`): a BFS hop-distance over
the water cells, computed ONCE per Ruleset from the static mask, toward each
team's enemy base (`map.navByTeam`) and own base (`map.navHomeByTeam`). Movement
reads its descending gradient (`navStepToward`) in O(1) to follow the lane
around the landmass. This is **NOT per-tick A***: there is no per-tick search and
no per-unit path state — every unit reads the same shared, immutable field. It
is "arithmetic against a static array" exactly like the mask, so a match still
replays bit-identically; the `dist: Int32Array` lives on the immutable Ruleset
(never in SimState/hashState, `deepClone` typed-array fast-path covers it).
Creeps always follow the push field down their lane (combat decides what to fire
at); ships follow it only for base-bound long hauls, so local micro / shop /
repair-bay moves stay plain straight-line.

- Any movement/creep logic added stays under the MODULES.md hard rules:
  randomness only via `rollInt`/`rollFloat`, trig only via `dSin`/`dCos`/
  `dAtan2`, ascending-id iteration, integer-tick durations, plain POJO state
  writes. Arithmetic against the mask is fine; do not add a Math.random/Date/
  Math-trig call, and do not add/remove an RNG draw (that breaks replay).

---

## 4. Module split (four disjoint implementers)

### pathing — core movement (`movement.ts` + `test/movement.test.ts`)

- Ships AND creeps cannot enter non-water cells. Resolve against the mask in
  `stepMovement`, deterministically (block, then slide along the coast), so the
  lanes funnel ship traffic through the tower gaps.
- Replace the Phase-3 bounds-only clamp (movement.ts: "Water-mask clamping is
  an OPEN follow-up … bounds-only") with a mask-aware resolution. Suggested
  shape: after kinematics + pushout, for any unit whose new `(x,y)` is land,
  reject the move — try axis-separated slide (keep the water-valid axis, zero
  the blocked one) before falling back to the pre-move position; final bounds
  clamp stays. Keep it integer-deterministic (no trig in the resolver; reuse
  `isWater`).
- Query `ruleset.map.waterMask` via `isWater(mask, x, y)`. Structures are not
  re-clamped (they are placed on/near shore by the map and never move).
- **Coordinate with creep-ai**: do NOT change `entity.order` logic — that is
  creep-ai's. You only execute orders and resolve collision-vs-land. A creep
  ordered toward a point it cannot reach should slide/stall at the coast, not
  re-path (no A*; SEMANTICS §3 accepts straight-line + slide + the land funnel).
- Tests: a ship/creep cannot cross a known land cell; sliding along a coast
  edge advances along the open axis; an all-water stub mask reproduces today's
  free movement (regression guard).

### creep-ai — core creeps (`creeps.ts` + `test/creeps.test.ts`)

- Lane creeps advance only up to the **frontmost LIVING enemy structure in
  their lane**: they hold at it and attack (let combat fire), and resume toward
  the next once it dies. Order: enemy towers in the lane, then the enemy HQ
  (target the nearest-to-spawn living enemy structure along the lane axis).
  Players are unaffected (this is creep `order` logic only).
- Where it lives: the waypoint-AI pass in `stepCreeps`. Today it issues
  `attackMove` to the lane's waypoints (ultimately the enemy HQ). Add a "hold
  gate": before issuing the next waypoint, find the frontmost living enemy
  structure ahead of the creep along the lane; if one exists nearer than the
  next waypoint, the creep holds (set its order to `attackMove` toward that
  structure — combat's targeting + movement's attack-stop handle the rest)
  instead of advancing the waypoint index past it.
- Finding the frontmost living enemy structure per lane: iterate
  `state.entities` in ascending-id order (determinism), filter
  `kind === 'structure'`, alive, `team === enemyTeam(creep.team)`, role
  tower/hq; pick the one nearest the creep along the lane's direction of
  travel (frontmost = smallest remaining distance toward the enemy HQ). Use
  `ruleset.map.lanes` for lane geometry; mirror the existing `structureAlive`
  liveness check. No new RNG draws.
- **Reconciliation note for the integrator** (and pathing): with the land
  funnel in place, creeps will physically pile at the tower chokepoint; the
  hold logic makes them *target* it rather than ghost past. Both are needed.
- Tests: a creep holds at a live enemy tower in its lane and does not advance
  its waypoint past it; after the tower dies the creep resumes to the next
  structure / HQ; opposing creeps still meet and fight (see §5).

### land-render — client render (`render/land.ts` NEW + `test/` for it)

- Draw the land masses / beaches / coastline from the mask, **behind units and
  structures**, keeping the bright water for the lanes. Pseudo-3D look matching
  `world.ts`: lit land top, sand/rock coast band, drop shadow where land meets
  sea (reuse `theme.ts` `COAST_SAND`/`COAST_ROCK`/`mix`/`scale`/`shade` and the
  `FORESHORTEN` squash).
- **Ownership of world.ts vs land.ts (decided)**: `world.ts` stays owned by its
  current author and keeps drawing the SEA (`seaStatic`/`seaFoam`) + structures.
  Create a NEW `render/land.ts` that exports a layer with the same lifecycle
  shape as `WorldLayer` (`view: Container; update(sample, nowMs); resize(w,h)`)
  OR a `drawLand(g, cam, mask)` the integrator inserts between the sea fill and
  the foam/structure layers. Do not edit `world.ts`'s sea/structure internals;
  the integrator wires the new land layer into `renderer.ts` z-order
  (sea base → LAND → foam → units/structures). Coordinate the exact insertion
  point with the integrator; keep your code self-contained in `land.ts`.
- Performance: cache like the static sea — rebuild land geometry only when the
  camera's visible-rect/zoom/viewport signature changes (mirror
  `seaStaticSignature`), not every frame. Iterate only the mask cells inside
  the visible world rect; batch runs of land cells per row into rects (the mask
  is already RLE-friendly). All positions via `getCamera().worldToScreen`, all
  sizes × `getCamera().zoom`; no raw screen offsets.
- Access the mask via `getCatalog().map.waterMask` + `isWater` (§1). Land is
  presentation-only — no game logic on the client.
- Tests: pure helpers (cell→world rect math agrees with the §2 transform; a
  visible-rect signature gates rebuilds). Pixi drawing can be smoke-tested like
  the existing render tests.

### shop-access — client shop surfacing (`hud/minimap.ts` + shop render/cue + tests)

- Render shop buildings clearly at each base (they already draw as the `market`
  silhouette in `structures.ts`; ensure they read distinctly and are not hidden
  under the new land — coordinate z-order with land-render/integrator).
- Minimap: add shop markers in `hud/minimap.ts` (it already has a `shop` glyph
  branch — make it prominent; consider always-on labels at the player's base).
- Proximity cue: surface "head to a shop" when the player is outside the shop
  `interactRadius` (≈450u; `ruleset.shops[typeId].interactRadius`). The player
  spawns ~760u from the nearest shop and shops are off-screen at the 1.7× follow
  zoom (`camera.ts` `DEFAULT_ZOOM`), so add a HUD marker/arrow toward the
  nearest base shop and ensure the base is framable (a "frame base" affordance,
  e.g. a minimap double-click already pans; add an explicit recenter-on-base or
  a marker the player can click to `panTo`).
- Read shop positions from the snapshot (`SnapshotEntity` with `role==='shop'`)
  and/or `getCatalog().map.structures` (role `shop`, with `shopSide`). Find the
  player's own ship via `store.match.mySlot`. Presentation-only.
- Tests: nearest-shop selection picks the player's own-side shop; the cue shows
  only when outside `interactRadius`; minimap shop markers render.

---

## 5. Keeping the bot-match / integration tests valid

`packages/core/test/integration.test.ts` "opposing creeps fought" asserts a
combat death with cross-player kill credit and that BOTH empires lost creeps —
i.e. opposing lane creeps meet and fight. Today they meet mid-map. After
creep-ai (hold at frontmost enemy tower) + pathing (land funnel), creeps engage
the enemy **tower** first and meet enemy creeps **at the chokepoint**, not the
open midline. The assertion (deaths with kill credit on both sides) should still
hold — towers + opposing creeps both produce cross-player kills. If the timing
shifts enough that 3000 ticks no longer shows a death, the integrator may
lengthen the run or relax the tick window; **say so in the PR**. These core
integration tests currently run on a `RawDataFiles` WITHOUT terrain (stub
mask = open sea), so they are unaffected unless a harness opts terrain in.

The server `ai-match.test.ts` only asserts the bots close distance to the enemy
HQ and the HQ takes some damage (creep/ship chip). With the funnel, ships still
reach the HQ through the lane; creeps now stall at towers. Keep an eye on the
"HQ takes damage" milestone — if towers fully block early creeps, ship pushes
still deliver the chip. Integrator reconciles if a milestone tick moves.

---

## 6. Validation already done (for confidence)

`compileWaterMask` round-trips the RLE bit-exactly (the extractor verified it
against the source `.w3e`). terrain.json embeds a structure cross-check: HQs
2/2 ON water, spawn buildings (harbours) 4/4 ON water, all 12 player spawns ON
water, shops 16/16 within 1 cell, towers 24/24 within 2 cells (the inland mid
towers guard the lane behind the chokepoint — expected, towers are land
buildings). The two bases are 4-connected by water. Water fraction ≈ 0.505. The
decisive HQs/harbours/spawns-on-water gate rejected both the waterLevel-height
rule and the flipped (north-first) w3e row order. Trust the mask; do not
re-derive the rule.
