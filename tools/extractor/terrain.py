#!/usr/bin/env python3
"""Parse war3map.wpm (WC3 pathing map) into a land/water mask -> terrain.json.

Usage:
    python terrain.py [--wpm data/extracted/war3map.wpm]
                      [--layout data/json/map-layout.json]
                      [--out data/json/terrain.json]
                      [--ascii]   # also print a downsampled ASCII map to stderr

The recreation renders open sea everywhere; the original BattleShips Pro is
water lanes carved through land. The static land/water shape lives in the WC3
pathing map (war3map.wpm), which classifies every pathing cell. This tool turns
it into a compact, deterministic, serializable mask consumed by the sim
(collision) and the client (render).

WPM format
----------
    char[4] magic  = 'MP3W'
    int32   version (0 here)
    int32   width   (= 384)
    int32   height  (= 512)
    byte[width*height] flags, row-major

Each flag byte is a bitfield of WC3 pathing-blocker bits. In this map only six
distinct byte values occur; the bit that cleanly separates ship-navigable water
from land is 0x40 (set => water). See the module docstring section "Rule choice"
and tools/extractor/README for the empirical validation.

Orientation
-----------
In this wpm, file row 0 is the NORTH (max-Y) edge of the playable area and the
row index increases southward (last row = min-Y / south); columns increase
eastward (col 0 = min-X / west). So the file is already stored in the TOP-DOWN,
north-first order we emit -- no flip is applied. This was determined (not
assumed) by validating against ASYMMETRIC structure positions: the top-down
mapping (row = floor((maxY - y) / cellSizeY), no flip) places 18 of 24 cannon
towers and all 4 creep-spawn buildings center-on-water, while the flipped
mapping places only 12 towers and 2 spawn buildings on water. Creep-spawn
buildings MUST sit on water (creeps spawn and sail), so the tower/spawn-building
counts decisively pick top-down. (The south HQ neighborhood is NOT a
disambiguator: its harbor docks read as walkable=water under BOTH orientations,
~25/25 either way.) Under top-down all 12 player ship spawns and all 4 lane
spawns are on water, both HQs share one connected water network, and the centre
band stays ~65% land. yOrientation in the output records it.

Rule choice (water = (byte & 0x40) OR ground-walkable)
------------------------------------------------------
The six byte values present and their interpretation:
    0x08  WALKABLE ground, buildable-blocked only -- the harbor "docks": ship
          spawn points, HQ/shop footprints and the base aprons. SHIP-NAVIGABLE.
    0x0a  not-walkable + buildable-blocked -- the LAND cliffs between the lanes.
    0x40  water-painted, otherwise open. SHIP-NAVIGABLE.
    0x48  water-painted, build-blocked. SHIP-NAVIGABLE.
    0xca  water-painted, walk-blocked + boundary bit. SHIP-NAVIGABLE.
    0xce  water-painted, walk+fly-blocked + boundary bit. SHIP-NAVIGABLE.

The navigable-water predicate is therefore:

    water = (byte & 0x40)          # explicitly painted water
            or not (byte & 0x02)   # walkable ground (harbor docks/aprons)

i.e. LAND is exactly the cells that are BOTH unpainted-water AND not-walkable
(0x0a) -- the WC3 cliffs/blockers that carve the lanes. The earlier rule
`byte & 0x40` alone was WRONG: it flagged every 0x08 base-dock cell as land, so
the south HQ, several ship spawn points and the base aprons were unsailable, and
ships spawned stuck on "land". Empirically the corrected rule places all 12 ship
spawn points ON water, keeps the south HQ <-> north HQ water network fully
connected, and still leaves ~65% of the central band as land (the lanes are real
channels through a landmass), all asserted in `validate` below.

Coordinate transform
---------------------
The pathing grid spans the playable rect (map-layout.json mapBounds.playableArea).
    cellSizeX = (maxX - minX) / cols   (~= 28.25 u)
    cellSizeY = (maxY - minY) / rows   (~= 29.0  u)
World point (x, y) -> emitted cell:
    col = floor((x - minX) / cellSizeX)
    row = floor((maxY - y) / cellSizeY)   # top-down, north-first
cell center world position:
    x = minX + (col + 0.5) * cellSizeX
    y = maxY - (row + 0.5) * cellSizeY

Output is run-length-encoded per row (water=true means ship-navigable); each row
is [leadingValue(0|1), run0, run1, ...] where runs alternate starting from
leadingValue and sum to cols. This is ~24 KB vs a 197k-element raw array.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

WATER_BIT = 0x40  # explicitly painted water
NOT_WALKABLE_BIT = 0x02  # set => ground-blocked (a land cliff)


def is_water(flag: int) -> bool:
    """Ship-navigable predicate: painted water OR walkable ground (docks).
    Land is exactly the not-walkable, unpainted cells (0x0a cliffs)."""
    return bool(flag & WATER_BIT) or not (flag & NOT_WALKABLE_BIT)


def parse_wpm(raw: bytes) -> tuple[int, int, int, bytes]:
    """Return (version, width, height, flag_bytes) from a war3map.wpm blob."""
    if raw[:4] != b"MP3W":
        raise SystemExit("not a war3map.wpm (missing 'MP3W' magic)")
    version, width, height = struct.unpack("<iii", raw[4:16])
    body = raw[16:]
    expected = width * height
    if len(body) < expected:
        raise SystemExit(f"wpm truncated: have {len(body)} flag bytes, need {expected}")
    return version, width, height, body[:expected]


def build_water_rows(width: int, height: int, body: bytes) -> list[list[int]]:
    """Classify each cell water(1)/land(0). File rows are already north-first
    (row 0 = max-Y), so no flip; see the orientation note in the module docstring."""
    rows: list[list[int]] = []
    for row in range(height):
        base = row * width
        rows.append([1 if is_water(body[base + c]) else 0 for c in range(width)])
    return rows


def rle_encode_row(row: list[int]) -> list[int]:
    """[leadingValue, run0, run1, ...]; runs alternate from leadingValue, sum to len(row)."""
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


def cell_for(x: float, y: float, bounds: dict, csx: float, csy: float,
             cols: int, rows: int) -> tuple[int, int]:
    """World point -> (col, row), clamped, top-down/north-first."""
    col = int((x - bounds["minX"]) / csx)
    row = int((bounds["maxY"] - y) / csy)
    return max(0, min(cols - 1, col)), max(0, min(rows - 1, row))


def _water_connected(rows: list[list[int]], cols: int, nrows: int,
                     a: tuple[int, int], b: tuple[int, int]) -> bool:
    """4-connected BFS over water cells: is cell `a` reachable from cell `b`?
    Both endpoints must be water (else returns False)."""
    (ac, ar), (bc, br) = a, b
    if not (rows[ar][ac] and rows[br][bc]):
        return False
    seen = bytearray(cols * nrows)
    seen[ar * cols + ac] = 1
    queue = [(ac, ar)]
    head = 0
    while head < len(queue):
        c, r = queue[head]
        head += 1
        if c == bc and r == br:
            return True
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if 0 <= nc < cols and 0 <= nr < nrows and rows[nr][nc] and not seen[nr * cols + nc]:
                seen[nr * cols + nc] = 1
                queue.append((nc, nr))
    return False


def validate(rows: list[list[int]], layout: dict, bounds: dict,
             csx: float, csy: float, cols: int, nrows: int) -> dict:
    """Fidelity gate. Faithful BSP map: every ship/creep spawn must sit ON
    navigable water, the two bases must be connected by a continuous water
    network (lanes are real channels), and the centre must retain land (lanes
    cut THROUGH a landmass, not open sea). Raises SystemExit on any failure so a
    bad rule change cannot silently ship a broken mask."""
    structures = layout.get("structures", [])
    player_starts = layout.get("playerStarts", {}).get("players", [])
    lanes = layout.get("creepSpawns", {}).get("lanes", [])
    report: dict[str, object] = {}

    def cell(x: float, y: float) -> tuple[int, int]:
        return cell_for(x, y, bounds, csx, csy, cols, nrows)

    def is_water_at(x: float, y: float) -> bool:
        c, r = cell(x, y)
        return bool(rows[r][c])

    # (1) Every player spawn (ship spawn if present, else start location) ON water.
    spawn_pts = [(p.get("shipSpawn") or p.get("startLocation")) for p in player_starts]
    spawn_pts = [s for s in spawn_pts if s]
    dry_spawns = [s for s in spawn_pts if not is_water_at(s["x"], s["y"])]
    report["playerSpawnsOnWater"] = f"{len(spawn_pts) - len(dry_spawns)}/{len(spawn_pts)}"
    if dry_spawns:
        raise SystemExit(f"terrain: {len(dry_spawns)} player spawn(s) on LAND: "
                         f"{[(round(s['x']), round(s['y'])) for s in dry_spawns]}")

    # (2) Every lane spawn ON water and connected to the enemy HQ by water.
    hq = {s.get("role"): s for s in structures if s.get("role") == "hq"}
    hqs_by_team = {}
    for s in structures:
        if s.get("role") == "hq":
            # south HQ has the most-negative y; north the most-positive.
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

    # (3) The two HQs share one water network (sanity on the lane corridors).
    if "hq" in hq and hqs_by_team.get("south") and hqs_by_team.get("north"):
        s_hq, n_hq = hqs_by_team["south"], hqs_by_team["north"]
        report["basesConnected"] = _water_connected(
            rows, cols, nrows, cell(s_hq["x"], s_hq["y"]), cell(n_hq["x"], n_hq["y"]))
        if not report["basesConnected"]:
            raise SystemExit("terrain: south HQ and north HQ are not water-connected")

    # (4) Centre band must retain meaningful land (lanes cut through a landmass).
    r0, r1 = int(nrows * 0.35), int(nrows * 0.65)
    c0, c1 = int(cols * 0.25), int(cols * 0.75)
    band_total = (r1 - r0) * (c1 - c0)
    band_land = sum(1 for r in range(r0, r1) for c in range(c0, c1) if not rows[r][c])
    land_pct = 100 * band_land / band_total if band_total else 0
    report["centreBandLandPct"] = round(land_pct, 1)
    if land_pct < 25:
        raise SystemExit(f"terrain: centre band is only {land_pct:.1f}% land "
                         "(expected a landmass with lanes carved through it)")

    # Structure proximity (informational): on or beside water.
    def water_within(col: int, row: int, rad: int) -> bool:
        for dr in range(-rad, rad + 1):
            for dc in range(-rad, rad + 1):
                rr, cc = row + dr, col + dc
                if 0 <= rr < nrows and 0 <= cc < cols and rows[rr][cc]:
                    return True
        return False

    for role in ("hq", "tower", "spawnBuilding", "shop"):
        items = [s for s in structures if s.get("role") == role]
        if not items:
            continue
        near2 = sum(1 for s in items if water_within(*cell(s["x"], s["y"]), 2))
        near4 = sum(1 for s in items if water_within(*cell(s["x"], s["y"]), 4))
        report[role] = f"{near2}/{len(items)} within ~57u, {near4}/{len(items)} within ~115u"
    return report


def ascii_map(rows: list[list[int]], cols: int, nrows: int,
              out_cols: int = 80, out_rows: int = 58) -> str:
    """Downsampled ASCII: water='.', land='#'. Row 0 = north (top)."""
    lines = []
    for orr in range(out_rows):
        r = int(orr / out_rows * nrows)
        line = []
        for oc in range(out_cols):
            c = int(oc / out_cols * cols)
            line.append("." if rows[r][c] else "#")
        lines.append("".join(line))
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wpm", type=Path, default=Path("data/extracted/war3map.wpm"))
    parser.add_argument("--layout", type=Path, default=Path("data/json/map-layout.json"))
    parser.add_argument("--out", type=Path, default=Path("data/json/terrain.json"))
    parser.add_argument("--ascii", action="store_true",
                        help="print a downsampled ASCII map to stderr")
    args = parser.parse_args()

    version, width, height, body = parse_wpm(args.wpm.read_bytes())
    layout = json.loads(args.layout.read_text())
    bounds = layout["mapBounds"]["playableArea"]
    bounds = {k: bounds[k] for k in ("minX", "minY", "maxX", "maxY")}

    cols, nrows = width, height
    csx = (bounds["maxX"] - bounds["minX"]) / cols
    csy = (bounds["maxY"] - bounds["minY"]) / nrows

    rows = build_water_rows(width, height, body)
    rle = [rle_encode_row(r) for r in rows]
    wf = water_fraction(rows)
    report = validate(rows, layout, bounds, csx, csy, cols, nrows)

    out = {
        "_comment": (
            "Static land/water mask from war3map.wpm. water=true is "
            "ship-navigable. Regenerate with: make terrain (tools/extractor/terrain.py). "
            "Rule: water = (byte & 0x40) OR not(byte & 0x02) -- painted water OR "
            "walkable ground (harbor docks); land is the 0x0a not-walkable cliffs "
            "that carve the lanes. yOrientation 'top-down' means rle row 0 is the "
            "NORTH (max-Y) edge."
        ),
        "source": "data/extracted/war3map.wpm",
        "rule": "water = (pathing flag byte & 0x40) OR not(byte & 0x02)",
        "bounds": bounds,
        "cols": cols,
        "rows": nrows,
        "cellSizeX": round(csx, 6),
        "cellSizeY": round(csy, 6),
        "yOrientation": "top-down",
        "yOrientationNote": (
            "rle row 0 = max-Y (north); last row = min-Y (south). "
            "col 0 = min-X (west). col=floor((x-minX)/cellSizeX), "
            "row=floor((maxY-y)/cellSizeY)."
        ),
        "rleFormat": (
            "water[r] = [leadingValue, run0, run1, ...]; runs alternate from "
            "leadingValue (0=land,1=water) and sum to cols."
        ),
        "waterFraction": round(wf, 6),
        "validation": report,
        "water": rle,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, separators=(",", ":")) + "\n")

    print(f"terrain: {cols}x{nrows} cells, cellSize {csx:.3f}x{csy:.3f} u, "
          f"waterFraction {wf:.3f} -> {args.out}", file=sys.stderr)
    print(f"validation: {report}", file=sys.stderr)
    if args.ascii:
        print(ascii_map(rows, cols, nrows), file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
