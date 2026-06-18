#!/usr/bin/env python3
"""Extract gameplay data from a Warcraft III .w3x map into JSON.

Usage:
    python extract.py path/to/map.w3x [--out-raw DIR] [--out-json DIR]

Stage 1: strips the 512-byte HM3W header, opens the MPQ archive, and dumps
the well-known war3map.* files into the raw output directory.

Stage 2: parses the binary object-data files (units/items/abilities/buffs/
upgrades/destructables), resolves TRIGSTR_ references against war3map.wts,
and writes one JSON file per object class plus strings.json.

The object-data format is the standard WC3 W3U/W3T/W3A/W3B/W3D/W3H/W3Q
encoding: a version int, then two tables (modified-standard and custom),
each a list of (baseId, newId, [mods]) entries. The "extended" variants
(w3a/w3d/w3q) carry a level and data pointer per modification.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import struct
import sys
import tempfile
from pathlib import Path

from mpyq import MPQArchive

HM3W_HEADER_SIZE = 512

# (archive name, output name, required)
KNOWN_FILES = [
    ("war3map.j", "war3map.j", False),
    ("Scripts\\war3map.j", "war3map.j", False),
    ("war3map.w3u", "war3map.w3u", False),
    ("war3map.w3t", "war3map.w3t", False),
    ("war3map.w3a", "war3map.w3a", False),
    ("war3map.w3b", "war3map.w3b", False),
    ("war3map.w3d", "war3map.w3d", False),
    ("war3map.w3h", "war3map.w3h", False),
    ("war3map.w3q", "war3map.w3q", False),
    ("war3map.wts", "war3map.wts", False),
    ("war3mapMisc.txt", "war3mapMisc.txt", False),
    ("war3map.w3i", "war3map.w3i", False),
    ("war3map.w3e", "war3map.w3e", False),
    ("war3map.w3r", "war3map.w3r", False),
    ("war3map.doo", "war3map.doo", False),
    ("war3mapUnits.doo", "war3mapUnits.doo", False),
    ("war3map.wpm", "war3map.wpm", False),
    ("war3mapMap.blp", "war3mapMap.blp", False),
]

# objectclass -> (extension, uses extended modification records)
OBJECT_CLASSES = {
    "units": ("w3u", False),
    "items": ("w3t", False),
    "destructables": ("w3b", False),
    "doodads": ("w3d", True),
    "abilities": ("w3a", True),
    "buffs": ("w3h", False),
    "upgrades": ("w3q", True),
}


def extract_raw(map_path: Path, raw_dir: Path) -> dict[str, bytes]:
    """Dump known files from the map's MPQ archive; returns {output name: bytes}."""
    data = map_path.read_bytes()
    if data[:4] != b"HM3W":
        raise SystemExit(f"{map_path} is not a .w3x map (missing HM3W header)")

    with tempfile.NamedTemporaryFile(suffix=".mpq") as tmp:
        tmp.write(data[HM3W_HEADER_SIZE:])
        tmp.flush()
        archive = MPQArchive(tmp.name, listfile=False)

        raw_dir.mkdir(parents=True, exist_ok=True)
        out: dict[str, bytes] = {}
        for archive_name, output_name, _ in KNOWN_FILES:
            if output_name in out:
                continue
            try:
                contents = archive.read_file(archive_name)
            except Exception:
                contents = None
            if contents:
                (raw_dir / output_name).write_bytes(contents)
                out[output_name] = contents
        return out


def parse_misc(raw: bytes) -> dict[str, object]:
    """Parse war3mapMisc.txt's [Misc] gameplay-constant overrides.

    The file is an INI-style override of GameplayConstants.slk: only the
    constants the map author CHANGED from the WC3 defaults are present. Each
    `Key=value` becomes a number, or a list of numbers when comma-separated
    (the damage tables, HeroFactorXP, GrantHeroXP). Non-numeric values are
    kept as raw strings. Other sections ([Errors], [CustomSkin], ...) are
    ignored — only [Misc] carries gameplay constants. This is the single most
    important file for hero stats/XP/speed fidelity (SEMANTICS.md §1/§3/§6),
    and the WC3 World Editor only writes the overridden keys, so a missing key
    means "engine default applies".
    """
    text = raw.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")
    out: dict[str, object] = {}
    in_misc = False
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        if line.startswith("["):
            in_misc = line.lower() == "[misc]"
            continue
        if not in_misc or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        parts = [p.strip() for p in value.split(",")]

        def as_num(s: str):
            try:
                f = float(s)
                return int(f) if f.is_integer() and "." not in s else round(f, 6)
            except ValueError:
                return None

        nums = [as_num(p) for p in parts]
        if all(n is not None for n in nums):
            out[key] = nums[0] if len(nums) == 1 else nums
        else:
            out[key] = value.strip()
    return out


def parse_wts(raw: bytes) -> dict[int, str]:
    """Parse war3map.wts into {string id: text}."""
    text = raw.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")
    strings: dict[int, str] = {}
    for match in re.finditer(r"STRING (\d+)\s*(?://[^\n]*\n)?\s*\{\n(.*?)\n\}", text, re.DOTALL):
        strings[int(match.group(1))] = match.group(2)
    return strings


class _Reader:
    def __init__(self, raw: bytes):
        self.buf = io.BytesIO(raw)

    def i32(self) -> int:
        return struct.unpack("<i", self.buf.read(4))[0]

    def f32(self) -> float:
        return struct.unpack("<f", self.buf.read(4))[0]

    def id4(self) -> str:
        return self.buf.read(4).decode("latin-1")

    def cstring(self) -> str:
        chunks = bytearray()
        while True:
            byte = self.buf.read(1)
            if not byte or byte == b"\x00":
                return chunks.decode("utf-8", errors="replace")
            chunks.extend(byte)


def parse_object_file(raw: bytes, extended: bool, strings: dict[int, str]) -> dict:
    """Parse a W3U-family object-data file into {id: {base, mods: [...]}}."""

    def resolve(value):
        if isinstance(value, str):
            match = re.fullmatch(r"TRIGSTR_(\d+)", value.strip())
            if match:
                return strings.get(int(match.group(1)), value)
        return value

    reader = _Reader(raw)
    version = reader.i32()
    objects: dict[str, dict] = {}

    for _table in ("standard", "custom"):
        count = reader.i32()
        for _ in range(count):
            base_id = reader.id4()
            new_id = reader.id4()
            object_id = new_id if new_id != "\x00\x00\x00\x00" else base_id
            mods = []
            for _ in range(reader.i32()):
                mod_id = reader.id4()
                var_type = reader.i32()
                level = data_pointer = None
                if extended:
                    level = reader.i32()
                    data_pointer = reader.i32()
                if var_type == 0:
                    value = reader.i32()
                elif var_type in (1, 2):
                    value = round(reader.f32(), 6)
                else:
                    value = resolve(reader.cstring())
                reader.id4()  # trailing sanity id, ignored
                mod = {"id": mod_id, "value": value}
                if level is not None:
                    mod["level"] = level
                    mod["data"] = data_pointer
                mods.append(mod)
            objects[object_id] = {"base": base_id, "mods": mods}

    return {"version": version, "objects": objects}


def decode_blp_minimap(blp: bytes, out_png: Path) -> bool:
    """Decode the map's embedded minimap (war3mapMap.blp, BLP1) to a PNG.

    BLP1 stores either a palette image (compression 1) or a JPEG (compression
    0). This map's minimap is a 256x256 JPEG with 4 components in BGRA order
    (the WC3 convention); we recombine the shared JPEG header with mip-0's body,
    decode it, and map BGRA -> RGB. The minimap is WC3's OWN picture of the map,
    so data/reference/war3mapMap.png is the fidelity target the terrain extractor
    matches its water mask against (see tools/extractor/terrain.py + TERRAIN.md).

    Pillow is OPTIONAL: it is only needed to JPEG-decode the BLP here. The import
    is guarded so `extract.py` (and everything downstream) still works without
    it — the function just reports it was skipped. The decoded PNG is committed,
    so `make terrain` never needs Pillow."""
    try:
        from PIL import Image  # type: ignore
    except ImportError:
        print("skipped war3mapMap.png: Pillow not installed (pip install Pillow); "
              "BLP->PNG decode is optional and the PNG is committed")
        return False
    if blp[:4] != b"BLP1":
        print(f"skipped war3mapMap.png: unexpected BLP magic {blp[:4]!r}")
        return False
    (compression,) = struct.unpack_from("<I", blp, 4)
    width, height = struct.unpack_from("<II", blp, 12)
    mip_offsets = struct.unpack_from("<16I", blp, 28)
    mip_sizes = struct.unpack_from("<16I", blp, 28 + 64)
    if compression != 0:
        print(f"skipped war3mapMap.png: unsupported BLP compression {compression} (expected 0=JPEG)")
        return False
    jpeg_header_pos = 28 + 64 + 64
    (jpeg_header_size,) = struct.unpack_from("<I", blp, jpeg_header_pos)
    shared = blp[jpeg_header_pos + 4: jpeg_header_pos + 4 + jpeg_header_size]
    body = blp[mip_offsets[0]: mip_offsets[0] + mip_sizes[0]]
    image = Image.open(io.BytesIO(shared + body))  # CMYK-tagged 4-channel
    px = image.load()
    rgb = Image.new("RGB", (width, height))
    rpx = rgb.load()
    for y in range(height):
        for x in range(width):
            b, g, r, _a = px[x, y]  # BLP stores BGRA
            rpx[x, y] = (r, g, b)
    out_png.parent.mkdir(parents=True, exist_ok=True)
    rgb.save(out_png)
    print(f"decoded war3mapMap.blp -> {out_png} ({width}x{height})")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("map", type=Path, help="path to the .w3x map file")
    parser.add_argument("--out-raw", type=Path, default=Path("data/extracted"))
    parser.add_argument("--out-json", type=Path, default=Path("data/json"))
    parser.add_argument("--out-ref", type=Path, default=Path("data/reference"),
                        help="where to write decoded reference assets (the minimap PNG)")
    args = parser.parse_args()

    raw_files = extract_raw(args.map, args.out_raw)
    print(f"extracted {len(raw_files)} files -> {args.out_raw}/")

    strings = parse_wts(raw_files.get("war3map.wts", b""))
    args.out_json.mkdir(parents=True, exist_ok=True)

    # Gameplay constants (war3mapMisc.txt [Misc]) — the hero stat/XP/speed
    # overrides. Only present keys are written; downstream readers treat a
    # missing key as the WC3 engine default.
    misc_raw = raw_files.get("war3mapMisc.txt")
    misc = parse_misc(misc_raw) if misc_raw else {}
    (args.out_json / "gameplay-constants.json").write_text(
        json.dumps({"misc": misc}, indent=1, ensure_ascii=False) + "\n"
    )
    print(f"parsed {len(misc)} gameplay constants -> gameplay-constants.json")

    (args.out_json / "strings.json").write_text(
        json.dumps({str(k): v for k, v in sorted(strings.items())},
                   indent=1, ensure_ascii=False) + "\n"
    )
    print(f"parsed {len(strings)} strings -> strings.json")

    for class_name, (extension, extended) in OBJECT_CLASSES.items():
        raw = raw_files.get(f"war3map.{extension}")
        if not raw:
            print(f"skipped {class_name}: war3map.{extension} not in archive")
            continue
        parsed = parse_object_file(raw, extended, strings)
        out_path = args.out_json / f"{class_name}.json"
        out_path.write_text(json.dumps(parsed, indent=1, ensure_ascii=False) + "\n")
        print(f"parsed {len(parsed['objects'])} {class_name} -> {out_path.name}")

    # Embedded minimap: copy the raw BLP into the reference dir and decode it to a
    # PNG (the terrain extractor's fidelity target). Both are reproducible from
    # the map; the PNG decode is guarded so extract still works without Pillow.
    blp = raw_files.get("war3mapMap.blp")
    if blp:
        args.out_ref.mkdir(parents=True, exist_ok=True)
        (args.out_ref / "war3mapMap.blp").write_bytes(blp)
        decode_blp_minimap(blp, args.out_ref / "war3mapMap.png")
    else:
        print("skipped war3mapMap: not in archive")


if __name__ == "__main__":
    sys.exit(main())
