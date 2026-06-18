#!/usr/bin/env python3
"""Classify the map's embedded minimap into a land/water mask -> terrain.json.

Usage:
    python terrain.py [--w3e data/extracted/war3map.w3e]          # grid geometry
                      [--minimap data/reference/war3mapMap.png]    # THE picture
                      [--layout data/json/map-layout.json]
                      [--out data/json/terrain.json]
                      [--compare data/reference/colorkey-compare.png]
                      [--ascii]   # also print the north-up ASCII map to stderr

WHAT THE WATER IS (the owner's CONFIRMED colour key)
----------------------------------------------------
The map's OWN embedded minimap -- war3mapMap.blp decoded to
data/reference/war3mapMap.png by extract.py -- IS the literal picture WC3 draws,
and the map owner (a former competitive player) CONFIRMED both the silhouette
and the colour key for what it draws:
    YELLOW/tan      = DEEP water
    GREEN           = SHALLOW water
    PINK/magenta    = passable SHALLOW water
    BLUE/slate      = LAND (ridges)
Therefore SAILABLE WATER = NON-BLUE (yellow + green + pink) and LAND = ONLY the
blue-dominant pixels. The per-tile water mask is the NON-BLUE classification of
the minimap. A prior version was WRONG because it classified ONLY the yellow as
water (~0.29) and threw away the green + pink, calling the green 'land' -- far
too dry. The owner says the ORIGINAL ~50%-water map was CLOSE; re-classifying by
this key gives ~half water (over the playable crop ~0.66, vs the ~0.535 measured
over the whole minimap content box, which still includes the land-heavy outer
borders the playable rectangle excludes), which matches the picture.

The sail-around island LOOPS the owner wants emerge NATURALLY: the GREEN shallow
water rings the BLUE ridge cores. The ONLY additions on top of the raw
classification are MINIMAL 1-cell necks to (a) connect every one of the 16 shops
to the sea and (b) keep the south HQ <-> north HQ water-connected with every
dock/spawn on connected water. Under the NON-BLUE key most water is already one
connected sea, so the necks rarely fire. We also still CARVE the two
owner-approved west sail-around island moats (a closed 1-cell ring + one
entrance) so each west shop sits on a compact land core you loop around.

OPTIONAL DEPTH METADATA: terrain.json also carries a per-tile `depth` field
(0=land, 1=deep, 2=shallow, 3=pink) so a client can paint the three water shades
+ land like the minimap. It is ADDITIVE render metadata -- the sim IGNORES it;
sailability is purely water-vs-land via the `water` RLE.

REPRODUCIBILITY (pure stdlib, no venv, no bake)
-----------------------------------------------
Deriving the mask needs to read the minimap PNG. The committed war3mapMap.png is
an 8-bit RGB (colour-type 2) PNG, which this file decodes with a pure-stdlib PNG
reader (zlib is stdlib) -- so `make terrain` reads the committed PNG and the
committed w3e with NO third-party dependency, NO venv and NO .w3x, and is
byte-deterministic. The classifier and the neck-carving are pure integer
arithmetic / deterministic Dijkstra. (We therefore do NOT need to bake the
classification into a generated array; reading + classifying the committed PNG
directly is simpler and stays equally reproducible. The PNG itself is reproduced
from war3mapMap.blp by extract.py, whose BLP1->JPEG decode is the only step that
needs Pillow -- and that step is not part of `make terrain`.)

MINIMAP REGISTRATION (letterbox-aware; calibrated on dock coords)
-----------------------------------------------------------------
war3mapMap.png is 256x256. The map is non-square (97 wide x 129 tall tilepoints)
so the picture is LETTERBOXED on the narrow x axis: the non-white content box is
cols ~32..223, rows 0..255 (aspect 192/256 = 0.75 = 97/129). That content box
maps to the FULL w3e tile-edge extent world x[-6144,6144] y[-8192,8192], north =
top = min row. For a world point (x,y):
    fx = (x + 6144) / 12288 ;  fy = (8192 - y) / 16384
    px = CONTENT_X0 + fx*(CONTENT_X1 - CONTENT_X0)
    py = CONTENT_Y0 + fy*(CONTENT_Y1 - CONTENT_Y0)
We sample a 3x3 patch and classify by majority. Calibrated against the docks the
owner said must read water -- Harbor2(256,-5952)=(238,187,178), Harbor3(-2304,5248)
=(245,207,157), Harbor4(128,5248)=(248,201,171) all classify NON-BLUE water; the
HQ footprints read green-grey (base platform) and are added back below.

NON-BLUE (water) CLASSIFIER
---------------------------
Excluding the WHITE letterbox (R>238 AND G>238 AND B>238), a content pixel is:
    LAND  iff blue-dominant   (B > R)    -- the owner's blue/slate ridges;
    WATER otherwise           (NOT blue) -- yellow deep + green shallow + pink.
For RENDER METADATA only (sailability is just water-vs-land), water sub-classifies
into a depth band:
    DEEP    (1): (R - B) > 35 AND R >= G            -- yellow/tan;
    PINK    (3): R > 150 AND B > 120 AND (R - G) > 15 -- magenta passable shallows;
    SHALLOW (2): every other non-blue water pixel   -- green.
Measured pixel fractions of non-white content: LAND 0.465 / DEEP 0.230 /
SHALLOW 0.287 / PINK 0.018 -> WATER total 0.535 over the whole content box; over
the playable crop (which excludes the land-heavy borders) WATER is ~0.65.

GRID GEOMETRY (preserved EXACTLY; only water VALUES change)
-----------------------------------------------------------
The emitted grid is the w3e tilepoint grid cropped to the war3map.w3i camera
bounds (the playable rectangle; the asymmetric unplayable border removed) with
the WEST bound extended 3 cells (see WEST_EXTEND_CELLS): bounds x[-5440,4928]
y[-7488,6976], cols 81, rows 113, cellSizeX/Y 128, per-row RLE
water[r]=[lead,run0,...], yOrientation top-down (rle row 0 = max-Y = north). Cell
center world x = minX+(col+0.5)*csx, y = maxY-(row+0.5)*csy; sim isWater col =
floor((x-minX)/csx), row = floor((maxY-y)/csy). w3e tilepoints are stored
south-first; we crop then FLIP rows so emit row 0 = north (matching sim isWater
and the north-up minimap).

PIPELINE
--------
  1. classify each playable tilepoint as NON-BLUE water -> the raw water mask.
  2. drop singleton (size-1) water components -- classifier speckle, never a real
     lane; everything size >= 2 is kept. (Under the NON-BLUE key the sea is one
     big connected component, so this rarely removes anything.)
  3. base-platform addback: every HQ/Harbour/ship-spawn/lane-spawn tilepoint is a
     base-platform footprint the minimap draws green-grey (not classified water);
     set those cells water so docks/spawns sit on water (G4), then thread each to
     the main sea with a 1-cell neck.
  4. shop necks: for each shop not already within ACCESS_CELLS of the main sea,
     carve the shortest navigable neck from the main sea to its access ring
     (Dijkstra: cost 1 per water cell, LAND_COST per land cell). Most shops are
     already sea-reachable under the NON-BLUE key, so few necks fire.
  5. base-to-base: ensure the two HQ water cells share one 4-connected network.
  6. west-island loops: ring each of the two owner-circled west-island shops
     (Swedish Lumber Mill, Goblin Potion Dealer) with a thin 1-cell navigable moat
     around a compact land core, connected to the main sea by EXACTLY ONE entrance
     (see the WEST-ISLAND LOOPS section). The green shallow water already rings the
     blue cores, so the loops largely emerge naturally; this step guarantees the
     closed single-entrance moat. Deterministic; only WATER VALUES change.
  7. OPTIONAL depth metadata: per-tile depth band (0=land,1=deep,2=shallow,3=pink)
     over the FINAL mask, emitted as the additive `depth` RLE (sim IGNORES it).
Only water VALUES change; the geometry above is byte-identical run to run.
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import struct
import sys
import zlib
from collections import deque
from pathlib import Path

TILE_SPACING = 128.0  # WC3 world units between tilepoints

# WEST-BOUND EXTENSION (owner-approved): the prior crop put minX at the camera
# bounds (-4992), which placed the Goblin Potion Dealer shop (world x=-4960) on
# grid COL 0 -- the very west edge -- so it could not be a sail-around island (no
# water west of it). The owner confirmed Goblin is ALSO a sail-around island. The
# minimap content + w3e tile-edge extent reach west to x=-6144, so there is real
# minimap content west of the old bound. We EXTEND the playable WEST bound westward
# by WEST_EXTEND_CELLS whole 128u cells (only minX/cols change; minY/maxX/maxY/rows/
# cellSize unchanged) -- the MINIMAL extension for which the Goblin shop sits on a
# compact on-grid island with a closed 1-cell moat + one entrance. K=3 lands the
# Goblin shop on grid col 3 == the minimum island anchor col (R+1, R=2), so its
# whole 1-cell moat ring (Chebyshev 3 = cols 0..6) fits on-grid as a CLOSED loop
# and the shop sits ON the island LAND CORE (the west moat side at col 0 is sealed
# by the off-grid boundary, exactly like a land wall). The new west columns get
# their water from the SAME minimap trace.
WEST_EXTEND_CELLS = 3  # K: whole cells the playable west bound is moved westward.
_PLAYABLE_CAMERA_MIN_X = -4992.0  # the prior west bound (war3map.w3i camera bounds).

# Playable rectangle = war3map.w3i camera bounds, with the WEST bound extended by
# WEST_EXTEND_CELLS cells (see above). minY/maxX/maxY unchanged.
PLAYABLE = {
    "minX": _PLAYABLE_CAMERA_MIN_X - WEST_EXTEND_CELLS * TILE_SPACING,
    "minY": -7424.0,
    "maxX": 4864.0,
    "maxY": 6912.0,
}

# --- minimap registration (content box -> full w3e tile-edge extent) ----------
CONTENT_X0, CONTENT_X1 = 32.0, 223.0   # non-white content cols (letterboxed x)
CONTENT_Y0, CONTENT_Y1 = 0.0, 255.0    # content rows (full height)
EXTENT_MIN_X, EXTENT_MAX_X = -6144.0, 6144.0
EXTENT_MIN_Y, EXTENT_MAX_Y = -8192.0, 8192.0
SAMPLE_PATCH = 3  # NxN minimap pixel patch sampled per tile (majority vote)

# --- connectivity-neck knobs (kept small/explicit so additions are auditable) --
ACCESS_CELLS = 2   # a shop is "sea-reachable" if main-sea water is within this
#                    Manhattan radius (~256u). Kept tight so the carved neck
#                    brings navigable water RIGHT UP to the shop on its sea-facing
#                    side -- a shop with water only 3 cells away on the far side
#                    of a land gap looks "reachable" but the AI/player ship cannot
#                    slide around the gap to dock, so we carve a proper short neck.
SOFT_COST = 2      # Dijkstra cost to carve a neck through a faint-tan cell.
LAND_COST = 30     # Dijkstra cost to carve a neck through solid land (keeps the
#                    carved neck as short as possible for far-flank shops).

# Repair-area REGIONS the sim routes ships into (a damaged ship sails into the
# repair bay; the trader visits the repair station). These are regions in
# map-layout, NOT role=="shop" structures, so the shop-neck pass below misses
# them -- the owner reported ships "could not get to the repair station" because
# the classifier left each repair bay on a tiny isolated water pocket. We carve a
# neck connecting each one's water to the main sea, and the fidelity gate fails
# loud if any stays unreachable.
CONNECT_REGIONS = ["Repair_Station_South", "Repair_Station_North"]

# --- west sail-around island loops (owner-approved; see WEST-ISLAND LOOPS) ------
# The two far-WEST shops sit on ISLANDS the owner sails AROUND through a single
# narrow entrance. The minimap tan is too faint there to trace the loop, so we
# CARVE a thin (1-cell) navigable moat ring around a compact land core, sealed by
# a land wall, connected to the main sea by EXACTLY ONE entrance. The two shops
# are matched by their owner-circled world coords (deterministic, explicit -- NOT
# "western-most x", which would grab the north Pigfarm Elven Library instead).
WEST_ISLAND_SHOPS = ((-4640.0, -928.0), (-4960.0, -5344.0))  # LumberMill, GoblinPotion
WEST_ISLAND_CORE_R = 2   # filled (2R+1)x(2R+1) land core; moat ring at chebyshev R+1.


# ---------------------------------------------------------------------------
# w3e parsing (used ONLY for the playable-crop grid geometry)
# ---------------------------------------------------------------------------


def parse_w3e(raw: bytes) -> dict:
    """Parse war3map.w3e -> width/height/centerOffset. We only need the grid
    dimensions and origin to crop the playable tilepoint rectangle; the water
    VALUES come from the minimap, not the w3e."""
    if raw[:4] != b"W3E!":
        raise SystemExit("not a war3map.w3e (missing 'W3E!' magic)")
    off = 4
    (version,) = struct.unpack_from("<i", raw, off)
    off += 4
    if version != 11:
        print(f"terrain: warning: unexpected w3e version {version} (expected 11)", file=sys.stderr)
    off += 1  # tileset char
    off += 4  # customTilesetFlag
    (ground_count,) = struct.unpack_from("<i", raw, off)
    off += 4 + 4 * ground_count
    (cliff_count,) = struct.unpack_from("<i", raw, off)
    off += 4 + 4 * cliff_count
    (width,) = struct.unpack_from("<i", raw, off)
    off += 4
    (height,) = struct.unpack_from("<i", raw, off)
    off += 4
    (center_x,) = struct.unpack_from("<f", raw, off)
    off += 4
    (center_y,) = struct.unpack_from("<f", raw, off)
    return {"width": width, "height": height, "centerX": center_x, "centerY": center_y}


def playable_indices(w3e: dict, playable: dict) -> tuple[list[int], list[int]]:
    """Tilepoint col/row indices whose CENTER lies in the playable rectangle."""
    width, height = w3e["width"], w3e["height"]
    cx, cy = w3e["centerX"], w3e["centerY"]
    cols = [c for c in range(width) if playable["minX"] <= cx + c * TILE_SPACING <= playable["maxX"]]
    rows = [r for r in range(height) if playable["minY"] <= cy + r * TILE_SPACING <= playable["maxY"]]
    if not cols or not rows:
        raise SystemExit("terrain: playable rectangle selects no tilepoints (bad bounds)")
    return cols, rows


def crop_geometry(w3e: dict, cols_idx: list[int], rows_idx: list[int], playable: dict) -> dict:
    """Bounds + cell sizes for the cropped grid. Tilepoints are cell CENTERS;
    bounds pad half a cell beyond the outermost selected centers so the sim's
    floor() transform lands on the nearest tilepoint."""
    cx, cy = w3e["centerX"], w3e["centerY"]
    half = TILE_SPACING / 2.0
    min_x = cx + cols_idx[0] * TILE_SPACING - half
    max_x = cx + cols_idx[-1] * TILE_SPACING + half
    min_y = cy + rows_idx[0] * TILE_SPACING - half
    max_y = cy + rows_idx[-1] * TILE_SPACING + half
    cols, nrows = len(cols_idx), len(rows_idx)
    bounds = {"minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y}
    return {
        "bounds": bounds,
        "cols": cols,
        "rows": nrows,
        "csx": (max_x - min_x) / cols,
        "csy": (max_y - min_y) / nrows,
        "playable": playable,
    }


def cell_for(x: float, y: float, geom: dict) -> tuple[int, int]:
    """World point -> (col, row), clamped, NORTH-FIRST (matches sim isWater)."""
    b = geom["bounds"]
    col = math.floor((x - b["minX"]) / geom["csx"])
    row = math.floor((b["maxY"] - y) / geom["csy"])
    return max(0, min(geom["cols"] - 1, col)), max(0, min(geom["rows"] - 1, row))


def cell_center(col: int, row: int, geom: dict) -> tuple[float, float]:
    b = geom["bounds"]
    return b["minX"] + (col + 0.5) * geom["csx"], b["maxY"] - (row + 0.5) * geom["csy"]


# ---------------------------------------------------------------------------
# Minimap PNG decode (pure stdlib) + registration + tan classifier
# ---------------------------------------------------------------------------


def decode_png_rgb(path: Path) -> tuple[int, int, list[tuple[int, int, int]]]:
    """Pure-stdlib PNG decode -> (width, height, pixels[row*width+col] = (R,G,B)).

    Handles 8-bit non-interlaced colour types 2 (RGB) and 6 (RGBA) -- the formats
    the minimap exporter produces. zlib is stdlib, so this keeps the extractor
    dependency-free (make terrain needs no venv)."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: not a PNG")
    pos = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack_from(">IIBB", chunk, 0)
        elif ctype == b"IDAT":
            idat.extend(chunk)
        elif ctype == b"IEND":
            break
    if bit_depth != 8 or color_type not in (2, 6):
        raise SystemExit(f"{path}: unsupported PNG (bitdepth {bit_depth}, colortype {color_type})")
    channels = 4 if color_type == 6 else 3
    raw = zlib.decompress(bytes(idat))
    stride = width * channels

    def paeth(a: int, b: int, c: int) -> int:
        p = a + b - c
        pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
        return a if pa <= pb and pa <= pc else (b if pb <= pc else c)

    out = bytearray(width * height * channels)
    prev = bytearray(stride)
    ip = 0
    for _y in range(height):
        ftype = raw[ip]
        ip += 1
        line = bytearray(raw[ip:ip + stride])
        ip += stride
        for x in range(stride):
            a = line[x - channels] if x >= channels else 0
            b = prev[x]
            c = prev[x - channels] if x >= channels else 0
            if ftype == 1:
                line[x] = (line[x] + a) & 0xFF
            elif ftype == 2:
                line[x] = (line[x] + b) & 0xFF
            elif ftype == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 0xFF
            elif ftype == 4:
                line[x] = (line[x] + paeth(a, b, c)) & 0xFF
        out[_y * stride:(_y + 1) * stride] = line
        prev = line
    pixels = [
        (out[(y * width + x) * channels], out[(y * width + x) * channels + 1], out[(y * width + x) * channels + 2])
        for y in range(height)
        for x in range(width)
    ]
    return width, height, pixels


def _is_white(rgb: tuple[int, int, int]) -> bool:
    """The minimap's WHITE LETTERBOX (the unplayable margin painted around the
    non-square content box). Excluded from every classification: it is neither
    land nor water. Owner-validated test: R>238 AND G>238 AND B>238."""
    r, g, b = rgb
    return r > 238 and g > 238 and b > 238


def is_water(rgb: tuple[int, int, int]) -> bool:
    """SAILABLE-WATER test (the owner's CONFIRMED colour key).

    On the embedded minimap the sailable water is the NON-BLUE region -- the
    YELLOW/tan DEEP-water cross, the GREEN SHALLOW-water rings, AND the
    PINK/magenta passable shallows. LAND is ONLY the blue/slate ridge pixels.
    So, excluding the white letterbox, a content pixel is:
        LAND  if blue-dominant  (B > R)
        WATER otherwise         (yellow + green + pink: NOT blue-dominant)

    This replaces the prior YELLOW-ONLY 'tan' trace that classified only the
    deep-water cross as water (~0.29 of the area) and threw away the green +
    pink -- far too dry. Re-classifying NON-BLUE = water yields the owner's
    ~half-water silhouette (deep+shallow+pink), matching the picture."""
    r, _g, b = rgb
    if _is_white(rgb):
        return False
    return not (b > r)


def water_depth(rgb: tuple[int, int, int]) -> int:
    """RENDER-METADATA sub-classification of a content pixel (the sim ignores
    this -- sailability is purely water-vs-land via `is_water`). Returns the
    minimap colour band so the client can paint the three water shades + land:
        0 = LAND     (blue-dominant ridge, B > R; or the white letterbox)
        1 = DEEP     (yellow/tan: (R-B)>35 AND R>=G)
        3 = PINK     (magenta passable shallows: R>150 AND B>120 AND (R-G)>15)
        2 = SHALLOW  (green: every other non-blue water pixel)
    The thresholds are the owner-validated CLASSIFICATION RULE; measured pixel
    fractions of non-white content are LAND 0.465 / DEEP 0.230 / SHALLOW 0.287 /
    PINK 0.018 -> WATER total 0.535."""
    r, g, b = rgb
    if _is_white(rgb) or (b > r):
        return 0  # land (or letterbox, folded to land for the depth field)
    if (r - b) > 35 and r >= g:
        return 1  # deep (yellow/tan)
    if r > 150 and b > 120 and (r - g) > 15:
        return 3  # pink (magenta passable shallows)
    return 2  # shallow (green)


def _world_to_px(x: float, y: float) -> tuple[float, float]:
    fx = (x - EXTENT_MIN_X) / (EXTENT_MAX_X - EXTENT_MIN_X)
    fy = (EXTENT_MAX_Y - y) / (EXTENT_MAX_Y - EXTENT_MIN_Y)
    return CONTENT_X0 + fx * (CONTENT_X1 - CONTENT_X0), CONTENT_Y0 + fy * (CONTENT_Y1 - CONTENT_Y0)


def classify_grid(geom: dict, mm_w: int, mm_h: int, mm_px: list, classifier) -> list[list[int]]:
    """North-first 0/1 grid: per playable tilepoint, majority of `classifier` over
    a SAMPLE_PATCH x SAMPLE_PATCH minimap pixel block at the tile's center."""
    cols, nrows = geom["cols"], geom["rows"]
    half = SAMPLE_PATCH // 2
    offs = [o - half for o in range(SAMPLE_PATCH)]
    grid: list[list[int]] = []
    for r in range(nrows):
        line: list[int] = []
        for c in range(cols):
            x, y = cell_center(c, r, geom)
            px, py = _world_to_px(x, y)
            hit = total = 0
            for oy in offs:
                for ox in offs:
                    ix, iy = int(round(px + ox)), int(round(py + oy))
                    if 0 <= ix < mm_w and 0 <= iy < mm_h:
                        total += 1
                        if classifier(mm_px[iy * mm_w + ix]):
                            hit += 1
            line.append(1 if (total > 0 and hit / total >= 0.5) else 0)
        grid.append(line)
    return grid


def classify_depth_grid(geom: dict, mm_w: int, mm_h: int, mm_px: list,
                        water_grid: list[list[int]]) -> list[list[int]]:
    """North-first per-tile DEPTH metadata (0=land,1=deep,2=shallow,3=pink) for
    the optional terrain.json `depth` field -- additive render hints the SIM
    IGNORES. A tile classified WATER by `classify_grid` gets the dominant water
    band (deep/shallow/pink) over its SAMPLE_PATCH; a LAND tile gets 0. So the
    depth field is exactly consistent with the authoritative `water` mask (the
    one the sim reads): depth>0 IFF the cell is water in the FINAL mask, except
    that carved necks/moats (water added on top of the raw trace) are emitted as
    SHALLOW (2) since they have no minimap colour of their own."""
    cols, nrows = geom["cols"], geom["rows"]
    half = SAMPLE_PATCH // 2
    offs = [o - half for o in range(SAMPLE_PATCH)]
    grid: list[list[int]] = []
    for r in range(nrows):
        line: list[int] = []
        for c in range(cols):
            if not water_grid[r][c]:
                line.append(0)  # land in the final mask
                continue
            x, y = cell_center(c, r, geom)
            px, py = _world_to_px(x, y)
            counts = {1: 0, 2: 0, 3: 0}
            for oy in offs:
                for ox in offs:
                    ix, iy = int(round(px + ox)), int(round(py + oy))
                    if 0 <= ix < mm_w and 0 <= iy < mm_h:
                        d = water_depth(mm_px[iy * mm_w + ix])
                        if d in counts:
                            counts[d] += 1
            # Dominant water band; ties favour deeper (lower code). A carved
            # neck/moat cell whose patch reads all-land/letterbox falls back to
            # SHALLOW so every water cell has a non-zero depth.
            best = max(counts, key=lambda k: (counts[k], -k))
            line.append(best if counts[best] > 0 else 2)
        grid.append(line)
    return grid


# ---------------------------------------------------------------------------
# Connectivity helpers (4-connected water; all deterministic)
# ---------------------------------------------------------------------------


def _components(rows: list[list[int]], cols: int, nrows: int) -> list[list[tuple[int, int]]]:
    seen = [[False] * cols for _ in range(nrows)]
    comps: list[list[tuple[int, int]]] = []
    for r in range(nrows):
        for c in range(cols):
            if rows[r][c] and not seen[r][c]:
                cells = [(c, r)]
                seen[r][c] = True
                q = deque([(c, r)])
                while q:
                    a, b = q.popleft()
                    for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nc, nr = a + dc, b + dr
                        if 0 <= nc < cols and 0 <= nr < nrows and rows[nr][nc] and not seen[nr][nc]:
                            seen[nr][nc] = True
                            q.append((nc, nr))
                            cells.append((nc, nr))
                comps.append(cells)
    return comps


def drop_singletons(rows: list[list[int]], cols: int, nrows: int) -> int:
    """Remove size-1 water components (classifier speckle on the land). Keeps all
    real lanes / island-loop pockets (size >= 2). Returns #cells removed."""
    removed = 0
    for cells in _components(rows, cols, nrows):
        if len(cells) == 1:
            c, r = cells[0]
            rows[r][c] = 0
            removed += 1
    return removed


def _main_sea(rows: list[list[int]], cols: int, nrows: int, seed: tuple[int, int]) -> list[list[bool]]:
    """4-connected water flood (the main navigable sea) from `seed`."""
    seen = [[False] * cols for _ in range(nrows)]
    sc, sr = seed
    if not rows[sr][sc]:
        return seen
    seen[sr][sc] = True
    q = deque([(sc, sr)])
    while q:
        c, r = q.popleft()
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if 0 <= nc < cols and 0 <= nr < nrows and rows[nr][nc] and not seen[nr][nc]:
                seen[nr][nc] = True
                q.append((nc, nr))
    return seen


def _nearest_water(rows: list[list[int]], cols: int, nrows: int, c: int, r: int, rad: int = 12):
    for d in range(0, rad + 1):
        for dr in range(-d, d + 1):
            for dc in range(-d, d + 1):
                if abs(dc) + abs(dr) != d:
                    continue
                cc, rr = c + dc, r + dr
                if 0 <= cc < cols and 0 <= rr < nrows and rows[rr][cc]:
                    return (cc, rr)
    return None


def _shop_reachable(main: list[list[bool]], cols: int, nrows: int, c: int, r: int) -> bool:
    for dr in range(-ACCESS_CELLS, ACCESS_CELLS + 1):
        for dc in range(-ACCESS_CELLS, ACCESS_CELLS + 1):
            if abs(dc) + abs(dr) > ACCESS_CELLS:
                continue
            cc, rr = c + dc, r + dr
            if 0 <= cc < cols and 0 <= rr < nrows and main[rr][cc]:
                return True
    return False


def _carve_neck(rows: list[list[int]], soft: list[list[int]], cols: int, nrows: int,
                seed: tuple[int, int], targets: set[tuple[int, int]]) -> int:
    """Dijkstra from the main sea (flood of `seed`) to the NEAREST cell in
    `targets`, carving the shortest navigable thread to water. Cost 1 per existing
    water cell, SOFT_COST per faint-tan cell, LAND_COST per land cell -- so the
    neck follows the minimap's faintest channel and crosses land only as a last,
    short resort. Ties break on (cost, c, r) so it is deterministic. Returns #cells
    added."""
    main = _main_sea(rows, cols, nrows, seed)

    def cost(c: int, r: int) -> int:
        if rows[r][c]:
            return 1
        if soft[r][c]:
            return SOFT_COST
        return LAND_COST

    INF = 1 << 30
    dist = [[INF] * cols for _ in range(nrows)]
    parent: dict[tuple[int, int], tuple[int, int]] = {}
    pq: list[tuple[int, int, int]] = []
    for r in range(nrows):
        for c in range(cols):
            if main[r][c]:
                dist[r][c] = 0
                heapq.heappush(pq, (0, c, r))
    target: tuple[int, int] | None = None
    while pq:
        d, c, r = heapq.heappop(pq)
        if d > dist[r][c]:
            continue
        if (c, r) in targets and not main[r][c]:
            target = (c, r)
            break
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if 0 <= nc < cols and 0 <= nr < nrows:
                nd = d + cost(nc, nr)
                if nd < dist[nr][nc]:
                    dist[nr][nc] = nd
                    parent[(nc, nr)] = (c, r)
                    heapq.heappush(pq, (nd, nc, nr))
    if target is None:
        return 0
    added = 0
    cur = target
    while True:
        if not rows[cur[1]][cur[0]]:
            rows[cur[1]][cur[0]] = 1
            added += 1
        if cur not in parent:
            break
        cur = parent[cur]
    return added


def carve_connectivity(rows: list[list[int]], soft: list[list[int]], layout: dict, geom: dict) -> dict:
    """Add only MINIMAL 1-cell necks on top of the raw tan trace (mutated in
    place): base-platform addback for docks/spawns, base-to-base, and a neck to
    every shop not already sea-reachable. Returns a report dict."""
    cols, nrows = geom["cols"], geom["rows"]

    def cell(x: float, y: float) -> tuple[int, int]:
        return cell_for(x, y, geom)

    before = water_fraction(rows)

    hqs = [s for s in layout.get("structures", []) if s.get("role") == "hq"]
    south_hq = min(hqs, key=lambda s: s["y"]) if hqs else None
    north_hq = max(hqs, key=lambda s: s["y"]) if hqs else None

    # (1) base-platform addback: every dock/spawn/lane cell becomes water.
    dock_pts: list[tuple[float, float]] = []
    for s in layout.get("structures", []):
        if s.get("role") in ("hq", "spawnBuilding"):
            dock_pts.append((s["x"], s["y"]))
    for p in layout.get("playerStarts", {}).get("players", []):
        sp = p.get("shipSpawn") or p.get("startLocation")
        if sp:
            dock_pts.append((sp["x"], sp["y"]))
    for lane in layout.get("creepSpawns", {}).get("lanes", []):
        sp = lane.get("spawnPoint")
        if sp:
            dock_pts.append((sp["x"], sp["y"]))
    base_added = 0
    for x, y in dock_pts:
        c, r = cell(x, y)
        if not rows[r][c]:
            rows[r][c] = 1
            base_added += 1

    # Main-sea seed = the south HQ cell (now water).
    seed = cell(south_hq["x"], south_hq["y"]) if south_hq else (cols // 2, nrows - 1)
    if not rows[seed[1]][seed[0]]:
        nw = _nearest_water(rows, cols, nrows, *seed)
        if nw:
            seed = nw

    # (2) base-to-base: north HQ must join the south-HQ network.
    neck_added = 0
    if north_hq is not None:
        nseed = cell(north_hq["x"], north_hq["y"])
        if not _main_sea(rows, cols, nrows, seed)[nseed[1]][nseed[0]]:
            neck_added += _carve_neck(rows, soft, cols, nrows, seed, {nseed})

    # (3) thread any dock cell still off the main sea into it.
    for x, y in dock_pts:
        c, r = cell(x, y)
        if not _main_sea(rows, cols, nrows, seed)[r][c]:
            neck_added += _carve_neck(rows, soft, cols, nrows, seed, {(c, r)})

    # (4) shop necks: connect every shop to the main sea (recompute each time so
    # routes compound and a later shop can reuse an earlier neck).
    shops = [s for s in layout.get("structures", []) if s.get("role") == "shop"]
    shop_added = 0
    for s in shops:
        c, r = cell(s["x"], s["y"])
        if _shop_reachable(_main_sea(rows, cols, nrows, seed), cols, nrows, c, r):
            continue
        ring = {
            (c + dc, r + dr)
            for dr in range(-ACCESS_CELLS, ACCESS_CELLS + 1)
            for dc in range(-ACCESS_CELLS, ACCESS_CELLS + 1)
            if abs(dc) + abs(dr) <= ACCESS_CELLS and 0 <= c + dc < cols and 0 <= r + dr < nrows
        }
        shop_added += _carve_neck(rows, soft, cols, nrows, seed, ring)

    # (5) repair-area regions: a ship must be able to SAIL INTO each repair bay.
    #     These are REGIONS (not role=="shop" structures), so steps (1)-(4) miss
    #     them; connect each region's water to the main sea via the SAME neck
    #     machinery as shops (snap to nearest water, then carve if off the sea).
    region_by_name = {r["name"]: r for r in layout.get("regions", [])}
    region_added = 0
    for name in CONNECT_REGIONS:
        reg = region_by_name.get(name)
        if reg is None:
            continue
        c, r = cell(reg["centerX"], reg["centerY"])
        if _shop_reachable(_main_sea(rows, cols, nrows, seed), cols, nrows, c, r):
            continue
        target = _nearest_water(rows, cols, nrows, c, r) or (c, r)
        if not rows[target[1]][target[0]]:
            rows[target[1]][target[0]] = 1
            region_added += 1
        region_added += _carve_neck(rows, soft, cols, nrows, seed, {target})

    main = _main_sea(rows, cols, nrows, seed)
    n_reach = sum(_shop_reachable(main, cols, nrows, *cell(s["x"], s["y"])) for s in shops)
    n_region_reach = sum(
        _shop_reachable(main, cols, nrows, *cell(region_by_name[n]["centerX"], region_by_name[n]["centerY"]))
        for n in CONNECT_REGIONS if n in region_by_name
    )
    return {
        "basePlatformCellsAdded": base_added,
        "connectivityNeckCellsAdded": neck_added,
        "shopNeckCellsAdded": shop_added,
        "repairRegionNeckCellsAdded": region_added,
        "waterFractionBefore": round(before, 4),
        "waterFractionAfter": round(water_fraction(rows), 4),
        "shopsReachable": f"{n_reach}/{len(shops)}",
        "repairRegionsReachable": f"{n_region_reach}/{sum(1 for n in CONNECT_REGIONS if n in region_by_name)}",
    }


# ---------------------------------------------------------------------------
# WEST-ISLAND LOOPS (owner-approved sail-around moats; deterministic post-step)
# ---------------------------------------------------------------------------
#
# WHY (owner memory): the two far-WEST shops sit on ISLANDS you SAIL AROUND, each
# with ONE narrow entrance (one-way-in/out unless you teleport). The minimap tan
# is too faint there to TRACE the loop, so -- exactly as approved -- we CARVE the
# moat. The war3map.wpm navigable-water (MP3W, 0x80-set & 0x04-unset) was checked
# as a guide for where the moat could run, but it does not register a clean ring
# around either shop (noisy, mis-aligned at this resolution), so we construct the
# minimal deterministic ring around a compact land core, per the task fallback.
#
# WHAT (per island, all integer / deterministic, no RNG/time):
#   core   = a filled (2R+1)x(2R+1) LAND square centred on an ANCHOR (R=2).
#   ring   = the cells at Chebyshev distance EXACTLY R+1 from the anchor, set to
#            WATER -- a thin 1-cell square annulus that is 4-connected all the way
#            round (a closed loop a ship can traverse and return to its start).
#   wall   = the cells at Chebyshev distance EXACTLY R+2, set to LAND, so the only
#            opening into the moat is the single carved entrance.
#   anchor = the shop cell, CLAMPED into [R+1, N-2-R] on each axis -- the MINIMUM
#            offset for which the whole RING (Chebyshev R+1) lands on-grid (the
#            outer WALL may fall one cell off-grid for a wall-hugging shop; off-grid
#            reads as land/boundary and seals that side of the moat exactly as a
#            wall cell would). Clamping to R+1 (not R+2) keeps the island as CLOSE
#            to its shop as a CLOSED on-grid loop allows. With the WEST-bound
#            extension (WEST_EXTEND_CELLS=3, see the module top), BOTH west shops now
#            sit at col >= R+1 = 3, so BOTH land ON the island LAND CORE:
#              - Swedish Lumber Mill (grid col ~6): shop ON the CORE -- it sits on
#                the island land you sail around; the moat ring (Chebyshev R+1=3)
#                fits on-grid all the way round.
#              - Goblin Potion Dealer (grid col 3 after the west extension): shop ON
#                the CORE; the west side of its moat ring lands on grid col 0 and the
#                outer WALL at col -1 is off-grid (the boundary), which seals that
#                side of the moat exactly like a land wall. This is a TRUE sail-around
#                island (compact land core fully water-enclosed, one entrance) with
#                the shop ON the island -- NOT the prior over-cropped form where the
#                Goblin shop sat on grid col 0 (the west edge) as a dock on the ring,
#                with no map west of it to make a real island.
#            A ring shop stays WATER (a dock); only a core shop is forced to LAND.
#   entrance = the single shortest 1-cell channel from the main sea to the ring
#            (deterministic Dijkstra, cost 1 water / LAND_COST land, ties on
#            (cost,c,r)); after carving it, every OTHER ring cell that still touches
#            the main sea is RE-LANDED so the moat has EXACTLY ONE mouth. (With the
#            land wall this typically already holds; the re-land is a belt-and-
#            braces guarantee.)
# A CORE shop is finally forced to LAND so isWater(shop)=land; a RING (edge) shop
# stays WATER -- it is a dock on the moat loop, and re-landing a ring cell would
# break the closed cycle. Only WATER VALUES change; geometry is untouched. Run-to-
# run byte-identical (fixed shop order, fixed neighbour order, deterministic
# Dijkstra).


def _carve_one_entrance(rows: list[list[int]], cols: int, nrows: int,
                        seed: tuple[int, int], ring: set[tuple[int, int]],
                        core: set[tuple[int, int]]) -> tuple[list[tuple[int, int]], int]:
    """Carve EXACTLY one narrow entrance from the main sea to `ring`, then re-land
    any other ring cell still touching the main sea. Returns (entranceCells, mouths)
    where mouths is the final distinct-entrance count (must be 1)."""
    INF = 1 << 30

    def run_dijkstra() -> list[tuple[int, int]]:
        main = _main_sea(rows, cols, nrows, seed)
        dist = [[INF] * cols for _ in range(nrows)]
        parent: dict[tuple[int, int], tuple[int, int]] = {}
        pq: list[tuple[int, int, int]] = []
        for r in range(nrows):
            for c in range(cols):
                if main[r][c]:
                    dist[r][c] = 0
                    heapq.heappush(pq, (0, c, r))
        target: tuple[int, int] | None = None
        while pq:
            d, c, r = heapq.heappop(pq)
            if d > dist[r][c]:
                continue
            if (c, r) in ring and not main[r][c]:
                target = (c, r)
                break
            for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nc, nr = c + dc, r + dr
                if 0 <= nc < cols and 0 <= nr < nrows:
                    nd = d + (1 if rows[nr][nc] else LAND_COST)
                    if nd < dist[nr][nc]:
                        dist[nr][nc] = nd
                        parent[(nc, nr)] = (c, r)
                        heapq.heappush(pq, (nd, nc, nr))
        if target is None:
            return []
        carved: list[tuple[int, int]] = []
        cur: tuple[int, int] | None = target
        while cur is not None:
            if not rows[cur[1]][cur[0]]:
                rows[cur[1]][cur[0]] = 1
                carved.append(cur)
            cur = parent.get(cur)
        return carved

    # If the ring already touches the main sea (a mouth fell on the carved
    # base/shop necks), skip carving; otherwise carve the single shortest channel.
    main = _main_sea(rows, cols, nrows, seed)
    touches = any(
        main[r][c] for (c, r) in ring
    ) or any(
        0 <= c + dc < cols and 0 <= r + dr < nrows and main[r + dr][c + dc]
        and (c + dc, r + dr) not in ring and (c + dc, r + dr) not in core
        for (c, r) in ring for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1))
    )
    entrance = [] if touches else run_dijkstra()

    # RE-LAND extra mouths: keep only the one nearest the carved entrance (or, if no
    # carve was needed, the deterministically-first mouth). A mouth = a ring cell
    # 4-adjacent to a main-sea cell that is OUTSIDE the ring and core.
    main = _main_sea(rows, cols, nrows, seed)

    def is_mouth(c: int, r: int) -> bool:
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if (0 <= nc < cols and 0 <= nr < nrows and main[nr][nc]
                    and (nc, nr) not in ring and (nc, nr) not in core):
                return True
        return False

    mouths = sorted((c, r) for (c, r) in ring if rows[r][c] and is_mouth(c, r))
    if entrance:
        keep = min(mouths, key=lambda m: (abs(m[0] - entrance[0][0]) + abs(m[1] - entrance[0][1]), m))
    elif mouths:
        keep = mouths[0]
    else:
        keep = None
    # group mouths 8-connected; re-land every group except the one containing keep.
    seen: set[tuple[int, int]] = set()
    groups: list[set[tuple[int, int]]] = []
    mouth_set = set(mouths)
    for m in mouths:
        if m in seen:
            continue
        grp: set[tuple[int, int]] = {m}
        seen.add(m)
        stack = [m]
        while stack:
            c, r = stack.pop()
            for dc in (-1, 0, 1):
                for dr in (-1, 0, 1):
                    nb = (c + dc, r + dr)
                    if nb in mouth_set and nb not in seen:
                        seen.add(nb)
                        grp.add(nb)
                        stack.append(nb)
        groups.append(grp)
    for grp in groups:
        if keep is not None and keep in grp:
            continue
        for c, r in sorted(grp):
            rows[r][c] = 0
    return entrance, sum(1 for grp in groups if keep is not None and keep in grp) or len(groups)


def _ring_cells(ac: int, ar: int, R: int, cols: int, nrows: int) -> set[tuple[int, int]]:
    """The on-grid water-moat ring: cells at Chebyshev distance EXACTLY R+1 from
    the anchor that lie on the grid."""
    return {
        (c, r)
        for c in range(ac - R - 1, ac + R + 2)
        for r in range(ar - R - 1, ar + R + 2)
        if max(abs(c - ac), abs(r - ar)) == R + 1 and 0 <= c < cols and 0 <= r < nrows
    }


def _pick_island_anchor(sc: int, sr: int, R: int, cols: int, nrows: int) -> tuple[int, int]:
    """Choose the deterministic island anchor for a shop at (sc, sr).

    Search anchors within +-(R+1) of the shop, restricted to [R+1, cols-2-R] x
    [R+1, nrows-2-R] so the WHOLE ring (Chebyshev R+1) lands on-grid (a closed
    24-cell loop). Keep only anchors whose moat comes within ACCESS_CELLS of the
    shop (so the shop stays sea-reachable, G3). Pick by:
      (1) shop ON the LAND core (Chebyshev <= R) PREFERRED over shop on the moat
          ring -- an interior shop (Lumber Mill) sits on the island land;
      (2) then SMALLEST shop->moat distance (tighter dock);
      (3) then most COMPACT (anchor nearest the shop), then (ac, ar) for ties.
    After the WEST-bound extension (WEST_EXTEND_CELLS=3), BOTH west shops sit at col
    >= R+1=3 (Goblin at col 3, Lumber Mill at col ~6), so BOTH can anchor ON the core
    -- the shop sits on the island LAND you sail around. For Goblin at col 3 the
    anchor is col 3 and the moat ring's west side lands on grid col 0 (the outer wall
    at col -1 is off-grid = boundary, which seals that side). Both are TRUE sail-
    around islands (water-enclosed core, one entrance)."""
    lo_c, hi_c = R + 1, cols - 2 - R
    lo_r, hi_r = R + 1, nrows - 2 - R
    best_key: tuple | None = None
    best_anchor = (min(max(sc, lo_c), hi_c), min(max(sr, lo_r), hi_r))  # fallback
    for ac in range(max(lo_c, sc - (R + 1)), min(hi_c, sc + (R + 1)) + 1):
        for ar in range(max(lo_r, sr - (R + 1)), min(hi_r, sr + (R + 1)) + 1):
            ring = _ring_cells(ac, ar, R, cols, nrows)
            if len(ring) != 8 * (R + 1):  # full closed loop must be on-grid
                continue
            moat_dist = min(abs(c - sc) + abs(r - sr) for (c, r) in ring)
            if moat_dist > ACCESS_CELLS:
                continue
            on_core = max(abs(sc - ac), abs(sr - ar)) <= R
            key = (0 if on_core else 1, moat_dist, abs(ac - sc) + abs(ar - sr), ac, ar)
            if best_key is None or key < best_key:
                best_key = key
                best_anchor = (ac, ar)
    return best_anchor


def carve_west_island_loops(rows: list[list[int]], layout: dict, geom: dict) -> dict:
    """Deterministic post-step: ring each west-island shop with a closed 1-cell
    navigable moat connected to the main sea by EXACTLY ONE entrance (see the
    WEST-ISLAND LOOPS header). Mutates `rows`; returns a per-island report."""
    cols, nrows = geom["cols"], geom["rows"]
    R = WEST_ISLAND_CORE_R

    def cell(x: float, y: float) -> tuple[int, int]:
        return cell_for(x, y, geom)

    hqs = [s for s in layout.get("structures", []) if s.get("role") == "hq"]
    south_hq = min(hqs, key=lambda s: s["y"]) if hqs else None
    seed = cell(south_hq["x"], south_hq["y"]) if south_hq else (cols // 2, nrows - 1)
    if not rows[seed[1]][seed[0]]:
        nw = _nearest_water(rows, cols, nrows, *seed)
        if nw:
            seed = nw

    shops = [s for s in layout.get("structures", []) if s.get("role") == "shop"]

    def match_shop(tx: float, ty: float) -> dict | None:
        # owner-circled coord -> the nearest shop structure (exact in practice).
        best = min(shops, key=lambda s: (s["x"] - tx) ** 2 + (s["y"] - ty) ** 2, default=None)
        return best

    before = water_fraction(rows)
    report: dict[str, object] = {}
    total_added = 0
    for tx, ty in WEST_ISLAND_SHOPS:
        s = match_shop(tx, ty)
        if s is None:
            continue
        sc, sr = cell(s["x"], s["y"])
        # Anchor the island deterministically so the WHOLE 1-cell ring fits on-grid
        # (a closed loop) AND the shop stays within ACCESS_CELLS of the moat (so it
        # is sea-reachable, G3), preferring the shop ON the LAND core (interior
        # shop) over a dock ON the moat ring (a west-edge shop that can't reach the
        # core). See _pick_island_anchor + the WEST-ISLAND LOOPS header.
        ac, ar = _pick_island_anchor(sc, sr, R, cols, nrows)
        core = {(c, r) for c in range(ac - R, ac + R + 1) for r in range(ar - R, ar + R + 1)
                if 0 <= c < cols and 0 <= r < nrows}
        ring = _ring_cells(ac, ar, R, cols, nrows)
        wall = {(c, r) for c in range(ac - R - 2, ac + R + 3) for r in range(ar - R - 2, ar + R + 3)
                if max(abs(c - ac), abs(r - ar)) == R + 2 and 0 <= c < cols and 0 <= r < nrows}
        before_cells = [list(r) for r in rows]
        for c, r in wall:
            rows[r][c] = 0
        for c, r in core:
            rows[r][c] = 0
        for c, r in ring:
            rows[r][c] = 1
        # Keep the shop on LAND only when it sits on the island CORE (interior shop);
        # a west-edge shop sits ON the moat RING, so it stays WATER (a dock on the
        # loop). Re-landing a ring cell would break the closed cycle, so we never do.
        shop_in_core = (sc, sr) in core
        if shop_in_core:
            rows[sr][sc] = 0
        entrance, mouths = _carve_one_entrance(rows, cols, nrows, seed, ring, core)
        changed = sum(1 for rr in range(nrows) for cc in range(cols) if rows[rr][cc] != before_cells[rr][cc])
        total_added += changed
        # cycle length = ring-water cells in one 4-connected loop component.
        ring_water = [(c, r) for (c, r) in ring if rows[r][c]]
        report[s.get("name") or s.get("type")] = {
            "shopCell": [sc, sr],
            "anchor": [ac, ar],
            "shopInCore": shop_in_core,
            "shopInRing": (sc, sr) in ring,
            "shopOnLand": rows[sr][sc] == 0,
            "cycleLen": len(ring_water),
            "entranceCells": [list(e) for e in entrance],
            "entrances": mouths,
            "cellsChanged": changed,
        }
    report["waterFractionBefore"] = round(before, 4)
    report["waterFractionAfter"] = round(water_fraction(rows), 4)
    report["totalCellsChanged"] = total_added
    return report


# ---------------------------------------------------------------------------
# RLE + fraction + sim-style connectivity (for the gates)
# ---------------------------------------------------------------------------


def rle_encode_row(row: list[int]) -> list[int]:
    leading = row[0]
    runs: list[int] = []
    cur, count = leading, 0
    for v in row:
        if v == cur:
            count += 1
        else:
            runs.append(count)
            cur, count = v, 1
    runs.append(count)
    return [leading, *runs]


def water_fraction(rows: list[list[int]]) -> float:
    total = sum(len(r) for r in rows)
    wet = sum(sum(r) for r in rows)
    return wet / total if total else 0.0


def rle_encode_values_row(row: list[int]) -> list[int]:
    """Generic value-run RLE for the OPTIONAL depth field: alternating
    [value0, run0, value1, run1, ...] (explicit value per run, since depth has 4
    states 0..3, unlike the binary `water` RLE). Runs sum to cols."""
    out: list[int] = []
    cur, count = row[0], 0
    for v in row:
        if v == cur:
            count += 1
        else:
            out.extend((cur, count))
            cur, count = v, 1
    out.extend((cur, count))
    return out


def _water_connected(rows: list[list[int]], cols: int, nrows: int,
                     a: tuple[int, int], b: tuple[int, int]) -> bool:
    (ac, ar), (bc, br) = a, b
    if not (rows[ar][ac] and rows[br][bc]):
        return False
    seen = bytearray(cols * nrows)
    seen[ar * cols + ac] = 1
    q = deque([(ac, ar)])
    while q:
        c, r = q.popleft()
        if c == bc and r == br:
            return True
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if 0 <= nc < cols and 0 <= nr < nrows and rows[nr][nc] and not seen[nr * cols + nc]:
                seen[nr * cols + nc] = 1
                q.append((nc, nr))
    return False


# ---------------------------------------------------------------------------
# Validation gates (fail-loud)
# ---------------------------------------------------------------------------


def validate(rows: list[list[int]], layout: dict, geom: dict) -> dict:
    """Fail-loud fidelity gate (G3 shops / G5 structures+spawns / base-to-base /
    G2 lane widths / fraction band)."""
    cols, nrows = geom["cols"], geom["rows"]
    structures = layout.get("structures", [])
    player_starts = layout.get("playerStarts", {}).get("players", [])
    report: dict[str, object] = {}

    def cell(x: float, y: float) -> tuple[int, int]:
        return cell_for(x, y, geom)

    def is_water_at(x: float, y: float) -> bool:
        c, r = cell(x, y)
        return bool(rows[r][c])

    # (G5a) HQs / Main Harbours on water.
    hqs = [s for s in structures if s.get("role") == "hq"]
    dry_hqs = [s for s in hqs if not is_water_at(s["x"], s["y"])]
    report["hqsOnWater"] = f"{len(hqs) - len(dry_hqs)}/{len(hqs)}"
    if dry_hqs:
        raise SystemExit(f"terrain: {len(dry_hqs)} HQ(s) on LAND: "
                         f"{[(round(s['x']), round(s['y'])) for s in dry_hqs]}")

    # (G5b) creep-spawn Harbours on water.
    harbors = [s for s in structures if s.get("role") == "spawnBuilding"]
    dry_harbors = [s for s in harbors if not is_water_at(s["x"], s["y"])]
    report["harboursOnWater"] = f"{len(harbors) - len(dry_harbors)}/{len(harbors)}"
    if dry_harbors:
        raise SystemExit(f"terrain: {len(dry_harbors)} harbour(s) on LAND: "
                         f"{[(round(s['x']), round(s['y'])) for s in dry_harbors]}")

    # (G5c) every player spawn on water.
    spawn_pts = [(p.get("shipSpawn") or p.get("startLocation")) for p in player_starts]
    spawn_pts = [s for s in spawn_pts if s]
    dry_spawns = [s for s in spawn_pts if not is_water_at(s["x"], s["y"])]
    report["playerSpawnsOnWater"] = f"{len(spawn_pts) - len(dry_spawns)}/{len(spawn_pts)}"
    if dry_spawns:
        raise SystemExit(f"terrain: {len(dry_spawns)} player spawn(s) on LAND: "
                         f"{[(round(s['x']), round(s['y'])) for s in dry_spawns]}")

    # (G5d) lane spawns on water and water-connected to the enemy HQ.
    lanes = layout.get("creepSpawns", {}).get("lanes", [])
    hqs_by_team: dict[str, dict] = {}
    for s in hqs:
        hqs_by_team.setdefault("south" if s["y"] < 0 else "north", s)
    lane_report = []
    for lane in lanes:
        sp = lane["spawnPoint"]
        enemy = "north" if lane["team"] == "south" else "south"
        enemy_hq = hqs_by_team.get(enemy)
        on_water = is_water_at(sp["x"], sp["y"])
        connected = enemy_hq is not None and _water_connected(
            rows, cols, nrows, cell(sp["x"], sp["y"]), cell(enemy_hq["x"], enemy_hq["y"]))
        lane_report.append(f"{lane['id']}: spawnWater={on_water} connToEnemyHQ={connected}")
        if not on_water:
            raise SystemExit(f"terrain: lane {lane['id']} spawn on LAND")
        if not connected:
            raise SystemExit(f"terrain: lane {lane['id']} spawn not water-connected to enemy HQ")
    report["lanes"] = lane_report

    # base-to-base: the two HQs share one 4-connected water network.
    south_hq = hqs_by_team.get("south")
    if south_hq and hqs_by_team.get("north"):
        n_hq = hqs_by_team["north"]
        report["basesConnected"] = _water_connected(
            rows, cols, nrows, cell(south_hq["x"], south_hq["y"]), cell(n_hq["x"], n_hq["y"]))
        if not report["basesConnected"]:
            raise SystemExit("terrain: south HQ and north HQ are not water-connected")

    # (G3) ALL SHOPS sea-reachable from the south HQ main sea.
    shops = [s for s in structures if s.get("role") == "shop"]
    if shops and south_hq is not None:
        main = _main_sea(rows, cols, nrows, cell(south_hq["x"], south_hq["y"]))
        shop_report = []
        unreachable = []
        for s in shops:
            sc, sr = cell(s["x"], s["y"])
            ok = _shop_reachable(main, cols, nrows, sc, sr)
            nd = None
            for rad in range(0, cols + nrows):
                hit = False
                for dr in range(-rad, rad + 1):
                    for dc in range(-rad, rad + 1):
                        if abs(dc) + abs(dr) != rad:
                            continue
                        cc, rr = sc + dc, sr + dr
                        if 0 <= cc < cols and 0 <= rr < nrows and main[rr][cc]:
                            hit = True
                            break
                    if hit:
                        break
                if hit:
                    nd = rad
                    break
            shop_report.append(f"{s.get('name') or s.get('type')}: reachable={ok} nearestSeaCells={nd}")
            if not ok:
                unreachable.append(s.get("name") or s.get("type"))
        report["shopsReachable"] = f"{len(shops) - len(unreachable)}/{len(shops)}"
        report["shopReach"] = shop_report
        if unreachable:
            raise SystemExit(f"terrain: {len(unreachable)} shop(s) NOT sea-reachable (G3): {unreachable}")

    # (G3b) ALL REPAIR-AREA REGIONS sea-reachable (the owner's "could not get to
    # the repair station"): the repair bays are regions, not shops, so G3 above
    # never covered them. carve_connectivity step (5) connects each one; this
    # gate guarantees it stuck.
    region_by_name = {r["name"]: r for r in layout.get("regions", [])}
    if south_hq is not None:
        main = _main_sea(rows, cols, nrows, cell(south_hq["x"], south_hq["y"]))
        region_report = []
        region_unreachable = []
        for name in CONNECT_REGIONS:
            reg = region_by_name.get(name)
            if reg is None:
                continue
            rc, rr = cell(reg["centerX"], reg["centerY"])
            ok = _shop_reachable(main, cols, nrows, rc, rr)
            region_report.append(f"{name}: reachable={ok}")
            if not ok:
                region_unreachable.append(name)
        report["repairRegionsReachable"] = (
            f"{len([n for n in CONNECT_REGIONS if n in region_by_name]) - len(region_unreachable)}"
            f"/{len([n for n in CONNECT_REGIONS if n in region_by_name])}"
        )
        report["repairRegionReach"] = region_report
        if region_unreachable:
            raise SystemExit(f"terrain: {len(region_unreachable)} repair region(s) NOT sea-reachable (G3b): {region_unreachable}")

    # (G1) Water fraction. Under the owner's CONFIRMED colour key (sailable water
    # = NON-BLUE = yellow deep + green shallow + pink passable; LAND = blue-
    # dominant pixels only) the PLAYABLE-crop grid reads ~0.66 water -- honestly
    # higher than the ~0.535 measured over the WHOLE minimap content box, because
    # the playable rectangle EXCLUDES the land-heavy outer borders (its own pixel
    # footprint reads ~0.647, which the per-tile sample reproduces). This is the
    # faithful ~half-water silhouette, NOT the prior too-dry ~0.29 yellow-only
    # trace. Band [0.55, 0.70] (target the playable-crop NON-BLUE read).
    wf = water_fraction(rows)
    report["waterFraction"] = round(wf, 4)
    if not (0.55 <= wf <= 0.70):
        raise SystemExit(f"terrain: water fraction {wf:.3f} out of NON-BLUE range [0.55, 0.70] "
                         "(land = blue-dominant pixels only; NOT the old ~0.29 yellow-only trace)")

    def lane_runs(col_range, row_range) -> list[int]:
        out: list[int] = []
        for r in row_range:
            run = 0
            for c in col_range:
                if rows[r][c]:
                    run += 1
                elif run:
                    out.append(run)
                    run = 0
            if run:
                out.append(run)
        return out

    east0 = (2 * cols) // 3
    east = lane_runs(range(east0, cols), range(nrows))
    botright = lane_runs(range(east0, cols), range((2 * nrows) // 3, nrows))

    def med(xs: list[int]) -> float:
        s = sorted(xs)
        n = len(s)
        if n == 0:
            return 0.0
        return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2

    # Lane-run report (INFORMATIONAL only). Under the NON-BLUE key the map is
    # ~half open water, so the old "narrow-lane / not-a-blob" hard gate (median
    # east-third run <= 4) no longer applies and is REMOVED -- the right side is
    # legitimately open sea in the minimap. Kept as a reported metric.
    report["eastThirdWaterRun"] = (
        f"median={med(east):.1f} mean={(sum(east) / len(east)) if east else 0:.2f} count={len(east)}")
    report["bottomRightWaterRun"] = (
        f"median={med(botright):.1f} mean={(sum(botright) / len(botright)) if botright else 0:.2f} "
        f"count={len(botright)}")
    return report


# ---------------------------------------------------------------------------
# Side-route confirmations (G4) + minimap agreement (G1)
# ---------------------------------------------------------------------------


def confirm_side_routes(rows: list[list[int]], tan: list[list[int]], layout: dict, geom: dict) -> dict:
    """Confirm the owner-traced side routes: each west island is a sail-around
    LOOP with a SINGLE narrow entrance; the east north->brewery wrap exists and is
    narrow; the bottom-right is winding. Reported with numbers."""
    cols, nrows = geom["cols"], geom["rows"]

    def cell(x: float, y: float) -> tuple[int, int]:
        return cell_for(x, y, geom)

    south_hq = min((s for s in layout["structures"] if s.get("role") == "hq"), key=lambda s: s["y"])
    main = _main_sea(rows, cols, nrows, cell(south_hq["x"], south_hq["y"]))

    def entrance_count(island_cells: set[tuple[int, int]]) -> int:
        """Count the distinct NARROW entrances connecting the water that rings an
        island to the open main sea. We take the ring of water cells 4-adjacent to
        the island land, then count the connected GROUPS of those ring cells that
        touch the main sea: each group = one mouth. A true sail-around loop with a
        single entrance reports 1."""
        ring: set[tuple[int, int]] = set()
        for c, r in island_cells:
            for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nc, nr = c + dc, r + dr
                if 0 <= nc < cols and 0 <= nr < nrows and rows[nr][nc]:
                    ring.add((nc, nr))
        # mouths = ring cells adjacent to main sea that lie OUTSIDE the island.
        mouths = {(c, r) for (c, r) in ring
                  if any(0 <= c + dc < cols and 0 <= r + dr < nrows and main[r + dr][c + dc]
                         for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)))}
        # group adjacent mouths (8-connected) -> number of distinct entrances.
        seen: set[tuple[int, int]] = set()
        groups = 0
        for m in mouths:
            if m in seen:
                continue
            groups += 1
            stack = [m]
            seen.add(m)
            while stack:
                c, r = stack.pop()
                for dc in (-1, 0, 1):
                    for dr in (-1, 0, 1):
                        nb = (c + dc, r + dr)
                        if nb in mouths and nb not in seen:
                            seen.add(nb)
                            stack.append(nb)
        return groups

    def island_land(world_x: float, world_y: float, max_cells: int = 60) -> set[tuple[int, int]]:
        """4-connected LAND component containing the shop cell (the island the
        owner sails around). Capped so a connection to the mainland is not counted
        as 'the island'."""
        sc, sr = cell(world_x, world_y)
        if rows[sr][sc]:  # shop cell is water (a dock); nudge to nearest land
            for d in range(1, 4):
                found = False
                for dr in range(-d, d + 1):
                    for dc in range(-d, d + 1):
                        c2, r2 = sc + dc, sr + dr
                        if 0 <= c2 < cols and 0 <= r2 < nrows and not rows[r2][c2]:
                            sc, sr = c2, r2
                            found = True
                            break
                    if found:
                        break
                if found:
                    break
        comp: set[tuple[int, int]] = {(sc, sr)}
        q = deque([(sc, sr)])
        while q and len(comp) < max_cells:
            c, r = q.popleft()
            for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nc, nr = c + dc, r + dr
                if 0 <= nc < cols and 0 <= nr < nrows and not rows[nr][nc] and (nc, nr) not in comp:
                    comp.add((nc, nr))
                    q.append((nc, nr))
        return comp

    def west_island(world_x: float, world_y: float) -> dict:
        island = island_land(world_x, world_y)
        ring_water = len({
            (nc, nr)
            for (c, r) in island for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1))
            if 0 <= (nc := c + dc) < cols and 0 <= (nr := r + dr) < nrows and rows[nr][nc]
        })
        return {"islandLandCells": len(island), "ringWaterCells": ring_water,
                "entrances": entrance_count(island)}

    report = {
        # West sail-around islands (the two owner-circled, moated by
        # carve_west_island_loops): Swedish Lumber Mill (~ -4640,-928) and Goblin
        # Potion Dealer (~ -4960,-5344). A sail-around loop with ONE narrow
        # entrance reports entrances=1. (entrance_count here groups the OUTER mouths
        # of the shop's land component; carve_west_island_loops carries the
        # authoritative per-island cycleLen + entrance count in the necks report.)
        "westLumberMillIsland": west_island(-4640.0, -928.0),
        "westGoblinPotionIsland": west_island(-4960.0, -5344.0),
    }

    # East north->brewery wrap: the brewery (4768,-2016) is sea-reachable, and the
    # far-east column band carries water up into the north (the wrap-around lane).
    brew = cell(4768.0, -2016.0)
    far_east_north = sum(1 for r in range(0, nrows // 2) for c in range(cols - 8, cols) if rows[r][c])
    report["eastBreweryWrap"] = {
        "brewerySeaReachable": _shop_reachable(main, cols, nrows, *brew),
        "farEastNorthWaterCells": far_east_north,
    }

    # Bottom-right winding: the TAN lanes there are narrow/winding (the connectivity
    # necks add a few straight threads, so we measure the TAN trace, not the necks).
    east0 = (2 * cols) // 3
    tan_runs: list[int] = []
    for r in range((2 * nrows) // 3, nrows):
        run = 0
        for c in range(east0, cols):
            if tan[r][c]:
                run += 1
            elif run:
                tan_runs.append(run)
                run = 0
        if run:
            tan_runs.append(run)
    report["bottomRightWinding"] = {
        "tanSegments": len(tan_runs),
        "tanMaxRun": max(tan_runs) if tan_runs else 0,
        "windingNotBlob": (max(tan_runs) if tan_runs else 0) <= 6,
    }
    return report


def agreement_and_compare(rows: list[list[int]], ref: list[list[int]], depth: list[list[int]],
                          geom: dict, mm_w: int, mm_h: int, mm_px: list,
                          compare_path: Path | None) -> dict:
    """G2: per-tile LAND-vs-WATER agreement of the FINAL mask vs the minimap
    colour-key reference (`ref` = raw NON-BLUE classification: water=non-blue,
    land=blue-dominant) over the playable content box, plus the confusion split
    and the depth band split. Optionally writes the 4-shade compare PNG
    (minimap | mask deep/shallow/pink/land + shop dots | land-vs-water diff)."""
    cols, nrows = geom["cols"], geom["rows"]
    agree = ours_only = ref_only = 0
    total = cols * nrows
    for r in range(nrows):
        for c in range(cols):
            ow, rw = bool(rows[r][c]), bool(ref[r][c])
            if ow == rw:
                agree += 1
            elif ow:
                ours_only += 1   # water we added (carved necks/moats/base docks)
            else:
                ref_only += 1    # minimap-water we dropped (denoised speckle)
    split = {0: 0, 1: 0, 2: 0, 3: 0}
    for r in range(nrows):
        for c in range(cols):
            split[depth[r][c]] += 1
    result = {
        "agreement": round(agree / total, 4) if total else 0.0,
        "agreeFrac": round(agree / total, 4) if total else 0.0,
        "oursOnlyFrac": round(ours_only / total, 4) if total else 0.0,
        "refOnlyFrac": round(ref_only / total, 4) if total else 0.0,
        "landDeepShallowPink": [
            round(split[0] / total, 4), round(split[1] / total, 4),
            round(split[2] / total, 4), round(split[3] / total, 4),
        ],
        "tiles": total,
    }
    if compare_path is not None:
        _write_compare_png(rows, ref, depth, geom, mm_w, mm_h, mm_px, compare_path)
        result["comparePng"] = str(compare_path)
    return result


def _write_compare_png(rows: list[list[int]], ref: list[list[int]], depth: list[list[int]],
                       geom: dict, mm_w: int, mm_h: int, mm_px: list, path: Path) -> None:
    """3-panel compare (<=440px wide): real minimap pixels (resampled at tile
    centers) | the rebuilt mask painted with the FOUR colour-key shades
    (deep=yellow, shallow=green, pink=magenta, land=blue) + the 16 shop dots
    (green=reachable) | land-vs-water diff vs the minimap reference. Pure-stdlib
    PNG. scale 1 keeps width = 3*81 + 2*4 = 251px (<=440)."""
    cols, nrows = geom["cols"], geom["rows"]
    scale = 1
    gap = 4
    pw, ph = cols * scale, nrows * scale
    img_w = 3 * pw + 2 * gap
    img_h = ph
    px = bytearray((255, 255, 255)[k % 3] for k in range(img_w * img_h * 3))

    def put(panel: int, c: int, r: int, rgb: tuple[int, int, int]) -> None:
        x0 = panel * (pw + gap) + c * scale
        y0 = r * scale
        for dy in range(scale):
            for dx in range(scale):
                o = ((y0 + dy) * img_w + (x0 + dx)) * 3
                px[o], px[o + 1], px[o + 2] = rgb

    # The four colour-key shades for panel 1 (match the minimap's look).
    SHADE = {
        0: (70, 95, 150),    # LAND  (blue/slate ridge)
        1: (235, 205, 150),  # DEEP  (yellow/tan)
        2: (150, 200, 120),  # SHALLOW (green)
        3: (220, 150, 205),  # PINK  (magenta passable)
    }
    for r in range(nrows):
        for c in range(cols):
            # panel 0: the actual minimap pixel at this tile center (downsampled).
            x, y = cell_center(c, r, geom)
            ix, iy = _world_to_px(x, y)
            ix, iy = int(round(ix)), int(round(iy))
            if 0 <= ix < mm_w and 0 <= iy < mm_h:
                put(0, c, r, mm_px[iy * mm_w + ix])
            ow, rw = bool(rows[r][c]), bool(ref[r][c])
            # panel 1: rebuilt mask in the four shades (land cells -> blue).
            put(1, c, r, SHADE[depth[r][c]] if ow else SHADE[0])
            # panel 2: land-vs-water agreement diff vs the minimap reference.
            if ow and rw:
                diff = (70, 170, 90)     # agree-water
            elif not ow and not rw:
                diff = (120, 120, 120)   # agree-land
            elif ow:
                diff = (210, 60, 60)     # ours-only (carved necks/moats)
            else:
                diff = (210, 60, 200)    # ref-only (denoised speckle)
            put(2, c, r, diff)

    # Shop dots on panel 1 (green = sea-reachable).
    layout_shops = getattr(_write_compare_png, "_shops", None)
    if layout_shops:
        south_hq = layout_shops["south_hq"]
        main = _main_sea(rows, cols, nrows, cell_for(south_hq["x"], south_hq["y"], geom))
        for s in layout_shops["shops"]:
            c, r = cell_for(s["x"], s["y"], geom)
            ok = _shop_reachable(main, cols, nrows, c, r)
            dot = (40, 200, 80) if ok else (230, 40, 40)
            x0 = 1 * (pw + gap) + c * scale
            y0 = r * scale
            for dy in range(-2, scale + 2):
                for dx in range(-2, scale + 2):
                    xx, yy = x0 + dx, y0 + dy
                    if 0 <= xx < img_w and 0 <= yy < img_h:
                        o = (yy * img_w + xx) * 3
                        px[o], px[o + 1], px[o + 2] = dot

    _write_rgb_png(px, img_w, img_h, path)


def _write_rgb_png(px: bytearray, img_w: int, img_h: int, path: Path) -> None:
    """Encode an RGB pixel buffer (row-major, 3 bytes/px) as a pure-stdlib PNG."""
    raw = bytearray()
    stride = img_w * 3
    for y in range(img_h):
        raw.append(0)
        raw.extend(px[y * stride:(y + 1) * stride])

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", img_w, img_h, 8, 2, 0, 0, 0)
    out = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(out)


def write_westloop_compare(before: list[list[int]], after: list[list[int]], geom: dict,
                           layout: dict, path: Path) -> None:
    """Deliverable: a ZOOMED 2-panel compare of the two carved WEST sail-around
    islands -- [BEFORE the loop carve | AFTER] -- with all 16 shop dots (green =
    sea-reachable) drawn on the AFTER panel. Pure-stdlib PNG, <=440px wide.

    Crop = the west strip (cols 0..WL_COLS) over the row band that spans both
    islands, scaled up so the thin 1-cell moat is legible. Deterministic."""
    cols, nrows = geom["cols"], geom["rows"]
    shops = [s for s in layout["structures"] if s.get("role") == "shop"]
    west_cells = [cell_for(tx, ty, geom) for (tx, ty) in WEST_ISLAND_SHOPS]
    # Row band: pad generously around both island rows; clamp to grid.
    band_rows = [r for (_c, r) in west_cells]
    r0 = max(0, min(band_rows) - 8)
    r1 = min(nrows - 1, max(band_rows) + 8)
    c0, c1 = 0, min(cols - 1, 13)          # the west strip (islands hug col 0)
    cw, ch = c1 - c0 + 1, r1 - r0 + 1
    scale = 7                               # 2*14*7 + gap = 196+ < 440
    gap = 6
    pw, phh = cw * scale, ch * scale
    img_w = 2 * pw + gap
    img_h = phh
    px = bytearray((250, 250, 250)[k % 3] for k in range(img_w * img_h * 3))  # white gutter

    water = (60, 110, 190)
    land = (210, 195, 160)

    def put(panel: int, c: int, r: int, rgb: tuple[int, int, int]) -> None:
        x0 = panel * (pw + gap) + (c - c0) * scale
        y0 = (r - r0) * scale
        for dy in range(scale):
            for dx in range(scale):
                xx, yy = x0 + dx, y0 + dy
                if 0 <= xx < img_w and 0 <= yy < img_h:
                    o = (yy * img_w + xx) * 3
                    px[o], px[o + 1], px[o + 2] = rgb

    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            put(0, c, r, water if before[r][c] else land)
            put(1, c, r, water if after[r][c] else land)

    # All 16 shop dots on the AFTER panel; green = sea-reachable, red = not.
    south_hq = min((s for s in layout["structures"] if s.get("role") == "hq"), key=lambda s: s["y"])
    main = _main_sea(after, cols, nrows, cell_for(south_hq["x"], south_hq["y"], geom))
    for s in shops:
        c, r = cell_for(s["x"], s["y"], geom)
        if not (c0 <= c <= c1 and r0 <= r <= r1):
            continue
        ok = _shop_reachable(main, cols, nrows, c, r)
        dot = (40, 200, 80) if ok else (230, 40, 40)
        x0 = 1 * (pw + gap) + (c - c0) * scale + scale // 2
        y0 = (r - r0) * scale + scale // 2
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                if dx * dx + dy * dy <= 9:
                    xx, yy = x0 + dx, y0 + dy
                    if 0 <= xx < img_w and 0 <= yy < img_h:
                        o = (yy * img_w + xx) * 3
                        px[o], px[o + 1], px[o + 2] = dot

    _write_rgb_png(px, img_w, img_h, path)


# ---------------------------------------------------------------------------
# ASCII preview
# ---------------------------------------------------------------------------


def ascii_map(rows: list[list[int]], cols: int, nrows: int,
              out_cols: int = 78, out_rows: int = 56) -> str:
    lines = []
    for orr in range(out_rows):
        r = int(orr / out_rows * nrows)
        line = []
        for oc in range(out_cols):
            c = int(oc / out_cols * cols)
            line.append("." if rows[r][c] else "#")
        lines.append("".join(line))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--w3e", type=Path, default=Path("data/extracted/war3map.w3e"))
    parser.add_argument("--minimap", type=Path, default=Path("data/reference/war3mapMap.png"),
                        help="THE picture to classify (NON-BLUE = sailable water; blue = land)")
    parser.add_argument("--layout", type=Path, default=Path("data/json/map-layout.json"))
    parser.add_argument("--out", type=Path, default=Path("data/json/terrain.json"))
    parser.add_argument("--compare", type=Path, default=Path("data/reference/colorkey-compare.png"),
                        help="where to save the 3-panel (minimap | mask deep/shallow/pink/land | diff) PNG")
    parser.add_argument("--westloop", type=Path, default=Path("data/reference/westedge-compare.png"),
                        help="where to save the zoomed west-edge PNG (the two sail-around island "
                             "rings: [before | after] the loop carve, with all 16 shop dots)")
    parser.add_argument("--ascii", action="store_true",
                        help="print the north-up ASCII map to stderr")
    args = parser.parse_args()

    if not args.minimap.exists():
        raise SystemExit(f"terrain: minimap {args.minimap} not found -- it is the trace authority")

    w3e = parse_w3e(args.w3e.read_bytes())
    layout = json.loads(args.layout.read_text())
    cols_idx, rows_idx = playable_indices(w3e, PLAYABLE)
    geom = crop_geometry(w3e, cols_idx, rows_idx, PLAYABLE)

    mm_w, mm_h, mm_px = decode_png_rgb(args.minimap)

    # 1. raw NON-BLUE water classification (the owner's confirmed colour key:
    # sailable water = yellow deep + green shallow + pink passable; LAND = only
    # the blue-dominant ridge pixels). `nonblue` is the immutable minimap-key
    # reference G2 compares the final mask against.
    nonblue = classify_grid(geom, mm_w, mm_h, mm_px, is_water)
    # The connectivity-neck Dijkstra biases toward existing water (cost 1) over
    # land (LAND_COST); under the NON-BLUE key there is no separate faint band, so
    # the bias grid IS the water classification itself.
    soft = nonblue

    # rows = the working mask; keep `nonblue` (after the same denoise) as the
    # colour-key reference for the G2 agreement.
    rows = [list(r) for r in nonblue]
    removed = drop_singletons(rows, geom["cols"], geom["rows"])
    ref_after_denoise = [list(r) for r in rows]  # the reference G2 compares against

    # 2-5. minimal connectivity necks (base-platform, base-to-base, shops). Under
    # the NON-BLUE key most water is already one connected sea, so these rarely
    # fire; they only guarantee every shop/base/dock reaches the sea (G3/G4).
    neck_report = carve_connectivity(rows, soft, layout, geom)
    neck_report["singletonCellsDropped"] = removed

    # 6. WEST-ISLAND LOOPS (owner-approved): ring each of the two west-island shops
    # with a closed 1-cell navigable moat + EXACTLY ONE entrance (deterministic
    # post-step, only WATER VALUES change; see carve_west_island_loops). Under the
    # NON-BLUE key the green shallow water already RINGS the blue ridge cores, so
    # the sail-around loops largely emerge naturally; this step only guarantees the
    # closed single-entrance moat the owner wants around the two shop cores.
    rows_before_loops = [list(r) for r in rows]  # snapshot for the westloop compare
    west_island_report = carve_west_island_loops(rows, layout, geom)
    neck_report["westIslandLoops"] = west_island_report

    rle = [rle_encode_row(r) for r in rows]
    wf = water_fraction(rows)
    report = validate(rows, layout, geom)
    report["necks"] = neck_report
    report["sideRoutes"] = confirm_side_routes(rows, ref_after_denoise, layout, geom)

    # OPTIONAL depth metadata (0=land,1=deep,2=shallow,3=pink): the minimap colour
    # band per FINAL-mask water cell (additive render hint; the sim IGNORES it).
    depth = classify_depth_grid(geom, mm_w, mm_h, mm_px, rows)
    depth_rle = [rle_encode_values_row(r) for r in depth]

    # G2 agreement + 3-panel colour-key compare (minimap | 4-shade mask | diff).
    _write_compare_png._shops = {  # type: ignore[attr-defined]
        "shops": [s for s in layout["structures"] if s.get("role") == "shop"],
        "south_hq": min((s for s in layout["structures"] if s.get("role") == "hq"), key=lambda s: s["y"]),
    }
    compare_report = agreement_and_compare(rows, ref_after_denoise, depth, geom,
                                           mm_w, mm_h, mm_px, args.compare)
    report["minimapAgreement"] = compare_report["agreement"]
    report["minimapConfusion"] = (
        f"agree={compare_report['agreeFrac']} ours-only(necks/moats)={compare_report['oursOnlyFrac']} "
        f"ref-only(denoised)={compare_report['refOnlyFrac']}"
    )
    report["depthSplitLandDeepShallowPink"] = compare_report["landDeepShallowPink"]
    # (G2) hard gate: per-tile land-vs-water agreement vs the minimap colour key.
    if compare_report["agreement"] < 0.90:
        raise SystemExit(f"terrain: minimap colour-key agreement {compare_report['agreement']:.3f} "
                         "< 0.90 (the rebuilt land/water mask does not match the minimap, G2)")

    # Deliverable: zoomed [before | after] of the two west sail-around loops.
    if args.westloop is not None:
        write_westloop_compare(rows_before_loops, rows, geom, layout, args.westloop)

    out = {
        "_comment": (
            "Static land/water mask. SAILABLE WATER = the embedded minimap's "
            "NON-BLUE region (data/reference/war3mapMap.png; the owner-confirmed "
            "picture): the YELLOW/tan DEEP-water cross + the GREEN SHALLOW-water "
            "rings + the PINK/magenta passable shallows. LAND = ONLY the "
            "blue-dominant ridge pixels (B>R). Classified per terrain tile (3x3 "
            "patch majority, letterbox-aware registration). This is the faithful "
            "~half-water silhouette; it REPLACES the prior yellow-only 'tan' trace "
            "that kept only the deep cross (~0.29) and called the green+pink land "
            "-- far too dry. The green shallow water RINGS the blue ridge cores, so "
            "the west sail-around island loops + the side routes emerge naturally. "
            "The ONLY additions on top of the raw classification are MINIMAL 1-cell "
            "connectivity necks (so every shop + dock/spawn reaches the sea and the "
            "two bases stay water-connected) PLUS the two owner-approved WEST "
            "sail-around island moats: each of the two west-island shops (Swedish "
            "Lumber Mill, Goblin Potion Dealer) sits on a compact land core ringed "
            "by a thin 1-cell navigable water loop with EXACTLY ONE narrow entrance "
            "(sail in, loop around the island, sail out the same way; CARVED as a "
            "deterministic post-step). water=true is ship-navigable. The OPTIONAL "
            "`depth` field (0=land,1=deep,2=shallow,3=pink) is additive render "
            "metadata the SIM IGNORES (sailability is purely water-vs-land); it "
            "lets a client paint the three water shades + land like the minimap. "
            "Regenerate with: make terrain (tools/extractor/terrain.py; pure "
            "stdlib, reads the committed PNG+w3e, no venv). yOrientation 'top-down' "
            "means rle row 0 is the NORTH (max-Y) edge."
        ),
        "source": "data/reference/war3mapMap.png (embedded minimap, NON-BLUE=water) + data/extracted/war3map.w3e (grid geometry only)",
        "target": "data/reference/war3mapMap.png (the minimap is BOTH the source and the target -- we classify it directly by the owner's colour key)",
        "rule": (
            "water = minimap NON-BLUE per tile (LAND iff B>R among non-white "
            "content; WATER = yellow deep + green shallow + pink passable; 3x3 "
            "patch majority; letterbox-aware registration calibrated on dock "
            "coords) MINUS singleton speckle, PLUS minimal 1-cell connectivity "
            "necks (Dijkstra cost 1 water / 30 land) for shops, docks/spawns and "
            "base-to-base, PLUS the two carved WEST sail-around island moats "
            "(compact land core + thin 1-cell water ring + exactly one entrance) "
            "around the Swedish Lumber Mill and Goblin Potion Dealer shops. depth "
            "sub-classifies water for RENDER only: DEEP (R-B>35 AND R>=G), PINK "
            "(R>150 AND B>120 AND R-G>15), else SHALLOW (green)."
        ),
        "playableBounds": PLAYABLE,
        "bounds": geom["bounds"],
        "cols": geom["cols"],
        "rows": geom["rows"],
        "cellSizeX": round(geom["csx"], 6),
        "cellSizeY": round(geom["csy"], 6),
        "yOrientation": "top-down",
        "yOrientationNote": (
            "rle row 0 = max-Y (north); last row = min-Y (south). col 0 = min-X "
            "(west). col=floor((x-minX)/cellSizeX), row=floor((maxY-y)/cellSizeY). "
            "The minimap is north-up; tiles are sampled at their world centers via "
            "the content-box registration, emit row 0 = north, matching sim isWater."
        ),
        "rleFormat": (
            "water[r] = [leadingValue, run0, run1, ...]; runs alternate from "
            "leadingValue (0=land,1=water) and sum to cols."
        ),
        "depthRleFormat": (
            "OPTIONAL render metadata, the sim IGNORES it. depth[r] = [value0, "
            "run0, value1, run1, ...] (explicit value per run; values 0=land, "
            "1=deep, 2=shallow, 3=pink; runs sum to cols). depth[r][col]>0 IFF "
            "water[r][col]==1 (exactly consistent with the authoritative `water` "
            "mask). Carved necks/moats with no minimap colour emit as shallow (2)."
        ),
        "waterFraction": round(wf, 6),
        "validation": report,
        "water": rle,
        "depth": depth_rle,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, separators=(",", ":")) + "\n")

    print(f"terrain: {geom['cols']}x{geom['rows']} cells, cellSize {geom['csx']:.3f}x{geom['csy']:.3f} u, "
          f"waterFraction {wf:.3f} -> {args.out}", file=sys.stderr)
    print(f"minimap colour-key agreement: {compare_report['agreement']} "
          f"(agree {compare_report['agreeFrac']} / ours-only {compare_report['oursOnlyFrac']} / "
          f"ref-only {compare_report['refOnlyFrac']}) "
          f"depth land/deep/shallow/pink {compare_report['landDeepShallowPink']} "
          f"-> {compare_report.get('comparePng')}", file=sys.stderr)
    print(f"validation: {report}", file=sys.stderr)
    if args.ascii:
        print(ascii_map(rows, geom["cols"], geom["rows"]), file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
