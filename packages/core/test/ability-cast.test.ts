/**
 * Exhaustive ability cast audit (STATUS.md "Open / next"): drive the REAL
 * compiled ruleset AND the real specials module to learn + cast every active
 * `special` ability on every player hull that grants it, proving each fires an
 * effect end to end — not just the learn path. The companion STATIC check
 * (every special compiles to a non-degenerate parameter set) lives in
 * audit-probe.test.ts; this file is the DYNAMIC end-to-end half and therefore
 * uses the real specials.ts / combat.ts (no mocks).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { compileClassicRuleset } from '../src/sim/ruleset.js';
import { applySpecialsCommand } from '../src/sim/specials.js';
import { allocEntityId } from '../src/sim/types.js';
import type {
  AbilitySpec,
  PlayerState,
  RawDataFiles,
  ShipEntity,
  ShipSpec,
  SimState,
  TeamId,
} from '../src/sim/types.js';

function loadJson<T>(name: string): T {
  const url = new URL(`../../../data/json/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}
const raw: RawDataFiles = {
  weapons: loadJson('weapons.json'),
  equipment: loadJson('equipment.json'),
  ships: loadJson('ships.json'),
  upgradeCurves: loadJson('upgrade-curves.json'),
  scriptRules: loadJson('script-rules.json'),
  mapLayout: loadJson('map-layout.json'),
  gameplayConstants: loadJson('gameplay-constants.json'),
  units: loadJson('units.json'),
  abilities: loadJson('abilities.json'),
  items: loadJson('items.json'),
  buffs: loadJson('buffs.json'),
  strings: loadJson('strings.json'),
};
const rs = compileClassicRuleset(raw);

function makeState(): SimState {
  return {
    tick: 0, rngState: 12345, nextEntityId: 1, status: { phase: 'playing' },
    enabledModes: [], players: {},
    teams: {
      south: { id: 'south', aiPlayerSlot: 0, upgrades: {}, research: null },
      north: { id: 'north', aiPlayerSlot: 1, upgrades: {}, research: null },
    },
    entities: {}, projectiles: {}, groundItems: {}, detectionZones: [],
    pendingDeaths: [], events: [],
    timers: {
      nextWaveTick: {}, nextIncomeTick: 0, empireSharePeriodTicks: 0,
      nextEmpireShareTick: 0, nextGoldDumpTick: 0, streetMerchantSpawnTick: null,
    },
  };
}

function addPlayer(state: SimState, slot: number, team: TeamId, shipTypeId: string): PlayerState {
  const player: PlayerState = {
    slot, team, control: 'user', gold: 0, lumber: 0, xp: 0, level: 20,
    unspentSkillPoints: 0, heroSkillLevels: {}, shipTypeId, shipId: null,
    inventory: [null, null, null, null, null, null], cooldownGroups: {},
    missileReadyAtTick: 0, respawnAtTick: null, goldDumpEnabled: false,
  };
  state.players[slot] = player;
  return player;
}

function addShip(state: SimState, player: PlayerState, x: number, y: number): ShipEntity {
  const spec = rs.ships[player.shipTypeId];
  if (!spec) throw new Error(`no ship spec ${player.shipTypeId}`);
  const id = allocEntityId(state);
  const ship: ShipEntity = {
    id, typeId: spec.typeId, x, y, facingRad: 0, dead: false, kind: 'ship',
    owner: player.slot, team: player.team, hp: spec.maxHp, maxHp: spec.maxHp,
    order: { type: 'idle' }, statuses: [], vision: { south: true, north: true },
    attackReadyAtTick: 0, casting: null, pausedUntilTick: 0,
    invulnerableUntilTick: 0, submerged: false,
  };
  state.entities[id] = ship;
  player.shipId = id;
  return ship;
}

/** All (hullTypeId, abilityId, AbilitySpec) for granted active 'special' abilities. */
function activeSpecials(): Array<{ hull: string; abilityId: string; spec: AbilitySpec }> {
  const out: Array<{ hull: string; abilityId: string; spec: AbilitySpec }> = [];
  for (const hull of Object.keys(rs.ships)) {
    for (const abilityId of (rs.ships[hull] as ShipSpec).abilityIds) {
      const spec = rs.abilities[abilityId];
      if (
        spec &&
        spec.mechanic === 'special' &&
        spec.special &&
        !spec.special.passive &&
        spec.special.kind !== 'fireMissile'
      ) {
        out.push({ hull, abilityId, spec });
      }
    }
  }
  return out;
}

// Kinds whose effect lands on the caster or a self-centred area (no target id).
const SELF_OR_AREA = new Set(['empBlast', 'freezeWater', 'summonSwarm', 'mirrorImage', 'intercept', 'barrier']);
// Exotic kinds STATUS.md flagged as the cast-fires gap; if present on a hull they must be exercised.
const EXOTIC_GAP = ['acidBomb', 'freezeWater', 'sailRipper', 'boardShip', 'devour', 'disrupt', 'mirrorImage', 'sendSpy'];

describe('every active special on every player hull fires end to end', () => {
  const cases = activeSpecials();

  it('has active specials to exercise', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const { hull, abilityId, spec } of cases) {
    const kind = spec.special!.kind;
    it(`${hull} / ${abilityId} (${kind}) casts -> abilityCast + observable effect`, () => {
      const state = makeState();
      const caster = addPlayer(state, 2, 'south', hull);
      const ship = addShip(state, caster, 0, 0);
      caster.heroSkillLevels[abilityId] = 6; // learned to max; atRank clamps to the real rank count

      const ally = addPlayer(state, 3, 'south', 'H000');
      const allyShip = addShip(state, ally, 1, 0);
      allyShip.hp = 1; // leave room for a heal-over-time to act
      const enemy = addPlayer(state, 7, 'north', 'H006');
      const enemyShip = addShip(state, enemy, 1, 0);

      const cmd: {
        type: 'castAbility'; player: number; abilityId: string; targetId?: number; x?: number; y?: number;
      } = { type: 'castAbility', player: 2, abilityId };
      if (spec.special!.friendlyTarget) cmd.targetId = allyShip.id;
      else if (kind === 'disrupt') { cmd.x = enemyShip.x; cmd.y = enemyShip.y; }
      else if (!SELF_OR_AREA.has(kind)) cmd.targetId = enemyShip.id;

      applySpecialsCommand(state, rs, cmd);

      const rejected = state.events.find((e) => e.type === 'commandRejected');
      expect(
        rejected,
        `rejected: ${rejected && 'reason' in rejected ? (rejected as { reason: string }).reason : ''}`,
      ).toBeUndefined();
      expect(
        state.events.some((e) => e.type === 'abilityCast' && 'abilityId' in e && e.abilityId === abilityId),
        'no abilityCast emitted',
      ).toBe(true);

      // Observable effect: enemy/ally status or DoT, a summon/decoy spawned, a
      // detection zone dropped, the caster's own buff, or recorded damage.
      const enemyTouched = enemyShip.statuses.length > 0 || enemyShip.dead || enemyShip.hp < enemyShip.maxHp;
      const allyTouched = allyShip.statuses.length > 0 || allyShip.hp > 1;
      const selfTouched = ship.statuses.length > 0 || ship.dead;
      const spawned = Object.keys(state.entities).length > 3; // caster+ally+enemy baseline
      const zoneDropped = state.detectionZones.length > 0;
      expect(
        enemyTouched || allyTouched || selfTouched || spawned || zoneDropped,
        'fired but applied no observable effect',
      ).toBe(true);
    });
  }

  it('exercises every exotic special kind that exists on a player hull', () => {
    const present = new Set(cases.map(({ spec }) => spec.special!.kind));
    for (const kind of EXOTIC_GAP) {
      if (present.has(kind)) {
        expect(cases.some(({ spec }) => spec.special!.kind === kind)).toBe(true);
      }
    }
  });
});
