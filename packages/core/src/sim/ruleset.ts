/**
 * Ruleset compiler — turns the audited data/json extracts into the runtime
 * Ruleset every system consumes. No other module may read data/json shapes
 * directly.
 *
 * Ground truth (read, never invent numbers): data/json/weapons.json,
 * equipment.json, ships.json, upgrade-curves.json, script-rules.json,
 * map-layout.json; units.json/abilities.json/items.json for unit-type
 * stats, ability curves and stock/cooldown-group fields. WC3 base defaults
 * baked here are the ones documented in BALANCE.md §9.3 / SEMANTICS.md.
 *
 * Compile conventions (docs/SEMANTICS.md):
 * - seconds -> ticks via secondsToTicks(s, tickRate); tickRate = TICK_RATE.
 * - moveSpeed stays units/sec in specs (movement divides per tick);
 *   projectile speeds are precompiled to units/TICK.
 * - Hero effective stats (all BSP ships str=agi=1): maxHp = uhpm + 25,
 *   armor = udef - 1.7; raw fields preserved on ShipSpec for audit.
 * - TFT attack-vs-defense table baked in: spells row x0.70 vs hero, x1.00
 *   otherwise; normal/pierce/siege rows per SEMANTICS §1.
 * - PF buff gates: Acid BNab 20 s, Nuke B016 4 s, everything else 0.01 s
 *   (compiles to 1 tick, effectively ungated) — all read from abilities.json.
 * - Classic constants: missileExplodeOnDeathDoubling=false, sellbackRate=0,
 *   friendlyFire=false, speed clamps 150/400, heroLevelCap=12 (provisional).
 * - Stable instanceKeys for structures: use the map-data id when present
 *   ('n003_0024'), else `${typeId}@${x},${y}`.
 *
 * PROVISIONAL values (flagged, never silently guessed — SEMANTICS.md open
 * questions; each is a named constant below):
 * - lane-ship attack/defense types (pierce/heavy) and tower/HQ (siege/
 *   fortified) pending the 1.24 SLK extraction; unextracted unit armor 0.
 * - heroLevelCap 12 pending war3mapMisc.txt.
 * - AIlf hull-skill and Arll mechanics-skill rank curves: object data only
 *   carries levels 7-10 (slope 30 HP / 1 HP/s per rank); ranks 1-6 are the
 *   linear extension of that slope.
 * - shop interact radius 450 for shops without an A057 override (stock Aneu
 *   select range); Main Harbor 400 from A057 aran (data).
 * - Motion Detector ward lifetime 20 s (stock Healing Ward default; the map
 *   likely trigger-manages it).
 * - h00B Imperial Battle Ship level 3 (base hdes ulev, not overridden).
 * - neutral shop structures without a uhpm override get 500000 HP (matches
 *   the map's explicit overrides on its other neutral shops).
 * - ships' vestigial Hpal native-attack DAMAGE is NOT compiled: units.json
 *   carries no ua1b override and the Hpal base value awaits the 1.24 SLK
 *   extraction (SEMANTICS §2). Only the acquisition range (ua1r 1000) is
 *   compiled onto ShipSpec.nativeAttackRangeUnits so attackTarget chases
 *   stop at range instead of ramming; ships deal no native-attack damage.
 */

import { TICK_RATE } from '../index.js';
import type {
  AbilitySpec,
  AttackType,
  BountySpec,
  ContractRules,
  DefenseType,
  DotSpec,
  EquipmentActive,
  EquipmentPassives,
  EquipmentSpec,
  GameModeSpec,
  HeroSkillRule,
  IncomeRules,
  LaneSpec,
  MapSpec,
  MissileRules,
  NavField,
  QuestSystems,
  RawDataFiles,
  RawEquipmentRow,
  RawMapLayoutFile,
  RawQuestSystems,
  RawScriptedItemRow,
  RawShipRow,
  RawTerrainFile,
  RawTradeRouteRow,
  RawUpgradeRow,
  RawWeaponRow,
  RefinerySpec,
  RefineryRewardRoute,
  RegionRect,
  RepairMissionSpec,
  RespawnRules,
  Ruleset,
  RulesetConstants,
  RulesetPatch,
  ShipSpec,
  ShopItemEntry,
  ShopSpec,
  StackRule,
  StructurePlacement,
  StructureEntity,
  SubRules,
  SuicideQuestSpec,
  TargetFilter,
  TeamId,
  TradeRouteSpec,
  TreasureHuntSpec,
  UnitAttackSpec,
  UnitTypeSpec,
  UpgradeSpec,
  WaterMask,
  WaveSpec,
  WeaponSpec,
  XpRules,
} from './types.js';
import { NAV_UNREACHABLE, pointInRegion, secondsToTicks } from './types.js';

// ---------------------------------------------------------------------------
// Provisional / WC3-base-default constants (every one is documented in the
// header; changing any of these is a balance change, not a refactor)
// ---------------------------------------------------------------------------

/** SEMANTICS §6: cap unknown, >= 11 certain; 12 covers every learnable rank. */
const PROVISIONAL_HERO_LEVEL_CAP = 12;
/** SLK defaults not extracted (SEMANTICS §1) — lane ships (hdes base). */
const PROVISIONAL_CREEP_ATTACK_TYPE: AttackType = 'pierce';
/** SLK defaults not extracted — towers/HQ (nmer base, artillery weapon). */
const PROVISIONAL_STRUCTURE_ATTACK_TYPE: AttackType = 'siege';
const PROVISIONAL_CREEP_DEFENSE_TYPE: DefenseType = 'heavy';
const PROVISIONAL_STRUCTURE_DEFENSE_TYPE: DefenseType = 'fortified';
/** Stock Aneu select-unit range; only n000's A057 overrides it (400). */
const PROVISIONAL_SHOP_INTERACT_RADIUS = 450;
/** Stock Healing Ward lifetime — whwd ward duration unresolved (§9.4). */
const PROVISIONAL_MOTION_DETECTOR_LIFETIME_S = 20;
/** Base hdes unit level (h00B carries no ulev override). */
const PROVISIONAL_H00B_LEVEL = 3;
/** The map sets 500000 on its other neutral shops; SLK default unknown. */
const PROVISIONAL_NEUTRAL_STRUCTURE_HP = 500000;
/** Invulnerable wards/dummies without uhpm (HP is inert behind Avul). */
const PROVISIONAL_WARD_HP = 20;
/** BALANCE §9.3: AHtb Missilespeed = 1000 (HumanAbilityFunc.txt). */
const AHTB_DEFAULT_MISSILE_SPEED = 1000;
/** BALANCE §9.3: Arel = 2 HP/s (Ring of Regeneration baseline). */
const AREL_DEFAULT_HP_PER_SEC = 2;
/** SEMANTICS §5: H001's Adtg true-sight radius (stock 1200). */
const ADTG_TRUE_SIGHT_RADIUS = 1200;
/** SEMANTICS §5: stock sentry-ward (oeye) true-sight/vision radius. */
const PROVISIONAL_SENTRY_WARD_SIGHT = 1600;
/** WC3 engine: 0.20 rad per 0.03 s frame is the effective turn-rate cap. */
const TURN_RATE_FRAME_CAP = 0.2;
const ENGINE_FRAME_SECONDS = 0.03;
/** Gameplay-constant defaults (no war3mapMisc.txt found — SEMANTICS §3). */
const DEFAULT_MIN_MOVE_SPEED = 150;
const DEFAULT_MAX_MOVE_SPEED = 400;

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new Error(`ruleset compile: ${msg}`);
}

function mustNum(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} is missing or not a finite number (got ${String(v)})`);
  return v;
}

function optNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function mustStr(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(`${what} is missing or empty`);
  return v;
}

/** First capture group of `re` in `text` as a number, or null. */
function matchNum(text: string, re: RegExp): number | null {
  const m = text.match(re);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

function requireMention(haystack: string, needle: string, where: string): void {
  if (!haystack.includes(needle)) {
    fail(`${where}: expected the extracted script rules to mention '${needle}' — data layout changed?`);
  }
}

/** Insert record entries in ascending key order (stable output). */
function sortedRecord<T>(entries: [string, T][]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (k in out) fail(`duplicate record key '${k}'`);
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Narrow extractors over the raw object-data dumps (units/abilities/items).
// Shape: { objects: { rawcode: { base, mods: [{id, value, level?}] } } }
// ---------------------------------------------------------------------------

interface ObjectDataTable {
  /** rawcode -> base rawcode. */
  bases: Record<string, string>;
  /** rawcode -> (fieldId or `fieldId:level`) -> value. */
  fields: Record<string, Record<string, unknown>>;
}

function indexObjectData(raw: unknown, label: string): ObjectDataTable {
  if (typeof raw !== 'object' || raw === null || !('objects' in raw)) {
    fail(`${label}: expected an object-data dump with an 'objects' record`);
  }
  const objects = (raw as { objects: unknown }).objects;
  if (typeof objects !== 'object' || objects === null) fail(`${label}: 'objects' is not a record`);
  const bases: Record<string, string> = {};
  const fields: Record<string, Record<string, unknown>> = {};
  for (const code of Object.keys(objects as Record<string, unknown>).sort()) {
    const row = (objects as Record<string, unknown>)[code];
    if (typeof row !== 'object' || row === null) fail(`${label}: object '${code}' is not a record`);
    const base = (row as { base?: unknown }).base;
    bases[code] = typeof base === 'string' ? base : code;
    const mods = (row as { mods?: unknown }).mods;
    const table: Record<string, unknown> = {};
    if (Array.isArray(mods)) {
      for (const mod of mods) {
        const id = (mod as { id?: unknown }).id;
        if (typeof id !== 'string') continue;
        const level = (mod as { level?: unknown }).level;
        const key = typeof level === 'number' ? `${id}:${level}` : id;
        table[key] = (mod as { value?: unknown }).value;
      }
    }
    fields[code] = table;
  }
  return { bases, fields };
}

/** Unleveled field (tries plain id, then the level-0 form some dumps use). */
function field(t: ObjectDataTable, code: string, id: string): unknown {
  const row = t.fields[code];
  if (!row) return undefined;
  return row[id] !== undefined ? row[id] : row[`${id}:0`];
}

/** Leveled field, falling back to the unleveled form. */
function fieldAt(t: ObjectDataTable, code: string, id: string, level: number): unknown {
  const row = t.fields[code];
  if (!row) return undefined;
  return row[`${id}:${level}`] !== undefined ? row[`${id}:${level}`] : row[id];
}

function fieldNum(t: ObjectDataTable, code: string, id: string): number | null {
  return optNum(field(t, code, id));
}

function fieldNumAt(t: ObjectDataTable, code: string, id: string, level: number): number | null {
  return optNum(fieldAt(t, code, id, level));
}

function fieldStr(t: ObjectDataTable, code: string, id: string): string | null {
  const v = field(t, code, id);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function abilityList(t: ObjectDataTable, code: string, id: string): string[] {
  const v = fieldStr(t, code, id);
  if (v === null) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Targets-allowed parsing (weapons.json prose / atar / ua1g token lists)
// ---------------------------------------------------------------------------

function parseTargetFilter(text: string, what: string): TargetFilter {
  // Prefer the explicit atar list when the prose embeds one; otherwise use
  // the leading token list (before any parenthetical / em-dash commentary).
  const atar = text.match(/atar:?\s*([a-z,]+)/i);
  let tokenSource: string;
  if (atar?.[1] !== undefined) {
    tokenSource = atar[1];
  } else {
    tokenSource = text.split(/ \(|—|--/)[0] ?? text;
  }
  const tokens = tokenSource
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  const has = (tok: string): boolean => tokens.includes(tok);
  const hero = has('hero');
  const structures = has('structure') || has('structures');
  const ships = hero || has('ground') || has('air');
  if (!ships && !structures) fail(`${what}: could not parse target filter from '${text}'`);
  return { ships, structures, heroOnly: hero && !has('ground') && !has('air') };
}

// ---------------------------------------------------------------------------
// Attack-vs-defense table (TFT defaults; SEMANTICS §1)
// ---------------------------------------------------------------------------

function tftAttackTypeVsDefense(): Record<AttackType, Record<DefenseType, number>> {
  const row = (
    unarmored: number,
    light: number,
    medium: number,
    heavy: number,
    fortified: number,
    hero: number,
    divine: number,
  ): Record<DefenseType, number> => ({
    unarmored,
    light,
    medium,
    heavy,
    fortified,
    hero,
    divine,
    normal: 1.0,
  });
  return {
    normal: row(1.0, 1.0, 1.5, 1.0, 0.7, 1.0, 0.05),
    pierce: row(1.5, 2.0, 0.75, 1.0, 0.35, 0.5, 0.05),
    siege: row(1.5, 1.0, 0.5, 1.0, 1.5, 0.5, 0.05),
    magic: row(1.0, 1.25, 0.75, 2.0, 0.35, 0.5, 0.05),
    chaos: row(1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.4),
    /** All BSP weapons: x0.70 vs hero, x1.00 otherwise (divine n/a). */
    spells: row(1.0, 1.0, 1.0, 1.0, 1.0, 0.7, 1.0),
    hero: row(1.0, 1.0, 1.0, 1.0, 0.5, 1.0, 0.05),
  };
}

// ---------------------------------------------------------------------------
// Weapons (weapons.json rows + ability-curve DoT/buff lookups)
// ---------------------------------------------------------------------------

interface CompileCtx {
  tickRate: number;
  /** Compiled FIRST so ship hero math reads these instead of re-hardcoding. */
  constants: RulesetConstants;
  units: ObjectDataTable;
  abilities: ObjectDataTable;
  items: ObjectDataTable;
}

function weaponMechanicFor(base: string): WeaponSpec['mechanic'] | null {
  if (base === 'Apxf') return 'phoenixFire';
  if (base === 'AHtb') return 'stormBolt';
  if (base === 'Asdg') return 'kaboomMissile';
  return null;
}

function compileWeaponRow(ctx: CompileCtx, row: RawWeaponRow): WeaponSpec | null {
  const base = row.abilityBase ?? null;
  const mechanic = base === null ? null : weaponMechanicFor(base);
  // Non-item weapon mechanics (A055 Goblin Bomber, Ashs base) are delivered
  // through the abilities/specials path, not the weapons table.
  if (mechanic === null) return null;
  const id = mustStr(row.rawcode, 'weapon rawcode');
  const abilityId = row.abilityCode ?? null;
  const damage = mustNum(row.damage, `weapon ${id} damage`);
  const cooldownTicks = secondsToTicks(mustNum(row.cooldown, `weapon ${id} cooldown`), ctx.tickRate);
  // Warheads are map-wide (random structure pick); everything else needs aare/aran.
  const rangeUnits = mechanic === 'kaboomMissile' ? null : mustNum(row.range, `weapon ${id} range`);
  const projectileSpeed = mustNum(row.projectileSpeed, `weapon ${id} projectileSpeed`);
  const targets = parseTargetFilter(mustStr(row.targets, `weapon ${id} targets`), `weapon ${id}`);

  // DoT / buff-gate / cast-time data comes from the granted ability's fields.
  let dot: DotSpec | null = null;
  let buffId: string | null = null;
  let buffDurationTicks = 0;
  let castTimeTicks = 0;
  let homing = true;
  if (abilityId !== null && ctx.abilities.fields[abilityId]) {
    buffId = fieldStr(ctx.abilities, abilityId, 'abuf:1');
    const heroDur = fieldNumAt(ctx.abilities, abilityId, 'ahdu', 1) ?? fieldNumAt(ctx.abilities, abilityId, 'adur', 1);
    if (buffId !== null) {
      buffDurationTicks = secondsToTicks(heroDur ?? 0.01, ctx.tickRate);
    }
    const dotPerSec = fieldNumAt(ctx.abilities, abilityId, 'pxf2', 1);
    if (dotPerSec !== null && dotPerSec > 0) {
      dot = {
        dmgPerTick: dotPerSec / ctx.tickRate,
        durationTicks: secondsToTicks(mustNum(heroDur, `weapon ${id} DoT duration`), ctx.tickRate),
        buffId: mustStr(buffId, `weapon ${id} DoT buff`),
        nonLethal: true, // PF buff DoT clamps at 1 HP (SEMANTICS §2)
      };
    }
    const cast = fieldNumAt(ctx.abilities, abilityId, 'acas', 1);
    if (cast !== null && cast > 0) castTimeTicks = secondsToTicks(cast, ctx.tickRate);
    if (mechanic === 'phoenixFire') {
      homing = fieldNum(ctx.abilities, abilityId, 'amho') !== 0; // amho=0 -> non-homing
    }
  } else if (mechanic === 'phoenixFire') {
    fail(`weapon ${id}: Phoenix Fire row without an abilities.json entry for ${String(abilityId)}`);
  }

  return {
    id,
    name: mustStr(row.name, `weapon ${id} name`),
    abilityId,
    mechanic,
    gold: optNum(row.gold),
    damage,
    cooldownTicks,
    rangeUnits,
    aoeRadius: optNum(row.aoe),
    projectileSpeedPerTick: projectileSpeed / ctx.tickRate,
    homing,
    targets,
    attackType: mechanic === 'kaboomMissile' ? 'normal' : 'spells',
    damageType: mechanic === 'kaboomMissile' ? 'physical' : 'magic',
    noTypeMult: mechanic === 'kaboomMissile',
    dot,
    buffId,
    buffDurationTicks,
    castTimeTicks,
    cooldownGroup: fieldStr(ctx.items, id, 'icid'),
  };
}

/**
 * Hero-skill Storm Bolt weapons (Captain's Cannon, sub torpedo skills).
 * Rank 1 is keyed by the plain abilityId; ranks 2..n are emitted as
 * `${abilityId}:${rank}` variants — the convention combat's
 * resolveRankWeapon looks up (rank key first, base id fallback).
 */
function compileHeroStormBoltWeapon(ctx: CompileCtx, abilityId: string, rank: number): WeaponSpec {
  const name = mustStr(field(ctx.abilities, abilityId, 'anam'), `ability ${abilityId} name`);
  const buffId = fieldStr(ctx.abilities, abilityId, `abuf:${rank}`) ?? fieldStr(ctx.abilities, abilityId, 'abuf:1');
  return {
    id: rank === 1 ? abilityId : `${abilityId}:${rank}`,
    name,
    abilityId,
    mechanic: 'stormBolt',
    gold: null,
    damage: mustNum(fieldNumAt(ctx.abilities, abilityId, 'Htb1', rank), `ability ${abilityId} Htb1:${rank}`),
    cooldownTicks: secondsToTicks(mustNum(fieldNumAt(ctx.abilities, abilityId, 'acdn', rank), `ability ${abilityId} acdn`), ctx.tickRate),
    rangeUnits: mustNum(fieldNumAt(ctx.abilities, abilityId, 'aran', rank), `ability ${abilityId} aran`),
    aoeRadius: null,
    projectileSpeedPerTick: (fieldNum(ctx.abilities, abilityId, 'amsp') ?? AHTB_DEFAULT_MISSILE_SPEED) / ctx.tickRate,
    homing: true,
    targets: parseTargetFilter(fieldStr(ctx.abilities, abilityId, `atar:${rank}`) ?? fieldStr(ctx.abilities, abilityId, 'atar:1') ?? 'enemies,ground', `ability ${abilityId}`),
    attackType: 'spells',
    damageType: 'magic',
    noTypeMult: false,
    dot: null,
    buffId,
    buffDurationTicks: buffId === null ? 0 : secondsToTicks(fieldNumAt(ctx.abilities, abilityId, 'ahdu', rank) ?? 0.01, ctx.tickRate),
    castTimeTicks: 0,
    cooldownGroup: null,
  };
}

// ---------------------------------------------------------------------------
// Equipment (equipment.json prose magnitudes + items.json structured fields)
// ---------------------------------------------------------------------------

const EQUIPMENT_CATEGORIES = ['hull', 'sail', 'repair', 'utility', 'consumable'] as const;

function compileEquipmentRow(ctx: CompileCtx, row: RawEquipmentRow): EquipmentSpec {
  const id = mustStr(row.rawcode, 'equipment rawcode');
  const category = row.category as EquipmentSpec['category'];
  if (!EQUIPMENT_CATEGORIES.includes(category)) fail(`equipment ${id}: unknown category '${row.category}'`);
  const effects = mustStr(row.effects, `equipment ${id} effects`);
  const special = row.special ?? '';

  // Passive stat lines.
  const maxHpBonus = matchNum(effects, /\+(\d+) max HP/);
  const damageReductionPct = matchNum(effects, /(\d+)% damage reduction/);
  const armorBonus = matchNum(effects, /\+(\d+) armor/);
  const moveSpeedPctRaw = matchNum(effects, /([+-]\d+)% move speed/);
  const hpRegenPerSec = matchNum(effects, /\+(\d+) HP\/sec? (?:passive repair|regeneration)/i);
  let passives: EquipmentPassives | null = null;
  if (
    maxHpBonus !== null ||
    damageReductionPct !== null ||
    armorBonus !== null ||
    moveSpeedPctRaw !== null ||
    hpRegenPerSec !== null
  ) {
    passives = {
      maxHpBonus: maxHpBonus ?? 0,
      damageReductionPct: (damageReductionPct ?? 0) / 100,
      armorBonus: armorBonus ?? 0,
      moveSpeedPct: (moveSpeedPctRaw ?? 0) / 100,
      hpRegenPerTick: (hpRegenPerSec ?? 0) / ctx.tickRate,
    };
  }
  if (category === 'hull' && (passives === null || (passives.maxHpBonus === 0 && passives.hpRegenPerTick === 0))) {
    fail(`equipment ${id}: hull row without a parsable HP/regen bonus`);
  }
  if (category === 'sail' && (passives === null || passives.moveSpeedPct <= 0)) {
    fail(`equipment ${id}: sail row without a parsable move-speed bonus`);
  }

  const active = compileEquipmentActive(ctx, id, effects);

  // Charges: items.json iuse when set, else the prose ("1 charge"); endless
  // charges / unlimited uses compile to null.
  const iuse = fieldNum(ctx.items, id, 'iuse');
  let charges: number | null = iuse !== null && iuse > 0 ? iuse : null;
  if (charges === null) {
    const prose = matchNum(effects, /(\d+) charges?\b/);
    if (prose !== null && prose > 0) charges = prose;
  }

  return {
    id,
    name: mustStr(row.name, `equipment ${id} name`),
    category,
    gold: optNum(row.gold),
    passives,
    active,
    charges,
    perishable: /removed if dropped or given away/i.test(effects + special) || special.includes('Trade item'),
    cooldownGroup: fieldStr(ctx.items, id, 'icid'),
  };
}

function compileEquipmentActive(ctx: CompileCtx, id: string, effects: string): EquipmentActive | null {
  const tickRate = ctx.tickRate;
  const cooldownS = matchNum(effects, /cooldown (\d+) s/i);
  const cd = (what: string): number => secondsToTicks(mustNum(cooldownS, `equipment ${id} ${what} cooldown`), tickRate);
  const durationS =
    matchNum(effects, /for (\d+) s\b/) ?? matchNum(effects, /lasts (\d+) s\b/) ?? matchNum(effects, /(\d+) s\b/);
  const buffFromAbility = (): string | null => {
    const iabi = fieldStr(ctx.items, id, 'iabi');
    const abilityId = iabi?.split(',')[0]?.trim();
    return abilityId !== undefined && abilityId.length > 0 ? fieldStr(ctx.abilities, abilityId, 'abuf:1') : null;
  };

  const reju = effects.match(/repairs a friendly[^.]*? for (\d+) HP over (\d+) s/i);
  if (reju !== null) {
    return {
      kind: 'rejuvenation',
      totalHeal: Number(reju[1]),
      durationTicks: secondsToTicks(Number(reju[2]), tickRate),
      rangeUnits: mustNum(matchNum(effects, /cast range (\d+)/i), `equipment ${id} rejuvenation range`),
      buffId: mustStr(buffFromAbility(), `equipment ${id} rejuvenation buff`),
    };
  }
  const heal = matchNum(effects, /restores (\d+) HP/i);
  if (heal !== null) return { kind: 'instantHeal', amount: heal, cooldownTicks: cd('heal') };
  if (/blink/i.test(effects)) {
    return {
      kind: 'blink',
      maxDistance: mustNum(matchNum(effects, /max distance (\d+)/i), `equipment ${id} blink distance`),
      cooldownTicks: cd('blink'),
    };
  }
  const invis = matchNum(effects, /invisible for (\d+) s/i);
  if (invis !== null) {
    return {
      kind: 'invisibility',
      durationTicks: secondsToTicks(invis, tickRate),
      cooldownTicks: cd('invisibility'),
      buffId: mustStr(effects.match(/buff (B[0-9A-Za-z]{3})/)?.[1] ?? buffFromAbility(), `equipment ${id} invisibility buff`),
    };
  }
  if (/spy ward|'Spy' ward/i.test(effects)) {
    requireMention(effects, 'nvil', `equipment ${id}`);
    return {
      kind: 'summonWard',
      wardTypeId: 'nvil',
      durationTicks: secondsToTicks(mustNum(durationS, `equipment ${id} spy duration`), tickRate),
      cooldownTicks: 0,
    };
  }
  if (/sentry ward/i.test(effects)) {
    return {
      kind: 'summonWard',
      wardTypeId: 'oeye',
      durationTicks: secondsToTicks(mustNum(durationS, `equipment ${id} ward duration`), tickRate),
      cooldownTicks: 0,
    };
  }
  if (/motion detector/i.test(effects)) {
    return {
      kind: 'summonWard',
      wardTypeId: 'ohwd',
      durationTicks: secondsToTicks(PROVISIONAL_MOTION_DETECTOR_LIFETIME_S, tickRate),
      cooldownTicks: 0,
    };
  }
  const flareRadius = matchNum(effects, /radius (\d+)/i) ?? matchNum(effects, /(\d+)-radius/i);
  if (/reveals? a target area|reveals \d+-radius/i.test(effects) && flareRadius !== null) {
    return {
      kind: 'flare',
      radius: flareRadius,
      durationTicks: secondsToTicks(mustNum(durationS, `equipment ${id} flare duration`), tickRate),
      cooldownTicks: cd('flare'),
      // SEMANTICS §5 SIM DECISION: flares reveal AND detect invisible.
      detectsInvisible: true,
    };
  }
  if (/targeted reveal/i.test(effects)) {
    return { kind: 'reveal', durationTicks: null }; // wshs duration unresolved (§9.4)
  }
  const xp = matchNum(effects, /\+(\d+) XP/);
  if (xp !== null) return { kind: 'xpTome', xp };
  const summon = effects.match(/Summons a '([^']+)' \(unit (\w{4})\)[^.]*? for (\d+) s/);
  if (summon !== null) {
    return {
      kind: 'summonUnit',
      unitTypeId: mustStr(summon[2], `equipment ${id} summon unit`),
      durationTicks: secondsToTicks(Number(summon[3]), tickRate),
    };
  }
  if (/no gameplay effect/i.test(effects)) return { kind: 'flavor' };
  return null;
}

/**
 * Quest/contract goods sold by the Trade Masters (and the missile lumber
 * piece / suicide-quest tokens) are not in equipment.json — synthesize
 * minimal consumable entries so shops and quest rules resolve.
 */
function synthesizeQuestGood(ctx: CompileCtx, itemId: string): EquipmentSpec {
  const name = fieldStr(ctx.items, itemId, 'unam') ?? itemId;
  return {
    id: itemId,
    // Strip WC3 color codes (|cffxxxxxx ... |r) from display names.
    name: name.replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, ''),
    category: 'consumable',
    gold: fieldNum(ctx.items, itemId, 'igol'),
    passives: null,
    active: null,
    charges: null,
    // Treasure / Golden Statue are destroyed on drop by Trig_Destroy_Treasure
    // even though their iper flag is 0 — override to perishable so economy's
    // drop path destroys them (see PERISHABLE_QUEST_ITEM_IDS doc).
    perishable: fieldNum(ctx.items, itemId, 'iper') === 1 || PERISHABLE_QUEST_ITEM_IDS.has(itemId),
    cooldownGroup: null,
  };
}

// ---------------------------------------------------------------------------
// Ships + abilities
// ---------------------------------------------------------------------------

function turnRateRadPerTick(rawUmvr: number | null, tickRate: number): number {
  // SEMANTICS §3: min(umvr, 0.20) rad per 0.03 s frame -> rad per tick.
  // Missing umvr: every observed base default >= 0.25, i.e. at the cap.
  const perFrame = Math.min(rawUmvr ?? TURN_RATE_FRAME_CAP, TURN_RATE_FRAME_CAP);
  return (perFrame * (1 / tickRate)) / ENGINE_FRAME_SECONDS;
}

function bountyOf(t: ObjectDataTable, code: string): BountySpec {
  return {
    base: fieldNum(t, code, 'ubba') ?? 0,
    dice: fieldNum(t, code, 'ubdi') ?? 0,
    sides: fieldNum(t, code, 'ubsi') ?? 0,
  };
}

/** Ability ids granted by a unit, minus inventory/invulnerability plumbing. */
function grantedAbilityIds(ctx: CompileCtx, unitCode: string): string[] {
  const ids = [...abilityList(ctx.units, unitCode, 'uhab'), ...abilityList(ctx.units, unitCode, 'uabi')];
  const kept = ids.filter((id) => {
    if (id === 'AInv' || id === 'Avul') return false;
    return ctx.abilities.bases[id] !== 'AInv';
  });
  return [...new Set(kept)].sort();
}

function compileShipRow(ctx: CompileCtx, row: RawShipRow): ShipSpec {
  const typeId = mustStr(row.rawcode, 'ship rawcode');
  const rawHp = mustNum(row.hp, `ship ${typeId} hp`);
  const rawArmor = mustNum(row.armor, `ship ${typeId} armor`);
  if (!ctx.units.fields[typeId]) fail(`ship ${typeId}: missing from units.json`);
  const udty = fieldStr(ctx.units, typeId, 'udty');
  const c = ctx.constants;
  return {
    typeId,
    name: mustStr(row.name, `ship ${typeId} name`),
    gold: mustNum(row.gold, `ship ${typeId} gold`),
    rawHp,
    rawArmor,
    // Hero math (SEMANTICS §1/§6): str/agi/int all 1, zero growth — read
    // from the compiled constants so patches to them are not silently lost.
    maxHp: rawHp + c.heroStrHpBonus,
    armor: rawArmor + c.heroArmorBaseOffset + c.heroAgiArmorPerPoint,
    defenseType: udty === 'fort' ? 'fortified' : 'hero',
    moveSpeed: mustNum(row.moveSpeed, `ship ${typeId} moveSpeed`),
    turnRateRadPerTick: turnRateRadPerTick(fieldNum(ctx.units, typeId, 'umvr'), ctx.tickRate),
    collisionRadius: mustNum(fieldNum(ctx.units, typeId, 'ucol'), `ship ${typeId} ucol`),
    inventorySlots: mustNum(row.inventorySlots, `ship ${typeId} inventorySlots`),
    isSub: typeId === 'H00V' || typeId === 'H00W',
    abilityIds: grantedAbilityIds(ctx, typeId),
    // uhpr (0 on every ship) + the hero strength regen (+0.05 HP/s, §6).
    hpRegenPerTick:
      ((fieldNum(ctx.units, typeId, 'uhpr') ?? 0) + c.heroStrRegenPerSecond) / ctx.tickRate,
    bounty: bountyOf(ctx.units, typeId),
    sightRadius: mustNum(fieldNum(ctx.units, typeId, 'usid') ?? fieldNum(ctx.units, typeId, 'usin'), `ship ${typeId} sight`),
    detectionRadius: grantedAbilityIds(ctx, typeId).includes('Adtg') ? ADTG_TRUE_SIGHT_RADIUS : null,
    nativeAttackRangeUnits: fieldNum(ctx.units, typeId, 'ua1r'),
  };
}

function abilityMechanic(ctx: CompileCtx, abilityId: string, base: string): AbilitySpec['mechanic'] {
  switch (base) {
    case 'AHtb':
      return 'stormBoltWeapon';
    case 'Apxf':
      return 'phoenixFireWeapon';
    case 'AIlf':
      return 'hullHp';
    case 'AOae': {
      // Positive self-aura = ship-sails skill; negative aura (Slow Aura) is
      // an exotic debuff handled by specials.
      const oae1 = fieldNumAt(ctx.abilities, abilityId, 'Oae1', 1) ?? 0;
      return oae1 >= 0 ? 'sailSpeed' : 'special';
    }
    case 'Arll':
    case 'Arel':
      return 'mechanicsRegen';
    case 'AEme':
      return 'dive';
    case 'ANen':
      // Fishing Net (A00Y) — Ensnare-type hold that pins a target enemy
      // ship's movement (war3map.j tooltip "unable to move"; specials.ts
      // applies the 'ensnared' status). atar=enemies, range/dur/cd from
      // aran/ahdu/acdn.
      return 'ensnare';
    case 'Aivs':
    case 'AIv1':
    case 'Agho':
      return 'invisibility';
    case 'AIfa':
      return 'flareDetection';
    case 'Adtg':
      return 'trueSightPassive';
    default:
      return 'special';
  }
}

function rankedValues(ctx: CompileCtx, abilityId: string, fieldId: string, ranks: number): number[] | null {
  const out: number[] = [];
  for (let level = 1; level <= ranks; level++) {
    const v = fieldNumAt(ctx.abilities, abilityId, fieldId, level);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

/**
 * AIlf hull skills / Arll mechanics skill: the dump only carries levels 1
 * (zeroed) and 7-10. Ranks 1..n are the linear extension of the 7-10 slope
 * (30 HP/rank, 1 HP/s per rank). PROVISIONAL — see header.
 */
function slopeExtendedRanks(ctx: CompileCtx, abilityId: string, fieldId: string, ranks: number): number[] {
  const v9 = fieldNumAt(ctx.abilities, abilityId, fieldId, 9);
  const v10 = fieldNumAt(ctx.abilities, abilityId, fieldId, 10);
  if (v9 === null || v10 === null) fail(`ability ${abilityId}: expected ${fieldId} at levels 9/10 for slope extension`);
  const step = v10 - v9;
  if (!(step > 0)) fail(`ability ${abilityId}: non-positive ${fieldId} slope`);
  return Array.from({ length: ranks }, (_, i) => step * (i + 1));
}

function compileAbility(ctx: CompileCtx, abilityId: string): AbilitySpec {
  // Stock abilities the map never overrides (absent from abilities.json).
  if (abilityId === 'Adtg') {
    return {
      abilityId,
      name: 'True Sight',
      kind: 'innate',
      mechanic: 'trueSightPassive',
      specialKey: null,
      skill: null,
      magnitudePerRank: [ADTG_TRUE_SIGHT_RADIUS],
      durationTicksPerRank: null,
      cooldownTicks: null,
      rangeUnits: null,
      weaponId: null,
    };
  }
  if (abilityId === 'Agho') {
    return {
      abilityId,
      name: 'Ghost',
      kind: 'innate',
      mechanic: 'invisibility',
      specialKey: 'Agho',
      skill: null,
      magnitudePerRank: [],
      durationTicksPerRank: null, // permanent (suppressed while acting)
      cooldownTicks: null,
      rangeUnits: null,
      weaponId: null,
    };
  }
  const base = ctx.abilities.bases[abilityId];
  if (base === undefined || !ctx.abilities.fields[abilityId]) fail(`ability ${abilityId}: missing from abilities.json`);
  const mechanic = abilityMechanic(ctx, abilityId, base);
  const isHeroSkill =
    fieldNum(ctx.abilities, abilityId, 'aher') === 1 ||
    fieldNum(ctx.abilities, abilityId, 'alsk') !== null ||
    fieldNum(ctx.abilities, abilityId, 'arlv') !== null;
  const ranks = fieldNum(ctx.abilities, abilityId, 'alev') ?? 1;
  const skill: HeroSkillRule | null = isHeroSkill
    ? {
        abilityId,
        ranks,
        levelsPerRank: fieldNum(ctx.abilities, abilityId, 'alsk') ?? 2,
        minHeroLevel: fieldNum(ctx.abilities, abilityId, 'arlv') ?? 1,
      }
    : null;

  let magnitudePerRank: number[] = [];
  switch (mechanic) {
    case 'stormBoltWeapon':
      magnitudePerRank = slopeOrRanked(ctx, abilityId, 'Htb1', ranks);
      break;
    case 'phoenixFireWeapon':
      magnitudePerRank = slopeOrRanked(ctx, abilityId, 'pxf1', ranks);
      break;
    case 'hullHp':
      magnitudePerRank = slopeExtendedRanks(ctx, abilityId, 'Ilif', ranks);
      break;
    case 'mechanicsRegen':
      if (base === 'Arel') {
        // Innate Repair Crew (A00G): Ihpr not overridden -> Arel base 2 HP/s.
        magnitudePerRank = [fieldNumAt(ctx.abilities, abilityId, 'Ihpr', 1) ?? AREL_DEFAULT_HP_PER_SEC];
      } else {
        magnitudePerRank = slopeExtendedRanks(ctx, abilityId, 'Ihpr', ranks);
      }
      break;
    case 'sailSpeed':
      magnitudePerRank = slopeOrRanked(ctx, abilityId, 'Oae1', ranks);
      break;
    case 'flareDetection':
      magnitudePerRank = [mustNum(fieldNumAt(ctx.abilities, abilityId, 'aare', 1), `ability ${abilityId} aare`)];
      break;
    default:
      magnitudePerRank = [];
  }

  let durationTicksPerRank: number[] | null = null;
  const durations = rankedValues(ctx, abilityId, 'ahdu', mechanic === 'flareDetection' ? 1 : ranks);
  if (durations !== null && durations.some((d) => d > 0)) {
    durationTicksPerRank = durations.map((d) => secondsToTicks(d, ctx.tickRate));
  }

  const cooldown = fieldNumAt(ctx.abilities, abilityId, 'acdn', 1);
  return {
    abilityId,
    name: fieldStr(ctx.abilities, abilityId, 'anam') ?? abilityId,
    kind: isHeroSkill ? 'heroSkill' : 'innate',
    mechanic,
    specialKey: mechanic === 'special' ? base : null,
    skill,
    magnitudePerRank,
    durationTicksPerRank,
    cooldownTicks: cooldown !== null && cooldown > 0 ? secondsToTicks(cooldown, ctx.tickRate) : null,
    rangeUnits: fieldNumAt(ctx.abilities, abilityId, 'aran', 1),
    weaponId: mechanic === 'stormBoltWeapon' || mechanic === 'phoenixFireWeapon' ? abilityId : null,
  };
}

function slopeOrRanked(ctx: CompileCtx, abilityId: string, fieldId: string, ranks: number): number[] {
  const ranked = rankedValues(ctx, abilityId, fieldId, ranks);
  if (ranked === null) fail(`ability ${abilityId}: ${fieldId} missing for one of ranks 1..${ranks}`);
  return ranked;
}

// ---------------------------------------------------------------------------
// Upgrades (upgrade-curves.json)
// ---------------------------------------------------------------------------

function upgradeEffectKind(effectText: string, id: string): UpgradeSpec['effect']['kind'] {
  if (/% of base max HP/i.test(effectText)) return 'pctBaseMaxHp';
  if (/max HP/i.test(effectText)) return 'flatMaxHp';
  if (/attack damage/i.test(effectText)) return 'flatAttackDamage';
  if (/movement speed/i.test(effectText)) return 'flatMoveSpeed';
  if (/bonus (?:damage )?(?:die|dice)/i.test(effectText)) return 'bonusAttackDice';
  if (/HP\/s regeneration/i.test(effectText)) return 'flatHpRegen';
  fail(`upgrade ${id}: cannot classify effect '${effectText}'`);
}

function compileUpgradeRow(
  ctx: CompileCtx,
  row: RawUpgradeRow,
  appliesTo: string[],
  researchableIds: Set<string>,
): UpgradeSpec {
  const id = mustStr(row.rawcode, 'upgrade rawcode');
  const maxLevel = mustNum(row.maxLevel, `upgrade ${id} maxLevel`);
  if (row.levels.length !== maxLevel) fail(`upgrade ${id}: ${row.levels.length} level rows for maxLevel ${maxLevel}`);
  const kind = upgradeEffectKind(mustStr(row.levels[0]?.effect, `upgrade ${id} L1 effect`), id);
  const perLevel: number[] = [];
  const goldCostPerLevel: number[] = [];
  for (const level of row.levels) {
    goldCostPerLevel.push(mustNum(level.goldCost, `upgrade ${id} L${level.level} goldCost`));
    const magnitude = mustNum(matchNum(level.effect, /^\+(\d+(?:\.\d+)?)/), `upgrade ${id} L${level.level} effect magnitude`);
    // Prose percent points ("+25% of base max HP") normalize to the
    // fraction creeps.ts consumes (mirrors compileEquipmentRow's /100).
    perLevel.push(kind === 'pctBaseMaxHp' ? magnitude / 100 : magnitude);
  }
  const researchSeconds =
    matchNum(row.appliesTo, /(\d+)\s*s (?:research )?per level/) ?? matchNum(row.appliesTo, /(\d+)\s*s research/);
  return {
    id,
    name: mustStr(row.name, `upgrade ${id} name`),
    maxLevel,
    // n00P ures list — R002 is orphaned (unresearchable in v1.187).
    researchable: researchableIds.has(id),
    goldCostPerLevel,
    researchTicks: secondsToTicks(mustNum(researchSeconds, `upgrade ${id} research time`), ctx.tickRate),
    appliesToUnitTypes: appliesTo,
    effect: { kind, perLevel } as UpgradeSpec['effect'],
  };
}

// ---------------------------------------------------------------------------
// Unit types (units.json allowlist)
// ---------------------------------------------------------------------------

const LANE_CREEP_LEVELS_PROVISIONAL: Record<string, number> = { h00B: PROVISIONAL_H00B_LEVEL };

function compileUnitType(
  ctx: CompileCtx,
  typeId: string,
  isStructure: boolean,
  damageUpgradesByUnit: Record<string, string[]>,
): UnitTypeSpec {
  const u = ctx.units;
  if (!u.fields[typeId]) fail(`unit ${typeId}: missing from units.json`);
  const uabi = abilityList(u, typeId, 'uabi');
  const invulnerable = uabi.includes('Avul');
  let maxHp = fieldNum(u, typeId, 'uhpm');
  if (maxHp === null) {
    if (invulnerable) maxHp = PROVISIONAL_WARD_HP;
    else if (isStructure) maxHp = PROVISIONAL_NEUTRAL_STRUCTURE_HP;
    else fail(`unit ${typeId}: no uhpm and no documented default`);
  }
  const udty = fieldStr(u, typeId, 'udty');
  const defenseType: DefenseType =
    udty === 'fort'
      ? 'fortified'
      : udty !== null
        ? (udty as DefenseType)
        : isStructure
          ? PROVISIONAL_STRUCTURE_DEFENSE_TYPE
          : PROVISIONAL_CREEP_DEFENSE_TYPE;

  let attack: UnitAttackSpec | null = null;
  const ua1b = fieldNum(u, typeId, 'ua1b');
  const ua1c = fieldNum(u, typeId, 'ua1c');
  if (ua1b !== null && ua1b > 0 && ua1c !== null && ua1c > 0) {
    const ua1t = fieldStr(u, typeId, 'ua1t');
    const knownAttackTypes: AttackType[] = ['normal', 'pierce', 'siege', 'magic', 'chaos', 'spells', 'hero'];
    const attackType: AttackType = knownAttackTypes.includes(ua1t as AttackType)
      ? (ua1t as AttackType)
      : isStructure
        ? PROVISIONAL_STRUCTURE_ATTACK_TYPE
        : PROVISIONAL_CREEP_ATTACK_TYPE;
    const ua1g = fieldStr(u, typeId, 'ua1g');
    const ua1z = fieldNum(u, typeId, 'ua1z');
    attack = {
      damageBase: ua1b,
      damageDice: fieldNum(u, typeId, 'ua1d') ?? 1,
      damageSides: fieldNum(u, typeId, 'ua1s') ?? 1,
      cooldownTicks: secondsToTicks(ua1c, ctx.tickRate),
      rangeUnits: mustNum(fieldNum(u, typeId, 'ua1r'), `unit ${typeId} ua1r`),
      attackType,
      projectileSpeedPerTick: ua1z !== null && ua1z > 0 ? ua1z / ctx.tickRate : null,
      targets:
        ua1g !== null
          ? parseTargetFilter(ua1g, `unit ${typeId} ua1g`)
          : { ships: true, structures: true, heroOnly: false },
      upgradeIds: damageUpgradesByUnit[typeId] ?? [],
    };
  }

  return {
    typeId,
    name: fieldStr(u, typeId, 'unam') ?? typeId,
    maxHp,
    armor: fieldNum(u, typeId, 'udef') ?? 0,
    defenseType,
    attack,
    moveSpeed: fieldNum(u, typeId, 'umvs') ?? 0,
    turnRateRadPerTick: turnRateRadPerTick(fieldNum(u, typeId, 'umvr'), ctx.tickRate),
    collisionRadius: fieldNum(u, typeId, 'ucol') ?? 0,
    isStructure,
    level: fieldNum(u, typeId, 'ulev') ?? LANE_CREEP_LEVELS_PROVISIONAL[typeId] ?? 0,
    bounty: bountyOf(u, typeId),
    hpRegenPerTick: (fieldNum(u, typeId, 'uhpr') ?? 0) / ctx.tickRate,
    sightRadius: fieldNum(u, typeId, 'usid') ?? fieldNum(u, typeId, 'usin') ?? 0,
    detectionRadius: uabi.includes('Atru')
      ? (fieldNum(u, typeId, 'usid') ?? PROVISIONAL_SENTRY_WARD_SIGHT)
      : uabi.includes('Adt1')
        ? PROVISIONAL_SENTRY_WARD_SIGHT
        : null,
    permanentlyInvisible: uabi.includes('Agho') || uabi.includes('Aeth'),
    invulnerable,
  };
}

// ---------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------

function compileShop(
  ctx: CompileCtx,
  structureTypeId: string,
  lumberCosts: Record<string, number>,
  lumberRefunds: Record<string, number>,
  shipGold: Record<string, number>,
  auditedItemGold: Record<string, number>,
): ShopSpec | null {
  const usei = abilityList(ctx.units, structureTypeId, 'usei');
  const useu = abilityList(ctx.units, structureTypeId, 'useu');
  if (usei.length === 0 && useu.length === 0) return null;
  const uabi = abilityList(ctx.units, structureTypeId, 'uabi');
  // Main Harbor carries the A057 Aneu override (aran 400); other shops keep
  // the stock Aneu select radius (PROVISIONAL 450).
  let interactRadius = PROVISIONAL_SHOP_INTERACT_RADIUS;
  for (const abilityId of uabi) {
    if (ctx.abilities.bases[abilityId] === 'Aneu') {
      const aran = fieldNumAt(ctx.abilities, abilityId, 'aran', 1);
      if (aran !== null) interactRadius = aran;
    }
  }
  const items: ShopItemEntry[] = usei.map((itemId) => {
    const isst = fieldNum(ctx.items, itemId, 'isst');
    const stocked = isst !== null && isst > 1;
    // items.json igol where overridden; else the audited weapons/equipment
    // price (covers WC3 base-default prices like Bowmen Crew's 1000).
    return {
      itemId,
      gold: mustNum(
        fieldNum(ctx.items, itemId, 'igol') ?? auditedItemGold[itemId],
        `shop ${structureTypeId} item ${itemId} gold`,
      ),
      // udg_PlayerLumber THRESHOLD (never consumed). The engine's ilum charge
      // is refunded by Lumber_Back_From_Contracts and Lumber_Fix re-syncs
      // engine lumber to udg_PlayerLumber, so for the NEED group ilum acts as
      // a pure gate (>=4/10/10/18/25, coinciding with their ilum). REFUND-
      // group items (I00U/I013/I012/I01E/I02I/I02H) merely get the ilum charge
      // back and impose NO threshold — so their (large) ilum must NOT be read
      // as a gate. The treasure contracts I02H/I02I (ilum 80, refund 80) are
      // the case this guards: contractLumberThreshold = 0.
      lumberCost:
        itemId in lumberRefunds
          ? (lumberCosts[itemId] ?? 0)
          : Math.max(fieldNum(ctx.items, itemId, 'ilum') ?? 0, lumberCosts[itemId] ?? 0),
      stockMax: stocked ? (fieldNum(ctx.items, itemId, 'isto') ?? 1) : null,
      restockTicks: stocked ? secondsToTicks(isst, ctx.tickRate) : null,
    };
  });
  const ships = useu.map((shipTypeId) => ({
    shipTypeId,
    gold: mustNum(shipGold[shipTypeId], `shop ${structureTypeId} ship ${shipTypeId} gold`),
    lumberCost: 0,
  }));
  return { structureTypeId, interactRadius, items, ships };
}

// ---------------------------------------------------------------------------
// Script rules: stack caps, sub rules, missiles, suicide quests, contracts
// ---------------------------------------------------------------------------

function compileStackRules(mechanism: string, nonSubShipTypes: string[]): StackRule[] {
  // Rawcode lists verbatim from war3map.j §2 (script-rules.json); every id is
  // cross-checked against the extracted text so silent data drift fails loud.
  const guard = (trigger: string, ids: string[]): void => {
    requireMention(mechanism, trigger, `stack rule ${trigger}`);
    for (const id of ids) requireMention(mechanism, id, `stack rule ${trigger}`);
  };
  const hull = ['I009', 'I016', 'I00A'];
  const sail = ['I008', 'I01A', 'I01U', 'I01V', 'I01T'];
  const repair = ['I017', 'I00B', 'I011', 'I01W'];
  const kraken = ['I01X'];
  const torpedo = ['I026', 'I02N', 'I02O', 'I02P'];
  guard('Only_One_Hull', hull);
  guard('Only_One_Sail', sail);
  guard('Only_One_Repair', repair);
  guard('Only_One_Kraken', kraken);
  guard('Only_One_Nuke', ['I01Y']);
  guard('Only_One_Vulcan', ['I01Z']);
  guard('Only_One_Sniper', ['I02F', 'I02M']);
  guard('Only_One_Torpedo1', torpedo);
  return [
    {
      id: 'onlyOneHull',
      itemIds: hull,
      maxPerShip: 1,
      bannedOnShipTypes: ['H001'],
      exclusiveWithRuleIds: ['onlyOneKraken'],
      onlyInModes: null,
    },
    {
      // NOT banned on subs: war3map.j 8897-8961 keeps the first sail on any
      // hull — the H00V/H00W branch only suppresses the duplicate's refund
      // message (script-rules §2).
      id: 'onlyOneSail',
      itemIds: sail,
      maxPerShip: 1,
      bannedOnShipTypes: [],
      exclusiveWithRuleIds: ['onlyOneKraken'],
      onlyInModes: null,
    },
    {
      id: 'onlyOneRepair',
      itemIds: repair,
      maxPerShip: 1,
      bannedOnShipTypes: [],
      exclusiveWithRuleIds: ['onlyOneKraken'],
      onlyInModes: null,
    },
    {
      id: 'onlyOneKraken',
      itemIds: kraken,
      maxPerShip: 1,
      bannedOnShipTypes: [],
      exclusiveWithRuleIds: ['onlyOneHull', 'onlyOneSail', 'onlyOneRepair'],
      onlyInModes: null,
    },
    {
      id: 'onlyOneNuke',
      itemIds: ['I01Y'],
      maxPerShip: 1,
      bannedOnShipTypes: [],
      exclusiveWithRuleIds: [],
      onlyInModes: null,
    },
    {
      id: 'onlyOneVulcan',
      itemIds: ['I01Z'],
      maxPerShip: 1,
      bannedOnShipTypes: [],
      exclusiveWithRuleIds: [],
      onlyInModes: null,
    },
    {
      // Enforced only in OnlySailors mode (udg_ModeOnlySailors gate).
      id: 'onlyOneSniper',
      itemIds: ['I02F', 'I02M'],
      maxPerShip: 1,
      bannedOnShipTypes: [],
      exclusiveWithRuleIds: [],
      onlyInModes: ['OnlySailors'],
    },
    {
      // Torpedoes are additionally submarine-only (subRules covers carrier
      // gating; the banned list mirrors it for the generic enforcement path).
      id: 'onlyOneTorpedo',
      itemIds: torpedo,
      maxPerShip: 1,
      bannedOnShipTypes: nonSubShipTypes,
      exclusiveWithRuleIds: [],
      onlyInModes: null,
    },
  ];
}

function compileSubRules(ctx: CompileCtx, scriptRules: { mechanism: string; scriptedItems: RawScriptedItemRow[] }): SubRules {
  const torpedoItemIds = scriptRules.scriptedItems
    .filter((r) => r.special.startsWith('Torpedo'))
    .map((r) => r.rawcode)
    .sort();
  if (torpedoItemIds.length !== 4) fail(`expected 4 torpedo rows in script-rules, got ${torpedoItemIds.length}`);
  // SubAcquiredItems is a BLACKLIST (war3map.j 9353-9404): the four repair
  // woods (tagged rows) + repair crews + Kraken are refunded on sub pickup.
  const bannedWoods = scriptRules.scriptedItems
    .filter((r) => r.special.startsWith('Sub-banned item (SubAcquiredItems blacklist)'))
    .map((r) => r.rawcode)
    .sort();
  if (bannedWoods.length !== 4) fail(`expected 4 sub-banned repair-wood rows in script-rules, got ${bannedWoods.length}`);
  const repairAndKraken = ['I017', 'I00B', 'I011', 'I01W', 'I01X'];
  for (const id of repairAndKraken) requireMention(scriptRules.mechanism, id, 'sub blacklist');
  requireMention(scriptRules.mechanism, 'H00V', 'sub rules');
  requireMention(scriptRules.mechanism, 'H00W', 'sub rules');
  return {
    surfacedTypeId: 'H00V',
    submergedTypeId: 'H00W',
    torpedoItemIds,
    maxTorpedoBaysPerSub: 1,
    bannedItemIds: [...bannedWoods, ...repairAndKraken].sort(),
    diveAbilityId: 'A04C',
    diveCooldownTicks: secondsToTicks(
      mustNum(fieldNumAt(ctx.abilities, 'A04C', 'acdn', 1), 'A04C dive cooldown'),
      ctx.tickRate,
    ),
  };
}

function compileMissileRules(ctx: CompileCtx, scriptRules: { mechanism: string; scriptedItems: RawScriptedItemRow[] }): MissileRules {
  requireMention(scriptRules.mechanism, 'A032', 'missile rules');
  requireMention(scriptRules.mechanism, 'I01N', 'missile rules');
  const warheadEntries: [string, { dummyTypeId: string; weaponId: string }][] = [];
  let throttleSeconds: number | null = null;
  for (const row of scriptRules.scriptedItems) {
    if (!/^Missile warhead tier/.test(row.special)) continue;
    const dummy = row.special.match(/[Ss]pawns dummy(?: unit)? (h\w{3})/)?.[1];
    if (dummy === undefined) fail(`missile warhead ${row.rawcode}: cannot find payload dummy in script rules`);
    warheadEntries.push([row.rawcode, { dummyTypeId: dummy, weaponId: row.rawcode }]);
    if (row.cooldown !== null) throttleSeconds = row.cooldown;
  }
  if (warheadEntries.length !== 3) fail(`expected 3 missile warhead tiers, got ${warheadEntries.length}`);
  const buggfixSeconds = matchNum(scriptRules.mechanism, /Buggfix[^.]*?runs every (\d+) s/);
  return {
    castAbilityId: 'A032',
    lumberItemId: 'I01N',
    throttleTicks: secondsToTicks(mustNum(throttleSeconds, 'missile throttle'), ctx.tickRate),
    warheads: sortedRecord(warheadEntries),
    targeting: 'randomEnemyLeadPlayerStructure',
    buggfixPeriodTicks: secondsToTicks(mustNum(buggfixSeconds, 'Buggfix period'), ctx.tickRate),
    buggfixSouthOnly: true, // preserved asymmetric bug (script-rules §1)
  };
}

function compileSuicideQuests(ctx: CompileCtx, scriptRules: { mechanism: string; scriptedItems: RawScriptedItemRow[] }): SuicideQuestSpec[] {
  void ctx;
  const rowOf = (rawcode: string): RawScriptedItemRow => {
    const row = scriptRules.scriptedItems.find((r) => r.rawcode === rawcode);
    if (row === undefined) fail(`suicide quest: scripted item ${rawcode} missing from script-rules.json`);
    return row;
  };
  const bombRun = rowOf('I01E');
  const goblinDamage = mustNum(bombRun.damage, 'goblin bomb run damage');
  const goblinGold = mustNum(matchNum(bombRun.special, /rewarded (\d+) gold/), 'goblin bomb run gold');
  const goblinXp = mustNum(matchNum(bombRun.special, /gold \+ (\d+) XP/), 'goblin bomb run xp');
  const superbomb = rowOf('I02Z');
  const superDamage = mustNum(superbomb.damage, 'superbomb damage');
  const superGold = mustNum(matchNum(superbomb.special, /Awards (\d+) gold/), 'superbomb gold');
  const superXp = mustNum(matchNum(superbomb.special, /gold \+ (\d+) XP/), 'superbomb xp');
  const superWarnSeconds = matchNum(rowOf('I032').special, /(\d+) s minimap ping/) ?? 12;
  // Goblin pickup gate: "with <4 inventory items" (UnitInventoryCount < 4).
  const goblinPickupMax = matchNum(bombRun.special, /with <(\d+) inventory items/);
  requireMention(bombRun.special, 'H005', 'goblin bomb run');
  requireMention(superbomb.special, 'H005', 'superbomb');
  return [
    {
      id: 'goblinBombRun',
      shipTypeId: 'H005',
      startItemId: 'I01E',
      requiredItemIds: ['I01E', 'I01G'],
      unarmedTokenId: 'I01F',
      armedTokenId: 'I01G',
      pickupRegion: 'GoblinBombShop',
      pickupMaxCarriedItems: goblinPickupMax,
      armForbiddenItemIds: [],
      // Armed at the OWN team's reward zone (script-rules I01E).
      armRegionByTeam: { south: 'SouthReward', north: 'NorthReward' },
      detonateRegionByTeam: { south: 'North_Main', north: 'South_Main' },
      hqDamage: goblinDamage,
      rewardGold: goblinGold,
      rewardXp: goblinXp,
      warnPingTicks: secondsToTicks(superWarnSeconds, TICK_RATE),
    },
    {
      id: 'superbomb',
      shipTypeId: 'H005',
      // startItemId must SURVIVE arming (I032 is consumed by the swap):
      // the detonation condition is I01E + I02Z + I02Q (war3map.j
      // 14199-14225 — no I032).
      startItemId: 'I01E',
      requiredItemIds: ['I01E', 'I02Q', 'I02Z'],
      unarmedTokenId: 'I032',
      armedTokenId: 'I02Z',
      // I032 / I02Z are minted at the Refinery (questSystems.refinery
      // superbombSwaps: I01F+I02Q->I032 Trig_Superbomb_Pick_Up1, and
      // I01G+I02Q->I02Z Trig_Superbomb_Pick_Up), NOT at a suicide-quest pickup
      // region. So this quest has no pickupRegion of its own — the unarmed
      // token enters inventory via economy.runRefinery, then arms/detonates here.
      pickupRegion: null,
      pickupMaxCarriedItems: null,
      // Arming additionally requires NOT carrying the goblin armed token
      // (war3map.j 14144-14146 I01G == false).
      armForbiddenItemIds: ['I01G'],
      // Armed at the OWN team's reward zone (war3map.j 14131-14198:
      // South_Refinery on gg_rct_SouthReward for Player(0) allies).
      armRegionByTeam: { south: 'SouthReward', north: 'NorthReward' },
      detonateRegionByTeam: { south: 'North_Main', north: 'South_Main' },
      hqDamage: superDamage,
      rewardGold: superGold,
      rewardXp: superXp,
      warnPingTicks: secondsToTicks(superWarnSeconds, TICK_RATE),
    },
  ];
}

function compileTradeRoute(row: RawTradeRouteRow, blockOrder: number): TradeRouteSpec {
  const teamOf = (v: string | null): TeamId | null => {
    if (v === null) return null;
    if (v === 'south' || v === 'north') return v;
    fail(`trade route ${row.goodsItemId}: unknown team '${v}'`);
  };
  const deliverSouth = mustStr(row.deliverRegionByTeam['south'], `route ${row.goodsItemId} south deliver region`);
  const deliverNorth = mustStr(row.deliverRegionByTeam['north'], `route ${row.goodsItemId} north deliver region`);
  return {
    contractItemId: mustStr(row.contractItemId, 'trade route contract'),
    goodsItemId: mustStr(row.goodsItemId, 'trade route goods'),
    goodsName: mustStr(row.goodsName, `route ${row.goodsItemId} name`),
    pickupRegion: mustStr(row.pickupRegion, `route ${row.goodsItemId} pickup region`),
    team: teamOf(row.team),
    carrierMaxItems: { ...row.carrierMaxItems },
    deliverRegionByTeam: { south: deliverSouth, north: deliverNorth },
    rewardGold: mustNum(row.rewardGold, `route ${row.goodsItemId} gold`),
    rewardXp: mustNum(row.rewardXp, `route ${row.goodsItemId} xp`),
    rewardLumber: mustNum(row.rewardLumber, `route ${row.goodsItemId} lumber`),
    // The source-array index IS the JASS Trig_*_Rewards block order (the data
    // is authored in that order); preserved across the goodsItemId sort below.
    rewardBlockOrder: blockOrder,
  };
}

function compileContracts(scriptRules: {
  mechanism: string;
  scriptedItems: RawScriptedItemRow[];
  tradeRoutes: RawTradeRouteRow[];
}): ContractRules {
  // Parse "(<ids> need <amounts> lumber; <ids> refund <amounts>)" verbatim.
  const m = scriptRules.mechanism.match(/\(([I0-9A-Z/]+) need ([\d/]+) lumber; ([I0-9A-Z/]+) refund ([\d/]+)\)/);
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) {
    fail('contracts: cannot parse lumber cost/refund table from script-rules mechanism');
  }
  const zip = (ids: string, amounts: string, what: string): Record<string, number> => {
    const idList = ids.split('/');
    const amountList = amounts.split('/').map(Number);
    if (idList.length !== amountList.length) fail(`contracts: ${what} id/amount length mismatch`);
    return sortedRecord(idList.map((id, i) => [id, mustNum(amountList[i], `${what} ${id}`)] as [string, number]));
  };
  const lumberRow = scriptRules.scriptedItems.find((r) => r.rawcode === 'I01N');
  if (lumberRow === undefined) fail('contracts: I01N row missing');
  const cap = lumberRow.special.match(
    /(\d+) pieces are consumed with (\w{4}) present for the Captain Reward of (\d+) gold \/ (\d+) XP \/ (\d+) lumber/,
  );
  if (cap === null) fail('contracts: cannot parse Captain Reward from I01N script rules');
  if (scriptRules.tradeRoutes.length === 0) fail('contracts: no trade routes in script-rules.json');
  return {
    lumberCosts: zip(m[1], m[2], 'lumber cost'),
    lumberRefunds: zip(m[3], m[4], 'lumber refund'),
    // The nine base goods routes (war3map.j Trig_<Goods>(+_Copy) pickups +
    // South/North_Rewards payouts). Refinery upgrade chains, the Repair
    // Buildings Mission and the Treasure Hunts remain OPEN (script-rules
    // tradeRoutesProvenance).
    tradeRoutes: scriptRules.tradeRoutes
      .map((row, i) => compileTradeRoute(row, i))
      .sort((a, b) => (a.goodsItemId < b.goodsItemId ? -1 : a.goodsItemId > b.goodsItemId ? 1 : 0)),
    captainReward: {
      pieceItemId: 'I01N',
      piecesRequired: Number(cap[1]),
      tokenItemId: mustStr(cap[2], 'captain reward token'),
      // Trig_*_Captain_Rewards gate GetUnitTypeId == 'H00J' (The Captain).
      shipTypeId: 'H00J',
      rewardGold: Number(cap[3]),
      rewardXp: Number(cap[4]),
      rewardLumber: Number(cap[5]),
    },
  };
}

// ---------------------------------------------------------------------------
// Quest systems (questSystems block): refinery, repair mission, treasure hunt
// ---------------------------------------------------------------------------

function teamIdOf(v: string | null, what: string): TeamId | null {
  if (v === null) return null;
  if (v === 'south' || v === 'north') return v;
  fail(`${what}: unknown team '${v}'`);
}

/**
 * Compile the three secondary quest chains (script-rules.json questSystems)
 * into typed Ruleset specs. All numbers are authoritative extractor values —
 * no synthesis here. The treasure seed seconds compile to ticks.
 */
function compileQuestSystems(raw: RawQuestSystems, tickRate: number): QuestSystems {
  // --- refinery ------------------------------------------------------------
  const r = raw.refinery;
  const refineSwaps = r.refineSteps
    .map((step) => ({
      rawGoodId: mustStr(step.rawGoodId, 'refine raw good'),
      refinedGoodId: mustStr(step.refinedGoodId, 'refine refined good'),
    }))
    .sort((a, b) => (a.rawGoodId < b.rawGoodId ? -1 : a.rawGoodId > b.rawGoodId ? 1 : 0));
  const carrierMaxItems: Record<string, number> = {};
  for (const hull of r.carrierShipTypes) carrierMaxItems[hull] = hull === 'H00D' ? 3 : 4;
  const rewardRoutes: RefineryRewardRoute[] = r.rewardRoutes
    .map((route) => ({
      contractItemId: mustStr(route.contractItemId, 'refinery reward contract'),
      refinedGoodId: mustStr(route.refinedGoodId, 'refinery reward refined good'),
      team: teamIdOf(route.team, `refinery route ${route.contractItemId}`),
      rewardGold: mustNum(route.rewardGold, `refinery route ${route.contractItemId} gold`),
      rewardXp: mustNum(route.rewardXp, `refinery route ${route.contractItemId} xp`),
      rewardLumber: mustNum(route.rewardLumber, `refinery route ${route.contractItemId} lumber`),
    }))
    .sort((a, b) => (a.contractItemId < b.contractItemId ? -1 : a.contractItemId > b.contractItemId ? 1 : 0));
  // Superbomb token mints (H005-only; Trig_Superbomb_Pick_Up1 I01F->I032 and
  // Trig_Superbomb_Pick_Up I01G->I02Z). Sorted by rawTokenId for a stable,
  // deterministic swap order.
  const superbombSwaps = (r.superbombSteps ?? [])
    .map((step) => ({
      carrierShipType: mustStr(step.carrierShipType, 'superbomb carrier ship'),
      rawTokenId: mustStr(step.rawTokenId, 'superbomb raw token'),
      swappedTokenId: mustStr(step.swappedTokenId, 'superbomb swapped token'),
    }))
    .sort((a, b) => (a.rawTokenId < b.rawTokenId ? -1 : a.rawTokenId > b.rawTokenId ? 1 : 0));
  const refinery: RefinerySpec = {
    membershipItemId: mustStr(r.membershipItemId, 'refinery membership item'),
    refineRegion: mustStr(r.refineRegion, 'refinery refine region'),
    rewardRegionByTeam: {
      south: mustStr(r.rewardRegionByTeam['south'], 'refinery south reward region'),
      north: mustStr(r.rewardRegionByTeam['north'], 'refinery north reward region'),
    },
    carrierMaxItems,
    refineSwaps,
    rewardRoutes,
    superbombSwaps,
  };

  // --- repair mission ------------------------------------------------------
  const rm = raw.repairMission;
  const repairMission: RepairMissionSpec = {
    contractItemId: mustStr(rm.contractItemId, 'repair mission contract'),
    lumberThreshold: mustNum(rm.lumberThreshold, 'repair mission lumber threshold'),
    tokenRegion: mustStr(rm.tokenRegion, 'repair mission token region'),
    tokenItemId: mustStr(rm.tokenItemId, 'repair mission token'),
    carrierMaxItems: { ...rm.carrierMaxItems },
    reward: {
      rewardGold: mustNum(rm.reward.rewardGold, 'repair mission gold'),
      rewardXp: mustNum(rm.reward.rewardXp, 'repair mission xp'),
      rewardLumber: mustNum(rm.reward.rewardLumber, 'repair mission lumber'),
    },
    refinedVariant: {
      membershipItemId: mustStr(rm.refinedVariant.membershipItemId, 'repair mission refined membership'),
      refineRegion: mustStr(rm.refinedVariant.refineRegion, 'repair mission refine region'),
      refinedTokenId: mustStr(rm.refinedVariant.refinedTokenId, 'repair mission refined token'),
      reward: {
        rewardGold: mustNum(rm.refinedVariant.reward.rewardGold, 'repair mission refined gold'),
        rewardXp: mustNum(rm.refinedVariant.reward.rewardXp, 'repair mission refined xp'),
        rewardLumber: mustNum(rm.refinedVariant.reward.rewardLumber, 'repair mission refined lumber'),
      },
    },
  };

  // --- treasure hunts ------------------------------------------------------
  const th = raw.treasureHunts;
  const locByNumber = (team: TeamId): Record<string, string> => {
    const src = th.treasureLocationRegionsByNumber[team];
    if (src === undefined) fail(`treasure hunt: missing ${team} location regions`);
    const out: Record<string, string> = {};
    for (const key of Object.keys(src).sort((a, b) => Number(a) - Number(b))) {
      out[key] = mustStr(src[key], `treasure ${team} location ${key}`);
    }
    return out;
  };
  const treasureHunts: TreasureHuntSpec = {
    contractByTeam: {
      south: mustStr(th.contractByTeam['south'], 'treasure south contract'),
      north: mustStr(th.contractByTeam['north'], 'treasure north contract'),
    },
    treasureItemId: mustStr(th.treasureItemId, 'treasure item'),
    carrierShipType: mustStr(th.carrierShipType, 'treasure carrier ship'),
    pickupMaxCarriedItems: mustNum(th.pickupMaxCarriedItems, 'treasure pickup max items'),
    locationCount: mustNum(th.treasureLocationCount, 'treasure location count'),
    seedTick: secondsToTicks(mustNum(th.treasureSeededAtSeconds, 'treasure seed seconds'), tickRate),
    locationRegionsByNumber: { south: locByNumber('south'), north: locByNumber('north') },
    rewardRegionByTeam: {
      south: mustStr(th.rewardRegionByTeam['south'], 'treasure south reward region'),
      north: mustStr(th.rewardRegionByTeam['north'], 'treasure north reward region'),
    },
    reward: {
      rewardGold: mustNum(th.reward.rewardGold, 'treasure reward gold'),
      rewardXp: mustNum(th.reward.rewardXp, 'treasure reward xp'),
      rewardLumber: mustNum(th.reward.rewardLumber, 'treasure reward lumber'),
    },
    refinedVariant: {
      membershipItemId: mustStr(th.refinedVariant.membershipItemId, 'treasure refined membership'),
      refineRegion: mustStr(th.refinedVariant.refineRegion, 'treasure refine region'),
      refinedTreasureId: mustStr(th.refinedVariant.refinedTreasureId, 'treasure refined item'),
      reward: {
        rewardGold: mustNum(th.refinedVariant.reward.rewardGold, 'treasure refined gold'),
        rewardXp: mustNum(th.refinedVariant.reward.rewardXp, 'treasure refined xp'),
        rewardLumber: mustNum(th.refinedVariant.reward.rewardLumber, 'treasure refined lumber'),
      },
    },
  };

  return { refinery, repairMission, treasureHunts };
}

/**
 * Items that synthesizeQuestGood must mark perishable=true regardless of
 * their items.json iper flag: the Treasure (I02G) and Golden Statue (I030)
 * are destroyed shortly after being dropped unless re-acquired by the boat
 * (Trig_Destroy_Treasure war3map.j 11190-11220). The SIM DECISION (extractor
 * open question) is to model the net behavior as perishable-on-drop, matching
 * the trade-good drop semantics economy already keys on `perishable`.
 */
const PERISHABLE_QUEST_ITEM_IDS = new Set<string>(['I02G', 'I030']);

// ---------------------------------------------------------------------------
// XP / respawn / income
// ---------------------------------------------------------------------------

function compileXpRules(): XpRules {
  const cap = PROVISIONAL_HERO_LEVEL_CAP;
  // Cumulative XP to REACH level n: 50*(n^2 + n - 2)  (SEMANTICS §6).
  const xpToLevel: number[] = [0];
  for (let n = 1; n <= cap; n++) xpToLevel.push(50 * (n * n + n - 2));
  // Kill XP by victim level: 25, then xp(L) = xp(L-1) + 5L + 5.
  const killXpByVictimLevel: number[] = [0, 25];
  for (let level = 2; level <= cap; level++) {
    killXpByVictimLevel.push(mustNum(killXpByVictimLevel[level - 1], 'kill xp') + 5 * level + 5);
  }
  return {
    xpToLevel,
    killXpByVictimLevel,
    heroKillXpByVictimLevel: [0, 100, 120, 160, 220, 300],
    heroKillXpPerLevelAbove: 100,
    shareRadius: 1200,
    summonFactor: 0.5,
    heroLevelCap: cap,
    skillPointsPerLevel: 1,
  };
}

function compileRespawnRules(mapLayout: RawMapLayoutFile, tickRate: number): RespawnRules {
  const formula = mapLayout.income.heroRespawn.delaySecondsFormula;
  const m = formula.match(/(\d+)\s*\*\s*heroLevel\s*\+\s*(\d+)\s*\+\s*randomInt\(0,\s*(\d+)\)/);
  if (m === null) fail(`respawn: cannot parse delay formula '${formula}'`);
  return {
    perLevelSeconds: Number(m[1]),
    baseSeconds: Number(m[2]),
    randMaxSeconds: Number(m[3]),
    invulnerableTicks: secondsToTicks(mapLayout.income.heroRespawn.invulnerableAfterReviveSeconds, tickRate),
  };
}

interface StreetMerchantTrigger {
  name?: string;
  singleAtSeconds?: number[];
  effect?: string;
}

function compileIncomeRules(mapLayout: RawMapLayoutFile, tickRate: number): IncomeRules {
  const gps = mapLayout.income.goldPerSecond;
  const byHumanCount: IncomeRules['byHumanCount'] = {};
  for (const key of Object.keys(gps.byHumanCountOnTeam).sort()) {
    const entry = gps.byHumanCountOnTeam[key];
    if (entry === undefined) continue;
    byHumanCount[Number(key)] = {
      perHumanSlot: mustNum(entry.perHumanSlot, `income[${key}].perHumanSlot`),
      toTeamAi: mustNum(entry.toTeamAi, `income[${key}].toTeamAi`),
    };
  }
  // Street Merchant roll: parse the periodic-trigger note when the caller
  // passes the full map-layout file; fall back to the documented constants
  // (t=5s roll 1-12, spawn at t=7s if roll > 9, unit n00R).
  let rollAtS = 5;
  let spawnAtS = 7;
  let rollMin = 1;
  let rollMax = 12;
  let threshold = 9;
  let merchantTypeId = 'n00R';
  const triggers = (mapLayout as unknown as { periodicTriggers?: StreetMerchantTrigger[] }).periodicTriggers;
  const merchant = triggers?.find((t) => t.effect !== undefined && t.effect.includes('Street Merchant'));
  if (merchant?.effect !== undefined) {
    const e = merchant.effect.match(/at t=(\d+)s roll randomInt\((\d+),(\d+)\); if >(\d+), at t=(\d+)s spawn one (\w{4})/);
    if (e !== null) {
      rollAtS = Number(e[1]);
      rollMin = Number(e[2]);
      rollMax = Number(e[3]);
      threshold = Number(e[4]);
      spawnAtS = Number(e[5]);
      merchantTypeId = mustStr(e[6], 'street merchant type');
    }
  }
  return {
    intervalTicks: secondsToTicks(gps.intervalSeconds, tickRate),
    byHumanCount,
    // Preserved bug: both teams' triggers gate on the NORTH HQ (n000_0018).
    requiresNorthHqAlive: gps.condition.includes('n000_0018'),
    empireShareMinTicks: secondsToTicks(mapLayout.income.empireGoldShare.periodSeconds.min, tickRate),
    empireShareMaxTicks: secondsToTicks(mapLayout.income.empireGoldShare.periodSeconds.max, tickRate),
    goldDumpPeriodTicks: secondsToTicks(mapLayout.income.goldDump.periodSeconds, tickRate),
    streetMerchant: {
      rollAtTick: secondsToTicks(rollAtS, tickRate),
      spawnAtTick: secondsToTicks(spawnAtS, tickRate),
      rollMin,
      rollMax,
      threshold,
      merchantTypeId,
    },
  };
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const STRUCTURE_ROLE_BY_DATA_ROLE: Record<string, StructureEntity['role']> = {
  hq: 'hq',
  spawnBuilding: 'spawnBuilding',
  tower: 'tower',
  shop: 'shop',
};

/** Real neutral structures placed with role 'other' in the layout data. */
const EXTRA_STRUCTURE_ROLES: Record<string, StructureEntity['role']> = {
  nfnp: 'repair',
  n00L: 'other',
};

/**
 * Decode the static land/water mask from data/json/terrain.json (per-row RLE)
 * into the runtime WaterMask, or build an all-WATER stub when terrain is
 * absent (preserves the legacy open-sea behavior for harnesses that omit it).
 *
 * Pure + deterministic: a fixed decode of static data, no RNG/time/trig. The
 * resulting mask lives on the immutable Ruleset (not SimState), so the packed
 * Uint8Array is allowed and never round-trips through hashState. See
 * docs/TERRAIN.md.
 *
 * Throws on a malformed/contradictory terrain file rather than silently
 * mis-decoding (matches the compiler's fail-loud convention) — an RLE row
 * whose runs do not sum to `cols`, a wrong row count, or a bad orientation
 * are all hard errors.
 */
export function compileWaterMask(bounds: MapSpec['bounds'], terrain?: RawTerrainFile): WaterMask {
  // Stub: empty cells => isWater() returns open-sea true everywhere (legacy).
  if (terrain === undefined) {
    return {
      bounds,
      cols: 0,
      rows: 0,
      cellSizeX: 1,
      cellSizeY: 1,
      cells: new Uint8Array(0),
    };
  }

  const cols = mustNum(terrain.cols, 'terrain cols');
  const rows = mustNum(terrain.rows, 'terrain rows');
  if (terrain.yOrientation !== 'top-down') {
    fail(`terrain: unexpected yOrientation '${String(terrain.yOrientation)}' (expected 'top-down')`);
  }
  if (!Array.isArray(terrain.water) || terrain.water.length !== rows) {
    fail(`terrain: expected ${rows} RLE rows, got ${Array.isArray(terrain.water) ? terrain.water.length : 'non-array'}`);
  }
  const cells = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const rle = terrain.water[r];
    if (!Array.isArray(rle) || rle.length < 1) fail(`terrain: row ${r} RLE is empty`);
    let value = rle[0] === 1 ? 1 : 0; // leadingValue: 0=land, 1=water
    let col = 0;
    for (let k = 1; k < rle.length; k++) {
      const run = rle[k] ?? 0;
      if (value === 1) {
        for (let c = 0; c < run; c++) cells[r * cols + col + c] = 1;
      }
      col += run;
      value = value === 1 ? 0 : 1; // runs alternate
    }
    if (col !== cols) fail(`terrain: row ${r} runs sum to ${col}, expected ${cols}`);
  }
  return {
    bounds: {
      minX: mustNum(terrain.bounds.minX, 'terrain minX'),
      minY: mustNum(terrain.bounds.minY, 'terrain minY'),
      maxX: mustNum(terrain.bounds.maxX, 'terrain maxX'),
      maxY: mustNum(terrain.bounds.maxY, 'terrain maxY'),
    },
    cols,
    rows,
    cellSizeX: mustNum(terrain.cellSizeX, 'terrain cellSizeX'),
    cellSizeY: mustNum(terrain.cellSizeY, 'terrain cellSizeY'),
    cells,
  };
}

/**
 * Build the static lane-navigation field (see types.ts `NavField`) flowing
 * toward `(goalX, goalY)` over the water cells of `mask`: a BFS hop-distance
 * from the goal cell outward, 8-connected, computed ONCE here. Deterministic
 * static derivation of static data — no RNG/time/trig. A stub mask (no cells)
 * yields an empty field so `navStepToward` returns null (legacy straight-line).
 *
 * Why a field and not per-tick steering: the real BSP lanes wind so sharply
 * (a straight south-spawn→north-base line is ~90% land) that greedy goal-biased
 * coast-following traps a unit in the first concave bay. The precomputed
 * gradient routes around the landmass without any per-tick search. See
 * docs/TERRAIN.md §3 (integrator reconciliation of SEMANTICS §3's "no A*").
 */
export function compileNavField(mask: WaterMask, goalX: number, goalY: number): NavField {
  const { cols, rows, cellSizeX, cellSizeY, bounds, cells } = mask;
  const base: NavField = { cols, rows, cellSizeX, cellSizeY, bounds, goalX, goalY, dist: new Int32Array(0) };
  if (cells.length === 0) return base; // stub mask -> empty field (no-op nav)

  const dist = new Int32Array(cols * rows).fill(NAV_UNREACHABLE);
  const isWaterCell = (c: number, r: number): boolean =>
    c >= 0 && c < cols && r >= 0 && r < rows && cells[r * cols + c] === 1;

  // Goal cell via the shared transform; clamp into range so a goal placed in an
  // off-by-one shore cell still seeds the flood from the nearest valid cell.
  const gc = Math.max(0, Math.min(cols - 1, Math.floor((goalX - bounds.minX) / cellSizeX)));
  const gr = Math.max(0, Math.min(rows - 1, Math.floor((bounds.maxY - goalY) / cellSizeY)));
  // If the exact goal cell is land (HQ footprints read as walkable dock = water,
  // but be defensive), seed from the nearest water cell in a small spiral so the
  // field is still anchored at the base.
  let seedC = gc;
  let seedR = gr;
  if (!isWaterCell(seedC, seedR)) {
    let found = false;
    for (let radius = 1; radius <= 8 && !found; radius++) {
      for (let dr = -radius; dr <= radius && !found; dr++) {
        for (let dc = -radius; dc <= radius && !found; dc++) {
          if (isWaterCell(gc + dc, gr + dr)) {
            seedC = gc + dc;
            seedR = gr + dr;
            found = true;
          }
        }
      }
    }
    if (!found) return base; // goal not near any water -> no usable field
  }

  // 8-connected BFS flood from the seed cell. A plain queue with a head index
  // (no shift) keeps it O(cells); neighbour order is fixed for determinism.
  const NEIGHBOURS: readonly [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  const queue = new Int32Array(cols * rows);
  let tail = 0;
  let head = 0;
  dist[seedR * cols + seedC] = 0;
  queue[tail++] = seedR * cols + seedC;
  while (head < tail) {
    const idx = queue[head++] ?? 0;
    const c = idx % cols;
    const r = (idx - c) / cols;
    const d = dist[idx] ?? NAV_UNREACHABLE;
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = c + dc;
      const nr = r + dr;
      if (!isWaterCell(nc, nr)) continue;
      const nIdx = nr * cols + nc;
      if (dist[nIdx] !== NAV_UNREACHABLE) continue;
      dist[nIdx] = d + 1;
      queue[tail++] = nIdx;
    }
  }
  return { cols, rows, cellSizeX, cellSizeY, bounds, goalX, goalY, dist };
}

function compileMap(mapLayout: RawMapLayoutFile, tickRate: number, terrain?: RawTerrainFile): MapSpec {
  void tickRate;
  const regions = sortedRecord<RegionRect>(
    mapLayout.regions.map((r) => [
      r.name,
      {
        name: r.name,
        minX: mustNum(r.minX, `region ${r.name} minX`),
        minY: mustNum(r.minY, `region ${r.name} minY`),
        maxX: mustNum(r.maxX, `region ${r.name} maxX`),
        maxY: mustNum(r.maxY, `region ${r.name} maxY`),
        centerX: mustNum(r.centerX, `region ${r.name} centerX`),
        centerY: mustNum(r.centerY, `region ${r.name} centerY`),
      },
    ]),
  );
  const regionOrFail = (name: string): RegionRect => {
    const r = regions[name];
    if (r === undefined) fail(`map: region '${name}' missing`);
    return r;
  };
  const southHarbour = regionOrFail('South_Harbour');
  const northHarbour = regionOrFail('North_Harbour');

  const structures: StructurePlacement[] = [];
  for (const s of mapLayout.structures) {
    if (s.removedAtMapStart === true) continue;
    const role = STRUCTURE_ROLE_BY_DATA_ROLE[s.role] ?? EXTRA_STRUCTURE_ROLES[s.type];
    if (role === undefined) continue; // critters / showcase ships / decoration
    let shopSide: TeamId | null = null;
    if (role === 'shop') {
      if (pointInRegion(southHarbour, s.x, s.y)) shopSide = 'south';
      else if (pointInRegion(northHarbour, s.x, s.y)) shopSide = 'north';
    }
    structures.push({
      typeId: s.type,
      instanceKey: s.id ?? `${s.type}@${s.x},${s.y}`,
      owner: typeof s.owner === 'number' ? s.owner : null,
      x: mustNum(s.x, `structure ${s.type} x`),
      y: mustNum(s.y, `structure ${s.type} y`),
      facingDeg: mustNum(s.facing, `structure ${s.type} facing`),
      role,
      shopSide,
    });
  }

  const playerStarts: MapSpec['playerStarts'] = {};
  let startingShipTypeId: string | null = null;
  for (const p of mapLayout.playerStarts.players) {
    const team = p.team as TeamId;
    if (team !== 'south' && team !== 'north') fail(`player ${p.player}: unknown team '${p.team}'`);
    const spawn = p.shipSpawn;
    if (spawn !== undefined) {
      if (startingShipTypeId === null) startingShipTypeId = spawn.type;
      else if (startingShipTypeId !== spawn.type) fail('map: mixed starting ship types');
    }
    playerStarts[p.player] = {
      team,
      x: spawn?.x ?? mustNum(p.startLocation.x, `player ${p.player} start x`),
      y: spawn?.y ?? mustNum(p.startLocation.y, `player ${p.player} start y`),
      facingDeg: spawn?.facing ?? 0,
      startItems: p.startItems ?? [],
    };
  }

  const lanes: LaneSpec[] = mapLayout.creepSpawns.lanes.map((lane) => ({
    id: lane.id,
    creepOwner: lane.creepOwner,
    team: lane.team as TeamId,
    spawnX: lane.spawnPoint.x,
    spawnY: lane.spawnPoint.y,
    spawnFacingDeg: lane.spawnFacing,
    spawnRegion: lane.spawnRegion,
    ownHarborKey: lane.requiresOwnHarborAlive,
    bountyGateEnemyHarborKey: lane.bountyGateEnemyHarbor,
    waypoints: lane.waypoints.map((wp) => ({
      x: wp.x,
      y: wp.y,
      issuedOnEnteringRegions: wp.issuedOnEnteringRegions ?? null,
    })),
  }));

  const waves: WaveSpec[] = mapLayout.creepSpawns.waves.map((w) => ({
    name: w.name,
    periodTicks: w.periodTicks,
    count: w.count,
    // 0 is meaningful here (rowboats fire exactly at wave time).
    preSpawnDelayTicks: Math.round(w.preSpawnSleepSeconds * TICK_RATE),
    bountyTypeId: w.typeWhileEnemyHarborAlive,
    zeroBountyTypeId: w.typeAfterEnemyHarborDestroyed,
  }));

  const revive = mapLayout.income.heroRespawn.reviveRegion;
  const respawnRegionByTeam: Record<TeamId, string> = {
    south: mustStr(revive['south'], 'south revive region'),
    north: mustStr(revive['north'], 'north revive region'),
  };
  regionOrFail(respawnRegionByTeam.south);
  regionOrFail(respawnRegionByTeam.north);
  for (const name of [
    'Repair_Station_South',
    'Repair_Out_South',
    'Repair_Station_North',
    'Repair_Out_North',
    'South_Main',
    'North_Main',
    'SubMoveSouth',
    'SubMoveNorth',
    'Temp_Item_Region',
    'StreetMerchant',
    'StreetMerchant1',
  ]) {
    regionOrFail(name);
  }

  const bounds = {
    minX: mapLayout.mapBounds.playableArea.minX,
    minY: mapLayout.mapBounds.playableArea.minY,
    maxX: mapLayout.mapBounds.playableArea.maxX,
    maxY: mapLayout.mapBounds.playableArea.maxY,
  };
  const waterMask = compileWaterMask(bounds, terrain);

  // Per-team push goal = the ENEMY HQ (south pushes north, north pushes south).
  // Fall back to the enemy harbor region center if an HQ is somehow absent. The
  // nav field flows toward this goal so creeps/ships follow the winding lanes.
  // HQ team is read from world-Y sign: the south Main Harbor sits at negative y,
  // the north HQ at positive y (map geometry, GEOMETRY note in the task).
  const hqOf = (team: TeamId): StructurePlacement | undefined =>
    structures.find((s) => s.role === 'hq' && (s.y < 0 ? 'south' : 'north') === team);
  const goalFor = (foe: TeamId, fallback: RegionRect): { x: number; y: number } => {
    const hq = hqOf(foe);
    return hq ? { x: hq.x, y: hq.y } : { x: fallback.centerX, y: fallback.centerY };
  };
  const northBase = goalFor('north', northHarbour); // the north base point
  const southBase = goalFor('south', southHarbour); // the south base point
  const navByTeam: Record<TeamId, NavField> = {
    south: compileNavField(waterMask, northBase.x, northBase.y), // south pushes north
    north: compileNavField(waterMask, southBase.x, southBase.y), // north pushes south
  };
  const navHomeByTeam: Record<TeamId, NavField> = {
    south: compileNavField(waterMask, southBase.x, southBase.y), // south retreats home
    north: compileNavField(waterMask, northBase.x, northBase.y), // north retreats home
  };

  return {
    bounds,
    waterMask,
    navByTeam,
    navHomeByTeam,
    regions,
    structures,
    playerStarts,
    startingShipTypeId: mustStr(startingShipTypeId, 'starting ship type'),
    lanes,
    waves,
    respawnRegionByTeam,
    repairBays: [
      { team: 'south', stationRegion: 'Repair_Station_South', exitRegion: 'Repair_Out_South' },
      { team: 'north', stationRegion: 'Repair_Station_North', exitRegion: 'Repair_Out_North' },
    ],
    subTeleports: [
      { team: 'south', mainRegion: 'South_Main', exitRegion: 'SubMoveSouth' },
      { team: 'north', mainRegion: 'North_Main', exitRegion: 'SubMoveNorth' },
    ],
    tempItemRegion: 'Temp_Item_Region',
    streetMerchantRegions: { south: 'StreetMerchant1', north: 'StreetMerchant' },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function compileConstants(mapLayout: RawMapLayoutFile, tickRate: number): RulesetConstants {
  return {
    startingGold: mustNum(mapLayout.playerStarts.startingGold, 'startingGold'),
    minMoveSpeed: DEFAULT_MIN_MOVE_SPEED,
    maxMoveSpeed: DEFAULT_MAX_MOVE_SPEED,
    turnRateCapRadPerTick: turnRateRadPerTick(null, tickRate),
    armorFactorPerPoint: 0.06,
    negativeArmorBase: 0.94,
    heroStrHpBonus: 25,
    heroAgiArmorPerPoint: 0.3,
    heroArmorBaseOffset: -2,
    heroStrRegenPerSecond: 0.05,
    missileExplodeOnDeathDoubling: false, // OPEN (BALANCE §9.4) — Classic ships Dda2 once
    sellbackRate: 0, // no shop carries Asid (SEMANTICS §8)
    friendlyFire: false, // Dont_Attack_Friends
    pfDotNonLethal: true,
  };
}

// ---------------------------------------------------------------------------
// Top-level compile
// ---------------------------------------------------------------------------

/** Units placeable/spawnable at runtime beyond the preplaced structures. */
const RUNTIME_UNIT_TYPES = [
  // missile system
  'n00D',
  'n00Q',
  'h00N',
  'h00O',
  'h00P',
  // research / merchants (n00P absent from map-layout structures — OPEN)
  'n00P',
  'n00R',
  // wards & summons
  'nvil',
  'oeye',
  'ohwd',
  'nba2',
  'h002',
  // Spawn Seamonster tiers (A02L ranks)
  'n00I',
  'n00J',
  'n00K',
  'n00M',
  'n00N',
  'n00S',
];

/**
 * Compile the start-of-game vote modes (war3map.j
 * Trig_Mode_Vote_Done_Check_Actions 2521-2613). These effects are concrete
 * trigger logic (SetPlayerUnitAvailableBJ / ReplaceUnitBJ / RemoveUnit), not
 * data-file values, so the lists are transcribed verbatim from the script with
 * line citations. Keys are the udg_ mode names; labels are the announced
 * TRIGSTR text (which differs — see GameModeSpec note).
 *
 * The trade-master NPCs are n00E_0021 (Will, south) / n00F_0015 (Bill, north);
 * the supership seller is n005_0019 (Pirate Boat Merchant).
 */
function compileGameModes(): Record<string, GameModeSpec> {
  const TRADE_MASTERS = ['n00E_0021', 'n00F_0015'];
  const SUPERSHIP_SELLER = ['n005_0019'];
  const modes: GameModeSpec[] = [
    {
      // TRIGSTR_3380 — no restriction (the solo-vs-AI default).
      name: 'NormalPlay',
      label: 'Normal Play',
      disabledShipTypes: [],
      forceShipType: null,
      removedStructureKeys: [],
    },
    {
      // TRIGSTR_5671 — disables both Traders (H00D/H005) and removes the trade
      // masters + supership seller (war3map.j 2530-2535, 2313-2316).
      name: 'NoPearlAndNoTraders',
      label: 'No Superships & No Traders',
      disabledShipTypes: ['H00D', 'H005'],
      forceShipType: null,
      removedStructureKeys: [...TRADE_MASTERS, ...SUPERSHIP_SELLER],
    },
    {
      // TRIGSTR_3350 "No Superships" — removes only the supership seller
      // (war3map.j 2538-2542).
      name: 'NoBP',
      label: 'No Superships',
      disabledShipTypes: [],
      forceShipType: null,
      removedStructureKeys: [...SUPERSHIP_SELLER],
    },
    {
      // TRIGSTR_3361 "Only Submarines" — disables the whole surface roster and
      // forces every hull to H00V; removes the trade masters (war3map.j
      // 2354-2375, 2544-2552).
      name: 'OnlyTraders',
      label: 'Only Submarines',
      disabledShipTypes: [
        'H003', 'H004', 'H006', 'H009', 'H008', 'H007',
        'H00D', 'H005', 'H00L', 'H00K', 'H00C', 'H00A', 'H00Y',
      ],
      forceShipType: 'H00V',
      removedStructureKeys: [...TRADE_MASTERS],
    },
    {
      // TRIGSTR_3364 "No Traders" — disables H00D/H005 and removes the trade
      // masters (war3map.j 2395-2396, 2559-2560).
      name: 'NoTraders',
      label: 'No Traders',
      disabledShipTypes: ['H00D', 'H005'],
      forceShipType: null,
      removedStructureKeys: [...TRADE_MASTERS],
    },
    {
      // TRIGSTR_3365 "Tournament Mode" (udg_ModeOnlySailors). Restricts the
      // roster, removes the supership seller + trade masters, and (in the
      // original) enables the InstantDeath end-systems (war3map.j 2417-2426,
      // 2566-2573) — those anti-draw timers are out of scope for solo-vs-AI.
      // The sniper item-stack cap (StackRule.onlyInModes:['OnlySailors']) is
      // the one OnlySailors effect already modeled and stays keyed to this name.
      name: 'OnlySailors',
      label: 'Tournament Mode',
      disabledShipTypes: [
        'H00D', 'H005', 'H001', 'H003', 'H004', 'H006', 'H009', 'H008', 'H007', 'H00Y',
      ],
      forceShipType: null,
      removedStructureKeys: [...TRADE_MASTERS, ...SUPERSHIP_SELLER],
    },
  ];
  const out: Record<string, GameModeSpec> = {};
  for (const m of modes) out[m.name] = m;
  return out;
}

/**
 * Compile the Classic (v1.187-verbatim) ruleset. Pure and deterministic:
 * same raw inputs -> structurally identical Ruleset (no Date, no Math
 * randomness, record keys inserted in ascending rawcode order).
 *
 * Throws (with a descriptive message) on missing/contradictory data rather
 * than silently defaulting — every number traces to a data file, a
 * documented WC3 base default (BALANCE.md §9.3), or a named provisional
 * constant at the top of this file.
 */
export function compileClassicRuleset(raw: RawDataFiles): Ruleset {
  const tickRate = TICK_RATE;
  const ctx: CompileCtx = {
    tickRate,
    constants: compileConstants(raw.mapLayout, tickRate),
    units: indexObjectData(raw.units, 'units.json'),
    abilities: indexObjectData(raw.abilities, 'abilities.json'),
    items: indexObjectData(raw.items, 'items.json'),
  };

  // --- ships first (their granted abilities seed the ability table) -------
  const shipEntries: [string, ShipSpec][] = raw.ships.ships.map((row) => [row.rawcode, compileShipRow(ctx, row)]);
  const ships = sortedRecord(shipEntries);
  const shipGold: Record<string, number> = {};
  for (const id of Object.keys(ships)) shipGold[id] = (ships[id] as ShipSpec).gold;

  // --- abilities (ship-granted union + the missile cast ability) ----------
  const abilityIdSet = new Set<string>(['A032']);
  for (const id of Object.keys(ships)) for (const a of (ships[id] as ShipSpec).abilityIds) abilityIdSet.add(a);
  const abilities = sortedRecord([...abilityIdSet].map((id) => [id, compileAbility(ctx, id)] as [string, AbilitySpec]));

  // --- weapons: item rows + hero-skill storm bolts -------------------------
  const weaponEntries: [string, WeaponSpec][] = [];
  for (const row of raw.weapons.weapons) {
    const spec = compileWeaponRow(ctx, row);
    if (spec !== null) weaponEntries.push([spec.id, spec]);
  }
  for (const id of Object.keys(abilities)) {
    const spec = abilities[id] as AbilitySpec;
    if (spec.mechanic === 'stormBoltWeapon') {
      // Rank 1 on the base key, ranks 2..n as `${id}:${rank}` variants
      // (combat's per-rank resolution convention; magnitudePerRank length
      // equals the rank count verified at ability compile time).
      weaponEntries.push([id, compileHeroStormBoltWeapon(ctx, id, 1)]);
      for (let rank = 2; rank <= spec.magnitudePerRank.length; rank++) {
        weaponEntries.push([`${id}:${rank}`, compileHeroStormBoltWeapon(ctx, id, rank)]);
      }
    }
  }
  const weapons = sortedRecord(weaponEntries);

  // --- upgrades (appliesTo derived from units.json upgr back-references) ---
  const upgradeAppliesTo: Record<string, string[]> = {};
  for (const unitCode of Object.keys(ctx.units.fields).sort()) {
    for (const upgradeId of abilityList(ctx.units, unitCode, 'upgr')) {
      (upgradeAppliesTo[upgradeId] ??= []).push(unitCode);
    }
  }
  // The Upgrade Center's research list (n00P ures) gates applyResearch.
  const researchableIds = new Set(abilityList(ctx.units, 'n00P', 'ures'));
  const upgrades = sortedRecord(
    raw.upgradeCurves.upgrades.map(
      (row) =>
        [row.rawcode, compileUpgradeRow(ctx, row, (upgradeAppliesTo[row.rawcode] ?? []).sort(), researchableIds)] as [
          string,
          UpgradeSpec,
        ],
    ),
  );
  const damageUpgradeIds = Object.keys(upgrades).filter((id) => {
    const kind = (upgrades[id] as UpgradeSpec).effect.kind;
    return kind === 'flatAttackDamage' || kind === 'bonusAttackDice';
  });
  const damageUpgradesByUnit: Record<string, string[]> = {};
  for (const upgradeId of damageUpgradeIds) {
    for (const unitCode of (upgrades[upgradeId] as UpgradeSpec).appliesToUnitTypes) {
      (damageUpgradesByUnit[unitCode] ??= []).push(upgradeId);
    }
  }

  // --- map (needed to know which structures exist) --------------------------
  const map = compileMap(raw.mapLayout, tickRate, raw.terrain);

  // --- unit types (lane creeps + placed/runtime structures + wards) --------
  const structureTypeIds = new Set<string>();
  for (const s of map.structures) structureTypeIds.add(s.typeId);
  for (const id of ['n00D', 'n00Q', 'n00P', 'n00R']) structureTypeIds.add(id);
  const unitTypeIds = new Set<string>(RUNTIME_UNIT_TYPES);
  for (const id of structureTypeIds) unitTypeIds.add(id);
  for (const w of map.waves) {
    unitTypeIds.add(w.bountyTypeId);
    unitTypeIds.add(w.zeroBountyTypeId);
  }
  // The Street Merchant / Spy / Motion Detector are mobile-ish wards, not
  // structures; everything placed by map.structures or the missile/upgrade
  // systems counts as a structure.
  const wardLike = new Set(['nvil', 'oeye', 'ohwd', 'nba2', 'h002', 'h00N', 'h00O', 'h00P']);
  const unitTypes = sortedRecord(
    [...unitTypeIds].map((typeId) => {
      const isStructure =
        !wardLike.has(typeId) && (structureTypeIds.has(typeId) || (typeId.startsWith('n') && !typeId.startsWith('nv')));
      const monsterIds = ['n00I', 'n00J', 'n00K', 'n00M', 'n00N', 'n00S'];
      return [
        typeId,
        compileUnitType(ctx, typeId, isStructure && !monsterIds.includes(typeId), damageUpgradesByUnit),
      ] as [string, UnitTypeSpec];
    }),
  );

  // --- script-rule systems -------------------------------------------------
  const contracts = compileContracts(raw.scriptRules);
  const nonSubShipTypes = Object.keys(ships).filter((id) => !(ships[id] as ShipSpec).isSub);
  const stackRules = compileStackRules(raw.scriptRules.mechanism, nonSubShipTypes);
  const subRules = compileSubRules(ctx, raw.scriptRules);
  const missiles = compileMissileRules(ctx, raw.scriptRules);
  const suicideQuests = compileSuicideQuests(ctx, raw.scriptRules);
  const questSystems = compileQuestSystems(raw.scriptRules.questSystems, tickRate);

  // --- equipment (+ synthesized quest/contract goods) -----------------------
  const equipmentEntries: [string, EquipmentSpec][] = raw.equipment.items.map((row) => [
    row.rawcode,
    compileEquipmentRow(ctx, row),
  ]);
  const knownItemIds = new Set<string>([...equipmentEntries.map(([id]) => id), ...Object.keys(weapons)]);
  const questItemIds = new Set<string>([missiles.lumberItemId]);
  for (const quest of suicideQuests) {
    questItemIds.add(quest.startItemId);
    if (quest.unarmedTokenId !== null) questItemIds.add(quest.unarmedTokenId);
    questItemIds.add(quest.armedTokenId);
    for (const id of quest.requiredItemIds) questItemIds.add(id);
  }
  questItemIds.add(contracts.captainReward.pieceItemId);
  questItemIds.add(contracts.captainReward.tokenItemId);
  for (const id of [...Object.keys(contracts.lumberCosts), ...Object.keys(contracts.lumberRefunds)]) questItemIds.add(id);
  for (const route of contracts.tradeRoutes) {
    questItemIds.add(route.contractItemId);
    questItemIds.add(route.goodsItemId);
  }
  // Quest-system items (refinery membership/refined goods, repair-mission
  // tokens, treasure contracts + treasure item) so synthesizeQuestGood
  // resolves them and they pass validateRuleset / shop resolution.
  questItemIds.add(questSystems.refinery.membershipItemId);
  for (const swap of questSystems.refinery.refineSwaps) {
    questItemIds.add(swap.rawGoodId);
    questItemIds.add(swap.refinedGoodId);
  }
  for (const route of questSystems.refinery.rewardRoutes) {
    questItemIds.add(route.contractItemId);
    questItemIds.add(route.refinedGoodId);
  }
  questItemIds.add(questSystems.repairMission.contractItemId);
  questItemIds.add(questSystems.repairMission.tokenItemId);
  questItemIds.add(questSystems.repairMission.refinedVariant.membershipItemId);
  questItemIds.add(questSystems.repairMission.refinedVariant.refinedTokenId);
  for (const id of Object.values(questSystems.treasureHunts.contractByTeam)) questItemIds.add(id);
  questItemIds.add(questSystems.treasureHunts.treasureItemId);
  // Refined-treasure branch: the Book of Formulas gate and the Golden Statue
  // (I030) must resolve so synthesizeQuestGood registers I030 as a perishable
  // quest good (PERISHABLE_QUEST_ITEM_IDS) — otherwise it would leak on drop.
  questItemIds.add(questSystems.treasureHunts.refinedVariant.membershipItemId);
  questItemIds.add(questSystems.treasureHunts.refinedVariant.refinedTreasureId);

  // --- shops ----------------------------------------------------------------
  const auditedItemGold: Record<string, number> = {};
  for (const [id, spec] of equipmentEntries) {
    if (spec.gold !== null) auditedItemGold[id] = spec.gold;
  }
  for (const id of Object.keys(weapons)) {
    const gold = (weapons[id] as WeaponSpec).gold;
    if (gold !== null) auditedItemGold[id] = gold;
  }
  const shopEntries: [string, ShopSpec][] = [];
  for (const typeId of Object.keys(unitTypes)) {
    const shop = compileShop(
      ctx,
      typeId,
      contracts.lumberCosts,
      contracts.lumberRefunds,
      shipGold,
      auditedItemGold,
    );
    if (shop !== null) {
      shopEntries.push([typeId, shop]);
      for (const entry of shop.items) questItemIds.add(entry.itemId);
    }
  }
  const shops = sortedRecord(shopEntries);
  for (const itemId of [...questItemIds].sort()) {
    if (!knownItemIds.has(itemId)) {
      equipmentEntries.push([itemId, synthesizeQuestGood(ctx, itemId)]);
      knownItemIds.add(itemId);
    }
  }
  const equipment = sortedRecord(equipmentEntries);

  return {
    name: 'classic-1.187',
    tickRate,
    constants: ctx.constants,
    attackTypeVsDefense: tftAttackTypeVsDefense(),
    weapons,
    equipment,
    abilities,
    ships,
    unitTypes,
    upgrades,
    shops,
    stackRules,
    subRules,
    missiles,
    suicideQuests,
    contracts,
    questSystems,
    xp: compileXpRules(),
    respawn: compileRespawnRules(raw.mapLayout, tickRate),
    income: compileIncomeRules(raw.mapLayout, tickRate),
    gameModes: compileGameModes(),
    map,
  };
}

// ---------------------------------------------------------------------------
// Balanced-ruleset patches
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep clone for plain JSON-style data (all a Ruleset ever contains). */
function deepClone<T>(value: T): T {
  // The water mask's packed bytes (WaterMask.cells) are the one non-JSON node
  // in a Ruleset; clone them as a typed array so the cloned ruleset's mask
  // stays queryable (a plain-object clone would lose .length and break
  // isWater). A Balanced patch never overrides the mask, so this is a copy.
  if (value instanceof Uint8Array) {
    return value.slice() as unknown as T;
  }
  // The per-team lane-navigation fields (map.navByTeam/navHomeByTeam) carry a
  // packed Int32Array `dist` derived from the mask — same rationale as the mask
  // bytes; clone as a typed array so the cloned ruleset's nav stays queryable.
  if (value instanceof Int32Array) {
    return value.slice() as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepClone(v)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out as T;
  }
  return value;
}

function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const key of Object.keys(patch)) {
    const patchValue = patch[key];
    if (patchValue === undefined) continue;
    const targetValue = target[key];
    if (isPlainObject(targetValue) && isPlainObject(patchValue)) {
      mergeInto(targetValue, patchValue);
    } else {
      // Arrays and primitives replace wholesale.
      target[key] = deepClone(patchValue);
    }
  }
}

/**
 * Apply a Balanced-ruleset patch on top of a compiled base (DESIGN.md:
 * versioned data overrides, never edits to Classic). Deep-merges objects;
 * arrays are replaced wholesale. Returns a NEW Ruleset — never mutates
 * `base`. Patch name becomes the result's name.
 */
export function applyRulesetPatch(base: Ruleset, patch: RulesetPatch): Ruleset {
  const merged = deepClone(base) as unknown as Record<string, unknown>;
  mergeInto(merged, patch.changes as Record<string, unknown>);
  const result = merged as unknown as Ruleset;
  result.name = patch.name;
  return result;
}

// ---------------------------------------------------------------------------
// Integrity validation
// ---------------------------------------------------------------------------

/**
 * Integrity check used by tests and the server at load time: every id
 * referenced anywhere (weaponId links, shop item lists, lane harbor keys,
 * region names, ship abilityIds, warhead dummy types...) must resolve.
 * Returns human-readable problem strings; empty array = valid.
 */
export function validateRuleset(ruleset: Ruleset): string[] {
  const problems: string[] = [];
  const hasItem = (id: string): boolean => id in ruleset.equipment || id in ruleset.weapons;
  const hasRegion = (name: string): boolean => name in ruleset.map.regions;
  const note = (msg: string): void => {
    problems.push(msg);
  };

  for (const id of Object.keys(ruleset.weapons)) {
    const w = ruleset.weapons[id] as WeaponSpec;
    if (!Number.isFinite(w.damage)) note(`weapon ${id}: non-finite damage`);
    if (w.cooldownTicks < 1) note(`weapon ${id}: cooldown < 1 tick`);
    if (w.dot !== null && w.buffId === null) note(`weapon ${id}: DoT without a buff`);
  }
  for (const id of Object.keys(ruleset.abilities)) {
    const a = ruleset.abilities[id] as AbilitySpec;
    if (a.weaponId !== null && !(a.weaponId in ruleset.weapons)) note(`ability ${id}: weaponId ${a.weaponId} unresolved`);
    if ((a.mechanic === 'stormBoltWeapon' || a.mechanic === 'phoenixFireWeapon') && a.weaponId === null) {
      note(`ability ${id}: weapon mechanic without weaponId`);
    }
  }
  for (const id of Object.keys(ruleset.ships)) {
    const s = ruleset.ships[id] as ShipSpec;
    if (!(s.maxHp > 0)) note(`ship ${id}: maxHp must be positive`);
    for (const abilityId of s.abilityIds) {
      if (!(abilityId in ruleset.abilities)) note(`ship ${id}: ability ${abilityId} unresolved`);
    }
  }
  for (const id of Object.keys(ruleset.upgrades)) {
    const u = ruleset.upgrades[id] as UpgradeSpec;
    if (u.goldCostPerLevel.length !== u.maxLevel) note(`upgrade ${id}: goldCostPerLevel length != maxLevel`);
    if (u.effect.perLevel.length !== u.maxLevel) note(`upgrade ${id}: effect.perLevel length != maxLevel`);
    for (const t of u.appliesToUnitTypes) {
      if (!(t in ruleset.unitTypes)) note(`upgrade ${id}: unit type ${t} unresolved`);
    }
  }
  for (const id of Object.keys(ruleset.unitTypes)) {
    const u = ruleset.unitTypes[id] as UnitTypeSpec;
    for (const upgradeId of u.attack?.upgradeIds ?? []) {
      if (!(upgradeId in ruleset.upgrades)) note(`unit ${id}: upgrade ${upgradeId} unresolved`);
    }
  }
  for (const shopId of Object.keys(ruleset.shops)) {
    const shop = ruleset.shops[shopId] as ShopSpec;
    if (!(shopId in ruleset.unitTypes)) note(`shop ${shopId}: structure type unresolved`);
    for (const entry of shop.items) {
      if (!hasItem(entry.itemId)) note(`shop ${shopId}: item ${entry.itemId} unresolved`);
    }
    for (const entry of shop.ships) {
      if (!(entry.shipTypeId in ruleset.ships)) note(`shop ${shopId}: ship ${entry.shipTypeId} unresolved`);
    }
  }
  const ruleIds = new Set(ruleset.stackRules.map((r) => r.id));
  for (const rule of ruleset.stackRules) {
    for (const itemId of rule.itemIds) if (!hasItem(itemId)) note(`stack rule ${rule.id}: item ${itemId} unresolved`);
    for (const shipId of rule.bannedOnShipTypes) {
      if (!(shipId in ruleset.ships)) note(`stack rule ${rule.id}: ship ${shipId} unresolved`);
    }
    for (const other of rule.exclusiveWithRuleIds) {
      if (!ruleIds.has(other)) note(`stack rule ${rule.id}: exclusive rule ${other} unresolved`);
    }
  }
  if (!(ruleset.subRules.surfacedTypeId in ruleset.ships)) note('subRules: surfaced ship unresolved');
  if (!(ruleset.subRules.submergedTypeId in ruleset.ships)) note('subRules: submerged ship unresolved');
  for (const itemId of [...ruleset.subRules.torpedoItemIds, ...ruleset.subRules.bannedItemIds]) {
    if (!hasItem(itemId)) note(`subRules: item ${itemId} unresolved`);
  }
  if (!hasItem(ruleset.missiles.lumberItemId)) note('missiles: lumber item unresolved');
  for (const warheadId of Object.keys(ruleset.missiles.warheads)) {
    const warhead = ruleset.missiles.warheads[warheadId];
    if (warhead === undefined) continue;
    if (!(warhead.weaponId in ruleset.weapons)) note(`missiles: warhead ${warheadId} weapon unresolved`);
    if (!(warhead.dummyTypeId in ruleset.unitTypes)) note(`missiles: warhead ${warheadId} dummy unresolved`);
  }
  for (const quest of ruleset.suicideQuests) {
    if (!(quest.shipTypeId in ruleset.ships)) note(`quest ${quest.id}: ship ${quest.shipTypeId} unresolved`);
    const itemIds = [quest.startItemId, quest.armedTokenId, ...quest.requiredItemIds];
    if (quest.unarmedTokenId !== null) itemIds.push(quest.unarmedTokenId);
    for (const itemId of itemIds) if (!hasItem(itemId)) note(`quest ${quest.id}: item ${itemId} unresolved`);
    const regionNames = [
      ...Object.values(quest.armRegionByTeam),
      ...Object.values(quest.detonateRegionByTeam),
      ...(quest.pickupRegion !== null ? [quest.pickupRegion] : []),
    ];
    for (const name of regionNames) if (!hasRegion(name)) note(`quest ${quest.id}: region ${name} unresolved`);
  }
  for (const itemId of [...Object.keys(ruleset.contracts.lumberCosts), ...Object.keys(ruleset.contracts.lumberRefunds)]) {
    if (!hasItem(itemId)) note(`contracts: item ${itemId} unresolved`);
  }
  if (!hasItem(ruleset.contracts.captainReward.pieceItemId)) note('contracts: captain reward piece unresolved');
  if (!hasItem(ruleset.contracts.captainReward.tokenItemId)) note('contracts: captain reward token unresolved');
  for (const route of ruleset.contracts.tradeRoutes) {
    if (!hasItem(route.contractItemId)) note(`route ${route.goodsItemId}: contract item unresolved`);
    if (!hasItem(route.goodsItemId)) note(`route ${route.goodsItemId}: goods item unresolved`);
    if (!hasRegion(route.pickupRegion)) note(`route ${route.goodsItemId}: pickup region unresolved`);
    for (const name of Object.values(route.deliverRegionByTeam)) {
      if (!hasRegion(name)) note(`route ${route.goodsItemId}: deliver region ${name} unresolved`);
    }
    for (const shipId of Object.keys(route.carrierMaxItems)) {
      if (!(shipId in ruleset.ships)) note(`route ${route.goodsItemId}: carrier ${shipId} unresolved`);
    }
  }

  // --- quest systems --------------------------------------------------------
  const qs = ruleset.questSystems;
  const ref = qs.refinery;
  if (!hasItem(ref.membershipItemId)) note(`refinery: membership item ${ref.membershipItemId} unresolved`);
  if (!hasRegion(ref.refineRegion)) note(`refinery: refine region ${ref.refineRegion} unresolved`);
  for (const name of Object.values(ref.rewardRegionByTeam)) {
    if (!hasRegion(name)) note(`refinery: reward region ${name} unresolved`);
  }
  for (const hull of Object.keys(ref.carrierMaxItems)) {
    if (!(hull in ruleset.ships)) note(`refinery: carrier ${hull} unresolved`);
  }
  for (const swap of ref.refineSwaps) {
    if (!hasItem(swap.rawGoodId)) note(`refinery: raw good ${swap.rawGoodId} unresolved`);
    if (!hasItem(swap.refinedGoodId)) note(`refinery: refined good ${swap.refinedGoodId} unresolved`);
  }
  for (const route of ref.rewardRoutes) {
    if (!hasItem(route.contractItemId)) note(`refinery: route contract ${route.contractItemId} unresolved`);
    if (!hasItem(route.refinedGoodId)) note(`refinery: route good ${route.refinedGoodId} unresolved`);
  }
  const rm = qs.repairMission;
  if (!hasItem(rm.contractItemId)) note(`repair mission: contract ${rm.contractItemId} unresolved`);
  if (!hasItem(rm.tokenItemId)) note(`repair mission: token ${rm.tokenItemId} unresolved`);
  if (!hasRegion(rm.tokenRegion)) note(`repair mission: token region ${rm.tokenRegion} unresolved`);
  for (const hull of Object.keys(rm.carrierMaxItems)) {
    if (!(hull in ruleset.ships)) note(`repair mission: carrier ${hull} unresolved`);
  }
  if (!hasItem(rm.refinedVariant.membershipItemId)) {
    note(`repair mission: refined membership ${rm.refinedVariant.membershipItemId} unresolved`);
  }
  if (!hasItem(rm.refinedVariant.refinedTokenId)) {
    note(`repair mission: refined token ${rm.refinedVariant.refinedTokenId} unresolved`);
  }
  if (!hasRegion(rm.refinedVariant.refineRegion)) {
    note(`repair mission: refine region ${rm.refinedVariant.refineRegion} unresolved`);
  }
  const th = qs.treasureHunts;
  for (const id of Object.values(th.contractByTeam)) {
    if (!hasItem(id)) note(`treasure hunt: contract ${id} unresolved`);
  }
  if (!hasItem(th.treasureItemId)) note(`treasure hunt: treasure item ${th.treasureItemId} unresolved`);
  if (!(th.carrierShipType in ruleset.ships)) note(`treasure hunt: carrier ${th.carrierShipType} unresolved`);
  for (const name of Object.values(th.rewardRegionByTeam)) {
    if (!hasRegion(name)) note(`treasure hunt: reward region ${name} unresolved`);
  }
  for (const team of ['south', 'north'] as TeamId[]) {
    const byNumber = th.locationRegionsByNumber[team];
    const count = Object.keys(byNumber).length;
    if (count !== th.locationCount) {
      note(`treasure hunt: ${team} has ${count} locations, expected ${th.locationCount}`);
    }
    for (let n = 1; n <= th.locationCount; n++) {
      const name = byNumber[String(n)];
      if (name === undefined) note(`treasure hunt: ${team} missing location ${n}`);
      else if (!hasRegion(name)) note(`treasure hunt: ${team} location ${n} region ${name} unresolved`);
    }
  }
  const trv = th.refinedVariant;
  if (!hasItem(trv.membershipItemId)) note(`treasure hunt: refined membership ${trv.membershipItemId} unresolved`);
  if (!hasItem(trv.refinedTreasureId)) note(`treasure hunt: refined treasure ${trv.refinedTreasureId} unresolved`);
  if (!hasRegion(trv.refineRegion)) note(`treasure hunt: refine region ${trv.refineRegion} unresolved`);

  const structureKeys = new Set(ruleset.map.structures.map((s) => s.instanceKey));
  for (const s of ruleset.map.structures) {
    if (!(s.typeId in ruleset.unitTypes)) note(`map structure ${s.instanceKey}: type ${s.typeId} unresolved`);
  }
  for (const lane of ruleset.map.lanes) {
    if (!hasRegion(lane.spawnRegion)) note(`lane ${lane.id}: spawn region unresolved`);
    if (!structureKeys.has(lane.ownHarborKey)) note(`lane ${lane.id}: own harbor ${lane.ownHarborKey} unresolved`);
    if (!structureKeys.has(lane.bountyGateEnemyHarborKey)) {
      note(`lane ${lane.id}: enemy harbor ${lane.bountyGateEnemyHarborKey} unresolved`);
    }
    for (const wp of lane.waypoints) {
      for (const regionName of wp.issuedOnEnteringRegions ?? []) {
        if (!hasRegion(regionName)) note(`lane ${lane.id}: waypoint region ${regionName} unresolved`);
      }
    }
  }
  for (const w of ruleset.map.waves) {
    if (!(w.bountyTypeId in ruleset.unitTypes)) note(`wave ${w.name}: type ${w.bountyTypeId} unresolved`);
    if (!(w.zeroBountyTypeId in ruleset.unitTypes)) note(`wave ${w.name}: type ${w.zeroBountyTypeId} unresolved`);
  }
  for (const slot of Object.keys(ruleset.map.playerStarts)) {
    const start = ruleset.map.playerStarts[Number(slot)];
    if (start === undefined) continue;
    for (const itemId of start.startItems) {
      if (!hasItem(itemId)) note(`player ${slot}: start item ${itemId} unresolved`);
    }
  }
  if (!(ruleset.map.startingShipTypeId in ruleset.ships)) note('map: starting ship type unresolved');
  for (const bay of ruleset.map.repairBays) {
    if (!hasRegion(bay.stationRegion)) note(`repair bay: region ${bay.stationRegion} unresolved`);
    if (!hasRegion(bay.exitRegion)) note(`repair bay: region ${bay.exitRegion} unresolved`);
  }
  for (const tp of ruleset.map.subTeleports) {
    if (!hasRegion(tp.mainRegion)) note(`sub teleport: region ${tp.mainRegion} unresolved`);
    if (!hasRegion(tp.exitRegion)) note(`sub teleport: region ${tp.exitRegion} unresolved`);
  }
  if (!hasRegion(ruleset.map.tempItemRegion)) note('map: temp item region unresolved');
  for (const name of Object.values(ruleset.map.streetMerchantRegions)) {
    if (!hasRegion(name)) note(`map: street merchant region ${name} unresolved`);
  }
  if (!hasRegion(ruleset.map.respawnRegionByTeam.south)) note('map: south respawn region unresolved');
  if (!hasRegion(ruleset.map.respawnRegionByTeam.north)) note('map: north respawn region unresolved');
  if (!(ruleset.income.streetMerchant.merchantTypeId in ruleset.unitTypes)) {
    note('income: street merchant type unresolved');
  }
  if (!(ruleset.missiles.castAbilityId in ruleset.abilities)) note('missiles: cast ability unresolved');
  if (!(ruleset.subRules.diveAbilityId in ruleset.abilities)) note('subRules: dive ability unresolved');

  return problems;
}
