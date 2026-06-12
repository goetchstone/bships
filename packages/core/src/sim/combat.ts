/**
 * Combat system: weapons, projectiles, damage pipeline, regen, death
 * detection.
 *
 * Phase order inside stepCombat (FIXED — RNG draws happen in phases 1-3, so
 * reordering is a replay-breaking change):
 *   1. storm-bolt wind-up completions (ShipEntity.casting)
 *   2. Phoenix Fire scans — players ascending slot, inventory slots in array
 *      order; ONE rollInt per shot fired (drawn even when only a single
 *      candidate exists, to keep the draw count independent of fleet layout)
 *   3. native attacks — entities ascending id; dice rolled per die at launch
 *   4. projectile flight & impact — projectiles ascending id
 *   5. regen / HoT / DoT single pass + expiry of combat-owned statuses
 *      (dot / hot / weaponBuff)
 *
 * Key behaviors (docs/SEMANTICS.md):
 * - Phoenix Fire (§2): every PF weapon in every player's inventory is an
 *   independent instance on ItemInstance.readyAtTick. Candidates are built
 *   ascending entity id — TargetFilter, enemy, dist <= rangeUnits, alive,
 *   visible to the owner team, NOT carrying the weapon's buffId (any
 *   'weaponBuff'/'dot' status). Empty list: stays ready, cooldown NOT
 *   consumed, no RNG draw. PF is passive — it never breaks invisibility.
 * - Storm Bolt (§4): validated at cast (range/visibility/targetability);
 *   castTimeTicks wind-ups park on ShipEntity.casting and launch in phase 1
 *   without re-validation (fizzle only if caster/target died). The homing
 *   projectile cannot miss; fizzles if the target dies in flight; still hits
 *   if the target went invisible after launch.
 * - Projectiles: homing re-homes per tick and hits when within speedPerTick;
 *   non-homing flies to the launch-point (targetX/Y) and damages
 *   intendedTargetId only if its collision circle covers the impact point.
 *   Weapons with aoeRadius (Kaboom warheads) splash every enemy passing the
 *   weapon's TargetFilter within aoeRadius (+ target collision radius, the
 *   WC3 enum-in-range convention) of the impact point — invisibility does
 *   not protect against point AoE.
 * - Native attacks: UnitTypeSpec.attack (ships' vestigial attack included
 *   when the compiler lists the ship typeId in unitTypes). Target from
 *   entity.order (attackTarget; 'move' suppresses auto-acquire) or nearest
 *   valid enemy in range with ascending-id tiebreak. Allies are never
 *   acquired and ally damage is dropped in applyDamage
 *   (constants.friendlyFire === false — Dont_Attack_Friends).
 * - Damage pipeline (§1): 'true' verbatim; 'magic' = typeMult x (1 - best
 *   hull AIsr reduction, never stacks); 'physical' = typeMult x armor-value
 *   factor (negative armor amplifies via 2 - base^(-armor)); noTypeMult
 *   skips only the attack-vs-defense multiplier. Invulnerable targets
 *   (invulnerableUntilTick / pausedUntilTick > tick, unit-type invulnerable,
 *   active 'shielded' status) take nothing.
 * - Regen (§10): single pass — ship spec + equipment hpRegenPerTick +
 *   mechanics-skill rank (AbilitySpec.magnitudePerRank is HP/s, converted
 *   here via ruleset.tickRate) + 'hot' statuses, capped at maxHp. DoTs tick
 *   here through applyDamage as 'true' damage (nonLethal clamps at 1 HP).
 * - Death: hp <= 0 flags entity.dead = true ONCE, pushes a PendingDeath and
 *   emits 'death'; sim finalize deletes after progression consumed it.
 *
 * Local decisions pending architect/ruleset alignment (also in module
 * report): hero-skill weapon cooldowns live in PlayerState.cooldownGroups
 * keyed by abilityId; per-rank weapons resolve as
 * weapons[`${weaponId}:${rank}`] with fallback to weapons[weaponId].
 *
 * Tick order: runs 4th — after specials (visibility fresh), before economy.
 */

import { dist } from '../math.js';
import { breakInvisibilityOnAction } from './specials.js';
import {
  allocEntityId,
  isCombatant,
  isUnitEntity,
  rollInt,
  sortedNumericKeys,
} from './types.js';
import type {
  AbilitySpec,
  Combatant,
  CombatCommandU,
  DamageInstance,
  DefenseType,
  Entity,
  EntityId,
  Projectile,
  Ruleset,
  SimState,
  Status,
  TargetFilter,
  TeamId,
  UnitAttackSpec,
  WeaponSpec,
} from './types.js';

// ---------------------------------------------------------------------------
// Deterministic pow — the negative-armor amplification needs base^x for
// fractional x, and Math.pow is transcendental (NOT bit-identical across JS
// engines). Fixed-iteration ln/exp keeps it pure arithmetic: accurate to
// ~1e-12 for base near 1 (Classic: 0.94) and |exponent·ln(base)| < ~40.
// ---------------------------------------------------------------------------

const E_CONST = 2.718281828459045;

function dExpPositive(t: number): number {
  const k = Math.floor(t);
  let intPart = 1;
  for (let i = 0; i < k; i++) intPart *= E_CONST;
  const r = t - k;
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 14; n++) {
    term = (term * r) / n;
    sum += term;
  }
  return intPart * sum;
}

function dExp(x: number): number {
  return x < 0 ? 1 / dExpPositive(-x) : dExpPositive(x);
}

function dLn(x: number): number {
  const z = (x - 1) / (x + 1);
  const z2 = z * z;
  let term = z;
  let sum = 0;
  for (let n = 0; n < 32; n++) {
    sum += term / (2 * n + 1);
    term *= z2;
  }
  return 2 * sum;
}

/** Deterministic base^exponent for base > 0 (fixed-iteration exp/ln). */
export function dPow(base: number, exponent: number): number {
  if (exponent === 0) return 1;
  if (base <= 0) return 0;
  return dExp(exponent * dLn(base));
}

// ---------------------------------------------------------------------------
// Stat lookups (ships read ruleset.ships, everything else ruleset.unitTypes)
// ---------------------------------------------------------------------------

function defenseTypeOf(ruleset: Ruleset, target: Combatant): DefenseType {
  if (target.kind === 'ship') {
    return (
      ruleset.ships[target.typeId]?.defenseType ??
      ruleset.unitTypes[target.typeId]?.defenseType ??
      'hero'
    );
  }
  return ruleset.unitTypes[target.typeId]?.defenseType ?? 'normal';
}

function collisionRadiusOf(ruleset: Ruleset, target: Combatant): number {
  if (target.kind === 'ship') {
    return (
      ruleset.ships[target.typeId]?.collisionRadius ??
      ruleset.unitTypes[target.typeId]?.collisionRadius ??
      0
    );
  }
  return ruleset.unitTypes[target.typeId]?.collisionRadius ?? 0;
}

/** Effective armor value: ship spec (hero math precompiled) + item bonuses. */
function effectiveArmor(state: SimState, ruleset: Ruleset, target: Combatant): number {
  if (target.kind !== 'ship') return ruleset.unitTypes[target.typeId]?.armor ?? 0;
  let armor = ruleset.ships[target.typeId]?.armor ?? 0;
  const player = state.players[target.owner];
  if (player) {
    for (const item of player.inventory) {
      if (!item) continue;
      armor += ruleset.equipment[item.itemId]?.passives?.armorBonus ?? 0;
    }
  }
  return armor;
}

/** Best single AIsr hull/Kraken spell reduction — never stacks (§1). */
function bestSpellReduction(state: SimState, ruleset: Ruleset, target: Combatant): number {
  if (target.kind !== 'ship') return 0;
  const player = state.players[target.owner];
  if (!player) return 0;
  let best = 0;
  for (const item of player.inventory) {
    if (!item) continue;
    const pct = ruleset.equipment[item.itemId]?.passives?.damageReductionPct ?? 0;
    if (pct > best) best = pct;
  }
  return best;
}

function armorFactor(ruleset: Ruleset, armor: number): number {
  const c = ruleset.constants.armorFactorPerPoint;
  if (armor >= 0) return 1 - (armor * c) / (1 + armor * c);
  return 2 - dPow(ruleset.constants.negativeArmorBase, -armor);
}

// ---------------------------------------------------------------------------
// Target validity
// ---------------------------------------------------------------------------

function visibleToTeam(target: Entity, team: TeamId): boolean {
  return 'vision' in target ? target.vision[team] : true;
}

function matchesFilter(filter: TargetFilter, target: Combatant): boolean {
  if (filter.heroOnly) return target.kind === 'ship';
  return target.kind === 'structure' ? filter.structures : filter.ships;
}

function hasActiveStatus(
  target: Combatant,
  kind: 'stunned' | 'silenced',
  tick: number,
): boolean {
  return target.statuses.some((s) => s.kind === kind && s.expiresAtTick > tick);
}

function isInvulnerableTarget(state: SimState, ruleset: Ruleset, target: Combatant): boolean {
  if (target.kind === 'ship') {
    if (target.invulnerableUntilTick > state.tick || target.pausedUntilTick > state.tick) {
      return true;
    }
  } else if (ruleset.unitTypes[target.typeId]?.invulnerable) {
    return true;
  }
  return target.statuses.some((s) => s.kind === 'shielded' && s.expiresAtTick > state.tick);
}

/** PF retarget gate: any 'weaponBuff' or 'dot' status carrying this buffId. */
function hasWeaponBuff(target: Combatant, buffId: string, tick: number): boolean {
  return target.statuses.some(
    (s) => (s.kind === 'weaponBuff' || s.kind === 'dot') && s.buffId === buffId
      && s.expiresAtTick > tick,
  );
}

function isValidWeaponTarget(
  state: SimState,
  ruleset: Ruleset,
  weapon: WeaponSpec,
  team: TeamId,
  x: number,
  y: number,
  target: Entity,
): target is Combatant {
  if (!isCombatant(target) || target.dead) return false;
  if (target.team === null || target.team === team) return false;
  if (!matchesFilter(weapon.targets, target)) return false;
  if (isInvulnerableTarget(state, ruleset, target)) return false;
  if (weapon.rangeUnits !== null && dist(x, y, target.x, target.y) > weapon.rangeUnits) {
    return false;
  }
  return visibleToTeam(target, team);
}

// ---------------------------------------------------------------------------
// Damage / heal — THE only hp mutation points in the codebase
// ---------------------------------------------------------------------------

function flagDeath(state: SimState, target: Combatant, damage: DamageInstance): void {
  target.dead = true;
  state.pendingDeaths.push({
    entityId: target.id,
    victimPlayer: target.owner,
    killerPlayer: damage.sourcePlayer,
    killerEntityId: damage.sourceEntityId,
    scripted: false,
  });
  state.events.push({
    type: 'death',
    tick: state.tick,
    entityId: target.id,
    entityTypeId: target.typeId,
    victimPlayer: target.owner,
    killerPlayer: damage.sourcePlayer,
    x: target.x,
    y: target.y,
  });
}

function isFriendlyDamage(state: SimState, ruleset: Ruleset, damage: DamageInstance, target: Combatant): boolean {
  if (ruleset.constants.friendlyFire) return false;
  if (damage.sourcePlayer === null || target.team === null) return false;
  return state.players[damage.sourcePlayer]?.team === target.team;
}

/**
 * THE single entry point for hp loss, any module (specials uses it for
 * suicide-bomb true damage; economy never calls it). Runs the full pipeline,
 * emits 'hit', flags death. Safe to call for already-dead targets (no-op).
 */
export function applyDamage(
  state: SimState,
  ruleset: Ruleset,
  targetId: EntityId,
  damage: DamageInstance,
): void {
  const target = state.entities[targetId];
  if (!target || target.dead || !isCombatant(target)) return;
  if (isInvulnerableTarget(state, ruleset, target)) return;
  if (isFriendlyDamage(state, ruleset, damage, target)) return;
  let final = damage.amount;
  if (damage.damageType !== 'true') {
    if (!damage.noTypeMult) {
      final *= ruleset.attackTypeVsDefense[damage.attackType][defenseTypeOf(ruleset, target)];
    }
    if (damage.damageType === 'magic') {
      final *= 1 - bestSpellReduction(state, ruleset, target);
    } else {
      final *= armorFactor(ruleset, effectiveArmor(state, ruleset, target));
    }
  }
  if (final < 0) final = 0;
  if (damage.nonLethal) final = Math.min(final, Math.max(0, target.hp - 1));
  target.hp -= final;
  state.events.push({
    type: 'hit',
    tick: state.tick,
    targetEntityId: targetId,
    attackerPlayer: damage.sourcePlayer,
    weaponId: damage.weaponId,
    amount: final,
  });
  if (target.hp <= 0) flagDeath(state, target, damage);
}

/**
 * THE single entry point for hp gain (repair woods via economy,
 * rejuvenation HoT setup is a status — its per-tick accrual flows through
 * the regen pass, not this). Clamps at maxHp; no-op on dead targets.
 */
export function applyHeal(state: SimState, targetId: EntityId, amount: number): void {
  const target = state.entities[targetId];
  if (!target || target.dead || !isCombatant(target)) return;
  if (amount <= 0) return;
  target.hp = Math.min(target.maxHp, target.hp + amount);
}

// ---------------------------------------------------------------------------
// Weapon fire & projectile impact
// ---------------------------------------------------------------------------

interface ShotSource {
  player: number | null;
  entityId: EntityId | null;
  team: TeamId;
  x: number;
  y: number;
}

function upsertStatus(target: Combatant, status: Status, matches: (s: Status) => boolean): void {
  const idx = target.statuses.findIndex(matches);
  if (idx >= 0) target.statuses[idx] = status;
  else target.statuses.push(status);
}

/** Re-application refreshes (replaces) the same buffId — never stacks (§2). */
function applyWeaponStatuses(
  state: SimState,
  ruleset: Ruleset,
  weapon: WeaponSpec,
  sourcePlayer: number | null,
  sourceTeam: TeamId,
  targetId: EntityId,
): void {
  if (weapon.dot === null && weapon.buffId === null) return;
  const target = state.entities[targetId];
  if (!target || target.dead || !isCombatant(target)) return;
  if (target.team === null || target.team === sourceTeam) return;
  if (isInvulnerableTarget(state, ruleset, target)) return;
  if (weapon.dot !== null) {
    const dotSpec = weapon.dot;
    const status: Status = {
      kind: 'dot',
      buffId: dotSpec.buffId,
      dmgPerTick: dotSpec.dmgPerTick,
      expiresAtTick: state.tick + dotSpec.durationTicks,
      nonLethal: dotSpec.nonLethal,
      sourcePlayer,
    };
    upsertStatus(target, status, (s) => s.kind === 'dot' && s.buffId === dotSpec.buffId);
  }
  if (weapon.buffId !== null && !(weapon.dot !== null && weapon.dot.buffId === weapon.buffId)) {
    const buffId = weapon.buffId;
    const status: Status = {
      kind: 'weaponBuff',
      buffId,
      expiresAtTick: state.tick + weapon.buffDurationTicks,
    };
    upsertStatus(target, status, (s) => s.kind === 'weaponBuff' && s.buffId === buffId);
  }
}

function deliverHit(
  state: SimState,
  ruleset: Ruleset,
  weapon: WeaponSpec | null,
  weaponId: string,
  source: { player: number | null; entityId: EntityId | null; team: TeamId },
  payload: Projectile['payload'],
  targetId: EntityId,
): void {
  applyDamage(state, ruleset, targetId, {
    amount: payload.amount,
    attackType: payload.attackType,
    damageType: payload.damageType,
    noTypeMult: payload.noTypeMult,
    nonLethal: false,
    sourcePlayer: source.player,
    sourceEntityId: source.entityId,
    weaponId,
  });
  if (weapon) {
    applyWeaponStatuses(state, ruleset, weapon, source.player, source.team, targetId);
  }
}

/** Launch one shot of a data-driven weapon (instant when speed is null). */
function fireWeapon(
  state: SimState,
  ruleset: Ruleset,
  weapon: WeaponSpec,
  source: ShotSource,
  target: Combatant,
): void {
  const payload: Projectile['payload'] = {
    amount: weapon.damage,
    attackType: weapon.attackType,
    damageType: weapon.damageType,
    noTypeMult: weapon.noTypeMult,
  };
  if (weapon.projectileSpeedPerTick === null) {
    deliverHit(state, ruleset, weapon, weapon.id, source, payload, target.id);
    return;
  }
  const id = allocEntityId(state);
  state.projectiles[id] = {
    id,
    ownerPlayer: source.player,
    team: source.team,
    sourceEntityId: source.entityId,
    weaponId: weapon.id,
    mechanic: weapon.mechanic,
    x: source.x,
    y: source.y,
    speedPerTick: weapon.projectileSpeedPerTick,
    homingTargetId: weapon.homing ? target.id : null,
    targetX: target.x,
    targetY: target.y,
    intendedTargetId: target.id,
    payload,
  };
}

function impactProjectile(
  state: SimState,
  ruleset: Ruleset,
  projectile: Projectile,
  x: number,
  y: number,
  homingTarget: Combatant | null,
): void {
  const weapon = ruleset.weapons[projectile.weaponId] ?? null;
  const source = {
    player: projectile.ownerPlayer,
    entityId: projectile.sourceEntityId,
    team: projectile.team,
  };
  if (weapon !== null && weapon.aoeRadius !== null) {
    const radius = weapon.aoeRadius;
    for (const id of sortedNumericKeys(state.entities)) {
      const e = state.entities[id];
      if (!e || !isCombatant(e) || e.dead) continue;
      if (e.team === null || e.team === projectile.team) continue;
      if (!matchesFilter(weapon.targets, e)) continue;
      if (dist(x, y, e.x, e.y) > radius + collisionRadiusOf(ruleset, e)) continue;
      deliverHit(state, ruleset, weapon, projectile.weaponId, source, projectile.payload, e.id);
    }
    return;
  }
  if (homingTarget !== null) {
    deliverHit(state, ruleset, weapon, projectile.weaponId, source, projectile.payload, homingTarget.id);
    return;
  }
  if (projectile.intendedTargetId === null) return;
  const target = state.entities[projectile.intendedTargetId];
  if (!target || target.dead || !isCombatant(target)) return;
  if (dist(x, y, target.x, target.y) > collisionRadiusOf(ruleset, target)) return;
  deliverHit(state, ruleset, weapon, projectile.weaponId, source, projectile.payload, target.id);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Per-rank weapon resolution: prefer a rank-keyed WeaponSpec
 * (`${weaponId}:${rank}`), then the base weaponId, then the abilityId.
 * Keying convention pending alignment with the ruleset compiler.
 */
function resolveRankWeapon(ruleset: Ruleset, ability: AbilitySpec, rank: number): WeaponSpec | null {
  const baseId = ability.weaponId ?? ability.abilityId;
  return (
    ruleset.weapons[`${baseId}:${rank}`] ??
    ruleset.weapons[baseId] ??
    ruleset.weapons[ability.abilityId] ??
    null
  );
}

/**
 * castAbility routed here by sim.ts when the AbilitySpec mechanic is
 * 'stormBoltWeapon' (Captain's Cannon A01Y, built-in sub torpedoes
 * A04X/A04Z). Validates skill rank > 0 and per-skill cooldown (stored in
 * PlayerState.cooldownGroups keyed by abilityId), then delegates to
 * castStormBolt with the rank's WeaponSpec. 'phoenixFireWeapon' casts are
 * rejected — PF is passive and fires from the inventory scan.
 */
export function applyCombatCommand(state: SimState, ruleset: Ruleset, cmd: CombatCommandU): void {
  const reject = (reason: string): void => {
    state.events.push({
      type: 'commandRejected',
      tick: state.tick,
      player: cmd.player,
      commandType: cmd.type,
      reason,
    });
  };
  const player = state.players[cmd.player];
  if (!player) {
    reject('unknownPlayer');
    return;
  }
  const ability = ruleset.abilities[cmd.abilityId];
  if (!ability) {
    reject('unknownAbility');
    return;
  }
  if (ability.mechanic === 'phoenixFireWeapon') {
    reject('passiveWeapon');
    return;
  }
  if (ability.mechanic !== 'stormBoltWeapon') {
    reject('notACombatAbility');
    return;
  }
  const ship = player.shipId !== null ? state.entities[player.shipId] : undefined;
  if (!ship || ship.kind !== 'ship' || ship.dead) {
    reject('noShip');
    return;
  }
  const shipSpec = ruleset.ships[ship.typeId];
  if (shipSpec && !shipSpec.abilityIds.includes(cmd.abilityId)) {
    reject('abilityNotOnShip');
    return;
  }
  const learned = player.heroSkillLevels[cmd.abilityId] ?? 0;
  const rank = ability.kind === 'innate' ? Math.max(1, learned) : learned;
  if (rank <= 0) {
    reject('skillNotLearned');
    return;
  }
  if (hasActiveStatus(ship, 'silenced', state.tick)) {
    reject('silenced');
    return;
  }
  if (state.tick < (player.cooldownGroups[cmd.abilityId] ?? 0)) {
    reject('onCooldown');
    return;
  }
  const weapon = resolveRankWeapon(ruleset, ability, rank);
  if (!weapon) {
    reject('noWeaponForRank');
    return;
  }
  if (cmd.targetId === undefined) {
    reject('targetRequired');
    return;
  }
  if (!castStormBolt(state, ruleset, ship.id, weapon.id, cmd.targetId)) return;
  player.cooldownGroups[cmd.abilityId] = state.tick + (ability.cooldownTicks ?? weapon.cooldownTicks);
}

/**
 * Fire a Storm-Bolt-mechanic weapon (torpedo bays via economy.useItem, hero
 * skills via applyCombatCommand). Returns false (and emits commandRejected)
 * if validation fails — caller must NOT consume cooldowns/charges on false.
 * Wind-up weapons (castTimeTicks > 0) park on ShipEntity.casting and return
 * true immediately; the launch happens in stepCombat phase 1.
 */
export function castStormBolt(
  state: SimState,
  ruleset: Ruleset,
  casterId: EntityId,
  weaponId: string,
  targetId: EntityId,
): boolean {
  const caster = state.entities[casterId];
  const casterPlayer = caster !== undefined && isUnitEntity(caster) ? caster.owner : -1;
  const fail = (reason: string): false => {
    state.events.push({
      type: 'commandRejected',
      tick: state.tick,
      player: casterPlayer,
      commandType: 'castAbility',
      reason,
    });
    return false;
  };
  if (!caster || caster.dead || !isUnitEntity(caster)) return fail('invalidCaster');
  const weapon = ruleset.weapons[weaponId];
  if (!weapon || weapon.mechanic !== 'stormBolt') return fail('notAStormBoltWeapon');
  if (caster.kind === 'ship' && (caster.pausedUntilTick > state.tick || caster.casting !== null)) {
    return fail('busy');
  }
  if (hasActiveStatus(caster, 'stunned', state.tick)) return fail('stunned');
  const target = state.entities[targetId];
  if (
    !target ||
    target.dead ||
    !isCombatant(target) ||
    target.team === null ||
    target.team === caster.team ||
    !matchesFilter(weapon.targets, target) ||
    isInvulnerableTarget(state, ruleset, target)
  ) {
    return fail('invalidTarget');
  }
  if (!visibleToTeam(target, caster.team)) return fail('targetNotVisible');
  if (
    weapon.rangeUnits !== null &&
    dist(caster.x, caster.y, target.x, target.y) > weapon.rangeUnits
  ) {
    return fail('outOfRange');
  }
  if (weapon.castTimeTicks > 0 && caster.kind === 'ship') {
    caster.casting = {
      abilityOrItemId: weapon.id,
      slot: null,
      targetId,
      x: null,
      y: null,
      completesAtTick: state.tick + weapon.castTimeTicks,
    };
    breakInvisibilityOnAction(state, caster.id);
    return true;
  }
  breakInvisibilityOnAction(state, caster.id);
  fireWeapon(
    state,
    ruleset,
    weapon,
    { player: caster.owner, entityId: caster.id, team: caster.team, x: caster.x, y: caster.y },
    target,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Tick phases
// ---------------------------------------------------------------------------

/** Phase 1: storm-bolt wind-ups whose completesAtTick is due launch now. */
function completeCasts(state: SimState, ruleset: Ruleset): void {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.kind !== 'ship' || e.casting === null) continue;
    const weapon = ruleset.weapons[e.casting.abilityOrItemId];
    if (!weapon || weapon.mechanic !== 'stormBolt') continue; // not a combat wind-up
    if (state.tick < e.casting.completesAtTick) continue;
    const casting = e.casting;
    e.casting = null;
    if (e.dead) continue;
    const target = casting.targetId !== null ? state.entities[casting.targetId] : undefined;
    if (!target || target.dead || !isCombatant(target)) continue; // fizzle
    fireWeapon(
      state,
      ruleset,
      weapon,
      { player: e.owner, entityId: e.id, team: e.team, x: e.x, y: e.y },
      target,
    );
  }
}

/** Phase 2: Phoenix Fire instance scans (SEMANTICS §2). */
function stepPhoenixFire(state: SimState, ruleset: Ruleset): void {
  for (const slot of sortedNumericKeys(state.players)) {
    const player = state.players[slot];
    if (!player || player.shipId === null) continue;
    const ship = state.entities[player.shipId];
    if (!ship || ship.kind !== 'ship' || ship.dead) continue;
    if (ship.pausedUntilTick > state.tick) continue;
    for (const item of player.inventory) {
      if (!item) continue;
      const weapon = ruleset.weapons[item.itemId];
      if (!weapon || weapon.mechanic !== 'phoenixFire') continue;
      if (state.tick < item.readyAtTick) continue;
      const candidates: Combatant[] = [];
      for (const id of sortedNumericKeys(state.entities)) {
        const e = state.entities[id];
        if (!e) continue;
        if (!isValidWeaponTarget(state, ruleset, weapon, ship.team, ship.x, ship.y, e)) continue;
        if (weapon.buffId !== null && hasWeaponBuff(e, weapon.buffId, state.tick)) continue;
        candidates.push(e);
      }
      if (candidates.length === 0) continue; // stays ready; cooldown NOT consumed
      const pick = candidates[rollInt(state, 0, candidates.length - 1)];
      if (!pick) continue;
      fireWeapon(
        state,
        ruleset,
        weapon,
        { player: player.slot, entityId: ship.id, team: ship.team, x: ship.x, y: ship.y },
        pick,
      );
      item.readyAtTick = state.tick + weapon.cooldownTicks;
    }
  }
}

function sumPerLevel(perLevel: number[], level: number): number {
  let total = 0;
  for (let i = 0; i < level && i < perLevel.length; i++) total += perLevel[i] ?? 0;
  return total;
}

function selectAttackTarget(
  state: SimState,
  ruleset: Ruleset,
  attacker: Combatant,
  team: TeamId,
  attack: UnitAttackSpec,
): Combatant | null {
  const valid = (target: Entity): target is Combatant =>
    isCombatant(target) &&
    !target.dead &&
    target.team !== null &&
    target.team !== team &&
    matchesFilter(attack.targets, target) &&
    !isInvulnerableTarget(state, ruleset, target) &&
    visibleToTeam(target, team) &&
    dist(attacker.x, attacker.y, target.x, target.y) <= attack.rangeUnits;
  if (isUnitEntity(attacker)) {
    const order = attacker.order;
    if (order.type === 'move') return null; // plain move never stops to attack
    if (order.type === 'attackTarget') {
      const target = state.entities[order.targetId];
      return target !== undefined && valid(target) ? target : null;
    }
  }
  // idle / hold / attackMove / structures: nearest in range, ascending-id tiebreak.
  let best: Combatant | null = null;
  let bestDist = Infinity;
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.id === attacker.id || !valid(e)) continue;
    const d = dist(attacker.x, attacker.y, e.x, e.y);
    if (d < bestDist) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

/** Phase 3: native attacks (creeps/towers/HQ + ships' vestigial attack). */
function stepNativeAttacks(state: SimState, ruleset: Ruleset): void {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || !isCombatant(e) || e.dead) continue;
    const team = e.team;
    if (team === null) continue; // neutral structures never attack
    const attack = ruleset.unitTypes[e.typeId]?.attack ?? null;
    if (!attack) continue;
    if (state.tick < e.attackReadyAtTick) continue;
    if (e.kind === 'ship' && (e.pausedUntilTick > state.tick || e.casting !== null)) continue;
    if (hasActiveStatus(e, 'stunned', state.tick)) continue;
    const target = selectAttackTarget(state, ruleset, e, team, attack);
    if (!target) continue;
    let base = attack.damageBase;
    let dice = attack.damageDice;
    const teamState = state.teams[team];
    for (const upgradeId of attack.upgradeIds) {
      const spec = ruleset.upgrades[upgradeId];
      if (!spec) continue;
      const level = teamState.upgrades[upgradeId] ?? 0;
      if (level <= 0) continue;
      const total = sumPerLevel(spec.effect.perLevel, level);
      if (spec.effect.kind === 'flatAttackDamage') base += total;
      else if (spec.effect.kind === 'bonusAttackDice') dice += total;
    }
    let amount = base;
    if (attack.damageSides > 0) {
      for (let i = 0; i < dice; i++) amount += rollInt(state, 1, attack.damageSides);
    }
    breakInvisibilityOnAction(state, e.id);
    e.attackReadyAtTick = state.tick + attack.cooldownTicks;
    const payload: Projectile['payload'] = {
      amount,
      attackType: attack.attackType,
      damageType: 'physical',
      noTypeMult: false,
    };
    if (attack.projectileSpeedPerTick === null) {
      applyDamage(state, ruleset, target.id, {
        ...payload,
        nonLethal: false,
        sourcePlayer: e.owner,
        sourceEntityId: e.id,
        weaponId: e.typeId,
      });
    } else {
      const pid = allocEntityId(state);
      state.projectiles[pid] = {
        id: pid,
        ownerPlayer: e.owner,
        team,
        sourceEntityId: e.id,
        weaponId: e.typeId,
        mechanic: 'nativeAttack',
        x: e.x,
        y: e.y,
        speedPerTick: attack.projectileSpeedPerTick,
        homingTargetId: target.id,
        targetX: target.x,
        targetY: target.y,
        intendedTargetId: target.id,
        payload,
      };
    }
  }
}

/** Phase 4: flight & impact for ALL projectiles (incl. specials' missiles). */
function stepProjectiles(state: SimState, ruleset: Ruleset): void {
  for (const id of sortedNumericKeys(state.projectiles)) {
    const p = state.projectiles[id];
    if (!p) continue;
    if (p.homingTargetId !== null) {
      const target = state.entities[p.homingTargetId];
      if (!target || target.dead || !isCombatant(target)) {
        delete state.projectiles[id]; // fizzle: homing target died in flight
        continue;
      }
      p.targetX = target.x;
      p.targetY = target.y;
      const d = dist(p.x, p.y, target.x, target.y);
      if (d <= p.speedPerTick) {
        delete state.projectiles[id];
        impactProjectile(state, ruleset, p, target.x, target.y, target);
        continue;
      }
      const stepX = ((target.x - p.x) / d) * p.speedPerTick;
      const stepY = ((target.y - p.y) / d) * p.speedPerTick;
      p.x += stepX;
      p.y += stepY;
    } else {
      const d = dist(p.x, p.y, p.targetX, p.targetY);
      if (d <= p.speedPerTick) {
        delete state.projectiles[id];
        impactProjectile(state, ruleset, p, p.targetX, p.targetY, null);
        continue;
      }
      const stepX = ((p.targetX - p.x) / d) * p.speedPerTick;
      const stepY = ((p.targetY - p.y) / d) * p.speedPerTick;
      p.x += stepX;
      p.y += stepY;
    }
  }
}

/** Phase 5: single regen/HoT/DoT pass + combat-owned status expiry (§10). */
function stepRegenAndStatuses(state: SimState, ruleset: Ruleset): void {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || !isCombatant(e) || e.dead) continue;
    let regen = 0;
    if (e.kind === 'ship') {
      regen += ruleset.ships[e.typeId]?.hpRegenPerTick ?? 0;
      const player = state.players[e.owner];
      if (player) {
        for (const item of player.inventory) {
          if (!item) continue;
          regen += ruleset.equipment[item.itemId]?.passives?.hpRegenPerTick ?? 0;
        }
        // Mechanics-skill magnitudes are HP/s; sorted keys keep float order stable.
        for (const abilityId of Object.keys(player.heroSkillLevels).sort()) {
          const rank = player.heroSkillLevels[abilityId] ?? 0;
          if (rank <= 0) continue;
          const ability = ruleset.abilities[abilityId];
          if (!ability || ability.mechanic !== 'mechanicsRegen') continue;
          const idx = Math.min(rank, ability.magnitudePerRank.length) - 1;
          regen += (ability.magnitudePerRank[idx] ?? 0) / ruleset.tickRate;
        }
      }
    } else {
      regen += ruleset.unitTypes[e.typeId]?.hpRegenPerTick ?? 0;
    }
    for (const s of e.statuses) {
      if (s.kind === 'hot' && s.expiresAtTick > state.tick) regen += s.healPerTick;
    }
    if (regen > 0 && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + regen);
    for (const s of e.statuses) {
      if (s.kind !== 'dot' || s.expiresAtTick <= state.tick) continue;
      applyDamage(state, ruleset, e.id, {
        amount: s.dmgPerTick,
        attackType: 'spells',
        damageType: 'true',
        noTypeMult: true,
        nonLethal: s.nonLethal,
        sourcePlayer: s.sourcePlayer,
        sourceEntityId: null,
        weaponId: s.buffId,
      });
      if (e.dead) break;
    }
    if (e.statuses.length > 0) {
      // Expire ALL timed status kinds here (specials owns only the
      // invisible/revealed pair) so inert objects never accumulate.
      e.statuses = e.statuses.filter(
        (s) =>
          !(
            (s.kind === 'dot' ||
              s.kind === 'hot' ||
              s.kind === 'weaponBuff' ||
              s.kind === 'ensnared' ||
              s.kind === 'stunned' ||
              s.kind === 'silenced' ||
              s.kind === 'slowed' ||
              s.kind === 'shielded') &&
            s.expiresAtTick <= state.tick + 1
          ),
      );
    }
  }
}

/** One combat tick: casts, PF scans, native attacks, projectiles, regen/DoT. */
export function stepCombat(state: SimState, ruleset: Ruleset): void {
  completeCasts(state, ruleset);
  stepPhoenixFire(state, ruleset);
  stepNativeAttacks(state, ruleset);
  stepProjectiles(state, ruleset);
  stepRegenAndStatuses(state, ruleset);
}
