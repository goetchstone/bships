/**
 * Pure HUD logic — no DOM, no cross-module imports (only types from core).
 * Everything here is unit-tested in test/hud.test.ts without a browser.
 */

import type { Ruleset, SimEvent } from '@bships/core';

// ---------------------------------------------------------------------------
// Key labels
// ---------------------------------------------------------------------------

const SPECIAL_KEY_LABELS: Record<string, string> = {
  Tab: 'TAB',
  Enter: 'ENT',
  Escape: 'ESC',
  Space: 'SPC',
  Backspace: 'BKSP',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
};

/** Short human label for a KeyboardEvent.code ('KeyW' -> 'W'). */
export function keyLabel(code: string): string {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3);
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  return SPECIAL_KEY_LABELS[code] ?? code.toUpperCase();
}

// ---------------------------------------------------------------------------
// XP / level progress
// ---------------------------------------------------------------------------

export interface XpProgress {
  /** XP earned into the current level. */
  into: number;
  /** XP span of the current level; null = at cap (show MAX). */
  needed: number | null;
}

/**
 * Progress toward the next level. `xpToLevel` is CUMULATIVE XP required to
 * REACH the level at that index (core XpRules.xpToLevel).
 */
export function xpProgress(
  xp: number,
  level: number,
  xpToLevel: readonly number[],
  levelCap: number,
): XpProgress {
  if (level >= levelCap || level + 1 >= xpToLevel.length) return { into: 0, needed: null };
  const base = xpToLevel[level] ?? 0;
  const next = xpToLevel[level + 1] ?? base;
  const needed = Math.max(0, next - base);
  const into = Math.max(0, Math.min(needed, xp - base));
  return { into, needed };
}

// ---------------------------------------------------------------------------
// Cooldown sweeps
// ---------------------------------------------------------------------------

/**
 * Remaining-cooldown fraction in [0,1] for a conic-gradient sweep.
 * 0 = ready. When the total duration is unknown, anything still cooling
 * reports 1 (full overlay) — callers should prefer CooldownTracker.
 */
export function sweepFraction(
  readyAtTick: number,
  nowTick: number,
  durationTicks: number | null,
): number {
  if (nowTick >= readyAtTick) return 0;
  if (durationTicks === null || durationTicks <= 0) return 1;
  return Math.min(1, (readyAtTick - nowTick) / durationTicks);
}

/**
 * Tracks when each cooldown was first observed so the sweep animates even
 * when the catalog has no duration for it (readyAtTick is an absolute sim
 * tick; the sim never tells us when the cooldown started).
 */
export class CooldownTracker {
  private readonly entries = new Map<string, { readyAtTick: number; startTick: number }>();

  /**
   * Fraction remaining in [0,1]. `fallbackDurationTicks` (catalog) is used
   * to back-compute the start when a new cooldown appears mid-flight.
   */
  fraction(
    key: string,
    readyAtTick: number,
    nowTick: number,
    fallbackDurationTicks: number | null = null,
  ): number {
    if (nowTick >= readyAtTick) {
      this.entries.delete(key);
      return 0;
    }
    let entry = this.entries.get(key);
    if (entry === undefined || entry.readyAtTick !== readyAtTick) {
      const backStart =
        fallbackDurationTicks !== null && fallbackDurationTicks > 0
          ? readyAtTick - fallbackDurationTicks
          : nowTick;
      entry = { readyAtTick, startTick: Math.min(backStart, nowTick) };
      this.entries.set(key, entry);
    }
    const span = entry.readyAtTick - entry.startTick;
    if (span <= 0) return 0;
    return Math.max(0, Math.min(1, (entry.readyAtTick - nowTick) / span));
  }
}

/** Total cooldown ticks for an inventory item, from the display catalog. */
export function itemCooldownTicks(
  catalog: Pick<Ruleset, 'equipment' | 'weapons'>,
  itemId: string,
): number | null {
  const weapon = catalog.weapons[itemId];
  if (weapon !== undefined) return weapon.cooldownTicks;
  const active = catalog.equipment[itemId]?.active;
  if (active !== undefined && active !== null && 'cooldownTicks' in active) {
    return active.cooldownTicks;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Item / ability display
// ---------------------------------------------------------------------------

const WEAPON_EMOJI: Record<string, string> = {
  phoenixFire: '\u{1F525}', // fire
  stormBolt: '\u{26A1}', // zap
  kaboomMissile: '\u{1F680}', // rocket
};

const EQUIPMENT_EMOJI: Record<string, string> = {
  hull: '\u{1F6E1}', // shield
  sail: '\u{26F5}', // sailboat
  repair: '\u{1F527}', // wrench
  utility: '\u{1F9ED}', // compass
  consumable: '\u{1F9EA}', // test tube
};

export interface ItemDisplay {
  name: string;
  emoji: string;
}

/** Display name + placeholder emoji for any purchasable/carried item id. */
export function itemDisplay(
  catalog: Pick<Ruleset, 'equipment' | 'weapons'>,
  itemId: string,
): ItemDisplay {
  const weapon = catalog.weapons[itemId];
  if (weapon !== undefined) {
    return { name: weapon.name, emoji: WEAPON_EMOJI[weapon.mechanic] ?? '\u{1F4A5}' };
  }
  const equip = catalog.equipment[itemId];
  if (equip !== undefined) {
    return { name: equip.name, emoji: EQUIPMENT_EMOJI[equip.category] ?? '\u{1F4E6}' };
  }
  return { name: itemId, emoji: '\u{1F4E6}' }; // package
}

/** Ability mechanics with no castable active component. */
const PASSIVE_MECHANICS = new Set(['hullHp', 'sailSpeed', 'mechanicsRegen', 'trueSightPassive']);

/**
 * The ability the F key casts: the ship's first INNATE non-passive ability
 * (Dive, Hide, Captain's Cannon...). Hero skills are not F-castable here.
 */
export function shipActiveAbilityId(
  catalog: Pick<Ruleset, 'ships' | 'abilities'>,
  shipTypeId: string,
): string | null {
  const ship = catalog.ships[shipTypeId];
  if (ship === undefined) return null;
  for (const abilityId of ship.abilityIds) {
    const ability = catalog.abilities[abilityId];
    if (ability !== undefined && ability.kind === 'innate' && !PASSIVE_MECHANICS.has(ability.mechanic)) {
      return abilityId;
    }
  }
  return null;
}

/**
 * Cooldown bookkeeping for an ability: readyAtTick from the player's
 * cooldownGroups (keyed by abilityId or the linked weapon's group), total
 * duration from the catalog when known.
 */
export function abilityCooldownInfo(
  catalog: Pick<Ruleset, 'abilities' | 'weapons'>,
  cooldownGroups: Record<string, number>,
  abilityId: string,
): { readyAtTick: number; durationTicks: number | null } {
  const ability = catalog.abilities[abilityId];
  const weapon =
    ability?.weaponId !== null && ability?.weaponId !== undefined
      ? catalog.weapons[ability.weaponId]
      : undefined;
  const keys = [abilityId];
  if (weapon !== undefined) {
    keys.push(weapon.id);
    if (weapon.cooldownGroup !== null) keys.push(weapon.cooldownGroup);
  }
  let readyAtTick = 0;
  for (const key of keys) {
    const value = cooldownGroups[key];
    if (value !== undefined && value > readyAtTick) readyAtTick = value;
  }
  const durationTicks = ability?.cooldownTicks ?? weapon?.cooldownTicks ?? null;
  return { readyAtTick, durationTicks };
}

// ---------------------------------------------------------------------------
// Minimap transform (linear, y flipped, NO foreshortening)
// ---------------------------------------------------------------------------

export interface MapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MinimapTransform {
  width: number;
  height: number;
  scale: number;
  toMini(x: number, y: number): { x: number; y: number };
  toWorld(mx: number, my: number): { x: number; y: number };
}

/**
 * Uniform world->minimap mapping: the longer map axis spans `maxPx` pixels,
 * aspect preserved, +y north drawn upward (canvas y flipped).
 */
export function createMinimapTransform(bounds: MapBounds, maxPx = 220): MinimapTransform {
  const worldW = Math.max(1, bounds.maxX - bounds.minX);
  const worldH = Math.max(1, bounds.maxY - bounds.minY);
  const scale = maxPx / Math.max(worldW, worldH);
  return {
    width: Math.round(worldW * scale),
    height: Math.round(worldH * scale),
    scale,
    toMini(x: number, y: number) {
      return { x: (x - bounds.minX) * scale, y: (bounds.maxY - y) * scale };
    },
    toWorld(mx: number, my: number) {
      return { x: bounds.minX + mx / scale, y: bounds.maxY - my / scale };
    },
  };
}

// ---------------------------------------------------------------------------
// Shop proximity
// ---------------------------------------------------------------------------

export interface ShopCandidate {
  id: number;
  typeId: string;
  x: number;
  y: number;
}

/**
 * Nearest shop structure whose ShopSpec.interactRadius covers the ship,
 * or null. Pure distance math on snapshot positions.
 */
export function nearestShopInRange(
  ship: { x: number; y: number },
  structures: Iterable<ShopCandidate>,
  shops: Record<string, { interactRadius: number }>,
): ShopCandidate | null {
  let best: ShopCandidate | null = null;
  let bestDistSq = Infinity;
  for (const s of structures) {
    const spec = shops[s.typeId];
    if (spec === undefined) continue;
    const dx = s.x - ship.x;
    const dy = s.y - ship.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= spec.interactRadius * spec.interactRadius && distSq < bestDistSq) {
      bestDistSq = distSq;
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Kill feed
// ---------------------------------------------------------------------------

/**
 * Classify a death event as a feed-worthy kill kind, or null when it should
 * be suppressed. Uses `ruleset.ships` to distinguish player ships from creeps
 * (the same gate match.ts uses for kill/death tallies):
 *   - 'playerKill'  : victim is a player ship, killed by another player
 *   - 'playerDeath' : victim is a player ship, unattributed kill
 *   - 'neutral'     : victim is a non-player unit (creep, structure, summon)
 *   - null          : not a death event at all
 *
 * Lane-creep deaths have a non-null victimPlayer (the AI empire slot 0/1),
 * but entityTypeId is NOT in ruleset.ships, so they classify as 'neutral'.
 */
export function classifyKillEvent(
  ev: SimEvent,
  ruleset: Pick<Ruleset, 'ships'>,
): 'playerKill' | 'playerDeath' | 'neutral' | null {
  if (ev.type !== 'death') return null;
  // Only events where the victim entity is a player ship type make the feed.
  if (!(ev.entityTypeId in ruleset.ships)) return 'neutral';
  if (ev.killerPlayer !== null) return 'playerKill';
  return 'playerDeath';
}

/**
 * Kill-feed line for a death event, or null when it is not feed-worthy
 * (only player-ship deaths make the feed — entity must be in ruleset.ships).
 * `nameOf` resolves a player slot to a display name.
 */
export function killFeedLine(
  ev: SimEvent,
  nameOf: (slot: number) => string,
  ruleset?: Pick<Ruleset, 'ships'>,
): string | null {
  if (ev.type !== 'death' || ev.victimPlayer === null) return null;
  // If a ruleset is provided, gate on ship-type to suppress creep deaths.
  if (ruleset !== undefined && !(ev.entityTypeId in ruleset.ships)) return null;
  const victim = nameOf(ev.victimPlayer);
  if (ev.killerPlayer === null) return `${victim} was sunk`;
  return `${nameOf(ev.killerPlayer)} sunk ${victim}`;
}

/** Seconds string for a remaining-ticks countdown ('12' / '3.4'). */
export function cooldownSecondsText(remainingTicks: number, tickRate: number): string {
  const seconds = Math.max(0, remainingTicks) / tickRate;
  if (seconds >= 10) return String(Math.ceil(seconds));
  return (Math.ceil(seconds * 10) / 10).toFixed(1);
}
