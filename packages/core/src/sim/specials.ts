/**
 * Specials system: missiles, suicide quests, invisibility/detection, dive,
 * teleports, region triggers, wards, exotic ship abilities.
 *
 * Responsibilities:
 * - Visibility (SEMANTICS §5/§9): recomputeVisibility writes
 *   entity.vision per tick — invisible ('invisible' status without
 *   'revealed') defeats enemy vision unless a team detector covers the
 *   unit: ship/unit detectionRadius (H001 Adtg 1200, Spy wards Atru, gemt
 *   carrier), ward detectionRadius, or an active DetectionZone (flares).
 *   Own team always sees its units. PF scans and unit-target casts in
 *   combat require vision — so this MUST run before stepCombat.
 * - Invisibility lifecycle: smoke statuses expire; breakInvisibilityOnAction
 *   (exported; called by combat on attack/cast and economy on item use)
 *   removes breaksOnAction invisibility permanently, and for Ghost (H00W)
 *   adds a 'revealed' status for the action window instead.
 * - Missile system (script-rules.json §1): fireMissile validates carried
 *   I01N + at least one warhead + missileReadyAtTick, then fires ONE
 *   missile per carried warhead tier in ascending rawcode order (the three
 *   sequential non-exclusive JASS branches) — each launch consumes its own
 *   I01N + warhead and rolls its own uniformly random STRUCTURE owned by
 *   the ENEMY LEAD PLAYER (slot 0 or 1), candidates in ascending entity id
 *   — sets the ~2 s throttle once and spawns kaboomMissile Projectiles
 *   (combat flies/detonates them). Launching breaks invisibility.
 *   Buggfix retry is a documented no-op divergence: sim projectiles cannot
 *   stick, so the 20 s gg_trg_Buggfix re-order (and its south-only
 *   asymmetry, MissileRules.buggfixSouthOnly) has nothing to repair.
 * - Suicide quests (SuicideQuestSpec): region-driven token swaps
 *   (pickupRegion -> unarmedToken, armRegionByTeam -> armedToken + enemy
 *   warn event), detonation on entering detonateRegionByTeam: flat true
 *   damage to the enemy HQ via combat.applyDamage, carrier dies (scripted
 *   PendingDeath), pilot paid rewardGold + progression.grantXp,
 *   'questProgress' events at each stage. Quest token add/swap is a
 *   documented exception to economy's inventory ownership (like the
 *   missile consumption). Verbatim behavior kept: detonation does NOT
 *   remove the quest items — WC3 heroes keep their inventory through
 *   death, so a revived carrier still holds the armed token.
 * - Dive (SEMANTICS §5): castAbility dive swaps ShipSpec stat block
 *   H00V <-> H00W on the SAME entity id (typeId, maxHp by HP FRACTION —
 *   flagged OPEN, SEMANTICS §5 question 5), sets submerged, manages the
 *   permanent-ghost 'invisible' status, 5 s cooldown. Sub base teleport:
 *   SUBMERGED subs (subRules.submergedTypeId) entering
 *   map.subTeleports[].mainRegion jump to exitRegion center — NOTE this
 *   follows war3map.j (Trig_*SubHarbor_Copy conditions check 'H00W',
 *   lines 9411-9435 / 9475-9499) and diverges from the map-layout.json
 *   annotation ("surfaced") mirrored in types.ts; flagged for architect
 *   review.
 * - Repair bays: damaged allied hero entering stationRegion -> paused +
 *   invulnerable for the scripted settle window, healed to full via
 *   combat.applyHeal at release, then moved to exitRegion center; one ship
 *   at a time per bay (war3map.j Trig_Start_Repair_*).
 * - Wards & zones: ward/summon expiry (dead=true, no PendingDeath — expiry
 *   is not a kill), DetectionZone expiry, motion-detector 'proximityWarning'
 *   events (no vision granted); goblin-mine ('goblinMine' status) arming on
 *   victim action + 5 s scripted kill.
 * - Exotic ship abilities (AbilitySpec mechanic 'special'): castSpecial
 *   dispatches on the compiled SpecialParams.kind (Capsize suicidal nuke,
 *   EMP/Freeze self-AoE damage+slow/root, Acid/Board DoT+debuff, Sail Ripper
 *   slow, Disrupt area-silence, Hull/Goblin Repair HoT, Pirate/Ghost Crew &
 *   Seamonster summons, Mirror-Image decoy, Eat/Digest Hero devour, Intercept
 *   haste, Barrier invuln, Send Spy detector, Goblin Bomber mine, Fire Missile
 *   route). Passive auras (Slow Aura, Ghost-cloud damage, regen aura) run in
 *   runSpecialAuras every tick. Unknown bases (special === null) still reject
 *   'unimplemented'; passive auras reject an explicit cast as 'passiveAura'.
 *   All effects are deterministic (no RNG/wall-clock) and the AI never casts
 *   them, so seed-equal AI replays stay bit-identical.
 *
 * Ability cooldowns are tracked in PlayerState.cooldownGroups keyed by
 * abilityId (the record is shared with item icid groups; rawcode namespaces
 * cannot collide).
 *
 * Reads: ruleset.missiles/suicideQuests/subRules/abilities/ships/unitTypes/
 * map.regions, player inventories (mutated ONLY for the documented missile
 * consumption + quest tokens), entity positions (post-movement).
 * Mutates: entity.vision/statuses/typeId/submerged/pausedUntilTick/
 * invulnerableUntilTick/x/y (teleports), state.projectiles (missile spawn),
 * state.detectionZones, wards/summons lifecycle, player gold (quest
 * payouts) + missileReadyAtTick + cooldownGroups (ability cooldowns),
 * state.pendingDeaths (scripted), state.events.
 *
 * Tick order: runs 3rd — after movement (fresh positions for region
 * triggers), before combat (fresh vision for targeting).
 */

import { applyDamage, applyHeal } from './combat.js';
import { grantXp } from './progression.js';
import {
  allocEntityId,
  enemyTeam,
  isCombatant,
  isUnitEntity,
  nearestWater,
  pointInRegion,
  rollInt,
  sortedNumericKeys,
} from './types.js';
import type {
  AbilitySpec,
  CastAbilityCommand,
  DamageInstance,
  EntityId,
  EquipmentActive,
  FireMissileCommand,
  PlayerState,
  Ruleset,
  ShipEntity,
  SimState,
  SpecialParams,
  SpecialsCommandU,
  Status,
  StructureEntity,
  SuicideQuestSpec,
  SummonEntity,
  TeamId,
  UnitEntity,
  WardEntity,
} from './types.js';

// ---------------------------------------------------------------------------
// Scripted-trigger constants. These timings come from war3map.j trigger
// bodies, not object data, and the current Ruleset shape has no field for
// them (breakInvisibilityOnAction also has no ruleset parameter). Ticks at
// the fixed TICK_RATE of 20 — flagged as an open question to migrate into
// the Ruleset.
// ---------------------------------------------------------------------------

/** Bstt Goblin Mine fuse: kills the victim 5 s after its next action (war3map.j:8752-8805). */
const GOBLIN_MINE_FUSE_TICKS = 100;

/**
 * Repair bay service window: the scripted 1.5 s settle sleep before
 * pause/heal (war3map.j:9803). The original then drip-heals via four h002
 * Repairmen until 100%; the sim collapses that to a full heal at release.
 */
const REPAIR_BAY_SERVICE_TICKS = 30;

/**
 * Goblin Scout Crew (I00F, base item gemt) grants carrier true sight.
 * EquipmentSpec carries no detection field, so the item id and the ~900
 * stock gemt radius live here as PROVISIONAL constants (SEMANTICS §5,
 * confidence medium) — open question to move into the Ruleset.
 */
const GEM_TRUE_SIGHT_ITEM_ID = 'I00F';
const GEM_TRUE_SIGHT_RADIUS = 900;

/**
 * Warhead WeaponSpecs always carry a projectile speed (dummy umvs 200-400);
 * a null in patched data means "instant" — modeled as fast enough to arrive
 * within one combat tick.
 */
const INSTANT_PROJECTILE_SPEED_PER_TICK = 1e9;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * fireMissile, plus castAbility for every non-weapon ability (dive,
 * invisibility, flare, exotic specials). Weapon-mechanic casts are routed
 * to combat by sim.ts before this is called.
 */
export function applySpecialsCommand(
  state: SimState,
  ruleset: Ruleset,
  cmd: SpecialsCommandU,
): void {
  if (cmd.type === 'fireMissile') applyFireMissile(state, ruleset, cmd);
  else applyCastAbility(state, ruleset, cmd);
}

/** One specials tick (see module doc). Calls recomputeVisibility last. */
export function stepSpecials(state: SimState, ruleset: Ruleset): void {
  pruneExpiredVisibilityStatuses(state);
  detonateArmedGoblinMines(state);
  expireWardsSummonsAndZones(state);
  runSuicideQuests(state, ruleset);
  runSubTeleports(state, ruleset);
  runRepairBays(state, ruleset);
  emitProximityWarnings(state);
  runSpecialAuras(state, ruleset);
  recomputeVisibility(state, ruleset);
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

interface DetectorPoint {
  x: number;
  y: number;
  radius: number;
}

/**
 * Recompute entity.vision for every unit from invisibility statuses,
 * detectors and detection zones. Exported for tests; stepSpecials calls it
 * after all status/position changes of this phase. Fog-of-war is not
 * modeled — a non-invisible unit is visible to both teams.
 */
export function recomputeVisibility(state: SimState, ruleset: Ruleset): void {
  const detectors: Record<TeamId, DetectorPoint[]> = { south: [], north: [] };

  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead) continue;

    if (e.kind === 'ward') {
      if (e.expiresAtTick !== null && state.tick >= e.expiresAtTick) continue;
      if (e.detectionRadius !== null && e.detectionRadius > 0) {
        detectors[e.team].push({ x: e.x, y: e.y, radius: e.detectionRadius });
      }
      continue;
    }

    const team = e.team;
    if (team === null) continue;

    if (e.kind === 'ship') {
      const spec = ruleset.ships[e.typeId];
      if (spec && spec.detectionRadius !== null && spec.detectionRadius > 0) {
        detectors[team].push({ x: e.x, y: e.y, radius: spec.detectionRadius });
      }
      // Carrier true sight (Goblin Scout Crew) — see constant doc above.
      const player = state.players[e.owner];
      if (player) {
        for (const item of player.inventory) {
          if (item && item.itemId === GEM_TRUE_SIGHT_ITEM_ID) {
            detectors[team].push({ x: e.x, y: e.y, radius: GEM_TRUE_SIGHT_RADIUS });
            break;
          }
        }
      }
    } else {
      const spec = ruleset.unitTypes[e.typeId];
      if (spec && spec.detectionRadius !== null && spec.detectionRadius > 0) {
        detectors[team].push({ x: e.x, y: e.y, radius: spec.detectionRadius });
      }
    }
  }

  for (const zone of state.detectionZones) {
    if (zone.expiresAtTick > state.tick) {
      detectors[zone.team].push({ x: zone.x, y: zone.y, radius: zone.radius });
    }
  }

  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead || !isUnitEntity(e)) continue;
    const foe = enemyTeam(e.team);
    const hidden =
      hasActiveInvisible(e.statuses, state.tick) && !hasActiveRevealed(e.statuses, state.tick);
    let foeSees = !hidden;
    if (hidden) {
      for (const d of detectors[foe]) {
        if (distSq(d.x, d.y, e.x, e.y) <= d.radius * d.radius) {
          foeSees = true;
          break;
        }
      }
    }
    e.vision =
      e.team === 'south' ? { south: true, north: foeSees } : { south: foeSees, north: true };
  }
}

/**
 * The acting unit attacked / cast / used an item (move & stop exempt):
 * removes breaks-on-action invisibility permanently; Ghost units instead
 * gain 'revealed' until the action completes (instant = 1 tick; wind-up
 * casts until casting.completesAtTick). Also arms a pending 'goblinMine'
 * (detonates GOBLIN_MINE_FUSE_TICKS later). Called by combat and economy —
 * never for plain movement.
 *
 * Granularity note (open question, SEMANTICS §5 q6): an instant reveal
 * expires at tick+1, so an action taken in the combat phase (after this
 * tick's recomputeVisibility) is pruned before the next recompute and never
 * surfaces in vision; actions from the applyCommands phase are revealed for
 * exactly the action tick.
 */
export function breakInvisibilityOnAction(state: SimState, entityId: EntityId): void {
  const e = state.entities[entityId];
  if (!e || e.dead || !isUnitEntity(e)) return;

  let ghost = false;
  const kept: Status[] = [];
  for (const s of e.statuses) {
    if (s.kind === 'invisible') {
      if (s.breaksOnAction) continue; // smoke: dispelled permanently
      ghost = true; // Agho: suppressed, not removed
    }
    kept.push(s);
  }
  e.statuses = kept;

  if (ghost) {
    const completes =
      e.kind === 'ship' && e.casting !== null ? e.casting.completesAtTick : state.tick + 1;
    let extended = false;
    for (const s of e.statuses) {
      if (s.kind === 'revealed') {
        s.expiresAtTick = Math.max(s.expiresAtTick, completes);
        extended = true;
        break;
      }
    }
    if (!extended) e.statuses.push({ kind: 'revealed', expiresAtTick: completes });
  }

  for (const s of e.statuses) {
    if (s.kind === 'goblinMine' && s.detonateAtTick === null) {
      s.detonateAtTick = state.tick + GOBLIN_MINE_FUSE_TICKS;
    }
  }
}

/** Smoke/reveal timers run out (statuses with expiry at or before now). */
function pruneExpiredVisibilityStatuses(state: SimState): void {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead || e.kind === 'ward') continue;
    let stale = false;
    for (const s of e.statuses) {
      if (
        (s.kind === 'invisible' && s.expiresAtTick !== null && s.expiresAtTick <= state.tick) ||
        (s.kind === 'revealed' && s.expiresAtTick <= state.tick)
      ) {
        stale = true;
        break;
      }
    }
    if (!stale) continue;
    e.statuses = e.statuses.filter(
      (s) =>
        !(
          (s.kind === 'invisible' && s.expiresAtTick !== null && s.expiresAtTick <= state.tick) ||
          (s.kind === 'revealed' && s.expiresAtTick <= state.tick)
        ),
    );
  }
}

// ---------------------------------------------------------------------------
// Missile system
// ---------------------------------------------------------------------------

function applyFireMissile(state: SimState, ruleset: Ruleset, cmd: FireMissileCommand): void {
  const player = state.players[cmd.player];
  if (!player) {
    reject(state, cmd.player, cmd.type, 'unknownPlayer');
    return;
  }
  // The missile dummy spawns at the player's boat (war3map.j:11029ff) —
  // a live boat is required as the launch origin.
  const ship = player.shipId !== null ? state.entities[player.shipId] : undefined;
  if (!ship || ship.kind !== 'ship' || ship.dead) {
    reject(state, cmd.player, cmd.type, 'noShip');
    return;
  }
  if (ship.pausedUntilTick > state.tick) {
    reject(state, cmd.player, cmd.type, 'paused');
    return;
  }
  if (ship.casting !== null) {
    reject(state, cmd.player, cmd.type, 'casting');
    return;
  }
  if (player.missileReadyAtTick > state.tick) {
    reject(state, cmd.player, cmd.type, 'missileNotReady');
    return;
  }

  const rules = ruleset.missiles;
  if (findItemSlot(player, rules.lumberItemId) < 0) {
    reject(state, cmd.player, cmd.type, 'missingLumber');
    return;
  }
  let anyWarhead = false;
  for (const item of player.inventory) {
    if (item && rules.warheads[item.itemId] !== undefined) anyWarhead = true;
  }
  if (!anyWarhead) {
    reject(state, cmd.player, cmd.type, 'missingWarhead');
    return;
  }

  // Candidate structures of the ENEMY LEAD PLAYER ONLY (slot 0 or 1) —
  // other enemy players' structures are never hit (preserved verbatim
  // behavior, war3map.j:11029-11035). Ascending entity id before the draw.
  const enemyLeadSlot = state.teams[enemyTeam(player.team)].aiPlayerSlot;
  const candidates: StructureEntity[] = [];
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (e && e.kind === 'structure' && !e.dead && e.owner === enemyLeadSlot) candidates.push(e);
  }
  // Divergence (documented): the verbatim script consumes the items before
  // targeting and strands a dummy when the pool is empty; the sim rejects
  // pre-consumption instead (the pool only empties once the match is over).
  if (candidates.length === 0) {
    reject(state, cmd.player, cmd.type, 'noTarget');
    return;
  }

  // One missile per carried warhead TIER, in ascending warhead rawcode
  // order (the three sequential non-exclusive JASS branches, war3map.j
  // 11006-11129): each launch consumes its own I01N + that warhead and
  // rolls its own random target; stops when the lumber runs out. At most
  // one shot per tier per cast even when duplicates are carried.
  let launched = false;
  for (const warheadItemId of Object.keys(rules.warheads)) {
    const warheadSlot = findItemSlot(player, warheadItemId);
    if (warheadSlot < 0) continue;
    const lumberSlot = findItemSlot(player, rules.lumberItemId);
    if (lumberSlot < 0) break; // out of lumber: later branches silently skip
    const link = rules.warheads[warheadItemId];
    const weapon = link ? ruleset.weapons[link.weaponId] : undefined;
    if (!link || !weapon) {
      reject(state, cmd.player, cmd.type, 'unknownWarheadWeapon');
      continue;
    }

    // Launch: consume BOTH items (documented exception to economy's
    // inventory ownership), roll the target, spawn the projectile.
    consumeItemAt(player, lumberSlot);
    consumeItemAt(player, warheadSlot);
    launched = true;

    const target = candidates[rollInt(state, 0, candidates.length - 1)];
    if (!target) continue; // unreachable: index in [0, length-1]

    const projId = allocEntityId(state);
    state.projectiles[projId] = {
      id: projId,
      // The dummy is owned by the firing TEAM's lead player (war3map.j:
      // Player(0)/Player(1)), not the casting player.
      ownerPlayer: state.teams[player.team].aiPlayerSlot,
      team: player.team,
      sourceEntityId: ship.id,
      weaponId: weapon.id,
      mechanic: 'kaboomMissile',
      x: ship.x,
      y: ship.y,
      speedPerTick: weapon.projectileSpeedPerTick ?? INSTANT_PROJECTILE_SPEED_PER_TICK,
      homingTargetId: weapon.homing ? target.id : null,
      targetX: target.x,
      targetY: target.y,
      intendedTargetId: target.id,
      payload: {
        amount: weapon.damage,
        attackType: weapon.attackType,
        damageType: weapon.damageType,
        noTypeMult: weapon.noTypeMult,
      },
    };

    state.events.push({
      type: 'missileLaunched',
      tick: state.tick,
      player: cmd.player,
      warheadItemId,
      targetEntityId: target.id,
    });
  }

  if (launched) {
    player.missileReadyAtTick = state.tick + rules.throttleTicks;
    // Launching is an action: breaks smoke / reveals a ghost (§9).
    breakInvisibilityOnAction(state, ship.id);
  }
}

// ---------------------------------------------------------------------------
// Ability casts (non-weapon mechanics)
// ---------------------------------------------------------------------------

function applyCastAbility(state: SimState, ruleset: Ruleset, cmd: CastAbilityCommand): void {
  const player = state.players[cmd.player];
  if (!player) {
    reject(state, cmd.player, cmd.type, 'unknownPlayer');
    return;
  }
  const ship = player.shipId !== null ? state.entities[player.shipId] : undefined;
  if (!ship || ship.kind !== 'ship' || ship.dead) {
    reject(state, cmd.player, cmd.type, 'noShip');
    return;
  }
  if (ship.pausedUntilTick > state.tick) {
    reject(state, cmd.player, cmd.type, 'paused');
    return;
  }
  if (ship.casting !== null) {
    reject(state, cmd.player, cmd.type, 'casting');
    return;
  }
  // Mirror the combat cast path: stunned/silenced units cannot cast
  // (combat.applyCombatCommand / castStormBolt enforce the same).
  if (hasActiveTimedStatus(ship, 'stunned', state.tick)) {
    reject(state, cmd.player, cmd.type, 'stunned');
    return;
  }
  if (hasActiveTimedStatus(ship, 'silenced', state.tick)) {
    reject(state, cmd.player, cmd.type, 'silenced');
    return;
  }
  const spec = ruleset.abilities[cmd.abilityId];
  if (!spec) {
    reject(state, cmd.player, cmd.type, 'unknownAbility');
    return;
  }

  switch (spec.mechanic) {
    case 'special':
      // Exotic kit (Capsize, EMP, Freeze Water, Eat Hero, ...) decoded into
      // SpecialParams at compile time and dispatched by castSpecial.
      castSpecial(state, ruleset, cmd, player, ship, spec, abilityRank(ruleset, player, ship, spec));
      return;
    case 'dive':
      castDive(state, ruleset, cmd, player, ship, spec);
      return;
    case 'invisibility':
      castInvisibility(state, cmd, player, ship, spec, abilityRank(ruleset, player, ship, spec));
      return;
    case 'flareDetection':
      castFlare(state, cmd, player, ship, spec, abilityRank(ruleset, player, ship, spec));
      return;
    case 'ensnare':
      castNet(state, cmd, player, ship, spec, abilityRank(ruleset, player, ship, spec));
      return;
    case 'shoreLeave':
      castShoreLeave(state, ruleset, cmd, player, ship, spec);
      return;
    default:
      // Passive mechanics (hullHp/sailSpeed/mechanicsRegen/trueSightPassive)
      // and misrouted weapon casts cannot be activated.
      reject(state, cmd.player, cmd.type, 'notActivatable');
      return;
  }
}

/**
 * Castable rank of an ability for this player's current ship: hero skills
 * use the learned rank (and must be in the hull's kit), innates are rank 1
 * when present on the hull. 0 = not castable.
 */
function abilityRank(
  ruleset: Ruleset,
  player: PlayerState,
  ship: ShipEntity,
  spec: AbilitySpec,
): number {
  const shipSpec = ruleset.ships[ship.typeId];
  const onShip = shipSpec ? shipSpec.abilityIds.includes(spec.abilityId) : false;
  if (!onShip) return 0;
  if (spec.kind === 'heroSkill') return player.heroSkillLevels[spec.abilityId] ?? 0;
  return 1;
}

function castDive(
  state: SimState,
  ruleset: Ruleset,
  cmd: CastAbilityCommand,
  player: PlayerState,
  ship: ShipEntity,
  spec: AbilitySpec,
): void {
  const sub = ruleset.subRules;
  // The submerged form casts the morph-back natively (AEme alternate form)
  // even though H00W's data kit is empty; the surfaced form must carry the
  // ability.
  const surfacing = ship.typeId === sub.submergedTypeId;
  if (!surfacing && ship.typeId !== sub.surfacedTypeId) {
    reject(state, cmd.player, cmd.type, 'notASubmarine');
    return;
  }
  if (!surfacing && abilityRank(ruleset, player, ship, spec) === 0) {
    reject(state, cmd.player, cmd.type, 'notOnShip');
    return;
  }
  if ((player.cooldownGroups[spec.abilityId] ?? 0) > state.tick) {
    reject(state, cmd.player, cmd.type, 'onCooldown');
    return;
  }
  const fromSpec = ruleset.ships[ship.typeId];
  const toTypeId = surfacing ? sub.surfacedTypeId : sub.submergedTypeId;
  const toSpec = ruleset.ships[toTypeId];
  if (!fromSpec || !toSpec) {
    reject(state, cmd.player, cmd.type, 'unknownShipType');
    return;
  }

  // Casting dive is an action: breaks smoke (the submerged ghost status is
  // managed explicitly below, so the transient reveal is harmless).
  breakInvisibilityOnAction(state, ship.id);

  // HP FRACTION carryover across differing max HP (flagged OPEN — WC3
  // morph carryover needs in-engine verification, SEMANTICS §5 q5). The
  // maxHp delta swap keeps whatever equipment/skill bonuses economy baked
  // into entity.maxHp without duplicating its recompute.
  const frac = ship.maxHp > 0 ? ship.hp / ship.maxHp : 1;
  ship.typeId = toTypeId;
  ship.maxHp = Math.max(1, ship.maxHp - fromSpec.maxHp + toSpec.maxHp);
  ship.hp = frac * ship.maxHp;
  ship.submerged = !surfacing;

  if (surfacing) {
    // Surfaced form loses the permanent ghost invisibility.
    ship.statuses = ship.statuses.filter(
      (s) => !(s.kind === 'invisible' && s.expiresAtTick === null),
    );
  } else {
    let hasGhost = false;
    for (const s of ship.statuses) {
      if (s.kind === 'invisible' && s.expiresAtTick === null) hasGhost = true;
    }
    if (!hasGhost) {
      ship.statuses.push({
        kind: 'invisible',
        buffId: null,
        expiresAtTick: null,
        breaksOnAction: false,
      });
    }
  }

  player.cooldownGroups[spec.abilityId] = state.tick + sub.diveCooldownTicks;
}

function castInvisibility(
  state: SimState,
  cmd: CastAbilityCommand,
  player: PlayerState,
  ship: ShipEntity,
  spec: AbilitySpec,
  rank: number,
): void {
  if (rank === 0) {
    reject(state, cmd.player, cmd.type, 'notLearned');
    return;
  }
  if ((player.cooldownGroups[spec.abilityId] ?? 0) > state.tick) {
    reject(state, cmd.player, cmd.type, 'onCooldown');
    return;
  }
  const dur = spec.durationTicksPerRank?.[rank - 1];
  if (dur === undefined) {
    reject(state, cmd.player, cmd.type, 'missingAbilityData');
    return;
  }
  // Casting the invisibility itself does not break it (SEMANTICS §9) —
  // no breakInvisibilityOnAction here.
  applyTimedInvisibility(ship, spec.abilityId, state.tick + dur);
  player.cooldownGroups[spec.abilityId] = state.tick + (spec.cooldownTicks ?? 0);
}

function castFlare(
  state: SimState,
  cmd: CastAbilityCommand,
  player: PlayerState,
  ship: ShipEntity,
  spec: AbilitySpec,
  rank: number,
): void {
  if (rank === 0) {
    reject(state, cmd.player, cmd.type, 'notLearned');
    return;
  }
  if ((player.cooldownGroups[spec.abilityId] ?? 0) > state.tick) {
    reject(state, cmd.player, cmd.type, 'onCooldown');
    return;
  }
  if (cmd.x === undefined || cmd.y === undefined) {
    reject(state, cmd.player, cmd.type, 'missingTarget');
    return;
  }
  // magnitudePerRank carries the flare area (AIfa aare, 1500 for
  // Echo-Location/Detector Flare); durationTicksPerRank the reveal time.
  const radius = spec.magnitudePerRank[rank - 1];
  const dur = spec.durationTicksPerRank?.[rank - 1];
  if (radius === undefined || dur === undefined) {
    reject(state, cmd.player, cmd.type, 'missingAbilityData');
    return;
  }
  // Plain multiplication, not `**`: Number::exponentiate is implementation-
  // approximated (same class as Math.pow) and not bit-identical across engines.
  if (
    spec.rangeUnits !== null &&
    distSq(ship.x, ship.y, cmd.x, cmd.y) > spec.rangeUnits * spec.rangeUnits
  ) {
    reject(state, cmd.player, cmd.type, 'outOfRange');
    return;
  }

  breakInvisibilityOnAction(state, ship.id);
  state.detectionZones.push({
    team: ship.team,
    x: cmd.x,
    y: cmd.y,
    radius,
    expiresAtTick: state.tick + dur,
  });
  player.cooldownGroups[spec.abilityId] = state.tick + (spec.cooldownTicks ?? 0);
}

/**
 * Fishing Net (A00Y, base ANen Ensnare): pins a target ENEMY ship's movement
 * for durationTicksPerRank (8 s = 160 ticks) — movement.ts effectiveMoveSpeed
 * returns 0 while the 'ensnared' status is live. atar='enemies' and the
 * tooltip names a ship, so the target must be a living enemy SHIP within
 * spec.rangeUnits (800). Per-ability cooldown (acdn 35 s = 700 ticks) keyed by
 * abilityId; the script has no shared cooldown group. Casting is an action
 * (breaks smoke / reveals a ghost). A teleport (Blink) escapes the hold —
 * applyEquipmentActive 'blink' clears the status after relocating.
 */
function castNet(
  state: SimState,
  cmd: CastAbilityCommand,
  player: PlayerState,
  ship: ShipEntity,
  spec: AbilitySpec,
  rank: number,
): void {
  if (rank === 0) {
    reject(state, cmd.player, cmd.type, 'notLearned');
    return;
  }
  if ((player.cooldownGroups[spec.abilityId] ?? 0) > state.tick) {
    reject(state, cmd.player, cmd.type, 'onCooldown');
    return;
  }
  if (cmd.targetId === undefined) {
    reject(state, cmd.player, cmd.type, 'missingTarget');
    return;
  }
  const target = state.entities[cmd.targetId];
  // atar='enemies' + tooltip "target enemy ship": living enemy SHIP only.
  if (!target || target.dead || target.kind !== 'ship' || target.team === player.team) {
    reject(state, cmd.player, cmd.type, 'invalidTarget');
    return;
  }
  const dur = spec.durationTicksPerRank?.[rank - 1];
  if (dur === undefined) {
    reject(state, cmd.player, cmd.type, 'missingAbilityData');
    return;
  }
  // Plain multiplication (not `**`): exponentiation is not bit-identical
  // across engines; range gate matches castFlare's convention.
  if (
    spec.rangeUnits !== null &&
    distSq(ship.x, ship.y, target.x, target.y) > spec.rangeUnits * spec.rangeUnits
  ) {
    reject(state, cmd.player, cmd.type, 'outOfRange');
    return;
  }

  target.statuses.push({ kind: 'ensnared', expiresAtTick: state.tick + dur });
  player.cooldownGroups[spec.abilityId] = state.tick + (spec.cooldownTicks ?? 0);
  breakInvisibilityOnAction(state, ship.id);
  state.events.push({
    type: 'abilityCast',
    tick: state.tick,
    player: cmd.player,
    abilityId: spec.abilityId,
    targetEntityId: target.id,
  });
}

/** Own-team Main Harbour interior region (gg_rct_South_Main / North_Main). */
const SHORE_LEAVE_MAIN_REGION: Record<TeamId, string> = {
  south: 'South_Main',
  north: 'North_Main',
};

/**
 * Shore Leave (A01D, base Afzy) — the Battle Ship / Submarine innate that
 * surfaces on F. In war3map.j (Trig_Shore_Leave_Begin) the captain may only
 * cast it while standing inside the OWN team's Main Harbour rect
 * (gg_rct_South_Main / gg_rct_North_Main; tooltip aub1 "Only usable close to
 * the Main Harbour"), whereupon the boat goes ashore as a Handy Man (H00J) to
 * be repaired. The Handy-Man transform is its own (unmodeled) subsystem; we
 * model the player-visible payoff — the hull is repaired to full at the base —
 * gated on that same region so the ability stays faithful and deterministic.
 *
 * No RNG/time/trig: a region containment test + a heal of the exact missing
 * HP, so a match still replays bit-identically.
 */
function castShoreLeave(
  state: SimState,
  ruleset: Ruleset,
  cmd: CastAbilityCommand,
  player: PlayerState,
  ship: ShipEntity,
  spec: AbilitySpec,
): void {
  if (abilityRank(ruleset, player, ship, spec) === 0) {
    reject(state, cmd.player, cmd.type, 'notOnShip');
    return;
  }
  if ((player.cooldownGroups[spec.abilityId] ?? 0) > state.tick) {
    reject(state, cmd.player, cmd.type, 'onCooldown');
    return;
  }
  const region = ruleset.map.regions[SHORE_LEAVE_MAIN_REGION[ship.team]];
  if (!region || !pointInRegion(region, ship.x, ship.y)) {
    // Faithful to the tooltip: "Only usable close to the Main Harbour."
    reject(state, cmd.player, cmd.type, 'notAtMainHarbour');
    return;
  }

  breakInvisibilityOnAction(state, ship.id);
  if (ship.hp < ship.maxHp) applyHeal(state, ship.id, ship.maxHp - ship.hp);
  player.cooldownGroups[spec.abilityId] = state.tick + (spec.cooldownTicks ?? 0);
  state.events.push({
    type: 'abilityCast',
    tick: state.tick,
    player: cmd.player,
    abilityId: spec.abilityId,
    targetEntityId: ship.id,
  });
}

// ---------------------------------------------------------------------------
// Exotic 'special' abilities (SpecialParams.kind dispatch)
//
// Every behavior here is a pure, deterministic reaction to an explicit
// castAbility command (no RNG draws, no wall-clock) so seed-equal AI replays —
// which never issue these casts — stay bit-identical. Magnitudes/durations come
// from the compiled SpecialParams (ruleset.ts compileSpecial, from the map
// object data). Direct (non-DoT) ability damage uses the BSP spell convention
// (attackType 'spells', damageType 'magic'); DoTs reuse combat's 'dot' status
// (true damage, armor-ignoring) like Phoenix Fire.
// ---------------------------------------------------------------------------

/** Rank-indexed lookup into a per-rank array (clamped). 0/'' when empty. */
function atRank(arr: number[], rank: number): number {
  if (arr.length === 0) return 0;
  return arr[Math.min(rank, arr.length) - 1] ?? 0;
}
function atRankStr(arr: string[], rank: number): string {
  if (arr.length === 0) return '';
  return arr[Math.min(rank, arr.length) - 1] ?? '';
}

/** A spell DamageInstance (spells/magic) — the convention for ability damage. */
function spellDamage(
  amount: number,
  sourcePlayer: number,
  sourceEntityId: EntityId,
  weaponId: string,
): DamageInstance {
  return {
    amount,
    attackType: 'spells',
    damageType: 'magic',
    noTypeMult: false,
    nonLethal: false,
    sourcePlayer,
    sourceEntityId,
    weaponId,
  };
}

/** Living enemy UNITS (ship/creep/summon) within `radius` of (x,y), id order. */
function enemyUnitsInRadius(
  state: SimState,
  x: number,
  y: number,
  radius: number,
  team: TeamId,
): UnitEntity[] {
  const out: UnitEntity[] = [];
  const r2 = radius * radius;
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead || !isUnitEntity(e)) continue;
    if (e.team === team) continue;
    if (distSq(x, y, e.x, e.y) > r2) continue;
    out.push(e);
  }
  return out;
}

/** Apply spell AoE damage to every enemy combatant in range (deterministic). */
function damageEnemiesInRadius(
  state: SimState,
  ruleset: Ruleset,
  x: number,
  y: number,
  radius: number,
  team: TeamId,
  caster: ShipEntity,
  weaponId: string,
  amount: number,
  hitStructures: boolean,
  excludeId?: EntityId,
): void {
  if (amount <= 0) return;
  const r2 = radius * radius;
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead || !isCombatant(e) || e.id === excludeId) continue;
    if (e.team === null || e.team === team) continue;
    if (e.kind === 'structure' && !hitStructures) continue;
    if (distSq(x, y, e.x, e.y) > r2) continue;
    applyDamage(state, ruleset, e.id, spellDamage(amount, caster.owner, caster.id, weaponId));
  }
}

/** Push a DoT (true damage per tick, like Phoenix Fire) onto a unit. */
function applyDot(
  target: UnitEntity,
  buffId: string,
  dmgPerSecond: number,
  tickRate: number,
  expiresAtTick: number,
  sourcePlayer: number,
): void {
  if (dmgPerSecond <= 0) return;
  target.statuses.push({
    kind: 'dot',
    buffId,
    dmgPerTick: dmgPerSecond / tickRate,
    expiresAtTick,
    nonLethal: false,
    sourcePlayer,
  });
}

/**
 * Spawn `count` timed summons around the caster on a deterministic ring
 * (evenly-spaced angles, no RNG). Used by Pirate/Ghost Crew, Release Hunters,
 * Spawn Seamonster, and Mirror Image (count 1, ship typeId decoy).
 */
function spawnSummons(
  state: SimState,
  ruleset: Ruleset,
  caster: ShipEntity,
  typeId: string,
  count: number,
  expiresAtTick: number,
  hpOverride: number | null,
): void {
  if (count <= 0) return;
  const unitSpec = ruleset.unitTypes[typeId];
  // Mirror-image decoys carry the caster's SHIP typeId (absent from unitTypes):
  // hpOverride supplies the HP and the lack of an attack makes it inert.
  const maxHp = hpOverride ?? unitSpec?.maxHp ?? 1;
  const ringR = 96 + (ruleset.ships[caster.typeId]?.collisionRadius ?? 16);
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    const id = allocEntityId(state);
    const summon: SummonEntity = {
      id,
      typeId,
      x: caster.x + ringR * Math.cos(angle),
      y: caster.y + ringR * Math.sin(angle),
      facingRad: caster.facingRad,
      dead: false,
      kind: 'summon',
      owner: caster.owner,
      team: caster.team,
      hp: maxHp,
      maxHp,
      order: { type: 'idle' },
      statuses: [],
      vision: { south: true, north: true },
      attackReadyAtTick: 0,
      expiresAtTick,
    };
    state.entities[id] = summon;
  }
}

function emitCast(
  state: SimState,
  player: number,
  abilityId: string,
  targetEntityId: EntityId | null,
): void {
  state.events.push({ type: 'abilityCast', tick: state.tick, player, abilityId, targetEntityId });
}

/**
 * Dispatch a 'special' ability cast. Validates rank/cooldown/target per
 * SpecialParams.kind, applies the effect, starts the cooldown, and breaks
 * invisibility (casting is an action). Passive auras (Slow Aura, Ghost cloud,
 * regen aura) are NOT castable and reject; unknown bases (special === null)
 * reject 'unimplemented'.
 */
function castSpecial(
  state: SimState,
  ruleset: Ruleset,
  cmd: CastAbilityCommand,
  player: PlayerState,
  ship: ShipEntity,
  spec: AbilitySpec,
  rank: number,
): void {
  const p = spec.special;
  if (p === null || p === undefined) {
    reject(state, cmd.player, cmd.type, 'unimplemented');
    return;
  }
  if (p.kind === 'fireMissile') {
    // A032 routes to the missile launcher (no hull carries it today).
    applyFireMissile(state, ruleset, { type: 'fireMissile', player: cmd.player });
    return;
  }
  if (p.passive) {
    // Slow Aura / Ghost cloud / regen aura run every tick in runSpecialAuras.
    reject(state, cmd.player, cmd.type, 'passiveAura');
    return;
  }
  if (rank <= 0) {
    reject(state, cmd.player, cmd.type, spec.kind === 'heroSkill' ? 'notLearned' : 'notOnShip');
    return;
  }
  if ((player.cooldownGroups[spec.abilityId] ?? 0) > state.tick) {
    reject(state, cmd.player, cmd.type, 'onCooldown');
    return;
  }

  if (!applySpecialEffect(state, ruleset, cmd, player, ship, spec, p, rank)) return;

  player.cooldownGroups[spec.abilityId] = state.tick + (spec.cooldownTicks ?? 0);
  // Capsize (and any suicidal cast) is itself the action that ends the boat;
  // every other cast breaks smoke / reveals a ghost like a normal action.
  if (!p.suicidal) breakInvisibilityOnAction(state, ship.id);
}

/**
 * Resolve the cast's effect. Returns false (and rejects) when targeting is
 * invalid so the caller skips the cooldown/break — keeping a mis-click free.
 */
function applySpecialEffect(
  state: SimState,
  ruleset: Ruleset,
  cmd: CastAbilityCommand,
  player: PlayerState,
  ship: ShipEntity,
  spec: AbilitySpec,
  p: SpecialParams,
  rank: number,
): boolean {
  const tick = state.tick;
  const tr = ruleset.tickRate;
  const dur = atRank(p.effectDurTicksPerRank, rank);

  switch (p.kind) {
    case 'capsize': {
      const target = enemyShipTarget(state, cmd, ship, spec, player);
      if (target === null) return false;
      // Splash hits NEARBY ships (tooltip: "and DataD damage in splash to
      // nearby ships") — the primary target is excluded and takes DataB only.
      damageEnemiesInRadius(
        state, ruleset, target.x, target.y, atRank(p.splashRadiusPerRank, rank), ship.team, ship,
        spec.abilityId, atRank(p.splashPerRank, rank), false, target.id,
      );
      applyDamage(
        state, ruleset, target.id,
        spellDamage(atRank(p.damagePerRank, rank), ship.owner, ship.id, spec.abilityId),
      );
      emitCast(state, cmd.player, spec.abilityId, target.id);
      // Suicide: the caster sinks (scripted death, no killer credit).
      ship.dead = true;
      state.pendingDeaths.push({
        entityId: ship.id,
        victimPlayer: ship.owner,
        killerPlayer: null,
        killerEntityId: null,
        scripted: true,
      });
      return true;
    }
    case 'empBlast': {
      const r = p.areaRadius;
      damageEnemiesInRadius(
        state, ruleset, ship.x, ship.y, r, ship.team, ship, spec.abilityId,
        atRank(p.damagePerRank, rank), false,
      );
      const pct = atRank(p.moveSpeedPctPerRank, rank);
      for (const e of enemyUnitsInRadius(state, ship.x, ship.y, r, ship.team)) {
        if (e.kind === 'ship') e.statuses.push({ kind: 'slowed', moveSpeedPct: pct, expiresAtTick: tick + dur });
      }
      emitCast(state, cmd.player, spec.abilityId, null);
      return true;
    }
    case 'freezeWater': {
      const r = p.areaRadius;
      damageEnemiesInRadius(
        state, ruleset, ship.x, ship.y, r, ship.team, ship, spec.abilityId,
        atRank(p.damagePerRank, rank), false,
      );
      for (const e of enemyUnitsInRadius(state, ship.x, ship.y, r, ship.team)) {
        if (e.kind === 'ship') e.statuses.push({ kind: 'ensnared', expiresAtTick: tick + dur });
      }
      emitCast(state, cmd.player, spec.abilityId, null);
      return true;
    }
    case 'acidBomb': {
      const target = enemyShipTarget(state, cmd, ship, spec, player, true);
      if (target === null) return false;
      if (isUnitEntity(target)) {
        applyDot(target, spec.abilityId, atRank(p.dotPerSecondPerRank, rank), tr, tick + dur, ship.owner);
        if (target.kind === 'ship') {
          target.statuses.push({ kind: 'slowed', moveSpeedPct: atRank(p.moveSpeedPctPerRank, rank), expiresAtTick: tick + dur });
        }
      }
      const splashDps = atRank(p.splashDotPerSecondPerRank, rank);
      for (const e of enemyUnitsInRadius(state, target.x, target.y, p.areaRadius, ship.team)) {
        if (e.id !== target.id) applyDot(e, spec.abilityId, splashDps, tr, tick + dur, ship.owner);
      }
      emitCast(state, cmd.player, spec.abilityId, target.id);
      return true;
    }
    case 'sailRipper': {
      const target = enemyShipTarget(state, cmd, ship, spec, player);
      if (target === null) return false;
      applyDamage(
        state, ruleset, target.id,
        spellDamage(atRank(p.damagePerRank, rank), ship.owner, ship.id, spec.abilityId),
      );
      target.statuses.push({ kind: 'slowed', moveSpeedPct: atRank(p.moveSpeedPctPerRank, rank), expiresAtTick: tick + dur });
      emitCast(state, cmd.player, spec.abilityId, target.id);
      return true;
    }
    case 'boardShip': {
      const target = enemyShipTarget(state, cmd, ship, spec, player);
      if (target === null) return false;
      target.statuses.push({ kind: 'ensnared', expiresAtTick: tick + dur });
      applyDot(target, spec.abilityId, atRank(p.dotPerSecondPerRank, rank), tr, tick + dur, ship.owner);
      emitCast(state, cmd.player, spec.abilityId, target.id);
      return true;
    }
    case 'disrupt': {
      if (cmd.x === undefined || cmd.y === undefined) {
        reject(state, cmd.player, cmd.type, 'missingTarget');
        return false;
      }
      if (
        spec.rangeUnits !== null &&
        distSq(ship.x, ship.y, cmd.x, cmd.y) > spec.rangeUnits * spec.rangeUnits
      ) {
        reject(state, cmd.player, cmd.type, 'outOfRange');
        return false;
      }
      for (const e of enemyUnitsInRadius(state, cmd.x, cmd.y, p.areaRadius, ship.team)) {
        if (e.kind === 'ship') e.statuses.push({ kind: 'silenced', expiresAtTick: tick + dur });
      }
      emitCast(state, cmd.player, spec.abilityId, null);
      return true;
    }
    case 'devour': {
      const target = enemyShipTarget(state, cmd, ship, spec, player);
      if (target === null) return false;
      // Swallow: disable (stun) + heavy DoT for the digest window. The target
      // stays on-map (regurgitation on caster death is OMITTED — PROVISIONAL).
      target.statuses.push({ kind: 'stunned', expiresAtTick: tick + dur });
      applyDot(target, spec.abilityId, atRank(p.dotPerSecondPerRank, rank), tr, tick + dur, ship.owner);
      emitCast(state, cmd.player, spec.abilityId, target.id);
      return true;
    }
    case 'sendSpy': {
      const target = enemyShipTarget(state, cmd, ship, spec, player);
      if (target === null) return false;
      // Drop a stationary detection zone where the spy boards (it does not
      // follow the ship — PROVISIONAL; gives vision + invis detection there).
      state.detectionZones.push({
        team: ship.team,
        x: target.x,
        y: target.y,
        radius: SEND_SPY_DETECT_RADIUS,
        expiresAtTick: tick + dur,
      });
      emitCast(state, cmd.player, spec.abilityId, target.id);
      return true;
    }
    case 'goblinMine': {
      const target = enemyShipTarget(state, cmd, ship, spec, player);
      if (target === null) return false;
      // Reuse the goblin-mine system: arms on the victim's next item/cast.
      target.statuses.push({ kind: 'goblinMine', sourcePlayer: ship.owner, detonateAtTick: null });
      emitCast(state, cmd.player, spec.abilityId, target.id);
      return true;
    }
    case 'repairHot': {
      const target = friendlyTarget(state, cmd, ship, spec, p);
      if (target === null) return false;
      const total = atRank(p.healTotalPerRank, rank);
      if (dur > 0 && total > 0) {
        target.statuses.push({ kind: 'hot', buffId: spec.abilityId, healPerTick: total / dur, expiresAtTick: tick + dur });
      }
      emitCast(state, cmd.player, spec.abilityId, target.id);
      return true;
    }
    case 'summonSwarm': {
      spawnSummons(
        state, ruleset, ship, atRankStr(p.summonTypeIdPerRank, rank),
        atRank(p.summonCountPerRank, rank), tick + dur, null,
      );
      emitCast(state, cmd.player, spec.abilityId, null);
      return true;
    }
    case 'mirrorImage': {
      // One decoy carrying the caster's ship typeId (a believable "bogus ship"
      // with the hull's HP and no attack of its own).
      spawnSummons(state, ruleset, ship, ship.typeId, 1, tick + dur, ship.maxHp);
      emitCast(state, cmd.player, spec.abilityId, null);
      return true;
    }
    case 'intercept': {
      // Timed self sail-speed HASTE: reuse the timed 'slowed' move-speed delta
      // with a POSITIVE pct (movement sums it like any other speed modifier).
      ship.statuses.push({ kind: 'slowed', moveSpeedPct: atRank(p.moveSpeedPctPerRank, rank), expiresAtTick: tick + dur });
      emitCast(state, cmd.player, spec.abilityId, ship.id);
      return true;
    }
    case 'barrier': {
      ship.statuses.push({ kind: 'shielded', expiresAtTick: tick + dur });
      emitCast(state, cmd.player, spec.abilityId, ship.id);
      return true;
    }
    default:
      // damageAura / slowAura / regenAura are passive (handled above);
      // fireMissile routed above. Nothing else reaches here.
      reject(state, cmd.player, cmd.type, 'notActivatable');
      return false;
  }
}

/** Stationary Send-Spy detection radius (no aare in the dump — PROVISIONAL). */
const SEND_SPY_DETECT_RADIUS = 1600;

/**
 * Validate a unit-target enemy cast: requires a targetId, a living enemy ship
 * (or any combatant when allowStructures), and the target within spec.rangeUnits.
 * Rejects with the right reason and returns null on failure.
 */
function enemyShipTarget(
  state: SimState,
  cmd: CastAbilityCommand,
  ship: ShipEntity,
  spec: AbilitySpec,
  player: PlayerState,
): ShipEntity | null;
function enemyShipTarget(
  state: SimState,
  cmd: CastAbilityCommand,
  ship: ShipEntity,
  spec: AbilitySpec,
  player: PlayerState,
  allowStructures: true,
): ShipEntity | StructureEntity | null;
function enemyShipTarget(
  state: SimState,
  cmd: CastAbilityCommand,
  ship: ShipEntity,
  spec: AbilitySpec,
  player: PlayerState,
  allowStructures = false,
): ShipEntity | StructureEntity | null {
  if (cmd.targetId === undefined) {
    reject(state, cmd.player, cmd.type, 'missingTarget');
    return null;
  }
  const target = state.entities[cmd.targetId];
  const okKind = target && !target.dead && (target.kind === 'ship' || (allowStructures && isCombatant(target)));
  if (!okKind || target.team === player.team || target.team === null) {
    reject(state, cmd.player, cmd.type, 'invalidTarget');
    return null;
  }
  if (
    spec.rangeUnits !== null &&
    distSq(ship.x, ship.y, target.x, target.y) > spec.rangeUnits * spec.rangeUnits
  ) {
    reject(state, cmd.player, cmd.type, 'outOfRange');
    return null;
  }
  return target as ShipEntity | StructureEntity;
}

/**
 * Validate a friendly-target cast (Hull Repair / Goblin Repair Crew): defaults
 * to the caster when no target is given; requires a same-team living ship (or
 * structure when structureTarget) within range.
 */
function friendlyTarget(
  state: SimState,
  cmd: CastAbilityCommand,
  ship: ShipEntity,
  spec: AbilitySpec,
  p: SpecialParams,
): ShipEntity | StructureEntity | null {
  const id = cmd.targetId ?? (p.structureTarget ? undefined : ship.id);
  if (id === undefined) {
    reject(state, cmd.player, cmd.type, 'missingTarget');
    return null;
  }
  const target = state.entities[id];
  const okKind =
    target && !target.dead && (target.kind === 'ship' || (p.structureTarget && target.kind === 'structure'));
  if (!okKind || target.team !== ship.team) {
    reject(state, cmd.player, cmd.type, 'invalidTarget');
    return null;
  }
  if (
    spec.rangeUnits !== null &&
    distSq(ship.x, ship.y, target.x, target.y) > spec.rangeUnits * spec.rangeUnits
  ) {
    reject(state, cmd.player, cmd.type, 'outOfRange');
    return null;
  }
  return target as ShipEntity | StructureEntity;
}

// ---------------------------------------------------------------------------
// Passive special auras (Slow Aura, Ghost cloud damage, regen aura)
//
// Re-evaluated every specials tick: prior aura-applied statuses are cleared
// (so leaving the radius drops the effect and re-entry never stacks), then
// re-applied from each live source. Deterministic — id-ordered, no RNG.
// ---------------------------------------------------------------------------

function runSpecialAuras(state: SimState, ruleset: Ruleset): void {
  // 1. Clear last tick's aura-applied statuses (identified by their source).
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead || !isUnitEntity(e) || e.statuses.length === 0) continue;
    e.statuses = e.statuses.filter((s) => {
      if (s.kind === 'speedAura') return ruleset.abilities[s.sourceAbilityId]?.special?.kind !== 'slowAura';
      if (s.kind === 'hot') return ruleset.abilities[s.buffId]?.special?.kind !== 'regenAura';
      return true;
    });
  }
  // 2. Re-apply from each live aura source ship.
  for (const id of sortedNumericKeys(state.entities)) {
    const ship = state.entities[id];
    if (!ship || ship.kind !== 'ship' || ship.dead) continue;
    if (ship.pausedUntilTick > state.tick) continue;
    const shipSpec = ruleset.ships[ship.typeId];
    const owner = state.players[ship.owner];
    if (!shipSpec || !owner) continue;
    for (const abilityId of shipSpec.abilityIds) {
      const spec = ruleset.abilities[abilityId];
      if (!spec || spec.mechanic !== 'special' || spec.special === null || !spec.special.passive) continue;
      const rank = abilityRank(ruleset, owner, ship, spec);
      if (rank > 0) applyAura(state, ruleset, ship, spec, spec.special, rank);
    }
  }
}

function applyAura(
  state: SimState,
  ruleset: Ruleset,
  ship: ShipEntity,
  spec: AbilitySpec,
  p: SpecialParams,
  rank: number,
): void {
  const r = p.areaRadius;
  if (r <= 0) return;
  if (p.kind === 'slowAura') {
    const pct = atRank(p.moveSpeedPctPerRank, rank);
    for (const e of enemyUnitsInRadius(state, ship.x, ship.y, r, ship.team)) {
      if (e.kind === 'ship') e.statuses.push({ kind: 'speedAura', moveSpeedPct: pct, sourceAbilityId: spec.abilityId });
    }
  } else if (p.kind === 'damageAura') {
    // Aura of Fright: deals dmg/s to enemies each tick (per-tick direct hit).
    const perTick = atRank(p.dotPerSecondPerRank, rank) / ruleset.tickRate;
    damageEnemiesInRadius(state, ruleset, ship.x, ship.y, r, ship.team, ship, spec.abilityId, perTick, false);
  } else if (p.kind === 'regenAura') {
    // +pct of the ALLY hull's base HP regen, granted as a 1-tick 'hot'.
    const pct = atRank(p.regenPctPerRank, rank);
    const r2 = r * r;
    for (const eid of sortedNumericKeys(state.entities)) {
      const e = state.entities[eid];
      if (!e || e.dead || e.kind !== 'ship' || e.team !== ship.team) continue;
      if (distSq(ship.x, ship.y, e.x, e.y) > r2) continue;
      const base = ruleset.ships[e.typeId]?.hpRegenPerTick ?? 0;
      const bonus = base * pct;
      if (bonus > 0) e.statuses.push({ kind: 'hot', buffId: spec.abilityId, healPerTick: bonus, expiresAtTick: state.tick + 2 });
    }
  }
}

// ---------------------------------------------------------------------------
// Equipment actives (specials-owned kinds), called by economy.useItem
// ---------------------------------------------------------------------------

/**
 * Execute the specials-owned part of an equipment active for economy's
 * useItem routing (MODULES.md: "utility actives -> the matching specials
 * helper"). Returns true when the active was handled and applied; false
 * when the kind is owned elsewhere (instantHeal/rejuvenation/xpTome/flavor)
 * or its data is unresolved (reveal without a duration — wshs open
 * question). The CALLER owns validation (charges, cooldowns, range), the
 * 'itemUsed' event and breakInvisibilityOnAction — call the break BEFORE
 * this so a freshly granted smoke status survives its own activation.
 */
export function applyEquipmentActive(
  state: SimState,
  ruleset: Ruleset,
  playerSlot: number,
  active: EquipmentActive,
  x?: number,
  y?: number,
  targetId?: EntityId,
): boolean {
  const player = state.players[playerSlot];
  if (!player) return false;
  const ship = player.shipId !== null ? state.entities[player.shipId] : undefined;
  if (!ship || ship.kind !== 'ship' || ship.dead) return false;
  const px = x ?? ship.x;
  const py = y ?? ship.y;

  switch (active.kind) {
    case 'invisibility':
      applyTimedInvisibility(ship, active.buffId, state.tick + active.durationTicks);
      return true;
    case 'flare':
      // Reveal-only flares (detectsInvisible false) have no sim effect:
      // fog-of-war is not modeled, vision flags only track invisibility.
      if (active.detectsInvisible) {
        state.detectionZones.push({
          team: ship.team,
          x: px,
          y: py,
          radius: active.radius,
          expiresAtTick: state.tick + active.durationTicks,
        });
      }
      return true;
    case 'summonWard': {
      const unitSpec = ruleset.unitTypes[active.wardTypeId];
      if (!unitSpec) return false;
      const id = allocEntityId(state);
      const ward: WardEntity = {
        id,
        typeId: active.wardTypeId,
        x: px,
        y: py,
        facingRad: 0,
        dead: false,
        kind: 'ward',
        owner: playerSlot,
        team: ship.team,
        expiresAtTick: state.tick + active.durationTicks,
        sightRadius: unitSpec.sightRadius,
        detectionRadius: unitSpec.detectionRadius,
        invisible: unitSpec.permanentlyInvisible,
        invulnerable: unitSpec.invulnerable,
      };
      state.entities[id] = ward;
      return true;
    }
    case 'summonUnit': {
      const unitSpec = ruleset.unitTypes[active.unitTypeId];
      if (!unitSpec) return false;
      const id = allocEntityId(state);
      const summon: SummonEntity = {
        id,
        typeId: active.unitTypeId,
        x: px,
        y: py,
        facingRad: ship.facingRad,
        dead: false,
        kind: 'summon',
        owner: playerSlot,
        team: ship.team,
        hp: unitSpec.maxHp,
        maxHp: unitSpec.maxHp,
        order: { type: 'idle' },
        statuses: [],
        vision: { south: true, north: true },
        attackReadyAtTick: 0,
        expiresAtTick: state.tick + active.durationTicks,
      };
      state.entities[id] = summon;
      return true;
    }
    case 'blink': {
      // Light Teleporter (I01L, base AEbl Blink): jumps the ship to the target
      // point clamped to maxDistance (1200). This is NOT bound by water-MOVE
      // pathing — its whole purpose on the WEST/left side is to cross a land
      // gap to far-side water that contiguous movement can't reach. We preserve
      // the cross-gap jump, then snap the LANDING to navigable water (tooltip
      // "Can only target shallow water" — AEbl lands on the nearest pathable
      // cell). If no water is reachable near the landing, the cast is invalid:
      // nothing moves and the caller consumes no charge/cooldown.
      if (x === undefined || y === undefined) return false;
      const d = Math.sqrt(distSq(ship.x, ship.y, x, y));
      let destX: number;
      let destY: number;
      if (d > active.maxDistance && d > 0) {
        const f = active.maxDistance / d;
        destX = ship.x + (x - ship.x) * f;
        destY = ship.y + (y - ship.y) * f;
      } else {
        destX = x;
        destY = y;
      }
      const landing = nearestWater(ruleset.map.waterMask, destX, destY);
      if (landing === null) return false; // no shallow water near the jump -> reject
      ship.x = landing.x;
      ship.y = landing.y;
      ship.order = { type: 'idle' };
      // Teleport breaks a net: relocating the ship escapes an Ensnare hold and
      // clears the lingering root so post-blink movement works (Blink-vs-Ensnare
      // escape). Blink already bypasses movement.ts, so the jump itself is never
      // blocked by the speed-0 pin.
      ship.statuses = ship.statuses.filter((s) => s.kind !== 'ensnared');
      return true;
    }
    case 'reveal': {
      // wshs Informant: stock Shadow Sight duration is UNRESOLVED
      // (equipment.json) — reject until the data lands.
      if (active.durationTicks === null) return false;
      const target = targetId !== undefined ? state.entities[targetId] : undefined;
      if (!target || target.dead || !isUnitEntity(target)) return false;
      const expiresAtTick = state.tick + active.durationTicks;
      let extended = false;
      for (const s of target.statuses) {
        if (s.kind === 'revealed') {
          s.expiresAtTick = Math.max(s.expiresAtTick, expiresAtTick);
          extended = true;
          break;
        }
      }
      if (!extended) target.statuses.push({ kind: 'revealed', expiresAtTick });
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Goblin mines (Bstt) — armed by breakInvisibilityOnAction
// ---------------------------------------------------------------------------

function detonateArmedGoblinMines(state: SimState): void {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead || !isUnitEntity(e)) continue;
    let mine: Status | null = null;
    for (const s of e.statuses) {
      if (s.kind === 'goblinMine' && s.detonateAtTick !== null && state.tick >= s.detonateAtTick) {
        mine = s;
        break;
      }
    }
    if (!mine || mine.kind !== 'goblinMine') continue;
    e.statuses = e.statuses.filter((s) => s !== mine);
    e.dead = true;
    state.pendingDeaths.push({
      entityId: e.id,
      victimPlayer: e.owner,
      killerPlayer: mine.sourcePlayer,
      killerEntityId: null,
      scripted: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Ward / summon / detection-zone expiry
// ---------------------------------------------------------------------------

function expireWardsSummonsAndZones(state: SimState): void {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead) continue;
    if (
      (e.kind === 'ward' || e.kind === 'summon') &&
      e.expiresAtTick !== null &&
      state.tick >= e.expiresAtTick
    ) {
      // Expiry is not a kill: no PendingDeath, no bounty/XP — finalize
      // deletes dead entities regardless.
      e.dead = true;
    }
  }
  if (state.detectionZones.some((z) => z.expiresAtTick <= state.tick)) {
    state.detectionZones = state.detectionZones.filter((z) => z.expiresAtTick > state.tick);
  }
}

// ---------------------------------------------------------------------------
// Suicide quests
// ---------------------------------------------------------------------------

/**
 * Region-driven quest stage machine, generic over SuicideQuestSpec:
 * - pickup (pickupRegion != null): carrier of startItemId without either
 *   token and with a free slot gains unarmedTokenId.
 * - arm (armRegionByTeam[team]): startItemId + unarmedTokenId and no
 *   armedTokenId -> swap unarmed -> armed in place, warn the enemy.
 * - detonate (detonateRegionByTeam[team]): startItemId + armedTokenId +
 *   every requiredItemIds entry (extra detonation requirements, e.g. the
 *   superbomb's I02Q) -> true damage to the enemy HQ, scripted carrier
 *   death, pilot rewards.
 * Verbatim JASS uses enter-rect events; the sim re-checks containment per
 * tick with conditions that stop matching after each mutation (divergence:
 * a carrier parked in the pickup region that drops its token re-gains it
 * without leaving first).
 */
function runSuicideQuests(state: SimState, ruleset: Ruleset): void {
  if (ruleset.suicideQuests.length === 0) return;
  for (const id of sortedNumericKeys(state.entities)) {
    const ship = state.entities[id];
    if (!ship || ship.kind !== 'ship' || ship.dead) continue;
    if (ship.pausedUntilTick > state.tick) continue;
    const player = state.players[ship.owner];
    if (!player) continue;
    for (const quest of ruleset.suicideQuests) {
      if (ship.typeId !== quest.shipTypeId) continue;
      tryQuestPickup(state, ruleset, quest, ship, player);
      tryQuestArm(state, ruleset, quest, ship, player);
      if (tryQuestDetonate(state, ruleset, quest, ship, player)) break;
    }
  }
}

function tryQuestPickup(
  state: SimState,
  ruleset: Ruleset,
  quest: SuicideQuestSpec,
  ship: ShipEntity,
  player: PlayerState,
): void {
  if (quest.pickupRegion === null || quest.unarmedTokenId === null) return;
  const region = ruleset.map.regions[quest.pickupRegion];
  if (!region || !pointInRegion(region, ship.x, ship.y)) return;
  if (findItemSlot(player, quest.startItemId) < 0) return;
  if (findItemSlot(player, quest.unarmedTokenId) >= 0) return;
  if (findItemSlot(player, quest.armedTokenId) >= 0) return;
  // JASS UnitInventoryCount gate (goblin run: < 4 carried items).
  if (
    quest.pickupMaxCarriedItems !== null &&
    countCarriedItems(player) >= quest.pickupMaxCarriedItems
  ) {
    return;
  }
  const slots = ruleset.ships[ship.typeId]?.inventorySlots ?? player.inventory.length;
  if (!addItemToFreeSlot(player, quest.unarmedTokenId, slots)) return;
  state.events.push({
    type: 'questProgress',
    tick: state.tick,
    player: ship.owner,
    questId: quest.id,
    stage: 'pickedUp',
  });
}

function tryQuestArm(
  state: SimState,
  ruleset: Ruleset,
  quest: SuicideQuestSpec,
  ship: ShipEntity,
  player: PlayerState,
): void {
  if (quest.unarmedTokenId === null) return;
  const region = ruleset.map.regions[quest.armRegionByTeam[ship.team]];
  if (!region || !pointInRegion(region, ship.x, ship.y)) return;
  if (findItemSlot(player, quest.startItemId) < 0) return;
  if (findItemSlot(player, quest.armedTokenId) >= 0) return;
  // Extra arm blockers (superbomb: carrying the goblin armed token I01G).
  for (const forbidden of quest.armForbiddenItemIds) {
    if (findItemSlot(player, forbidden) >= 0) return;
  }
  const slot = findItemSlot(player, quest.unarmedTokenId);
  if (slot < 0) return;
  player.inventory[slot] = { itemId: quest.armedTokenId, charges: null, readyAtTick: 0 };
  state.events.push({
    type: 'questProgress',
    tick: state.tick,
    player: ship.owner,
    questId: quest.id,
    stage: 'armed',
  });
  // The 12 s enemy minimap ping (warnPingTicks) is client presentation;
  // the sim emits the warning stage for it.
  state.events.push({
    type: 'questProgress',
    tick: state.tick,
    player: ship.owner,
    questId: quest.id,
    stage: 'enemyWarned',
  });
}

/** Returns true when the carrier detonated (and is dead). */
function tryQuestDetonate(
  state: SimState,
  ruleset: Ruleset,
  quest: SuicideQuestSpec,
  ship: ShipEntity,
  player: PlayerState,
): boolean {
  const region = ruleset.map.regions[quest.detonateRegionByTeam[ship.team]];
  if (!region || !pointInRegion(region, ship.x, ship.y)) return false;
  if (findItemSlot(player, quest.startItemId) < 0) return false;
  if (findItemSlot(player, quest.armedTokenId) < 0) return false;
  for (const required of quest.requiredItemIds) {
    if (findItemSlot(player, required) < 0) return false;
  }

  // Flat true damage to the enemy HQ (SetUnitLifeBJ — bypasses armor and
  // reductions entirely; attackType is inert for damageType 'true').
  const hq = findEnemyHq(state, ship.team);
  if (hq) {
    applyDamage(state, ruleset, hq.id, {
      amount: quest.hqDamage,
      attackType: 'chaos',
      damageType: 'true',
      noTypeMult: true,
      nonLethal: false,
      sourcePlayer: ship.owner,
      sourceEntityId: ship.id,
      weaponId: quest.armedTokenId,
    });
  }

  ship.dead = true;
  state.pendingDeaths.push({
    entityId: ship.id,
    victimPlayer: ship.owner,
    killerPlayer: null,
    killerEntityId: null,
    scripted: true,
  });
  player.gold += quest.rewardGold;
  grantXp(state, ruleset, ship.owner, quest.rewardXp, `quest:${quest.id}`);
  state.events.push({
    type: 'questProgress',
    tick: state.tick,
    player: ship.owner,
    questId: quest.id,
    stage: 'detonated',
  });
  return true;
}

function findEnemyHq(state: SimState, team: TeamId): StructureEntity | null {
  const foe = enemyTeam(team);
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (e && e.kind === 'structure' && !e.dead && e.role === 'hq' && e.team === foe) return e;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sub base teleports
// ---------------------------------------------------------------------------

function runSubTeleports(state: SimState, ruleset: Ruleset): void {
  if (ruleset.map.subTeleports.length === 0) return;
  const submergedTypeId = ruleset.subRules.submergedTypeId;
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    // war3map.j Trig_*SubHarbor_Copy checks unit type 'H00W' (the SUBMERGED
    // form) with no ownership filter — any submerged sub entering a main
    // base interior is bounced out. See module doc for the divergence flag
    // vs the "surfaced" annotation.
    if (!e || e.kind !== 'ship' || e.dead || e.typeId !== submergedTypeId) continue;
    if (e.pausedUntilTick > state.tick) continue;
    for (const tp of ruleset.map.subTeleports) {
      const main = ruleset.map.regions[tp.mainRegion];
      const exit = ruleset.map.regions[tp.exitRegion];
      if (!main || !exit || !pointInRegion(main, e.x, e.y)) continue;
      e.x = exit.centerX;
      e.y = exit.centerY;
      e.order = { type: 'idle' }; // JASS issues "stop" before the move
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Repair bays
// ---------------------------------------------------------------------------

function runRepairBays(state: SimState, ruleset: Ruleset): void {
  for (const bay of ruleset.map.repairBays) {
    const station = ruleset.map.regions[bay.stationRegion];
    const exit = ruleset.map.regions[bay.exitRegion];
    if (!station || !exit) continue;

    // Current occupant: an allied ship inside the station whose service
    // window is still open. The release happens one tick BEFORE the pause
    // lapses (pausedUntilTick === tick + 1) so movement — which runs
    // earlier in the tick and unlocks at pausedUntilTick <= tick — can
    // never step the occupant out of the station before its heal/eject.
    let occupant: ShipEntity | null = null;
    for (const id of sortedNumericKeys(state.entities)) {
      const e = state.entities[id];
      if (!e || e.kind !== 'ship' || e.dead || e.team !== bay.team) continue;
      if (e.pausedUntilTick < state.tick) continue;
      if (!pointInRegion(station, e.x, e.y)) continue;
      occupant = e;
      break;
    }

    if (occupant) {
      if (occupant.pausedUntilTick === state.tick + 1) {
        // Release: full heal (the original drip-heals to 100% while
        // paused), then eject to the exit region center.
        applyHeal(state, occupant.id, occupant.maxHp - occupant.hp);
        occupant.x = exit.centerX;
        occupant.y = exit.centerY;
        occupant.order = { type: 'idle' };
      }
      continue; // one ship at a time per bay
    }

    // Admit the lowest-id damaged allied hero ship standing in the station.
    // The +1 keeps the ship locked through its release tick (see above).
    for (const id of sortedNumericKeys(state.entities)) {
      const e = state.entities[id];
      if (!e || e.kind !== 'ship' || e.dead || e.team !== bay.team) continue;
      if (e.hp >= e.maxHp) continue;
      if (e.pausedUntilTick >= state.tick) continue;
      if (!pointInRegion(station, e.x, e.y)) continue;
      e.pausedUntilTick = state.tick + REPAIR_BAY_SERVICE_TICKS + 1;
      e.invulnerableUntilTick = state.tick + REPAIR_BAY_SERVICE_TICKS + 1;
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Motion detectors
// ---------------------------------------------------------------------------

/**
 * Wards without true sight (detectionRadius null — the Motion Detector
 * ohwd) warn their owner about enemies inside sightRadius. NOTE: no warning
 * trigger exists in the extracted war3map.j and ohwd's sight is 1, so this
 * is inert with verbatim data (matching the script) — the radius source is
 * an open question. Emits every tick while an intruder is inside (events
 * are derived output; clients de-duplicate).
 */
function emitProximityWarnings(state: SimState): void {
  for (const id of sortedNumericKeys(state.entities)) {
    const ward = state.entities[id];
    if (!ward || ward.kind !== 'ward' || ward.dead) continue;
    if (ward.detectionRadius !== null) continue;
    if (ward.expiresAtTick !== null && state.tick >= ward.expiresAtTick) continue;
    const radius = ward.sightRadius;
    if (radius <= 0) continue;
    for (const intruderId of sortedNumericKeys(state.entities)) {
      const intruder = state.entities[intruderId];
      if (!intruder || intruder.dead || !isUnitEntity(intruder)) continue;
      if (intruder.team === ward.team) continue;
      if (distSq(ward.x, ward.y, intruder.x, intruder.y) > radius * radius) continue;
      state.events.push({
        type: 'proximityWarning',
        tick: state.tick,
        ownerPlayer: ward.owner,
        wardEntityId: ward.id,
        intruderEntityId: intruder.id,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function reject(state: SimState, player: number, commandType: string, reason: string): void {
  state.events.push({ type: 'commandRejected', tick: state.tick, player, commandType, reason });
}

function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

function hasActiveTimedStatus(
  unit: UnitEntity,
  kind: 'stunned' | 'silenced',
  tick: number,
): boolean {
  return unit.statuses.some((s) => s.kind === kind && s.expiresAtTick > tick);
}

function hasActiveInvisible(statuses: Status[], tick: number): boolean {
  for (const s of statuses) {
    if (s.kind === 'invisible' && (s.expiresAtTick === null || s.expiresAtTick > tick)) return true;
  }
  return false;
}

function hasActiveRevealed(statuses: Status[], tick: number): boolean {
  for (const s of statuses) {
    if (s.kind === 'revealed' && s.expiresAtTick > tick) return true;
  }
  return false;
}

/** Timed smoke replaces existing timed smoke; the permanent ghost is kept. */
function applyTimedInvisibility(unit: UnitEntity, buffId: string | null, expiresAtTick: number): void {
  unit.statuses = unit.statuses.filter(
    (s) => !(s.kind === 'invisible' && s.expiresAtTick !== null),
  );
  unit.statuses.push({ kind: 'invisible', buffId, expiresAtTick, breaksOnAction: true });
}

function findItemSlot(player: PlayerState, itemId: string): number {
  for (let i = 0; i < player.inventory.length; i++) {
    const item = player.inventory[i];
    if (item && item.itemId === itemId) return i;
  }
  return -1;
}

/** Remove one use: multi-charge stacks decrement, single items vacate the slot. */
function consumeItemAt(player: PlayerState, slot: number): void {
  const item = player.inventory[slot];
  if (!item) return;
  if (item.charges !== null && item.charges > 1) item.charges = item.charges - 1;
  else player.inventory[slot] = null;
}

/** Carried item count (JASS UnitInventoryCount). */
function countCarriedItems(player: PlayerState): number {
  let n = 0;
  for (const item of player.inventory) {
    if (item !== null) n += 1;
  }
  return n;
}

/** Place a trigger-granted token in the first free slot within the hull's capacity. */
function addItemToFreeSlot(player: PlayerState, itemId: string, maxSlots: number): boolean {
  const limit = Math.min(maxSlots, player.inventory.length);
  for (let i = 0; i < limit; i++) {
    if (player.inventory[i] === null) {
      player.inventory[i] = { itemId, charges: null, readyAtTick: 0 };
      return true;
    }
  }
  return false;
}
