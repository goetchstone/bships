/**
 * Progression system: XP/levels, hero skills, respawn, bounties, research.
 *
 * Responsibilities:
 * - Death consumption: stepProgression processes state.pendingDeaths (in
 *   array order — combat/specials pushed deterministically):
 *   - XP (SEMANTICS §6): victim's level from UnitTypeSpec.level (creeps/
 *     summons; structures grant NO kill XP) or the victim player's hero
 *     level; killing side's living hero ships within xp.shareRadius of the
 *     death (ascending id) split evenly (integer division, remainder to
 *     lowest id); if none in range, full XP to the killing player. Summons
 *     grant floor(normalXp × xp.summonFactor). Scripted deaths grant no
 *     XP/bounty here (their triggers paid explicitly).
 *   - Bounty (SEMANTICS §7): if victim bounty nonzero, pay base + dice
 *     independent rollInt(1, sides) draws to the killing player; emit
 *     'bounty'. Zero-bounty creep twins pay nothing (data asymmetry kept).
 *   - Hero ship death (scripted or not — the JASS death timer runs on every
 *     hero death): clear player.shipId, respawnAtTick = tick +
 *     secondsToTicks(perLevelSeconds·level + baseSeconds +
 *     rollInt(0, randMaxSeconds)) (war3map.j:1836).
 * - XP/levels: grantXp is THE entry point (kills here; tomes from economy;
 *   quest/contract awards from specials/economy). Applies xp.heroLevelCap
 *   (xp clamps at the cap threshold so state stays hash-stable), awards
 *   skillPointsPerLevel per level, emits 'xpGained'/'levelUp'.
 * - Hero skills: learnSkill validates HeroSkillRule — rank R requires hero
 *   level >= minHeroLevel + levelsPerRank·(R−1) (WC3 arlv + alsk·(R−1);
 *   BSP alsk=2 everywhere, Goblin Bomber A055 arlv=8), rank < ranks, an
 *   unspent point, and the ability on the current hull's abilityIds.
 * - Respawn: when respawnAtTick is due, create a fresh ShipEntity of
 *   player.shipTypeId at the team's respawn region center (allocEntityId,
 *   ascending player-slot order), full hp, invulnerableUntilTick = tick +
 *   respawn.invulnerableTicks, inventory untouched (lives on PlayerState);
 *   emit 'respawn'.
 * - Research: research command validates the n00P research list
 *   (UpgradeSpec.researchable — R002 is orphaned in v1.187), upgrade
 *   level/cost/per-team queue, charges gold to the commanding player, sets
 *   TeamState.research; stepProgression completes due research ->
 *   TeamState.upgrades[id]++ (team-shared by construction = verbatim tech
 *   sharing), emits events. Damage effects are READ live by combat from
 *   TeamState.upgrades; HP/speed effects are spawn-baked by creeps, so
 *   completion ALSO applies the new level's delta to living units of the
 *   team (WC3 upgrades hit existing units immediately — this is the only
 *   way R000 ever reaches the pre-placed towers). NOTE: the n00P Upgrade
 *   Center is absent from map-layout.json structures, so research is not
 *   proximity-gated (OPEN).
 *
 * RNG draw order (replay contract): per consumed death — (a) bounty dice
 * (spec.dice draws, only when a nonzero bounty pays out to a non-null
 * killer), then (b) one respawn-jitter draw per hero ship death (including
 * scripted deaths). No draws in grantXp, respawn execution, or research.
 *
 * Reads: ruleset.xp/respawn/upgrades/ships/abilities/unitTypes/map,
 * pendingDeaths. Mutates: player xp/level/skill points/heroSkillLevels/
 * gold (bounty)/shipId/respawnAtTick, TeamState.upgrades/research, new ship
 * entities on respawn, state.events. Does NOT remove dead entities (sim
 * finalize does).
 *
 * Tick order: runs 6th (last system) — consumes deaths from this tick.
 */

import { recomputeShipStats } from './economy.js';
import { allocEntityId, rollInt, secondsToTicks, sortedNumericKeys } from './types.js';
import type {
  BountySpec,
  Entity,
  LearnSkillCommand,
  PendingDeath,
  ProgressionCommandU,
  ResearchCommand,
  Ruleset,
  ShipEntity,
  SimState,
  TeamId,
  XpRules,
} from './types.js';

/** Fixed team iteration order ('south' inserted first at createMatch). */
const TEAM_ORDER: readonly TeamId[] = ['south', 'north'];

function reject(state: SimState, player: number, commandType: string, reason: string): void {
  state.events.push({ type: 'commandRejected', tick: state.tick, player, commandType, reason });
}

/** research / learnSkill commands. Invalid -> 'commandRejected'. */
export function applyProgressionCommand(
  state: SimState,
  ruleset: Ruleset,
  cmd: ProgressionCommandU,
): void {
  switch (cmd.type) {
    case 'research':
      applyResearch(state, ruleset, cmd);
      return;
    case 'learnSkill':
      applyLearnSkill(state, ruleset, cmd);
      return;
  }
}

function applyResearch(state: SimState, ruleset: Ruleset, cmd: ResearchCommand): void {
  const player = state.players[cmd.player];
  if (!player) {
    reject(state, cmd.player, 'research', 'unknownPlayer');
    return;
  }
  const spec = ruleset.upgrades[cmd.upgradeId];
  if (!spec) {
    reject(state, cmd.player, 'research', 'unknownUpgrade');
    return;
  }
  // n00P's ures list — R002 exists in data but is never offered (orphaned).
  if (!spec.researchable) {
    reject(state, cmd.player, 'research', 'notResearchable');
    return;
  }
  const team = state.teams[player.team];
  const level = team.upgrades[cmd.upgradeId] ?? 0;
  const cost = spec.goldCostPerLevel[level];
  if (level >= spec.maxLevel || cost === undefined) {
    reject(state, cmd.player, 'research', 'maxLevel');
    return;
  }
  if (team.research !== null) {
    reject(state, cmd.player, 'research', 'researchBusy');
    return;
  }
  if (player.gold < cost) {
    reject(state, cmd.player, 'research', 'insufficientGold');
    return;
  }
  player.gold -= cost;
  team.research = {
    upgradeId: cmd.upgradeId,
    completesAtTick: state.tick + spec.researchTicks,
  };
  state.events.push({
    type: 'researchStarted',
    tick: state.tick,
    team: player.team,
    upgradeId: cmd.upgradeId,
    level: level + 1,
  });
}

function applyLearnSkill(state: SimState, ruleset: Ruleset, cmd: LearnSkillCommand): void {
  const player = state.players[cmd.player];
  if (!player) {
    reject(state, cmd.player, 'learnSkill', 'unknownPlayer');
    return;
  }
  const spec = ruleset.abilities[cmd.abilityId];
  const rule = spec?.skill ?? null;
  if (!spec || !rule) {
    reject(state, cmd.player, 'learnSkill', 'notASkill');
    return;
  }
  const ship = ruleset.ships[player.shipTypeId];
  if (!ship || !ship.abilityIds.includes(cmd.abilityId)) {
    reject(state, cmd.player, 'learnSkill', 'notOnShip');
    return;
  }
  const rank = player.heroSkillLevels[cmd.abilityId] ?? 0;
  if (rank >= rule.ranks) {
    reject(state, cmd.player, 'learnSkill', 'maxRank');
    return;
  }
  /** Next rank = rank + 1; WC3 gate: heroLevel >= arlv + alsk·(nextRank − 1).
   *  Skipped when the ruleset disables the level gate (free skill spending —
   *  owner-directed, see XpRules.skillLevelGated). */
  if (ruleset.xp.skillLevelGated) {
    const requiredLevel = rule.minHeroLevel + rule.levelsPerRank * rank;
    if (player.level < requiredLevel) {
      reject(state, cmd.player, 'learnSkill', 'levelTooLow');
      return;
    }
  }
  if (player.unspentSkillPoints <= 0) {
    reject(state, cmd.player, 'learnSkill', 'noSkillPoints');
    return;
  }
  player.unspentSkillPoints -= 1;
  player.heroSkillLevels[cmd.abilityId] = rank + 1;
  if (
    spec.mechanic === 'hullHp' ||
    spec.mechanic === 'sailSpeed' ||
    spec.mechanic === 'mechanicsRegen'
  ) {
    // economy owns the derived-stat recompute; heroSkillLevels (mutated
    // above) is the source of truth it reads. Speed/regen are computed live
    // by movement/combat each tick — only maxHp is stored.
    recomputeShipStats(state, ruleset, cmd.player);
  }
}

/** One progression tick: deaths, respawns due, research completion. */
export function stepProgression(state: SimState, ruleset: Ruleset): void {
  for (const death of state.pendingDeaths) {
    processDeath(state, ruleset, death);
  }
  processRespawns(state, ruleset);
  processResearch(state, ruleset);
}

/**
 * THE entry point for all XP (kills, tomes, quests, contracts). Applies the
 * level curve and cap, grants skill points, emits events. `reason` is a
 * stable stats key ('kill', 'tome', 'quest:suicideRun', 'contract:ale'...).
 * XP past the heroLevelCap threshold is discarded (clamped) so a capped
 * hero's state stays fixed; 'xpGained' carries the applied delta.
 */
export function grantXp(
  state: SimState,
  ruleset: Ruleset,
  playerSlot: number,
  amount: number,
  reason: string,
): void {
  const player = state.players[playerSlot];
  if (!player || amount <= 0) return;
  const xp = ruleset.xp;
  const before = player.xp;
  player.xp += amount;
  const capIndex = Math.min(xp.heroLevelCap, xp.xpToLevel.length - 1);
  const capXp = xp.xpToLevel[capIndex];
  if (capXp !== undefined && player.xp > capXp) player.xp = capXp;
  const applied = player.xp - before;
  if (applied <= 0) return;
  state.events.push({
    type: 'xpGained',
    tick: state.tick,
    player: playerSlot,
    amount: applied,
    reason,
  });
  while (player.level < xp.heroLevelCap) {
    const next = xp.xpToLevel[player.level + 1];
    if (next === undefined || player.xp < next) break;
    player.level += 1;
    player.unspentSkillPoints += xp.skillPointsPerLevel;
    state.events.push({
      type: 'levelUp',
      tick: state.tick,
      player: playerSlot,
      level: player.level,
    });
  }
}

// ---------------------------------------------------------------------------
// Death consumption
// ---------------------------------------------------------------------------

function processDeath(state: SimState, ruleset: Ruleset, death: PendingDeath): void {
  const victim = state.entities[death.entityId];
  if (!victim) return;
  if (!death.scripted) {
    awardKillXp(state, ruleset, death, victim);
    awardBounty(state, ruleset, death, victim);
  }
  if (victim.kind === 'ship') {
    scheduleRespawn(state, ruleset, victim);
  }
}

/** Kill XP from a normal (non-hero) victim of the given unit level. */
function normalKillXp(xp: XpRules, level: number): number {
  const table = xp.killXpByVictimLevel;
  if (level <= 0 || table.length === 0) return 0;
  // Levels past the table clamp to the last entry (compiler provides the
  // full default-formula table; clamp is defensive only).
  return table[Math.min(level, table.length - 1)] ?? 0;
}

/** Kill XP from a hero victim: table 1..5, +perLevelAbove per level past 5. */
function heroKillXp(xp: XpRules, level: number): number {
  const table = xp.heroKillXpByVictimLevel;
  if (level <= 0 || table.length === 0) return 0;
  const maxIndex = table.length - 1;
  if (level <= maxIndex) return table[level] ?? 0;
  return (table[maxIndex] ?? 0) + xp.heroKillXpPerLevelAbove * (level - maxIndex);
}

function victimKillXp(state: SimState, ruleset: Ruleset, victim: Entity): number {
  const xp = ruleset.xp;
  switch (victim.kind) {
    case 'structure':
      // war3mapMisc.txt BuildingKillsGiveExp=1: a killed structure grants
      // normal-unit-table XP at the structure's own ulev; engine default (flag
      // off) is bounty only (SEMANTICS §6). A structure type with no ulev
      // compiles to level 0, which correctly yields 0 XP here too.
      return xp.buildingKillsGiveXp
        ? normalKillXp(xp, ruleset.unitTypes[victim.typeId]?.level ?? 0)
        : 0;
    case 'ward':
      // Wards grant nothing, regardless of BuildingKillsGiveExp (SEMANTICS §6).
      return 0;
    case 'ship': {
      const owner = state.players[victim.owner];
      return heroKillXp(xp, owner ? owner.level : 1);
    }
    case 'creep':
      return normalKillXp(xp, ruleset.unitTypes[victim.typeId]?.level ?? 0);
    case 'summon':
      return Math.floor(
        normalKillXp(xp, ruleset.unitTypes[victim.typeId]?.level ?? 0) * xp.summonFactor,
      );
  }
}

function awardKillXp(state: SimState, ruleset: Ruleset, death: PendingDeath, victim: Entity): void {
  if (death.killerPlayer === null) return;
  const killer = state.players[death.killerPlayer];
  if (!killer) return;
  const total = victimKillXp(state, ruleset, victim);
  if (total <= 0) return;
  const radiusSq = ruleset.xp.shareRadius * ruleset.xp.shareRadius;
  const sharers: { owner: number }[] = [];
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.kind !== 'ship' || e.dead || e.team !== killer.team) continue;
    const dx = e.x - victim.x;
    const dy = e.y - victim.y;
    if (dx * dx + dy * dy <= radiusSq) sharers.push({ owner: e.owner });
  }
  if (sharers.length === 0) {
    // Global fallback: full XP to the killing player's hero (SEMANTICS §6).
    // A player with no living hero ship (notably the AI empire slots, which
    // never have one) gets nothing — WC3 kill XP with no hero is lost.
    const killerShip = killer.shipId !== null ? state.entities[killer.shipId] : undefined;
    if (killerShip && killerShip.kind === 'ship' && !killerShip.dead) {
      grantXp(state, ruleset, death.killerPlayer, total, 'kill');
    }
    return;
  }
  const share = Math.floor(total / sharers.length);
  const remainder = total - share * sharers.length;
  for (const [i, sharer] of sharers.entries()) {
    grantXp(state, ruleset, sharer.owner, share + (i === 0 ? remainder : 0), 'kill');
  }
}

function bountyFor(ruleset: Ruleset, victim: Entity): BountySpec | null {
  if (victim.kind === 'ship') {
    return ruleset.ships[victim.typeId]?.bounty ?? ruleset.unitTypes[victim.typeId]?.bounty ?? null;
  }
  return ruleset.unitTypes[victim.typeId]?.bounty ?? null;
}

function awardBounty(state: SimState, ruleset: Ruleset, death: PendingDeath, victim: Entity): void {
  if (death.killerPlayer === null) return;
  const killer = state.players[death.killerPlayer];
  if (!killer) return;
  const spec = bountyFor(ruleset, victim);
  // Zero-bounty victims (h00E/h00F/h00G twins) pay nothing and draw nothing.
  if (!spec || (spec.base <= 0 && spec.dice <= 0)) return;
  let amount = spec.base;
  for (let i = 0; i < spec.dice; i++) {
    amount += rollInt(state, 1, spec.sides);
  }
  killer.gold += amount;
  state.events.push({
    type: 'bounty',
    tick: state.tick,
    player: death.killerPlayer,
    amount,
    victimEntityId: death.entityId,
  });
}

function scheduleRespawn(state: SimState, ruleset: Ruleset, victim: ShipEntity): void {
  const player = state.players[victim.owner];
  // shipId guard skips stale entities that are no longer the hero ship.
  if (!player || player.shipId !== victim.id) return;
  player.shipId = null;
  const r = ruleset.respawn;
  const seconds = r.perLevelSeconds * player.level + r.baseSeconds + rollInt(state, 0, r.randMaxSeconds);
  player.respawnAtTick = state.tick + secondsToTicks(seconds, ruleset.tickRate);
}

// ---------------------------------------------------------------------------
// Respawn execution & research completion
// ---------------------------------------------------------------------------

function processRespawns(state: SimState, ruleset: Ruleset): void {
  for (const slot of sortedNumericKeys(state.players)) {
    const player = state.players[slot];
    if (!player || player.respawnAtTick === null || state.tick < player.respawnAtTick) continue;
    const ship = ruleset.ships[player.shipTypeId];
    const region = ruleset.map.regions[ruleset.map.respawnRegionByTeam[player.team]];
    if (!ship || !region) continue;
    const id = allocEntityId(state);
    const entity: ShipEntity = {
      id,
      kind: 'ship',
      typeId: player.shipTypeId,
      owner: slot,
      team: player.team,
      x: region.centerX,
      y: region.centerY,
      facingRad: 0,
      dead: false,
      hp: ship.maxHp,
      maxHp: ship.maxHp,
      order: { type: 'idle' },
      statuses: [],
      // Visible to own team until specials recomputes next tick (no combat
      // reads vision after progression within this tick).
      vision: { south: player.team === 'south', north: player.team === 'north' },
      attackReadyAtTick: state.tick,
      casting: null,
      pausedUntilTick: 0,
      invulnerableUntilTick: state.tick + ruleset.respawn.invulnerableTicks,
      submerged: false,
    };
    state.entities[id] = entity;
    player.shipId = id;
    player.respawnAtTick = null;
    // Bake hull-item + hullHp-skill bonuses into maxHp (economy owns the
    // recompute — inventory survives death on PlayerState), then revive at
    // full health.
    recomputeShipStats(state, ruleset, slot);
    entity.hp = entity.maxHp;
    state.events.push({ type: 'respawn', tick: state.tick, player: slot, entityId: id });
  }
}

function processResearch(state: SimState, ruleset: Ruleset): void {
  for (const teamId of TEAM_ORDER) {
    const team = state.teams[teamId];
    const research = team.research;
    if (!research || state.tick < research.completesAtTick) continue;
    const level = (team.upgrades[research.upgradeId] ?? 0) + 1;
    team.upgrades[research.upgradeId] = level;
    team.research = null;
    applyResearchLevelToLiveUnits(state, ruleset, teamId, research.upgradeId, level);
    state.events.push({
      type: 'researchComplete',
      tick: state.tick,
      team: teamId,
      upgradeId: research.upgradeId,
      level,
    });
  }
}

/**
 * WC3 applies a finished research to EXISTING units immediately. Damage
 * kinds (flatAttackDamage/bonusAttackDice) are read live at fire time by
 * combat; HP and speed kinds are baked into entities at creep SPAWN time
 * (creeps.spawnUpgradeMods), so the just-completed level's delta must also
 * be applied to units already on the map — without it, R000 Tower Defense
 * never affects the pre-placed n004 towers (they never respawn) and
 * R003/R004 skip one wave per lane.
 */
function applyResearchLevelToLiveUnits(
  state: SimState,
  ruleset: Ruleset,
  teamId: TeamId,
  upgradeId: string,
  level: number,
): void {
  const spec = ruleset.upgrades[upgradeId];
  if (!spec) return;
  const kind = spec.effect.kind;
  if (kind !== 'flatMaxHp' && kind !== 'pctBaseMaxHp' && kind !== 'flatMoveSpeed') return;
  const delta = spec.effect.perLevel[level - 1] ?? 0;
  if (delta === 0) return;
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.dead || e.kind === 'ward') continue;
    if (e.team !== teamId) continue;
    if (!spec.appliesToUnitTypes.includes(e.typeId)) continue;
    const unitType = ruleset.unitTypes[e.typeId];
    if (kind === 'flatMaxHp') {
      e.maxHp += delta;
      e.hp += delta;
    } else if (kind === 'pctBaseMaxHp') {
      // Fraction of the BASE (unit-type) max HP, matching spawn-time math.
      const bonus = (unitType?.maxHp ?? 0) * delta;
      e.maxHp += bonus;
      e.hp += bonus;
    } else if (e.kind !== 'structure') {
      // flatMoveSpeed: extend the spawn-baked 'speedAura' encoding
      // (creeps.ts) — moveSpeedPct fractions of base speed, keyed by the
      // upgrade id in sourceAbilityId.
      const base = unitType?.moveSpeed ?? 0;
      if (base <= 0) continue;
      const pctDelta = delta / base;
      const existing = e.statuses.find(
        (s) => s.kind === 'speedAura' && s.sourceAbilityId === upgradeId,
      );
      if (existing && existing.kind === 'speedAura') existing.moveSpeedPct += pctDelta;
      else e.statuses.push({ kind: 'speedAura', moveSpeedPct: pctDelta, sourceAbilityId: upgradeId });
    }
  }
}
