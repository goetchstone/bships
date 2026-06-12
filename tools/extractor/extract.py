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
    ("war3map.w3i", "war3map.w3i", False),
    ("war3map.w3e", "war3map.w3e", False),
    ("war3map.w3r", "war3map.w3r", False),
    ("war3map.doo", "war3map.doo", False),
    ("war3mapUnits.doo", "war3mapUnits.doo", False),
    ("war3map.wpm", "war3map.wpm", False),
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("map", type=Path, help="path to the .w3x map file")
    parser.add_argument("--out-raw", type=Path, default=Path("data/extracted"))
    parser.add_argument("--out-json", type=Path, default=Path("data/json"))
    args = parser.parse_args()

    raw_files = extract_raw(args.map, args.out_raw)
    print(f"extracted {len(raw_files)} files -> {args.out_raw}/")

    strings = parse_wts(raw_files.get("war3map.wts", b""))
    args.out_json.mkdir(parents=True, exist_ok=True)
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


if __name__ == "__main__":
    sys.exit(main())
