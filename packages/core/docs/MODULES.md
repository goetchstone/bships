# Simulation core — module contracts

Scaffold for parallel implementation of the BattleShips Pro v1.187 sim
(`packages/core/src/sim/`). One implementer per module; nobody edits another
module's files. `types.ts` is frozen API — changes to it require architect
sign-off and a note here.

Binding background reading: `docs/SEMANTICS.md` (engine behaviors + accepted
divergences), `docs/BALANCE.md` §1–2/§6–8, `data/json/script-rules.json`.

## Hard rules (all modules)

- Deterministic: randomness only via `rollInt`/`rollFloat` (types.ts);
  trig only via `dSin`/`dCos`/`dAtan2`; `Math.sqrt/abs/floor/min/max` fine.
  No `Date`, no locale formatting, no `Math.random/sin/cos/atan2`.
- Iteration in ascending numeric id order (`sortedNumericKeys`); random-pick
  candidate lists built in ascending entity-id order before drawing.
- All balance numbers come from the `Ruleset` parameter. Zero hardcoded
  gameplay numbers in system modules.
- State mutations are plain field writes on POJOs. No classes in state.
- Durations are integer ticks; convert at ruleset-compile time only.

## Tick order (canonical, documented in sim.ts)

```
applyCommands (server-ordered array, routed per command type)
1. creeps.stepCreeps          orders written
2. movement.stepMovement      positions/facings updated
3. specials.stepSpecials      region triggers, quests, missiles, dive, bays;
                              recomputeVisibility LAST in this phase
4. combat.stepCombat          weapons fire (fresh vision), projectiles,
                              regen/DoT, deaths flagged -> pendingDeaths
5. economy.stepEconomy        income, restocks, contracts, gold dump
6. progression.stepProgression consumes pendingDeaths, respawns, research
7. sim finalize               win check, delete dead entities, clear
                              pendingDeaths, tick++, drain events
```

## Cross-module conventions

- **Damage/heal**: `combat.applyDamage` / `combat.applyHeal` are the ONLY hp
  mutation points. Specials uses `applyDamage` with `damageType: 'true'` for
  suicide bombs; economy uses `applyHeal` for repair woods.
- **Deaths**: combat (and specials, for scripted kills) set
  `entity.dead = true` once and push a `PendingDeath`. Progression consumes
  them (XP/bounty/respawn); sim finalize deletes the entities. Nobody else
  deletes combatants.
- **Invisibility break**: combat (attack/cast) and economy (item use) call
  `specials.breakInvisibilityOnAction`. Move/stop never break invis.
- **Visibility**: specials writes `entity.vision` each tick; combat and
  movement (attackTarget validation) only read it.
- **XP**: `progression.grantXp` is the only XP entry point (kills, tomes,
  quests, contracts).
- **Gold/lumber**: plain `PlayerState` field writes, allowed from economy
  (purchases/income/refunds), progression (bounty), specials (quest
  payouts). Always emit the matching event.
- **Inventory**: owned by economy. Specials' missile launch consumes the
  warhead + I01N items (documented exception); combat only touches
  `ItemInstance.readyAtTick` on weapon fire.
- **maxHp recompute**: economy owns the ship maxHp/regen recompute on
  inventory change; progression reuses the same path for passive hero
  skills (coordinate the helper's home in economy.ts — progression may call
  an exported function from economy).
- **Ids**: `allocEntityId(state)` for every entity/projectile/ground item —
  one shared monotonically increasing counter; ids are never reused.
- **Events**: push onto `state.events`; include `tick`. `stepTick` drains
  the buffer. Events are derived output — never read them to drive logic.
- **RNG draw order is part of the replay contract**: draw only when the
  verbatim mechanic rolls (bounty dice, PF target picks, native attack dice,
  respawn jitter, missile targeting, init-time period rolls), in the
  documented system order. Adding/removing a draw is a replay-breaking
  change — note it in your module doc.

---

## Module: ruleset

- **Owns**: `src/sim/ruleset.ts`, `test/ruleset.test.ts`
- **Exports**: `compileClassicRuleset(raw: RawDataFiles): Ruleset`,
  `applyRulesetPatch(base, patch): Ruleset`, `validateRuleset(rs): string[]`
- Compiles `data/json/*` into the `Ruleset` shape in types.ts. Pure, IO-free
  (caller parses JSON). Classic = data verbatim including preserved bugs
  (zero-bounty creep twins, north-HQ income gate, missile lead-player
  targeting, R005 +8 dice anomaly, Buggfix south-only).
- Bakes WC3 base defaults from BALANCE.md §9.3 (Apxf cool 0.5/speed 900/
  area 600, AHtb speed 1000, Asdg DataE=1, AId3 +3, Arel 2 HP/s, Endurance
  10%) and the TFT attack-vs-defense table. Provisional values (lane/tower
  attack types, heroLevelCap 12) must be marked, not guessed silently.
- Compiles the static land/water mask: `compileWaterMask` decodes
  `data/json/terrain.json` (optional `RawDataFiles.terrain`) into
  `Ruleset.map.waterMask`. Query with `isWater(mask, x, y)`. See
  `docs/TERRAIN.md` — the contract for the pathing/creep-ai/land-render/
  shop-access map-fidelity work.

## Module: movement

- **Owns**: `src/sim/movement.ts`, `test/movement.test.ts`
- **Exports**: `applyMovementCommand`, `stepMovement`, `effectiveMoveSpeed`
- Owns `entity.order`, `x/y/facingRad`. Kinematics per SEMANTICS §3: turn
  cap `constants.turnRateCapRadPerTick`, move along current facing when
  heading error <= 90°, speed = base × (1 + Σ sail/aura/status pcts) clamped
  to [min,max]; circle pushout ascending-id; bounds clamp + land collision via
  `isWater(ruleset.map.waterMask, x, y)` (block/slide along the coast so lanes
  funnel through tower gaps) — see docs/TERRAIN.md (pathing).
- Skips dead/paused/stunned/casting units. Never touches hp/gold/statuses.

## Module: combat

- **Owns**: `src/sim/combat.ts`, `test/combat.test.ts`
- **Exports**: `applyCombatCommand`, `castStormBolt`, `stepCombat`,
  `applyDamage`, `applyHeal`
- Phoenix Fire per-instance cooldowns on `ItemInstance.readyAtTick`, uniform
  random target among valid candidates (filter + range + vision + lacks
  weapon buff), empty list keeps it ready. Storm Bolt cannot miss; fizzles
  on target death. Native attacks roll dice at launch (+team upgrade dice).
  All projectile flight/impact, incl. kaboom missile dummies from specials
  (no type-mult, armor value applies, aoe splashes structures only).
- Damage pipeline per `DamageInstance` doc (true / magic / physical), hull
  AIsr post-multiplier on magic only, friendly fire dropped, PF DoT clamps
  at 1 HP. Regen/DoT/HoT single pass per tick. Edge rules: stun neutralized
  on torpedoes (cosmetic 1-tick buff), Goblin Bomber's Bstt arming is in
  specials — combat only delivers the A055 buff application.

## Module: economy

- **Owns**: `src/sim/economy.ts`, `test/economy.test.ts`
- **Exports**: `applyEconomyCommand`, `stepEconomy`, `enforceItemRules`
- Shops (interact radius, side gating, stock/restock, lumber gating), no
  sell-back in Classic; inventory + ground items; stack/class rules from
  script-rules §2 with FULL-price refunds; useItem routing (stormBolt ->
  combat.castStormBolt, utility -> specials helpers, heal ->
  combat.applyHeal, tomes -> progression.grantXp); income/empire share/gold
  dump/street merchant; contracts + trade routes + Captain Reward.
  Quest systems (`questSystems`): the Refinery value-upgrade chain (refine
  swap + 1.5x cash-in), the Repair Buildings Mission (token grant in
  `stepQuestSystems` + USE-ITEM reward in `useItem`), and the Treasure Hunt
  (per-team active-location index in `SimState.treasureByTeam`, seeded +
  rerolled from the match Rng — the treasure draw order is the replay
  contract: seed south-then-north at the seed tick, reroll inline in the
  ascending-slot scan, `stepQuestSystems` runs right after `stepContracts`).
  The Treasure also has a refined branch: refine the Treasure into the Golden
  Statue (`I02G`->`I030`) at the Refinery with the Book of Formulas, then cash
  it for the 1.5x reward (21000g vs 14000g) at the own reward rect.
  Owns ship maxHp/regen recompute on equipment change.

## Module: creeps

- **Owns**: `src/sim/creeps.ts`, `test/creeps.test.ts`
- **Exports**: `stepCreeps`, `spawnWave`
- Wave timers (700/1600/3800 ticks; first at tick 0 + preSpawnDelay), spawn
  gated on own harbor alive, bounty-vs-zero-bounty type by enemy harbor
  liveness, verbatim re-order quirk (all units in spawn rect), waypoint AI
  with region-triggered HQ re-order. Applies R003/R004 to spawned stats.
- Lane creeps hold at the frontmost LIVING enemy structure (tower, then HQ) in
  their lane and resume to the next once it dies — see docs/TERRAIN.md
  (creep-ai). Players unaffected; no new RNG draws.

## Module: specials

- **Owns**: `src/sim/specials.ts`, `test/specials.test.ts`
- **Exports**: `applySpecialsCommand`, `stepSpecials`,
  `recomputeVisibility`, `breakInvisibilityOnAction`
- Visibility/detection (detectors, flare zones, ghost suppression), smoke
  lifecycle, missile system (item consumption, throttle, random enemy
  LEAD-player structure, spawns projectile), suicide quests (token stages,
  true-damage detonation via combat.applyDamage, scripted death, payouts),
  dive type-swap with HP-fraction carryover (flagged open), sub base
  teleports, repair bays (pause/invuln/heal/eject), wards/zones/summons
  expiry, motion-detector warnings, goblin-mine arm + 5 s kill, exotic
  ability stubs that reject as 'unimplemented'.

## Module: progression

- **Owns**: `src/sim/progression.ts`, `test/progression.test.ts`
- **Exports**: `applyProgressionCommand`, `stepProgression`, `grantXp`
- Consumes pendingDeaths: XP share (1200 radius, even split, remainder to
  lowest id, global fallback), bounty dice per-die rolls, respawn scheduling
  (2·level+5+rand(0,3) s, invuln 5 s) and respawn execution; level curve +
  cap + skill points; learnSkill gating (alsk/arlv); research queue and
  completion (TeamState.upgrades is team-shared by construction).
  Structures pay bounty but no kill XP; scripted deaths pay nothing here.

---

## Integrator (not a parallel module)

Owns `src/sim/sim.ts` bodies, `src/index.ts` exports, `test/sim.test.ts`
determinism harness (replay bit-identity via `hashState`, golden seeds).
Win condition: any HQ (`role 'hq'`) death ends the match.

## Known open questions (do not resolve unilaterally)

From SEMANTICS.md / BALANCE.md §9.4: hero level cap & gameplay constants
(misc.txt), missile 2× explode-on-death damage (`constants.
missileExplodeOnDeathDoubling` stays false in Classic), PF buff gate / DoT
clamp verification, lane/tower SLK attack data, dive HP carryover, water
mask extraction, n00P Upgrade Center placement (absent from
map-layout.json structures — progression/ruleset must locate or flag it).
