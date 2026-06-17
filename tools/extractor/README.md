# Map data extractor

Two stages, both reproducible from committed inputs.

## `extract.py` — object data + minimap from the `.w3x`
Strips the HM3W header, opens the MPQ, dumps `war3map.*` into `data/extracted/`,
and parses the W3U-family object files into `data/json/*.json`. Also copies the
embedded minimap `war3mapMap.blp` into `data/reference/` and decodes it to
`war3mapMap.png` (BLP1-JPEG → RGB; the `Pillow` import is guarded, so extract
still runs without it and the committed PNG is reused). Needs the (gitignored)
reference map and the venv:

    make extract        # runs extract.py then `make terrain`

## `terrain.py` — land/water mask CLASSIFIED from the embedded minimap
CLASSIFIES the map's own embedded minimap `data/reference/war3mapMap.png` (the
literal picture WC3 draws, **owner-confirmed correct**) per terrain tile into
`data/json/terrain.json` by the owner's **confirmed colour key**: SAILABLE WATER
= **NON-BLUE** (yellow deep + green shallow + pink passable), LAND = **only the
blue-dominant** ridge pixels. `data/extracted/war3map.w3e` (committed) is read
only for the grid GEOMETRY, then CROPPED to the playable rectangle. Pure stdlib —
a pure-stdlib PNG decoder reads the committed minimap and the classifier/neck-
carving are integer arithmetic / deterministic Dijkstra — so no venv, no `.w3x`,
byte-reproducible run to run:

    make terrain        # or: python3 tools/extractor/terrain.py [--ascii]

(No bake needed: reading + classifying the committed PNG directly is simpler and
equally reproducible. The PNG itself is produced from `war3mapMap.blp` by
`extract.py`, whose BLP1→JPEG decode is the only Pillow step — and it is NOT part
of `make terrain`.)

### What it produces
`terrain.json` = a static, deterministic ship-navigable-water mask over the
PLAYABLE sub-rectangle of the w3e tilepoint grid, run-length-encoded per row
(`water[r] = [leadingValue, run0, run1, …]`, runs alternate from `leadingValue`,
sum to `cols`). Resolution: **81×113** tilepoints at 128 u spacing (the unplayable
border cropped + the west bound extended 3 cells). `row 0 = max-Y (north)`,
`col 0 = min-X (west)`. Bounds are the tilepoint centers padded by half a cell so
the sim's `col=floor((x-minX)/128)`, `row=floor((maxY-y)/128)` lands on the
nearest tilepoint. It also carries an OPTIONAL `depth` RLE (`depth[r] = [value0,
run0, …]`; 0=land, 1=deep, 2=shallow, 3=pink) — additive render metadata the SIM
IGNORES (`depth>0` IFF `water==1`), so a client can paint the three water shades +
land like the minimap. Also writes the 3-panel
`data/reference/colorkey-compare.png` (real minimap | rebuilt 4-shade mask +
16 green shop dots | land-vs-water diff, ≤440px wide) and prints the agreement.

### Water rule — NON-BLUE = sailable water
Excluding the white letterbox (`R>238 AND G>238 AND B>238`), a tile (3×3 minimap
patch majority, sampled at the tile's world centre via the letterbox-aware
registration) is **LAND iff blue-dominant** (`B>R`) and **WATER otherwise**
(yellow + green + pink). This is the owner's confirmed key — the prior version was
WRONG because it classified ONLY the yellow as water (~0.29) and called the green
+ pink LAND (far too dry). For RENDER metadata only (sailability is just water-vs-
land) water sub-classifies into a depth band: DEEP (`R−B>35 AND R≥G`, yellow/tan),
PINK (`R>150 AND B>120 AND R−G>15`, magenta), else SHALLOW (green). Measured pixel
fractions of non-white content: LAND 0.465 / DEEP 0.230 / SHALLOW 0.287 / PINK
0.018 → WATER total 0.535 over the whole content box (~0.66 over the playable crop,
which excludes the land-heavy borders). The green shallow water RINGS the blue
ridge cores, so the west sail-around loops emerge naturally. **Registration**
(calibrated on dock coords): the 256×256 PNG content box (cols 32..223, rows
0..255, aspect 97/129) maps to the full w3e tile-edge extent `x[−6144,6144]
y[−8192,8192]`, `fx=(x+6144)/12288`, `fy=(8192−y)/16384`, `px=32+fx·191`,
`py=fy·255`.

### Minimal connectivity necks (the ONLY additions on top of the classification)
1. drop size-1 water components (classifier speckle — rare under the NON-BLUE key);
2. **base-platform addback** — every HQ/Harbour/ship-spawn/lane-spawn tilepoint is
   a base-platform footprint the minimap draws green-grey, so set those water and
   thread each to the main sea;
3. **base-to-base** — ensure the two HQ water cells share one 4-connected network;
4. **shop necks** — for each shop not within `ACCESS_CELLS`(=2) of the main sea,
   carve the shortest navigable neck from the sea to its access ring via a
   Dijkstra (cost 1 per water cell, 30 per land cell). Most shops are already sea-
   reachable under the NON-BLUE key, so few necks fire.
5. **west sail-around island loops** (owner-approved) — the two far-WEST shops
   (**Swedish Lumber Mill** ~(−4640,−928), **Goblin Potion Dealer** ~(−4960,−5344))
   sit on ISLANDS the owner sails AROUND through a SINGLE narrow entrance. The
   green shallow water already rings the blue cores, so the loops largely emerge
   naturally; this step GUARANTEES the closed moat: a compact (5×5) 25-cell LAND
   core, ringed by a thin **1-cell navigable water moat** (a closed 4-connected
   cycle of length 24), sealed by an outer land wall, connected to the main sea by
   **exactly one** narrow entrance (deterministic Dijkstra, ties on `(cost,c,r)`;
   extra mouths re-landed). The anchor is chosen deterministically
   (`_pick_island_anchor`) so the whole ring lands on-grid (a closed loop) AND the
   shop stays within `ACCESS_CELLS` of the moat; after the west-bound extension
   BOTH shops sit ON their 25-cell island land core. Both are TRUE sail-around
   islands: a 25-cell water-enclosed core, a closed 24-cell loop, ONE entrance.
   Only WATER VALUES change; geometry is untouched.

Net: water fraction (playable crop) ≈ **0.656** (NON-BLUE classification + a
handful of 1-cell connectivity necks + the two carved west sail-around moats);
minimap colour-key land-vs-water agreement ≈ **0.990**.

Also writes `data/reference/westedge-compare.png` (≤440px): a zoom of the two west
islands **[before moat | after sail-around moat]** plus the 16 shop dots green
(reachable).

### Playable crop
The full w3e extent has an ASYMMETRIC unplayable border (8 tiles N, 4 S, 5 W,
6 E per `war3map.w3i`). The mask is cropped to the w3i camera bounds with the west
bound extended 3 cells → bounds `x[-5440,4928] y[-7488,6976]`, which matches the
minimap content and becomes the single source of truth for `MapSpec.bounds`
(camera, client minimap, movement clamp) — see `packages/core/docs/TERRAIN.md`.

### Orientation & validation
The minimap is north-up; tiles are sampled at their world centres, emit row 0 =
max-Y = north to match the sim `isWater` transform. `validate` is FAIL-LOUD — it
raises if any gate fails. Cross-check vs `data/json/map-layout.json`:

| gate              | result                                         |
|-------------------|------------------------------------------------|
| hq (2)            | 2/2 ON water                                   |
| spawnBuilding (4) | 4/4 ON water (creep spawn points)              |
| player spawns (12)| 12/12 ON water                                 |
| lane spawns (4)   | 4/4 ON water + water-connected to enemy HQ     |
| bases            | south HQ ↔ north HQ 4-connected by water       |
| shops reachable   | 16/16 sea-reachable (trader sails to every shop, N+S, both sides) |
| west islands      | sail-around loops: cycleLen 24 + 1 entrance each |
| water fraction    | 0.656 (NON-BLUE; land = blue-dominant only)    |
| depth split       | land/deep/shallow/pink = 0.344/0.291/0.356/0.009 |
| minimap agree     | 0.990 (agree 0.990 / ours-only 0.006 / ref-only 0.005) |

Water fraction: **0.656** (the playable crop reads honestly higher than the
~0.535 measured over the whole minimap content box, because the playable
rectangle excludes the land-heavy outer borders). Run
`python3 tools/extractor/terrain.py --ascii` to print the north-up map.
