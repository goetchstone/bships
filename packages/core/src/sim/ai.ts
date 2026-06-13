/**
 * Deterministic AI brain for computer-controlled captains (docs/AI.md).
 *
 * This module is the ONLY place AI decisions are made. It is a PURE function
 * of (SimState, Ruleset, slot, the slot's AiMemory): given the world it
 * returns the `Command[]` that slot's player would issue this think, plus it
 * mutates the slot's `AiMemory` in place (a serializable POJO living inside
 * SimState). Its output is exactly what a human client sends — the server
 * feeds it through the SAME applyCommands path, so the AI cannot cheat the
 * rules.
 *
 * REPLAY CONTRACT (precise): a match with AI players replays bit-identically
 * from (seed, AI configs) by RE-RUNNING this deterministic brain — the brain
 * reproduces both its command stream and its `AiMemory` from the seed. The
 * logged command stream is the brain's OUTPUT, not a substitute for it:
 * replaying only the command log into a fresh `createMatch` WITHOUT re-running
 * the brain does NOT reproduce an AI match's `hashState`, because `aiMemory`
 * (nextThinkTick/aiRngState/lane/stance/stuck) is part of `SimState` + digested
 * by `hashState` and is only advanced by the brain. (Pure command-log replay
 * does reproduce a HUMAN match, whose state carries no brain-derived memory.)
 *
 * ====================================================================
 * DETERMINISM CONTRACT (binding — replays + server/client agreement depend
 * on every line of this holding):
 * ====================================================================
 * - Randomness: ONLY via this module's `aiNext`/`aiInt`/`aiPick`, which thread
 *   `AiMemory.aiRngState` through the shared mulberry32 `Rng`. The brain MUST
 *   NEVER call `Math.random`, read `Date`/wall-clock, or touch
 *   `state.rngState` (that channel's draw order is the sim-mechanic replay
 *   contract — see MODULES.md "RNG draw order"). The brain's stream is
 *   private and seeded from (matchSeed, slot) at `initAiMemory`.
 * - Angle math: ONLY via `dSin`/`dCos`/`dAtan2` from `../math.js`. Never
 *   `Math.sin/cos/atan2`. `Math.sqrt/abs/floor/min/max` and `dist` are fine.
 * - Iteration: over `state.entities` / `state.players` in ASCENDING numeric id
 *   order via `sortedNumericKeys`; candidate lists for random picks are built
 *   in ascending-id order BEFORE drawing (matches the sim-wide convention).
 * - No reads of `state.events` to drive logic (derived output only).
 * - The brain reads the FULL state (it runs server-side) but emits only
 *   PUBLIC actions — the same Commands a human could legally issue. It must
 *   not encode hidden information into commands (e.g. attacking an entity its
 *   own team cannot see); target selection respects the team's vision the way
 *   a human would (see `sim/specials.ts` `entity.vision` + sight).
 *
 * ====================================================================
 * THINK CADENCE (server calls the brain on an interval, not every tick):
 * ====================================================================
 * Humans may act every tick; bots "think" every N ticks where N derives from
 * difficulty (`thinkIntervalTicks`). The server AI runner calls
 * `computeAiCommands` for an AI slot when `state.tick >= memory.nextThinkTick`
 * and applies the returned commands on that tick. The brain advances
 * `memory.nextThinkTick = state.tick + thinkIntervalTicks(difficulty)` itself
 * so the cadence is part of the deterministic state. The runner MUST NOT
 * second-guess the cadence — it just gates on `nextThinkTick`.
 */

import { dAtan2, dCos, dist, dSin, HALF_PI } from '../math.js';
import { Rng } from '../rng.js';
import type {
  AiConfig,
  AiDifficulty,
  Combatant,
  Command,
  Entity,
  Ruleset,
  ShipEntity,
  SimState,
  StructureEntity,
  TeamId,
} from './types.js';
import { enemyTeam, sortedNumericKeys } from './types.js';
import type { AiMemory } from './types.js';

// ---------------------------------------------------------------------------
// Difficulty tuning (single source of truth; docs/AI.md mirrors this table)
// ---------------------------------------------------------------------------

/**
 * Per-difficulty behavior knobs. Implementers read these — there are NO
 * hardcoded difficulty numbers scattered through the decision logic. Tune
 * here and in docs/AI.md together.
 *
 * - `thinkIntervalTicks`: ticks between thinks (cadence). Lower = sharper.
 * - `retreatHpFraction`: retreat toward base/repair when hp/maxHp drops below
 *   this. 0 disables retreat (suicidal easy bot).
 * - `economyEfficiency`: 0..1 — chance per think the bot makes its ideal buy
 *   vs. dawdling (lower = wastes gold / buys late).
 * - `microQuality`: 0..1 — chance per think the bot issues an optimal
 *   targeting/positioning order vs. a coarse attack-move only.
 * - `reserveGold`: gold the bot tries to keep on hand (spends only the excess).
 */
export interface AiTuning {
  thinkIntervalTicks: number;
  retreatHpFraction: number;
  economyEfficiency: number;
  microQuality: number;
  reserveGold: number;
}

/**
 * Difficulty -> tuning. EASY: slow, sloppy, never retreats well; NORMAL:
 * steady; HARD: fast cadence, efficient economy, sharp micro, disciplined
 * retreats. Implementer (ai-brain) may refine the exact values during
 * playtesting but MUST keep them here and mirror them in docs/AI.md.
 */
export const AI_TUNING: Readonly<Record<AiDifficulty, AiTuning>> = {
  easy: {
    thinkIntervalTicks: 20, // ~1.0 s
    retreatHpFraction: 0.15,
    economyEfficiency: 0.5,
    microQuality: 0.3,
    reserveGold: 0,
  },
  normal: {
    thinkIntervalTicks: 10, // ~0.5 s
    retreatHpFraction: 0.3,
    economyEfficiency: 0.8,
    microQuality: 0.65,
    reserveGold: 100,
  },
  hard: {
    thinkIntervalTicks: 5, // ~0.25 s
    retreatHpFraction: 0.4,
    economyEfficiency: 1.0,
    microQuality: 0.95,
    reserveGold: 150,
  },
};

/** Ticks between thinks for a difficulty (cadence gate). */
export function thinkIntervalTicks(difficulty: AiDifficulty): number {
  return AI_TUNING[difficulty].thinkIntervalTicks;
}

// ---------------------------------------------------------------------------
// Brain-private PRNG (NEVER touches state.rngState)
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic 32-bit seed for slot `slot` from the match `seed`.
 * Pure integer hashing (no Math.random/trig) so it is engine-independent and
 * two AIs on the same match diverge. Exported for tests / the server runner.
 */
export function deriveAiSeed(seed: number, slot: number): number {
  // xorshift-ish mix of (seed, slot) — arbitrary but fixed and reproducible.
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (slot + 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

/**
 * Build the initial AiMemory for an AI slot at createMatch. Pure + IO-free;
 * does NOT touch `state.rngState`. The private PRNG stream starts from
 * `deriveAiSeed(seed, slot)`. Called by `createMatch` for every slot whose
 * PlayerConfig carries an `ai` config.
 */
export function initAiMemory(slot: number, seed: number, config: AiConfig): AiMemory {
  const initialSeed = deriveAiSeed(seed, slot);
  return {
    slot,
    difficulty: config.difficulty,
    initialSeed,
    aiRngState: initialSeed,
    nextThinkTick: 0,
    laneId: null,
    stance: 'push',
    retreatSinceTick: 0,
    lastOrderX: null,
    lastOrderY: null,
    lastProgressX: null,
    lastProgressY: null,
    lastProgressTick: 0,
    stuckCount: 0,
  };
}

/**
 * Load the brain's private PRNG from `memory.aiRngState`. Draw with the
 * returned helpers, then `commitAiRng(memory, rng)` once at the end of the
 * think to persist the advanced state. (Folding `state.tick` is optional and
 * up to the implementer — the stream is already per-slot deterministic; if
 * you fold the tick in, do it identically on every code path so replays hold.)
 */
export function seedAiRng(memory: AiMemory): Rng {
  return Rng.fromState(memory.aiRngState);
}

/** Persist the advanced PRNG state back into memory (call once per think). */
export function commitAiRng(memory: AiMemory, rng: Rng): void {
  memory.aiRngState = rng.getState();
}

// ---------------------------------------------------------------------------
// The brain entry point
// ---------------------------------------------------------------------------

/**
 * Compute this AI slot's commands for the current think and update its memory
 * in place (cadence gate, lane choice, stance, stuck tracking).
 *
 * Contract:
 * - `state.players[slot]` MUST exist and be `control: 'computer'` with an
 *   `aiMemory[slot]` entry (the server runner guarantees this before calling).
 * - Returns Commands whose `.player === slot`. They are queued by the server
 *   exactly like human commands and applied THIS tick via applyCommands.
 * - The brain SETS `memory.nextThinkTick` before returning so the server's
 *   cadence gate advances. Returning `[]` is valid (nothing to do this think).
 * - MUST be deterministic per the module-level contract.
 *
 * Implementer (ai-brain) owns the body. High-level behavior to implement
 * (docs/AI.md "Behavior spec"):
 *   1. Cadence: if `state.tick < memory.nextThinkTick` return [] unchanged
 *      (defensive; the runner already gates, but keep the invariant local).
 *      Otherwise set `memory.nextThinkTick = state.tick +
 *      thinkIntervalTicks(memory.difficulty)`.
 *   2. If dead (player.shipId === null / respawning): no orders; maybe queue a
 *      buy is invalid while dead — emit nothing.
 *   3. Economy: spend (gold - tuning.reserveGold) on the next BALANCE-tier
 *      item from the correct team's in-range shop (opening cannon, then
 *      weapon/hull/sail upgrades). Emit buyItem with the shop entity id.
 *   4. Survival: if hp/maxHp < tuning.retreatHpFraction set stance 'retreat'
 *      and move toward own base/repair bay; use a repair item/ability if
 *      carried. Hysteresis: only flip back to 'push' once healed above a
 *      higher band.
 *   5. Lane + push: pick/keep a lane (loose teammate coordination — avoid all
 *      bots stacking one lane), attack-move toward the enemy HQ so carried
 *      weapons (Phoenix Fire) auto-fire at creeps/ships en route.
 *   6. Targeting: prefer an enemy ship in range, else enemy creeps, else keep
 *      advancing toward the enemy HQ. Respect team vision like a human.
 *   7. Stuck breaking: if the ship hasn't progressed since the last check
 *      (compare lastProgress[XY] vs current pos), bump stuckCount and re-issue
 *      a fresh waypoint when it crosses a threshold.
 *
 * Use `AI_TUNING[memory.difficulty]` / the difficulty knobs for every tuned
 * decision; draw randomness only via `seedAiRng`/`commitAiRng`.
 */
export function computeAiCommands(
  state: SimState,
  ruleset: Ruleset,
  slot: number,
  memory: AiMemory,
): Command[] {
  // --- 1. Cadence gate (defensive — the runner already gates on this) ------
  // Returning early WITHOUT advancing nextThinkTick and WITHOUT committing the
  // RNG keeps the cadence/stream untouched: a too-early call is a no-op.
  if (state.tick < memory.nextThinkTick) return [];

  const tuning = AI_TUNING[memory.difficulty];
  // Advance the cadence first so EVERY return path below leaves it advanced.
  memory.nextThinkTick = state.tick + tuning.thinkIntervalTicks;

  // The brain draws ONLY from this stream; commit it back exactly once at the
  // end of the think, on every path (see `finish`).
  const rng = seedAiRng(memory);
  const commands: Command[] = [];
  const finish = (): Command[] => {
    commitAiRng(memory, rng);
    return commands;
  };

  // --- 2. Liveness ----------------------------------------------------------
  const player = state.players[slot];
  if (!player || player.shipId === null) {
    // Dead / awaiting respawn: no legal orders this think. Reset stuck/lane
    // tracking so the bot re-evaluates cleanly when it respawns.
    memory.stance = 'push';
    memory.stuckCount = 0;
    memory.lastProgressX = null;
    memory.lastProgressY = null;
    return finish();
  }
  const ship = shipOf(state, player.shipId);
  if (!ship) return finish();
  const team = player.team;
  const foe = enemyTeam(team);

  // --- 3. Survival + stance (hysteresis) ------------------------------------
  // retreatHpFraction enters retreat; recover to push only above a higher band
  // (reachable because retreat routes to the repair bay's full heal), or after
  // a bounded retreat timeout so a bot that cannot reach the bay re-engages.
  const hpFraction = ship.maxHp > 0 ? ship.hp / ship.maxHp : 1;
  const recoverBand = Math.min(
    RETREAT_RECOVER_BAND_CAP,
    tuning.retreatHpFraction + RETREAT_HYSTERESIS_BAND,
  );
  if (tuning.retreatHpFraction > 0 && hpFraction < tuning.retreatHpFraction) {
    if (memory.stance !== 'retreat') {
      memory.stance = 'retreat';
      memory.retreatSinceTick = state.tick;
    }
  } else if (memory.stance === 'retreat' && hpFraction >= recoverBand) {
    memory.stance = 'push';
    memory.retreatSinceTick = 0;
  }
  // Timeout: even if still wounded, stop hiding at base after a bounded spell
  // and push again (the bot might be unable to reach its bay or out of heals).
  if (
    memory.stance === 'retreat' &&
    state.tick - memory.retreatSinceTick >= RETREAT_MAX_TICKS
  ) {
    memory.stance = 'push';
    memory.retreatSinceTick = 0;
  }

  // --- 4. Economy (gated by economyEfficiency) ------------------------------
  // Spend only the excess above the reserve, on the next BALANCE-tier item,
  // bought from the correct team's in-range shop. Runs in BOTH stances: a
  // wounded bot retreating past its base shops should still upgrade (and buy
  // the Repair Crew its retreat heal depends on). If the shop is out of reach
  // while PUSHING we detour to dock; while RETREATING we only opportunistically
  // buy when already in range (the retreat route below owns positioning).
  const spendable = player.gold - tuning.reserveGold;
  const wantItem = spendable > 0 ? nextDesiredItem(ruleset, player.inventory, spendable) : null;
  if (wantItem !== null && rng.next() < tuning.economyEfficiency) {
    const shop = nearestSellingShop(state, ruleset, team, wantItem.itemId);
    if (shop) {
      const spec = ruleset.shops[shop.typeId];
      const reach = spec ? spec.interactRadius : 0;
      if (dist(ship.x, ship.y, shop.x, shop.y) <= reach) {
        if (wantItem.dropSlot !== null) {
          // Upgrading within a one-per-ship group (e.g. Stone -> Bronze hull):
          // drop the lower tier first (no sell-back in Classic) so the buy is
          // not auto-refunded next think. Drop AT the shop position.
          commands.push({
            type: 'dropItem',
            player: slot,
            slot: wantItem.dropSlot,
            x: ship.x,
            y: ship.y,
          });
        } else {
          commands.push({ type: 'buyItem', player: slot, shopId: shop.id, itemId: wantItem.itemId });
        }
        // A buy/drop is the whole think — re-evaluate next cadence.
        updateProgress(state, memory, ship);
        return finish();
      }
      // Not docked yet. While pushing, detour to the shop (stopping just inside
      // interact range so we never shove through its collision circle); while
      // retreating, fall through to the retreat route — survival comes first.
      // The approach point is stable across thinks, so the dead-zone keeps us
      // from re-issuing (and resetting pathing) every think.
      if (memory.stance !== 'retreat') {
        const approach = pointTowards(shop.x, shop.y, ship.x, ship.y, Math.max(0, reach - 64));
        issueMove(commands, memory, slot, 'move', approach.x, approach.y);
        updateProgress(state, memory, ship);
        return finish();
      }
    }
  }

  // --- 4b. Retreat route ----------------------------------------------------
  // Sail into the repair-bay station (specials.ts full-heals a damaged allied
  // ship that stands there, then ejects it), firing any carried instant-heal /
  // repair wood on the way. Routing to the BAY — not the HQ point — is what
  // makes the recover band reachable.
  if (memory.stance === 'retreat') {
    const healSlot = readyHealSlot(state, ruleset, player.inventory);
    if (healSlot >= 0) {
      commands.push({ type: 'useItem', player: slot, slot: healSlot });
    }
    const bay = repairBayPoint(ruleset, team) ?? ownBasePoint(team);
    // The bay point is stable and far from the front, so the dead-zone keeps us
    // from re-issuing (and resetting pathing) every think while retreating.
    issueMove(commands, memory, slot, 'move', bay.x, bay.y);
    updateProgress(state, memory, ship);
    return finish();
  }

  // --- 5. Lane pick / keep (loose teammate anti-stacking) -------------------
  const laneId = chooseLane(state, ruleset, slot, team, memory, rng);
  memory.laneId = laneId;
  const enemyHq = enemyHqPoint(state, foe) ?? defaultEnemyHqPoint(foe);

  // --- 6. Targeting (gated by microQuality) ---------------------------------
  // The push waypoint is ALWAYS biased toward the enemy HQ so the bot keeps net
  // forward momentum instead of parking on the nearest creep. Default: down the
  // chosen lane's corridor to the enemy HQ. With sharp micro, if a visible
  // enemy is in aggro range we aim just PAST it toward the HQ — close enough
  // that carried Phoenix Fire auto-fires while closing, but still advancing.
  let targetX = laneCorridorX(ruleset, laneId, enemyHq.x);
  let targetY = enemyHq.y;
  if (rng.next() < tuning.microQuality) {
    const target = pickCombatTarget(state, ship, team);
    if (target) {
      // Step from the ship through the target and a little beyond, toward the
      // HQ, so the attack-move advances through the brawl rather than stalling.
      const past = pointTowards(enemyHq.x, enemyHq.y, target.x, target.y, ENGAGE_PUSH_THROUGH);
      targetX = past.x;
      targetY = past.y;
    }
  }

  // --- 7. Stuck breaking ----------------------------------------------------
  // If the ship has not moved meaningfully since the last progress check, bump
  // stuckCount; once it crosses the threshold pick a fresh detoured waypoint.
  // The "meaningful" epsilon scales with this difficulty's think cadence and
  // the ship's speed, so a ship sailing flat out is never mistaken for stuck.
  const epsilonSq = stuckEpsilonSq(ruleset, ship, tuning.thinkIntervalTicks);
  const stuck = bumpStuck(state, memory, ship, epsilonSq);
  if (stuck) {
    const detour = stuckDetour(ship, targetX, targetY, rng);
    // Force the detour through the re-issue dead-zone — it must land even if it
    // lands near the last waypoint, or the bot would never break free.
    issueMove(commands, memory, slot, 'attackMove', detour.x, detour.y, true);
    return finish();
  }

  issueMove(commands, memory, slot, 'attackMove', targetX, targetY);
  return finish();
}

// ---------------------------------------------------------------------------
// Behavior constants (difficulty-independent geometry / thresholds)
// ---------------------------------------------------------------------------

/**
 * Added to retreatHpFraction to get the recover-to-push band (hysteresis). The
 * band MUST be reachable by in-game healing: a retreating bot sails into its
 * repair-bay station (full heal, see specials.ts `runRepairBays`) so reaching
 * a high band is realistic. Kept modest so a bot that tops up at the bay (or
 * heals a few % off a carried Repair Crew) promptly re-engages rather than
 * waiting on the ~0.05 HP/s passive regen (which alone would never close a
 * large band — that was the original permanent-retreat trap).
 */
const RETREAT_HYSTERESIS_BAND = 0.2;
/** Hard ceiling on the recover band so it is never set unreachably high. */
const RETREAT_RECOVER_BAND_CAP = 0.7;
/**
 * Force-flip retreat -> push after this many ticks even if not fully healed, so
 * a bot that cannot reach its repair bay (blocked path, no heal item) still
 * re-engages instead of idling at base for the whole match. ~45 s at 20 tps.
 */
const RETREAT_MAX_TICKS = 900;
/**
 * Fraction of the per-think expected travel below which a push think counts as
 * "no progress". The absolute epsilon MUST scale with the think cadence and
 * ship speed — at hard cadence (5 ticks) a full-speed start ship moves only
 * ~42 units/think, so a fixed 64-unit epsilon would flag a ship sailing flat
 * out as stuck and trigger constant detours (the original pathing-thrash bug).
 */
const STUCK_PROGRESS_FRACTION = 0.35;
/** Floor for the stuck epsilon (units) so a near-stationary ship still trips it. */
const STUCK_MOVE_EPSILON_MIN = 16;
/** Consecutive no-progress thinks before the bot re-routes around an obstacle. */
const STUCK_THRESHOLD = 3;
/** Lateral magnitude (units) of a stuck-breaking detour. */
const STUCK_DETOUR_UNITS = 600;

/**
 * BALANCE-tier opening + upgrade ladder (docs/AI.md §6, docs/BALANCE.md).
 * Each entry is bought once, in order, when affordable: opening Basic Cannon,
 * then sustain (Repair Crew), a hull (Stone -> Bronze -> Gold), a sail, then a
 * Mechanics Crew upgrade. The bot stops shopping once the ladder is done (gold
 * then banks toward the reserve). Kept deliberately small + readable.
 *
 * EVERY itemId here MUST be carried by at least one in-shop entry — a rung that
 * no shop sells can never be bought, and (because `nextDesiredItem` walks the
 * ladder in order) would wedge the whole ladder forever. `nextDesiredItem`
 * defensively skips any rung with no seller (see there), and the
 * `ai-ladder.test.ts` ruleset-availability assertion guards this at build time;
 * the gold figures below are the live Classic shop prices for reference. (The
 * Repair Crew sits early so a wounded bot can `useItem`-heal while retreating.)
 */
const ITEM_LADDER: readonly { itemId: string; gold: number }[] = [
  { itemId: 'I001', gold: 200 }, // Basic Cannon (opening weapon, n001)
  { itemId: 'I009', gold: 200 }, // Stone Hull (cheapest survivability, n002)
  { itemId: 'I017', gold: 145 }, // Repair Crew (carried sustain heal, n002)
  { itemId: 'I008', gold: 610 }, // Great Sail (in-shop speed, n002)
  { itemId: 'I016', gold: 1100 }, // Bronze Hull (replaces Stone, n002)
  { itemId: 'I00B', gold: 720 }, // Mechanics Crew (replaces Repair Crew, n002)
  { itemId: 'I00A', gold: 2500 }, // Gold Hull (replaces Bronze, n002)
];

/**
 * Mutually-exclusive upgrade groups, each ordered worst -> best. The engine
 * caps each group at one per ship (stackRules `onlyOneHull` / `onlyOneRepair`,
 * see economy.ts `enforceItemRules`) AND Classic has no sell-back, so the bot
 * cannot simply buy the better tier on top of the worse one — the purchase
 * would be auto-refunded (wasting the shop's stock). To climb a group the bot
 * first DROPS the lower-tier member it holds, then buys the upgrade next think
 * (see `nextDesiredItem` / the economy block in `computeAiCommands`).
 */
const UPGRADE_GROUPS: readonly (readonly string[])[] = [
  ['I009', 'I016', 'I00A'], // hulls
  ['I017', 'I00B'], // repair crews
];

// ---------------------------------------------------------------------------
// Internal helpers (all deterministic — no Math.random/Date/state.rngState,
// no Math.sin/cos/atan2; iterate via sortedNumericKeys)
// ---------------------------------------------------------------------------

/** The slot's living ship entity, or null if it is dead / not a ship. */
function shipOf(state: SimState, shipId: number): ShipEntity | null {
  const e = state.entities[shipId];
  return e && e.kind === 'ship' && !e.dead ? e : null;
}

/**
 * Re-issue dead-zone (units): a new waypoint within this distance of the last
 * one issued is treated as "the same order" and skipped. Set well above 1 so a
 * push waypoint that jitters slightly each think (target drift, the HQ point vs
 * a moving creep a few hundred units apart) does NOT reset the engine's path
 * every tick — which kept the ship pivoting in place instead of advancing.
 */
const REISSUE_DEADZONE = 350;

/**
 * Issue a move/attackMove only when the new waypoint differs meaningfully from
 * the last one issued (avoids spamming near-identical orders every think, which
 * would reset the engine's path each tick and stall forward momentum). Records
 * the issued waypoint. `force` bypasses the dead-zone for orders that MUST
 * land even if close to the last one (stuck detours, stance changes).
 */
function issueMove(
  commands: Command[],
  memory: AiMemory,
  slot: number,
  type: 'move' | 'attackMove',
  x: number,
  y: number,
  force = false,
): void {
  if (!force && memory.lastOrderX !== null && memory.lastOrderY !== null) {
    const dx = memory.lastOrderX - x;
    const dy = memory.lastOrderY - y;
    if (dx * dx + dy * dy < REISSUE_DEADZONE * REISSUE_DEADZONE) return;
  }
  commands.push({ type, player: slot, x, y });
  memory.lastOrderX = x;
  memory.lastOrderY = y;
}

/**
 * The first ready, charged instant-heal item slot (repair woods I00C/I00D/...),
 * scanning inventory ascending. -1 if none usable this tick. Used while
 * retreating to top up HP.
 */
function readyHealSlot(
  state: SimState,
  ruleset: Ruleset,
  inventory: SimState['players'][number]['inventory'],
): number {
  for (let i = 0; i < inventory.length; i++) {
    const item = inventory[i];
    if (!item) continue;
    const equip = ruleset.equipment[item.itemId];
    if (!equip || !equip.active || equip.active.kind !== 'instantHeal') continue;
    if (item.readyAtTick > state.tick) continue;
    if (item.charges !== null && item.charges <= 0) continue;
    return i;
  }
  return -1;
}

/**
 * Next item the bot wants from `ITEM_LADDER`: the first ladder entry it does
 * not yet own, can afford with `budget`, and which is not superseded by a
 * higher-tier item it already carries (so it does not re-buy a Stone Hull
 * after owning a Bronze Hull). Returns null when the ladder is satisfied or
 * nothing is affordable.
 *
 * `dropSlot` is set when the desired item is in a mutually-exclusive
 * `UPGRADE_GROUP` and the bot already holds a LOWER-tier member: the caller
 * must `dropItem` that inventory slot before the buy can land (the engine caps
 * the group at one and Classic has no sell-back). `dropSlot` is null for a
 * fresh purchase.
 */
function nextDesiredItem(
  ruleset: Ruleset,
  inventory: SimState['players'][number]['inventory'],
  budget: number,
): { itemId: string; gold: number; dropSlot: number | null } | null {
  const owned = new Set<string>();
  for (const item of inventory) if (item) owned.add(item.itemId);
  const hasHigherInGroup = (group: readonly string[], itemId: string): boolean => {
    const idx = group.indexOf(itemId);
    if (idx < 0) return false;
    for (let j = idx + 1; j < group.length; j++) if (owned.has(group[j]!)) return true;
    return false;
  };
  // Inventory slot of the highest-tier member of `itemId`'s group strictly
  // below it (the one to drop before upgrading), or null if none held.
  const lowerTierSlot = (itemId: string): number | null => {
    for (const group of UPGRADE_GROUPS) {
      const idx = group.indexOf(itemId);
      if (idx <= 0) continue;
      for (let j = idx - 1; j >= 0; j--) {
        const lower = group[j]!;
        for (let s = 0; s < inventory.length; s++) {
          if (inventory[s]?.itemId === lower) return s;
        }
      }
    }
    return null;
  };
  // A strictly-higher tier of `itemId`'s group is unowned AND affordable, so we
  // should hold out for it rather than buy this cheaper tier we'd only drop. (No
  // sell-back: buying the cheap tier then dropping it to climb wastes its gold.)
  const betterAffordableExists = (itemId: string): boolean => {
    for (const group of UPGRADE_GROUPS) {
      const idx = group.indexOf(itemId);
      if (idx < 0) continue;
      for (let j = idx + 1; j < group.length; j++) {
        const higher = group[j]!;
        if (owned.has(higher)) continue;
        const g = shopGoldOf(ruleset, higher);
        if (g !== null && g <= budget) return true;
      }
    }
    return false;
  };
  for (const entry of ITEM_LADDER) {
    if (owned.has(entry.itemId)) continue;
    if (UPGRADE_GROUPS.some((g) => hasHigherInGroup(g, entry.itemId))) continue;
    // Don't buy a cheap group tier when a better one is already affordable —
    // climb straight to the best the budget allows (avoids buy-then-drop churn).
    if (betterAffordableExists(entry.itemId)) continue;
    // Skip any rung NO shop sells: an un-buyable item could never be acquired
    // and (since we walk the ladder in order) would wedge every later rung
    // forever. The live shop price is also the ground-truth gold cost.
    const gold = shopGoldOf(ruleset, entry.itemId);
    if (gold === null) continue;
    if (gold > budget) continue;
    return { itemId: entry.itemId, gold, dropSlot: lowerTierSlot(entry.itemId) };
  }
  return null;
}

/** The gold price of an item from any shop that sells it (ascending typeId). */
function shopGoldOf(ruleset: Ruleset, itemId: string): number | null {
  for (const typeId of Object.keys(ruleset.shops).sort()) {
    const entry = ruleset.shops[typeId]?.items.find((i) => i.itemId === itemId);
    if (entry) return entry.gold;
  }
  return null;
}

/**
 * Nearest shop structure that (a) sells `itemId`, (b) is on this team's side
 * or open to both (so the buy will not be rejected as an enemy shop), scanning
 * entities ascending-id and keeping the closest. null if none placed.
 */
function nearestSellingShop(
  state: SimState,
  ruleset: Ruleset,
  team: TeamId,
  itemId: string,
): StructureEntity | null {
  let best: StructureEntity | null = null;
  let bestDist = Infinity;
  // We resolve the buyer's ship once for distance ranking.
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || e.kind !== 'structure' || e.role !== 'shop' || e.dead) continue;
    const spec = ruleset.shops[e.typeId];
    if (!spec || !spec.items.some((i) => i.itemId === itemId)) continue;
    const side = shopSideOf(ruleset, e);
    if (side !== null && side !== team) continue; // enemy-side shop: would reject
    // Rank by distance to the shop from the team's base (stable, ship-pos
    // independent so the bot does not thrash between two equidistant shops).
    const base = ownBasePoint(team);
    const d = dist(base.x, base.y, e.x, e.y);
    if (d < bestDist) {
      bestDist = d;
      best = e;
    }
  }
  return best;
}

/** Which team's zone a shop sits in (StructurePlacement.shopSide), or null. */
function shopSideOf(ruleset: Ruleset, shop: StructureEntity): TeamId | null {
  if (shop.instanceKey === '') return null;
  for (const placement of ruleset.map.structures) {
    if (placement.instanceKey === shop.instanceKey) return placement.shopSide;
  }
  return null;
}

/**
 * Choose / keep a lane. Loose anti-stacking: count allied PLAYER ships (other
 * AI + humans) already committed near each of this team's two lanes and prefer
 * the emptier one. Keeps the committed lane unless it is the more crowded
 * choice, to avoid thrashing. Falls back to slot parity when counts tie.
 */
function chooseLane(
  state: SimState,
  ruleset: Ruleset,
  slot: number,
  team: TeamId,
  memory: AiMemory,
  rng: Rng,
): string {
  // This team's lanes (creeps owned by the team push toward the enemy).
  const lanes: string[] = [];
  for (const lane of ruleset.map.lanes) if (lane.team === team) lanes.push(lane.id);
  lanes.sort();
  if (lanes.length === 0) return memory.laneId ?? '';
  if (lanes.length === 1) return lanes[0]!;

  // Anchor x of each lane (its spawn point) for an allied-ship headcount.
  const laneAnchor: Record<string, { x: number; y: number }> = {};
  for (const lane of ruleset.map.lanes) {
    if (lane.team === team) laneAnchor[lane.id] = { x: lane.spawnX, y: lane.spawnY };
  }
  const allyByLane: Record<string, number> = {};
  for (const id of lanes) allyByLane[id] = 0;
  for (const pid of sortedNumericKeys(state.players)) {
    if (pid === slot) continue;
    const p = state.players[pid];
    if (!p || p.team !== team || p.shipId === null) continue;
    if (p.slot === state.teams[team].aiPlayerSlot) continue; // skip empire AI
    const s = shipOf(state, p.shipId);
    if (!s) continue;
    // Bucket the ally into whichever of this team's lanes its x is closest to.
    let nearest = lanes[0]!;
    let nd = Infinity;
    for (const lid of lanes) {
      const a = laneAnchor[lid];
      if (!a) continue;
      const d = Math.abs(s.x - a.x);
      if (d < nd) {
        nd = d;
        nearest = lid;
      }
    }
    allyByLane[nearest] = (allyByLane[nearest] ?? 0) + 1;
  }

  // Keep the current lane unless another lane is strictly less crowded.
  const current = memory.laneId;
  if (current !== null && lanes.includes(current)) {
    const curCount = allyByLane[current] ?? 0;
    let minOther = Infinity;
    for (const lid of lanes) if (lid !== current) minOther = Math.min(minOther, allyByLane[lid] ?? 0);
    if (curCount <= minOther) return current;
  }

  // Pick the least-crowded lane; tie-break by slot parity, then a draw, both
  // deterministic. Build the candidate set ascending-id before drawing.
  let minCount = Infinity;
  for (const lid of lanes) minCount = Math.min(minCount, allyByLane[lid] ?? 0);
  const tied: string[] = [];
  for (const lid of lanes) if ((allyByLane[lid] ?? 0) === minCount) tied.push(lid);
  if (tied.length === 1) return tied[0]!;
  // Slot parity gives a stable split; the draw only resolves residual ties.
  const parityPick = tied[slot % tied.length]!;
  if (rng.next() < 0.5) return parityPick;
  return tied[rng.int(0, tied.length - 1)]!;
}

/** The chosen lane's x corridor (its spawn x), or the HQ x if the lane is unknown. */
function laneCorridorX(ruleset: Ruleset, laneId: string, fallbackX: number): number {
  for (const lane of ruleset.map.lanes) {
    if (lane.id === laneId) return lane.spawnX;
  }
  return fallbackX;
}

/**
 * Best combat target for an attack-move (respecting team vision like a human):
 * prefer the nearest visible enemy SHIP within an aggression radius, else the
 * nearest visible enemy CREEP, else null (advance to HQ). Candidate lists are
 * built ascending-id; the nearest wins with an ascending-id tie-break.
 */
function pickCombatTarget(
  state: SimState,
  ship: ShipEntity,
  team: TeamId,
): Combatant | null {
  const radius = AGGRO_TARGET_RADIUS;
  let bestShip: Combatant | null = null;
  let bestShipDist = Infinity;
  let bestCreep: Combatant | null = null;
  let bestCreepDist = Infinity;
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (!e || (e.kind !== 'ship' && e.kind !== 'creep')) continue;
    if (e.dead || e.team === null || e.team === team) continue;
    if (!visibleToTeam(e, team)) continue;
    const d = dist(ship.x, ship.y, e.x, e.y);
    if (d > radius) continue;
    if (e.kind === 'ship') {
      if (d < bestShipDist) {
        bestShipDist = d;
        bestShip = e;
      }
    } else if (d < bestCreepDist) {
      bestCreepDist = d;
      bestCreep = e;
    }
  }
  return bestShip ?? bestCreep;
}

/** Engagement radius for explicit targeting (≈ start-ship sight). */
const AGGRO_TARGET_RADIUS = 1100;

/**
 * When engaging a target, aim this many units PAST it toward the enemy HQ. Big
 * enough to keep the attack-move advancing through a brawl (so the bot does not
 * park on a creep), small enough that the target stays in Phoenix-Fire range
 * while the ship closes.
 */
const ENGAGE_PUSH_THROUGH = 400;

/** A team's vision over an entity, the way a human's targeting sees it. */
function visibleToTeam(target: Entity, team: TeamId): boolean {
  return 'vision' in target ? target.vision[team] : true;
}

/**
 * Own-base rally point (far end of the map for the team). South base sits at
 * far -y, north at far +y (map-layout.json). Used for shop ranking and as the
 * retreat fallback when the repair-bay region is missing from the ruleset.
 */
function ownBasePoint(team: TeamId): { x: number; y: number } {
  return team === 'south' ? { x: -896, y: -6912 } : { x: -1152, y: 6400 };
}

/**
 * Centre of this team's repair-bay STATION region (where specials.ts admits a
 * damaged allied ship and full-heals it). The retreat route aims here so the
 * engine actually repairs the bot — sailing to the HQ point instead leaves it
 * relying on the glacial ~0.05 HP/s passive regen. Returns null only if the
 * ruleset has no bay or its region is unresolved (then retreat falls back to
 * the base point).
 */
function repairBayPoint(ruleset: Ruleset, team: TeamId): { x: number; y: number } | null {
  for (const bay of ruleset.map.repairBays) {
    if (bay.team !== team) continue;
    const region = ruleset.map.regions[bay.stationRegion];
    if (!region) return null;
    return { x: region.centerX, y: region.centerY };
  }
  return null;
}

/** Live enemy HQ position (role 'hq', enemy team, alive), ascending-id. */
function enemyHqPoint(state: SimState, foe: TeamId): { x: number; y: number } | null {
  for (const id of sortedNumericKeys(state.entities)) {
    const e = state.entities[id];
    if (e && e.kind === 'structure' && e.role === 'hq' && e.team === foe && !e.dead) {
      return { x: e.x, y: e.y };
    }
  }
  return null;
}

/** Fallback enemy HQ point from the map if no HQ entity is visible/placed. */
function defaultEnemyHqPoint(foe: TeamId): { x: number; y: number } {
  // foe === 'north' -> push to north HQ (+y); foe === 'south' -> south HQ (-y).
  return foe === 'north' ? { x: -1152, y: 6400 } : { x: -896, y: -6912 };
}

/** Point `distAlong` units from (fromX,fromY) toward (towardX,towardY). */
function pointTowards(
  towardX: number,
  towardY: number,
  fromX: number,
  fromY: number,
  distAlong: number,
): { x: number; y: number } {
  const dx = towardX - fromX;
  const dy = towardY - fromY;
  const total = Math.sqrt(dx * dx + dy * dy);
  if (total < 1) return { x: towardX, y: towardY };
  const along = Math.min(distAlong, total);
  const ang = dAtan2(dy, dx);
  return { x: fromX + dCos(ang) * along, y: fromY + dSin(ang) * along };
}

/**
 * Squared no-progress epsilon for THIS ship + think cadence: a fraction of the
 * distance the ship would cover in one think at full speed (floored so a
 * near-stationary ship still trips it). Scaling with cadence/speed is what
 * stops a flat-out ship from self-flagging as stuck every think (the original
 * fixed 64-unit epsilon was below hard's ~42-unit/think travel).
 */
function stuckEpsilonSq(ruleset: Ruleset, ship: ShipEntity, thinkIntervalTicks: number): number {
  const spec = ruleset.ships[ship.typeId];
  const moveSpeed = spec ? spec.moveSpeed : 0; // units/sec
  const expectedTravel = (moveSpeed / ruleset.tickRate) * thinkIntervalTicks;
  const epsilon = Math.max(STUCK_MOVE_EPSILON_MIN, expectedTravel * STUCK_PROGRESS_FRACTION);
  return epsilon * epsilon;
}

/**
 * Stuck detection: compare current ship pos to lastProgress[XY]; bump
 * stuckCount when it has moved less than `epsilonSq` (units^2) since the last
 * check. Always refreshes the progress anchor. Returns true once stuckCount
 * crosses the threshold (and resets it) so the caller takes a one-time detour.
 */
function bumpStuck(state: SimState, memory: AiMemory, ship: ShipEntity, epsilonSq: number): boolean {
  const px = memory.lastProgressX;
  const py = memory.lastProgressY;
  let stuckNow = false;
  if (px !== null && py !== null) {
    const dx = ship.x - px;
    const dy = ship.y - py;
    if (dx * dx + dy * dy < epsilonSq) {
      memory.stuckCount += 1;
      if (memory.stuckCount >= STUCK_THRESHOLD) {
        memory.stuckCount = 0;
        stuckNow = true;
      }
    } else {
      memory.stuckCount = 0;
    }
  }
  memory.lastProgressX = ship.x;
  memory.lastProgressY = ship.y;
  memory.lastProgressTick = state.tick;
  return stuckNow;
}

/** Refresh the progress anchor without evaluating stuck (non-push paths). */
function updateProgress(state: SimState, memory: AiMemory, ship: ShipEntity): void {
  memory.lastProgressX = ship.x;
  memory.lastProgressY = ship.y;
  memory.lastProgressTick = state.tick;
  memory.stuckCount = 0;
}

/**
 * A detoured waypoint: step perpendicular to the heading toward the target so
 * the ship slides around whatever it is wedged on, side chosen by a draw.
 */
function stuckDetour(
  ship: ShipEntity,
  targetX: number,
  targetY: number,
  rng: Rng,
): { x: number; y: number } {
  const ang = dAtan2(targetY - ship.y, targetX - ship.x);
  const side = rng.next() < 0.5 ? 1 : -1;
  const perp = ang + side * HALF_PI;
  return {
    x: ship.x + dCos(perp) * STUCK_DETOUR_UNITS,
    y: ship.y + dSin(perp) * STUCK_DETOUR_UNITS,
  };
}
