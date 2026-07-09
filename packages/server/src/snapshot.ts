/**
 * Per-team snapshot payloads + keyframe/delta diffing + per-team event
 * filtering. The payload is built ONCE per team per tick (entities through
 * the visibility.ts security boundary, projectiles, JSON compare strings);
 * match.ts wraps it per seat with that seat's private `you` and the public
 * `players` scoreboard.
 *
 * Display precision: x/y (entities and projectiles) and hp/maxHp round to
 * 0.1 world units / hit points — display-only precision that also keeps
 * float drift (e.g. regen accumulating 0.05/tick) from bloating delta JSON.
 * `facing` is sim facingRad verbatim.
 */

import { sortedNumericKeys } from '@bships/core';
import type {
  Entity,
  Projectile,
  Ruleset,
  SimEvent,
  SimState,
  SnapshotEntity,
  SnapshotProjectile,
  SnapshotStatusKind,
  Status,
  TeamId,
} from '@bships/core';
import { computeTeamVision, collectVisibleEntities, coveredSight, isProjectileVisible } from './visibility.js';
import type { TeamVision } from './visibility.js';

/** Round to 0.1 (display precision; shrinks payloads). */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** One team's complete vision-filtered world for one tick. */
export interface TeamPayload {
  tick: number;
  team: TeamId;
  /** id -> snapshot entity, ascending-id insertion order. */
  entities: Map<number, SnapshotEntity>;
  /** id -> JSON of the entity, for cheap changed-field compares. */
  entityJson: Map<number, string>;
  projectiles: SnapshotProjectile[];
}

/**
 * Map sim statuses to renderer kinds (protocol SnapshotStatusKind doc):
 * dot->'burning', hot->'healing', speedAura->'hasted', weaponBuff dropped.
 * 'invisible' is only ever sent for OWN-team entities; an enemy entity that
 * reaches this function is detected by construction (visibility.ts included
 * it), so its active invisibility maps to 'revealed' instead.
 * Output is deduplicated and sorted for stable delta compares.
 */
export function mapStatuses(statuses: readonly Status[], own: boolean, tick: number): SnapshotStatusKind[] {
  const kinds = new Set<SnapshotStatusKind>();
  for (const s of statuses) {
    switch (s.kind) {
      case 'dot':
        if (s.expiresAtTick > tick) kinds.add('burning');
        break;
      case 'hot':
        if (s.expiresAtTick > tick) kinds.add('healing');
        break;
      case 'invisible':
        if (s.expiresAtTick === null || s.expiresAtTick > tick) {
          kinds.add(own ? 'invisible' : 'revealed');
        }
        break;
      case 'revealed':
        if (s.expiresAtTick > tick) kinds.add('revealed');
        break;
      case 'weaponBuff':
        break; // PF retarget gate — renderer never needs it
      case 'goblinMine':
        kinds.add('goblinMine');
        break;
      case 'ensnared':
        if (s.expiresAtTick > tick) kinds.add('ensnared');
        break;
      case 'stunned':
        if (s.expiresAtTick > tick) kinds.add('stunned');
        break;
      case 'silenced':
        if (s.expiresAtTick > tick) kinds.add('silenced');
        break;
      case 'slowed':
        if (s.expiresAtTick > tick) kinds.add('slowed');
        break;
      case 'shielded':
        if (s.expiresAtTick > tick) kinds.add('shielded');
        break;
      case 'speedAura':
        kinds.add('hasted');
        break;
    }
  }
  return [...kinds].sort();
}

/** Convert one sim entity to its wire form as seen by `viewerTeam`. */
export function toSnapshotEntity(entity: Entity, viewerTeam: TeamId, tick: number): SnapshotEntity {
  const own = entity.team === viewerTeam;

  if (entity.kind === 'ward') {
    return {
      id: entity.id,
      kind: 'ward',
      typeId: entity.typeId,
      x: round1(entity.x),
      y: round1(entity.y),
      facing: entity.facingRad,
      hp: 1,
      maxHp: 1,
      team: entity.team,
      ownerSlot: entity.owner,
      // Own wards may report 'invisible' so the HUD can mark them hidden.
      statuses: own && entity.invisible ? ['invisible'] : [],
    };
  }

  const snap: SnapshotEntity = {
    id: entity.id,
    kind: entity.kind,
    typeId: entity.typeId,
    x: round1(entity.x),
    y: round1(entity.y),
    facing: entity.facingRad,
    hp: round1(entity.hp),
    maxHp: round1(entity.maxHp),
    team: entity.team,
    ownerSlot: entity.owner,
    statuses: mapStatuses(entity.statuses, own, tick),
  };

  if (entity.kind === 'structure') {
    snap.role = entity.role;
    if (entity.shopStock !== null) {
      const shopStock: Record<string, number> = {};
      for (const itemId of Object.keys(entity.shopStock).sort()) {
        const entry = entity.shopStock[itemId];
        if (entry) shopStock[itemId] = entry.stock;
      }
      snap.shopStock = shopStock;
    }
  } else if (entity.kind === 'ship' && entity.submerged) {
    snap.submerged = true;
  }

  return snap;
}

function toSnapshotProjectile(p: Projectile): SnapshotProjectile {
  return {
    id: p.id,
    weaponId: p.weaponId,
    mechanic: p.mechanic,
    x: round1(p.x),
    y: round1(p.y),
    team: p.team,
  };
}

/**
 * Build team T's payload for the current tick. The entity set is exactly
 * what visibility.ts admits — nothing outside it may reach a T client.
 */
export function buildTeamPayload(state: SimState, ruleset: Ruleset, team: TeamId): TeamPayload {
  const vision = computeTeamVision(state, ruleset, team);
  const entities = new Map<number, SnapshotEntity>();
  const entityJson = new Map<number, string>();
  for (const entity of collectVisibleEntities(state, vision)) {
    const snap = toSnapshotEntity(entity, team, state.tick);
    entities.set(snap.id, snap);
    entityJson.set(snap.id, JSON.stringify(snap));
  }
  const projectiles: SnapshotProjectile[] = [];
  for (const id of sortedNumericKeys(state.projectiles)) {
    const p = state.projectiles[id];
    if (p && isProjectileVisible(vision, p)) projectiles.push(toSnapshotProjectile(p));
  }
  return { tick: state.tick, team, entities, entityJson, projectiles };
}

/**
 * Delta of `cur` against the previous tick's payload: `upserts` = changed
 * (any wire field, via the JSON compare strings) or entered vision;
 * `removed` = died or left vision (the client cannot tell, and must not).
 */
export function diffTeamPayloads(
  prev: TeamPayload,
  cur: TeamPayload,
): { upserts: SnapshotEntity[]; removed: number[] } {
  const upserts: SnapshotEntity[] = [];
  const removed: number[] = [];
  for (const [id, snap] of cur.entities) {
    if (prev.entityJson.get(id) !== cur.entityJson.get(id)) upserts.push(snap);
  }
  for (const id of prev.entities.keys()) {
    if (!cur.entities.has(id)) removed.push(id);
  }
  return { upserts, removed };
}

/**
 * Filter one tick's sim events down to what the seat (slot, on team) may
 * see, preserving event order:
 * - Player-private (purchase, refund, itemUsed, xpGained, levelUp, bounty,
 *   questProgress, proximityWarning, commandRejected): owning seat only.
 * - Team-scoped: researchStarted/researchComplete (matching team), respawn
 *   (own team).
 * - Global: waveSpawned, matchEnded.
 * - Spatial (death, hit, missileLaunched): only if the affected entity is in
 *   `visibleIds` (this tick's ∪ previous tick's filtered set — deaths remove
 *   the entity before the post-step set is built) or a T player is involved
 *   (victim/killer; hit attacker; missile owner). AI empire slots count as
 *   team players — their kills happen inside their own creeps' sight anyway.
 *
 * Vision-leak gate (death): a 'death' event carries the victim's exact death
 * coordinates (combat.ts flagDeath), and the client renders an explosion there
 * (render/fx.ts). A kill credited to T (killerPlayer on T) can land on an
 * ENEMY ship that already broke line of sight — e.g. a damage-over-time burn
 * or a slow projectile fired with the original shooter as sourcePlayer. The
 * killer-team branch must therefore NOT leak the coordinates of an enemy death
 * that lies outside T's sight: such an event is dropped (the victim's OWN team
 * still gets it, and K/D is tallied server-side independent of filtering).
 */
export function filterEventsForSeat(
  state: SimState,
  events: readonly SimEvent[],
  team: TeamId,
  slot: number,
  visibleIds: ReadonlySet<number>,
  vision: TeamVision,
): SimEvent[] {
  const playerTeam = (player: number | null): TeamId | null =>
    player === null ? null : (state.players[player]?.team ?? null);

  const out: SimEvent[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case 'purchase':
      case 'refund':
      case 'itemUsed':
      case 'xpGained':
      case 'levelUp':
      case 'bounty':
      case 'questProgress':
      case 'commandRejected':
        if (ev.player === slot) out.push(ev);
        break;
      case 'proximityWarning':
        if (ev.ownerPlayer === slot) out.push(ev);
        break;
      case 'researchStarted':
      case 'researchComplete':
        if (ev.team === team) out.push(ev);
        break;
      case 'respawn':
        if (playerTeam(ev.player) === team) out.push(ev);
        break;
      case 'waveSpawned':
      case 'matchEnded':
        out.push(ev);
        break;
      case 'death':
        // Own-team death OR a death whose location is in T's sight (entity was
        // visible this/last tick, or the spot is covered now) forwards verbatim.
        if (
          playerTeam(ev.victimPlayer) === team ||
          visibleIds.has(ev.entityId) ||
          coveredSight(vision.sight, vision.mask, ev.x, ev.y)
        ) {
          out.push(ev);
          break;
        }
        // Otherwise the only reason T would learn of this death is that the
        // KILLER is on T (e.g. a DoT/slow projectile finished the kill after the
        // enemy fled T's vision). Dropping it closes the coordinate leak; kill
        // credit is tallied server-side and is unaffected.
        break;
      case 'hit':
        if (playerTeam(ev.attackerPlayer) === team || visibleIds.has(ev.targetEntityId)) {
          out.push(ev);
        }
        break;
      case 'missileLaunched':
        if (playerTeam(ev.player) === team || visibleIds.has(ev.targetEntityId)) {
          out.push(ev);
        }
        break;
    }
  }
  return out;
}
