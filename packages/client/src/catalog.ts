/**
 * Static display catalog: the Classic ruleset compiled CLIENT-SIDE from the
 * same data/json files the server uses. Used ONLY for display data — item
 * names/prices/shop inventories (HUD), ship classes/map bounds/regions
 * (renderer, minimap). The sim never runs here; the server remains
 * authoritative for every gameplay outcome.
 *
 * This file is complete — do not rewrite. All three client modules import
 * `getCatalog()`.
 */

import { compileClassicRuleset } from '@bships/core';
import type { RawDataFiles, Ruleset } from '@bships/core';

import weapons from '../../../data/json/weapons.json';
import equipment from '../../../data/json/equipment.json';
import ships from '../../../data/json/ships.json';
import upgradeCurves from '../../../data/json/upgrade-curves.json';
import scriptRules from '../../../data/json/script-rules.json';
import mapLayout from '../../../data/json/map-layout.json';
import terrain from '../../../data/json/terrain.json';
import gameplayConstants from '../../../data/json/gameplay-constants.json';
import units from '../../../data/json/units.json';
import abilities from '../../../data/json/abilities.json';
import items from '../../../data/json/items.json';
import buffs from '../../../data/json/buffs.json';
import strings from '../../../data/json/strings.json';

let cached: Ruleset | null = null;

/** The Classic ruleset as a read-only display catalog. Compiled once. */
export function getCatalog(): Ruleset {
  if (cached === null) {
    const raw = {
      weapons,
      equipment,
      ships,
      upgradeCurves,
      scriptRules,
      mapLayout,
      terrain,
      gameplayConstants,
      units,
      abilities,
      items,
      buffs,
      strings,
    } as unknown as RawDataFiles;
    cached = compileClassicRuleset(raw);
  }
  return cached;
}
