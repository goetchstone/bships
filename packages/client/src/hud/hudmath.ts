/**
 * Pure HUD logic — no DOM, no cross-module imports (only types from core).
 * Everything here is unit-tested in test/hud.test.ts without a browser.
 */

import type { AbilitySpec, Ruleset, SimEvent } from '@bships/core';

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

/** Placeholder emoji per ability mechanic for the spellbook quick-keys. */
const ABILITY_EMOJI: Record<string, string> = {
  shoreLeave: '\u{2693}', // anchor — go ashore to repair
  ensnare: '\u{1F578}', // spider web — Fishing Net
  invisibility: '\u{1F47B}', // ghost — Hide / smoke
  dive: '\u{1F30A}', // wave — submarine dive
  flareDetection: '\u{1F4E1}', // satellite antenna — detector / echo-location
  stormBoltWeapon: '\u{1F4A5}', // collision — Captain's Cannon / Torpedo
  phoenixFireWeapon: '\u{1F525}', // fire
  // Passive hero skills — never cast, but rank-able in the SKILLS strip, so
  // they need distinct icons there (otherwise hull/sails/repair all read alike).
  hullHp: '\u{1F6E1}', // shield — Enforced / Reinforced / Super Hull
  sailSpeed: '\u{26F5}', // sailboat — Ship Sails
  mechanicsRegen: '\u{1F527}', // wrench — Onboard Mechanics / Repair Crew
  trueSightPassive: '\u{1F441}', // eye — True Sight
};

/** Per-special-kind icon, so the exotic kit reads distinctly in the spellbook. */
const SPECIAL_KIND_EMOJI: Record<string, string> = {
  capsize: '\u{1F4A5}', // collision — suicidal explosion
  empBlast: '\u{26A1}', // zap — EMP
  acidBomb: '\u{1F9EA}', // test tube — acid flask
  freezeWater: '\u{2744}', // snowflake — freeze water
  sailRipper: '\u{2702}', // scissors — rip the sails
  boardShip: '\u{1FA9D}', // hook — board / grapple
  disrupt: '\u{1F507}', // muted speaker — silence
  repairHot: '\u{1F527}', // wrench — hull repair
  summonSwarm: '\u{1F988}', // shark — summoned sea swarm
  mirrorImage: '\u{1F47B}', // ghost — bogus ship
  devour: '\u{1F40B}', // whale — eat hero
  intercept: '\u{1F4A8}', // dashing — speed burst
  barrier: '\u{1F6E1}', // shield — divine barrier
  sendSpy: '\u{1F575}', // detective — spy
  goblinMine: '\u{1F4A3}', // bomb — goblin mine
  slowAura: '\u{1F40C}', // snail — slow aura (passive)
  damageAura: '\u{1F32B}', // fog — aura of fright (passive)
  regenAura: '\u{1F49A}', // green heart — regen aura (passive)
};

/** Placeholder icon for a hull ability quick-key, by its mechanic / kind. */
export function abilityIcon(catalog: Pick<Ruleset, 'abilities'>, abilityId: string): string {
  const ability = catalog.abilities[abilityId];
  if (ability?.mechanic === 'special' && ability.special) {
    return SPECIAL_KIND_EMOJI[ability.special.kind] ?? '\u{1F300}';
  }
  const mechanic = ability?.mechanic;
  return (mechanic !== undefined ? ABILITY_EMOJI[mechanic] : undefined) ?? '\u{1F300}'; // cyclone
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
 * Mechanics the sim CANNOT actively cast for the deprecated F-key picker:
 * passive 'special' auras (Slow Aura, Ghost cloud, regen aura) and the inert
 * missile-route share mechanic 'special', so the picker still skips the whole
 * bucket (it predates per-kind dispatch). The full spellbook (shipAbilitySlots)
 * surfaces the ACTIVE specials via isActiveSpecial instead.
 */
const UNIMPLEMENTED_MECHANICS = new Set(['special']);

/**
 * Mechanics the sim actively CASTS (an active the player triggers). Passive
 * mechanics (PASSIVE_MECHANICS) never claim a quick-key. 'special' is NOT a
 * blanket member here — only its ACTIVE kinds are castable (isActiveSpecial),
 * since the same mechanic also covers passive auras (Slow Aura, Ghost cloud)
 * and the inert missile route, which must never grab a quick-key. Shore Leave
 * is castable (a harbour repair) even though it is innate.
 */
const CASTABLE_MECHANICS = new Set([
  'shoreLeave',
  'flareDetection',
  'ensnare',
  'invisibility',
  'dive',
  'stormBoltWeapon',
  'phoenixFireWeapon',
]);

/**
 * Special-ability kinds the player UNIT-targets (a click on an enemy/ally).
 * The other active kinds are self-centred or point-cast (handled below).
 */
const UNIT_TARGET_SPECIAL_KINDS = new Set([
  'capsize', // suicidal nuke on a target ship
  'acidBomb', // acid flask on a target unit/structure
  'sailRipper', // sail-shredding shot on a target ship
  'boardShip', // root + DoT on a target ship
  'devour', // Eat / Digest Hero on a target ship
  'sendSpy', // drop a spy on a target ship
  'goblinMine', // mark a target ship
  'repairHot', // heal a friendly ship/building
]);

/**
 * A 'special' ability the player can actively cast (gets a quick-key): decoded
 * params present, not a passive aura, and not the missile route. Mirrors
 * specials.ts castSpecial (which rejects passive auras as 'passiveAura').
 */
export function isActiveSpecial(ability: Pick<AbilitySpec, 'mechanic' | 'special'>): boolean {
  return (
    ability.mechanic === 'special' &&
    ability.special !== null &&
    !ability.special.passive &&
    ability.special.kind !== 'fireMissile'
  );
}

/** One renderable ability quick-key: the ability + the click it needs. */
export interface AbilitySlot {
  abilityId: string;
  targeting: 'unit' | 'point' | 'none';
}

/**
 * The FULL ordered spellbook of CASTABLE abilities on a hull — one quick-key
 * per ability the sim can actually run (a Crusader shows several, a Sailor
 * fewer). Skips passives (hull/sails/regen/true-sight: ranked in the level-up
 * picker, never cast) and the unimplemented 'special' bucket (a guaranteed
 * silent no-op). Order follows ShipSpec.abilityIds so the slots are stable.
 * Replaces the single shipActiveAbilityId F path. Pure catalog lookup.
 */
export function shipAbilitySlots(
  catalog: Pick<Ruleset, 'ships' | 'abilities'>,
  shipTypeId: string,
): AbilitySlot[] {
  const ship = catalog.ships[shipTypeId];
  if (ship === undefined) return [];
  const slots: AbilitySlot[] = [];
  for (const abilityId of ship.abilityIds) {
    const ability = catalog.abilities[abilityId];
    if (ability === undefined) continue;
    if (!CASTABLE_MECHANICS.has(ability.mechanic) && !isActiveSpecial(ability)) continue;
    slots.push({ abilityId, targeting: abilityTargetingMode(catalog, abilityId) });
  }
  return slots;
}

/** One learnable hero skill (level-up picker row): id + max rank gate. */
export interface LearnableSkill {
  abilityId: string;
  ranks: number;
  minHeroLevel: number;
  levelsPerRank: number;
}

/**
 * The hull's LEARNABLE hero skills, in ability order — every ability carrying a
 * HeroSkillRule (skill !== null), passive OR active. This is the level-up picker
 * list: clicking a row sends learnSkill to rank it (the sim + server gate on
 * unspent points / hero level / max rank). Includes passives (Enforced Hull,
 * Ship Sails, Mechanics Crew) which are ranked here but never get a quick-key.
 * Pure catalog lookup.
 */
export function shipLearnableSkills(
  catalog: Pick<Ruleset, 'ships' | 'abilities'>,
  shipTypeId: string,
): LearnableSkill[] {
  const ship = catalog.ships[shipTypeId];
  if (ship === undefined) return [];
  const out: LearnableSkill[] = [];
  for (const abilityId of ship.abilityIds) {
    const skill = catalog.abilities[abilityId]?.skill;
    if (skill === null || skill === undefined) continue;
    out.push({
      abilityId,
      ranks: skill.ranks,
      minHeroLevel: skill.minHeroLevel,
      levelsPerRank: skill.levelsPerRank,
    });
  }
  return out;
}

/**
 * The hull's learnable hero skills that DON'T get a castable quick-key — the
 * PASSIVES (Enforced/Reinforced/Super Hull, Onboard Mechanics Crew, Ship Sails,
 * Slow/Damage/Regen auras, Nautical engineer...). These carry a HeroSkillRule
 * (so a skill point ranks them up and they matter — hull HP, move speed, regen)
 * but never appear in shipAbilitySlots, so the cast-bar level-up picker can
 * never reach them. The dedicated "Skills" strip renders THESE so every
 * learnable skill has exactly one place to spend a point: castable-learnable
 * skills keep their + in the cast bar, passive ones get it here. Without this
 * the bulk of a hull's progression (and, for hulls whose only castable skills
 * are high-level-gated, ALL of it) is unspendable — the owner's "I can't learn
 * it / bigger ships show no skills" bug. Pure catalog lookup.
 */
export function shipPassiveLearnableSkills(
  catalog: Pick<Ruleset, 'ships' | 'abilities'>,
  shipTypeId: string,
): LearnableSkill[] {
  const castable = new Set(shipAbilitySlots(catalog, shipTypeId).map((s) => s.abilityId));
  return shipLearnableSkills(catalog, shipTypeId).filter((s) => !castable.has(s.abilityId));
}

/**
 * Whether `learnSkill` would be ACCEPTED right now for this ability — mirrors
 * the sim's progression gate (unspent point + hero level >= the rank's minimum
 * + below max rank). Pure; lets the picker disable rows the sim would reject so
 * a click is never a silent no-op. `currentRank` is heroSkillLevels[id] ?? 0.
 */
export function canLearnSkill(
  skill: LearnableSkill,
  currentRank: number,
  heroLevel: number,
  unspentSkillPoints: number,
): boolean {
  if (unspentSkillPoints <= 0) return false;
  if (currentRank >= skill.ranks) return false;
  // arlv (minHeroLevel) gates rank 1; alsk (levelsPerRank) spaces later ranks.
  const requiredLevel = skill.minHeroLevel + currentRank * skill.levelsPerRank;
  return heroLevel >= requiredLevel;
}

/**
 * The ability the F key casts: the ship's first INNATE non-passive ability.
 *
 * Shore Leave (mechanic 'shoreLeave', ability A01D) is innate on nearly every
 * hull and sorts FIRST in the ability list, so the naive "first innate active"
 * would always bind F to a harbour-gated repair that does nothing while the ship
 * is out fighting/trading — the owner's "abilities don't fire" report. We
 * therefore PREFER a combat-relevant innate active (Dive, Fishing Net/ensnare,
 * Captain's Cannon stormBolt, flare, invisibility...) and only fall back to
 * Shore Leave when the hull has no other castable innate. Hero skills are not
 * F-castable here. Mechanics with no live sim handler ('special') are skipped
 * so F never binds to a guaranteed 'unimplemented' rejection. Pure catalog
 * lookup.
 *
 * @deprecated The HUD now renders the full spellbook via shipAbilitySlots;
 * retained for the existing catalog-coverage tests.
 */
export function shipActiveAbilityId(
  catalog: Pick<Ruleset, 'ships' | 'abilities'>,
  shipTypeId: string,
): string | null {
  const ship = catalog.ships[shipTypeId];
  if (ship === undefined) return null;
  let shoreLeaveFallback: string | null = null;
  for (const abilityId of ship.abilityIds) {
    const ability = catalog.abilities[abilityId];
    if (
      ability === undefined ||
      ability.kind !== 'innate' ||
      PASSIVE_MECHANICS.has(ability.mechanic) ||
      UNIMPLEMENTED_MECHANICS.has(ability.mechanic)
    ) {
      continue;
    }
    if (ability.mechanic === 'shoreLeave') {
      // Remember the first Shore Leave but keep scanning for a combat active.
      if (shoreLeaveFallback === null) shoreLeaveFallback = abilityId;
      continue;
    }
    return abilityId;
  }
  return shoreLeaveFallback;
}

/**
 * Targeting mode the F-key ability needs before it can be cast: 'unit' (ensnare
 * — the Fishing Net pins an enemy ship), 'point' (flare detection drops at a
 * map point), or 'none' (Dive / Shore Leave / invisibility — self-cast). Drives
 * the client's pending-target arming so a targeted ability isn't sent without a
 * target (which the sim rejects). Pure catalog lookup; unknown -> 'none'.
 */
export function abilityTargetingMode(
  catalog: Pick<Ruleset, 'abilities'>,
  abilityId: string,
): 'unit' | 'point' | 'none' {
  const ability = catalog.abilities[abilityId];
  const mechanic = ability?.mechanic;
  // ensnare (Fishing Net) and stormBoltWeapon (sub Torpedo / Captain's Cannon)
  // both fire at an ENEMY unit — combat.applyCombatCommand / castNet reject the
  // cast as 'invalidTarget'/'missingTarget' without a targetId.
  if (mechanic === 'ensnare' || mechanic === 'stormBoltWeapon') return 'unit';
  if (mechanic === 'flareDetection') return 'point';
  // Exotic 'special' kit: the unit-target kinds need an enemy/ally click; the
  // area-silence (disrupt) needs a map point; the rest are self/self-centred.
  if (mechanic === 'special' && ability?.special) {
    const kind = ability.special.kind;
    if (UNIT_TARGET_SPECIAL_KINDS.has(kind)) return 'unit';
    if (kind === 'disrupt') return 'point';
    return 'none';
  }
  return 'none';
}

/**
 * Targeting mode an item's active needs: 'point' (blink/flare-style teleport),
 * 'unit' (reveal / rejuvenation cast on an ally), or 'none' (self / untargeted:
 * instant heal, invisibility, xp tome, summon, flavour). Drives the same
 * pending-target arming for the W/E/R/A/S/D slots. Pure catalog lookup.
 */
export function itemTargetingMode(
  catalog: Pick<Ruleset, 'equipment'>,
  itemId: string,
): 'unit' | 'point' | 'none' {
  const active = catalog.equipment[itemId]?.active;
  if (active === null || active === undefined) return 'none';
  if (active.kind === 'blink') return 'point';
  if (active.kind === 'reveal' || active.kind === 'rejuvenation') return 'unit';
  return 'none';
}

// ---------------------------------------------------------------------------
// Targeting cue (the armed-cast on-screen prompt)
// ---------------------------------------------------------------------------

/**
 * The store's armed-target shape (mirrors store.ui.pendingTarget) — an ability
 * (by abilityId) or an item (by slot) awaiting a 'unit' or 'point' map click.
 * Re-declared here so the cue text is a pure, DOM-free, store-free helper.
 */
export interface PendingTargetLike {
  kind: 'item' | 'ability';
  targeting: 'point' | 'unit';
  slot?: number;
  abilityId?: string;
}

/**
 * The on-screen prompt for an armed targeted cast (BUG 2 cue): names the
 * ability/item and says WHAT to click — "click an enemy ship" for a unit cast
 * (e.g. Fishing Net / Captain's Cannon / Capsize), "click a location" for a
 * point cast (e.g. Echo-Location / Light Teleporter). Mirrors the wording of
 * the attack-move cue so the two armed states read the same. Pure catalog
 * lookup for abilities; the caller supplies an item's display name via
 * `itemName` (it owns the slot->itemId mapping). An unknown id still yields a
 * sensible generic line. The caller adds the "right-click or Esc to cancel"
 * hint in the UI chrome.
 */
export function targetingCueText(
  catalog: Pick<Ruleset, 'abilities'>,
  pending: PendingTargetLike,
  itemName: string | null = null,
): string {
  const name =
    pending.kind === 'ability' && pending.abilityId !== undefined
      ? (catalog.abilities[pending.abilityId]?.name ?? 'Ability')
      : (itemName ?? 'Item');
  const what = pending.targeting === 'unit' ? 'click an enemy ship' : 'click a location';
  return `${name}: ${what}`;
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
// Own-ship lookup (drop / order targeting)
// ---------------------------------------------------------------------------

/** Minimal snapshot-entity shape needed to find the player's own ship. */
export interface OwnShipCandidate {
  kind: string;
  ownerSlot: number | null;
  x: number;
  y: number;
}

/**
 * The viewer's own living ship position from a world sample, or null when the
 * ship is not in the sample (dead / not yet spawned / no slot). Pure — used by
 * the inventory drop affordance to fill the dropItem command's drop point (the
 * sim drops AT the ship and re-validates reach).
 */
export function ownShipPosition(
  entities: Iterable<OwnShipCandidate>,
  mySlot: number | null,
): { x: number; y: number } | null {
  if (mySlot === null) return null;
  for (const en of entities) {
    if (en.kind === 'ship' && en.ownerSlot === mySlot) return { x: en.x, y: en.y };
  }
  return null;
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

// ---------------------------------------------------------------------------
// Command-rejection messages (turn the sim's terse reasons into player help)
// ---------------------------------------------------------------------------

/**
 * Human-readable feedback for a sim 'commandRejected' reason — so a silent
 * no-op (e.g. casting a rank-0 hero skill) reads as a clear "here's why / here's
 * what to do" line instead of leaving the player thinking abilities don't work.
 * `label` is the friendly name of the rejected thing (ability/item) when known;
 * it lets the message name the offending slot. Reasons with no mapping fall back
 * to the terse "Cannot <command>: <reason>" form the caller composes.
 *
 * The canonical reasons live in the sim (specials.ts / progression.ts): the
 * key ones for the spellbook are 'notLearned' (rank 0), 'noSkillPoints',
 * 'levelTooLow', 'maxRank', 'notAtMainHarbour' (Shore Leave), and the
 * target reasons ('missingTarget' / 'needsTarget' / 'invalidTarget').
 */
export function rejectionMessage(reason: string, label: string | null): string {
  const name = label ?? 'That ability';
  switch (reason) {
    case 'notLearned':
      return `${name} isn't learned yet — spend a skill point (the + on its slot).`;
    case 'noSkillPoints':
      return 'No skill points to spend — level up first to earn one.';
    case 'levelTooLow':
      return `${name} needs a higher hero level before you can rank it up.`;
    case 'maxRank':
      return `${name} is already at max rank.`;
    case 'notAtMainHarbour':
      return 'Shore Leave only works at your Main Harbour — sail home to repair.';
    case 'missingTarget':
    case 'needsTarget':
      return `${name} needs a target — pick one, then cast.`;
    case 'invalidTarget':
      return `${name} can't be cast on that target.`;
    default:
      return label === null ? `Cannot do that: ${reason}` : `Cannot use ${name}: ${reason}`;
  }
}
