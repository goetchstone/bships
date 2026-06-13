/**
 * Data loading for the game server: reads data/json/* from the repo root and
 * compiles the Classic ruleset EXACTLY ONCE per process. Every room/match
 * shares the returned Ruleset object (it is treated as deeply immutable —
 * compileClassicRuleset output is never mutated by the sim).
 *
 * This file is complete — do not rewrite. Both the lobby (slot layout via
 * ruleset.map.playerStarts) and match runtimes import from here.
 */

import { readFileSync } from 'node:fs';
import { compileClassicRuleset } from '@bships/core';
import type { RawDataFiles, Ruleset } from '@bships/core';

/** Repo-root data directory, resolved relative to this file (src or dist). */
const DATA_DIR = new URL('../../../data/json/', import.meta.url);

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, DATA_DIR), 'utf8')) as T;
}

/** Parse the raw data files (the core stays IO-free; the server does IO). */
export function loadRawDataFiles(): RawDataFiles {
  return {
    weapons: loadJson('weapons.json'),
    equipment: loadJson('equipment.json'),
    ships: loadJson('ships.json'),
    upgradeCurves: loadJson('upgrade-curves.json'),
    scriptRules: loadJson('script-rules.json'),
    mapLayout: loadJson('map-layout.json'),
    units: loadJson('units.json'),
    abilities: loadJson('abilities.json'),
    items: loadJson('items.json'),
    buffs: loadJson('buffs.json'),
    strings: loadJson('strings.json'),
  };
}

let cachedClassic: Ruleset | null = null;

/** The shared, compile-once Classic ruleset. */
export function getClassicRuleset(): Ruleset {
  if (cachedClassic === null) {
    cachedClassic = compileClassicRuleset(loadRawDataFiles());
  }
  return cachedClassic;
}
