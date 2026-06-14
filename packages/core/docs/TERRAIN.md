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

- **Source**: `data/json/terrain.json`, emitted by `tools/extractor/terrain.py`
  from `data/extracted/war3map.wpm`. `water = (byte & 0x40) OR not(byte & 0x02)`
  — painted water OR walkable ground; LAND is only the `0x0a` not-walkable
  cliffs that carve the lanes. `yOrientation` top-down, no flip. Native pathing
  resolution 384×512.
  - **RULE CORRECTION (integrator)**: the original `water = byte & 0x40` rule was
    wrong — it flagged every `0x08` base-dock cell as land, so the south HQ,
    several ship spawns and the base aprons were unsailable and ships spawned
    stuck. The extractor now validates (fail-loud) that all 12 player spawns and
    all lane spawns sit ON water, the two bases form one connected water network,
    and the centre stays >25% land. Regenerate with
    `python3 tools/extractor/terrain.py`.
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

`cellSizeX ≈ 28.25`, `cellSizeY ≈ 29.0`. This transform lives **only** inside
`isWater`. Anyone needing cell coordinates (e.g. the land renderer iterating
cells for batching) must use the same formula; do not invent a second one.

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
against the source `.wpm`). terrain.json embeds a structure cross-check: HQs
2/2 on/near water, spawn buildings 4/4 on water, shops 16/16 within ~115u,
towers 20/24 within ~115u (the 4 inland towers guard the lane behind the
chokepoint — expected, towers are land buildings). The decisive south-HQ test
rejected the flipped orientation. Trust the mask; do not re-derive the rule.
