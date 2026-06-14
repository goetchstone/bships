# Map data extractor

Two stages, both reproducible from committed inputs.

## `extract.py` — object data from the `.w3x`
Strips the HM3W header, opens the MPQ, dumps `war3map.*` into `data/extracted/`,
and parses the W3U-family object files into `data/json/*.json`.
Needs the (gitignored) reference map and the venv:

    make extract        # runs extract.py then `make terrain`

## `terrain.py` — land/water mask from the pathing map
Parses `data/extracted/war3map.wpm` (committed) into `data/json/terrain.json`.
Pure stdlib, no venv, no `.w3x` needed:

    make terrain        # or: python3 tools/extractor/terrain.py [--ascii]

### What it produces
`terrain.json` = a static, deterministic ship-navigable-water mask over the
playable rect, run-length-encoded per row (`water[r] = [leadingValue, run0, run1,
…]`, runs alternate from `leadingValue`, sum to `cols`). ~18 KB vs a 197k-cell
raw array. Native pathing resolution: 384x512 cells, ~28.25 x 29.0 u/cell.
`row 0 = max-Y (north)`, `col 0 = min-X (west)`.

### Water rule (empirically chosen, not assumed)
`water = (pathing flag byte & 0x40)`. Only six byte values occur in this wpm;
`0x40` is set on the four water values and clear on the two land values. The
alternative rules (walkable bit, 0x80) render as noise rather than lanes.

### Orientation & validation
File rows are north-first (row 0 = max-Y); index increases southward — no flip.
Determined by structure cross-check, not assumption: the south Main Harbor HQ
(world y -6912) only sits on water under `row = floor((maxY - y)/cellSizeY)`
indexed directly into file rows. Cross-check vs `data/json/map-layout.json`:

| role          | on/near water                                  |
|---------------|------------------------------------------------|
| hq (2)        | 2/2 within 1 cell                              |
| spawnBuilding (4) | 4/4 on water (creep spawn points)          |
| shop (16)     | 12 on water, all 16 within ~115 u (½ tile)     |
| tower (24)    | 17 within ~57 u, 20 within ~115 u              |

(Inland towers guard the lane behind the chokepoint, so a few sit further back
on land — expected.) Water fraction over playable cells: **0.612** — majority
water with clear landmasses between the lanes, as a sea map should be.
Run `python3 tools/extractor/terrain.py --ascii` to print the lane map.
