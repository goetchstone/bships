# Project status / session handoff

Snapshot for picking the project up in a new session. Durable rules are in
[CLAUDE.md](../CLAUDE.md); owner design decisions in [DESIGN.md](DESIGN.md);
engine semantics in [SEMANTICS.md](SEMANTICS.md); balance audit in
[BALANCE.md](BALANCE.md).

_Last updated: 2026-06-18 (creep waves CLASH mid-lane + AI captains progress)._

## Done this session (creep waves clash mid-lane)

The owner playtest: "the creeps didn't fight each other" — opposing waves marched
PAST one another to the towers instead of brawling where they met. Root cause:
the hold-at-tower gate ordered every creep to attack-move onto the frontmost
enemy STRUCTURE, and movement only halted a creep AT a structure — so mid-lane,
with no structure between them, the two waves slid through each other (trading a
few passing shots) on the way to opposite towers.

Fix (`movement.ts` `enemyUnitInAttackArc`): an attack-moving CREEP now HOLDS while
a living enemy unit sits within its attack range and forward arc (WC3 attack-move
stop-to-engage) — so the waves halt and fight where they meet. Combat auto-fires
from the hold; the arc gate (ahead-only) lets a creep that breaks through keep
pushing, so the front is DYNAMIC: survivors leak on and pressure towers over time
rather than forming a permanent wall. Deterministic (ascending-id scan + dCos/
dSin arc test, no RNG). Probe (real mask, hard AI): the west-lane wave clusters
mid-lane with ~186 creep deaths at the contact line AND ~328 tower hits across
lanes from leakers. Towers still only fall to heroes (creeps just chip).

Tests updated to the new clash-then-leak dynamic (the old "creeps grind the
tower" milestones now come LATER, after the brawl): the open-sea creep unit test
disables one side's spawn buildings so the other wave reaches a tower unopposed
(deterministic, not emergent-leak-timed); the terrain-integration grind-tower
window is 9000 ticks; the two server bot-vs-bot tests assert the CLASH (opposing
creeps in firing contact + churn) rather than the now-slow tower leakage. The
AI-siege resolution test now PASSES again (ships siege; creeps chip on leak).

## Done this session (AI captains progress: abilities + ship types)

## Where it stands

The game **boots and plays solo-vs-AI** end to end: core sim + authoritative
server + PixiJS client + stats board are all functional. Test counts at this
snapshot: **client 398, core 546, server 143, stats 127**; lint clean; full
build green; determinism (AI-only seed-equal replay) intact.

To run: `pnpm install && pnpm dev`, open the client (`:5173`), **Create room →
Play vs AI** for a solo match.

## Done this session (AI captains progress: abilities + ship types)

The owner wanted bots that "evolve" — fight with abilities and **buy new ships,
new abilities**. The combat brain (`ai.ts`, `computeAiCommands`) now:

- **Learns a hero build + casts actives** (§4d): `maybeLearnSkill` spends skill
  points offence-first (`skillLearnPriority`: Captain's Cannon / Fishing Net = 4,
  offensive `special` = 3, hull HP = 2, …) and `maybeCastOffensive` fires a
  learned active at the nearest enemy ship (else nearest enemy tower/HQ within
  `ABILITY_CAST_RADIUS`). Both are additive and draw NO rng, so the brain PRNG
  order — the replay contract — is untouched. (Casting made bots fight longer, so
  the pure-siege resolution test threshold was relaxed 2000→1500 HP; documented.)
- **Buys bigger SHIP TYPES** (§4a): a captain that can bank the next hull tier
  buys the ship before topping up cheap items — a bigger hull is strictly tankier
  than armor on a small one, carries the cannons over (inventory transfers on
  Change_Ship), and **unlocks that hull's own abilities** (then auto-learned/cast
  above). `nextHullUpgrade` picks the tankiest affordable combat hull ≥
  `HULL_UPGRADE_MIN_RATIO`× (1.4×) the current hull's effective HP from the
  team's own-side hull vendor (`nearestHullVendor` — the HQ n000 that sells the
  combat ladder, role `'hq'` not `'shop'`); traders/subs (`NON_COMBAT_HULLS`) are
  never auto-bought and the dedicated `trader` role is untouched (it returns
  before §4a). Shares ONE `economyEfficiency` draw + the same in-range/detour
  machinery as item buys. Probe (hard-vs-hard, all 10 captains): **H000(200hp) →
  H001(750) → H007(2000) → H009(5000)**, each tier bringing new abilities.
  Deterministic (ascending-id scan, fixed `spec.ships` order); the engine
  re-validates range/sold-here/disabled-by-mode, so a borderline pick degrades to
  a harmless rejected buy. Two economy tests updated to the new (better) priority.
- **Skill points TRANSFER on Change Ship** (`economy.ts` `buyShip`): the hero's
  `xp`/`level` were already kept, but `heroSkillLevels` is keyed by abilityId, so
  the points SPENT on the old hull's skills were stranded on abilities the new
  hull can't use — the player (and AI) "lost" them on every ship change. Now a
  rank in a skill the new hull also has is kept; a rank in one it lacks is
  refunded to `unspentSkillPoints` (1 point/rank) to re-spend on the new hull.
  "Level is level"; no points lost. (This also lets the AI actually learn its new
  hull's abilities after an upgrade.)

Still open: the **AI-vs-AI mirror stalemate** ("towers only fall to heroes" needs
full combat AI — combos/ganks/pickoffs to actually kill an equal-tank enemy hero).
Out of scope here; documented. Solo-vs-AI plays well.

## Done this session (reachability + playable HUD + cross-land routing)

Driven by a live owner playtest (verified in-browser via the Claude-in-Chrome
extension, not just probes/tests):

- **Repair stations were UNREACHABLE** — the owner's "could not get to the repair
  station." The terrain classifier left `Repair_Station_South/North` on tiny
  ISOLATED water pockets (5 & 8 cells), disconnected from the main sea; the
  connectivity gate only covered `role=="shop"` structures, never the repair
  REGIONS. Fix: `terrain.py` `carve_connectivity` step (5) + gate G3b connect
  every repair region to the sea (`CONNECT_REGIONS`); regenerated `terrain.json`.
- **"Paint the navigable" (owner's idea)** — `compileMap` now builds a `NavField`
  for **every shop + repair station** (was only trade pickups + Refinery): 32
  fields, up from 10. So a ship ordered to any POI has a real gradient to follow.
- **Dock-approach movement** (`movement.ts` `laneNavGoal`): when the straight line
  to an order crosses land (`segmentCrossesLand`), ride the field to within 1 cell
  (`DOCK_APPROACH_LOCAL_GOAL_CELLS`) instead of beelining into the coast. Result:
  a driven ship reaches **all own-side shops + repair both teams (8/8)**, and the
  AI **trader delivers 10/10** sampled seeds (was 2/10).
- **Cross-land routing for PLAYER ships** (`laneNavGoal`, gated on
  `state.players[owner].control==='user'`): a human right-click whose straight
  line is blocked routes via a flow field computed **to the exact clicked point**
  on demand (`fieldToPoint`, per-mask WeakMap memo — pure, determinism-safe), so a
  click across the central land routes around it instead of wedging ("the ship
  just sits there"). Player cross-land reach 8–9/10; **AI path byte-unchanged**
  (the trader is delicate — three earlier attempts that touched the AI nav
  regressed it; this one does NOT). Remaining misses are extreme south→enemy-far-
  corner cases. The general flow-field WOBBLE-smoothing experiments were REVERTED
  (they regressed the trader); the wobble is cosmetic and the camera shake the
  owner saw was the dev-server restarts, not the sim.
- **Skill spending freed (owner-directed, documented divergence).** The map data
  is `alsk=2` (a rank every 2 hero levels); the owner plays with FREE spending.
  `XpRules.skillLevelGated=false` (Classic) skips the per-rank level gate in
  `applyLearnSkill` + client `canLearnSkill`. Flip to `true` to restore faithful
  WC3 gating. Verified live: clicking a skill ranked it 0→1.
- **HUD fixes** (all verified in-browser): `+` learn badge enlarged + made a
  stable (non-scaling) target, and clicking an unlearned skill's whole SLOT now
  learns it (the tiny badge was hard to hit); **gold-on-kill** floater by the gold
  counter (accumulates bursts) + running "from kills" total; **respawn countdown**
  in the top bar when dead; K/D formatting; **SKILLS strip un-bunched** — moved to
  its own row (`bottom:168px`) clear of the W/E/R/A/S/D item slots it overlapped.

## Done earlier this session (war3mapMisc.txt recovered — major fidelity correction)

## Done this session (war3mapMisc.txt recovered — major fidelity correction)

The owner supplied the `.w3x`; re-extraction is **byte-reproducible** (all 8
object-data JSONs identical). The map's **`war3mapMisc.txt` was in the archive
all along** — the extractor never pulled it, and SEMANTICS.md had guessed every
value it contains. Now extracted to **`data/json/gameplay-constants.json`**
(extract.py `parse_misc`) and wired through the compiler via `readMisc`
(engine-default fallback per key). Corrections (all were wrong before):

- **Hero attributes contribute NOTHING** (StrHitPointBonus/AgiDefenseBase/
  AgiDefenseBonus/StrRegenBonus = 0): maxHp = `uhpm` (no +25), armor = `udef`
  (no −1.7), regen = `uhpr` (no +0.05). Every ship's HP/armor changed.
- **Spells deal ×1.00 vs hero** (DamageBonusSpells override), not the engine
  default ×0.70 — so all item cannons/torpedoes deal FULL damage to hero-armor
  ships. The "70% to small/mid ships" model is gone.
- **Speed clamps 10 / 522** (MinUnitSpeed/MaxUnitSpeed), not the editor 150/400.
  The old 150 floor was artificially speeding up every sub-150 hull.
- **Hero level cap 20** (MaxHeroLevel), not the provisional 12.
- **XP share radius 1500** (HeroExpRange), not 1200.
- SEMANTICS §1/§3/§6 + ruleset.ts header updated; open-question #1 RESOLVED.
- An AI **trader upgrade-abandon** fix (mirror the captain's `shopApproachStuck`
  abandon) so a trader can't wedge forever on an unreachable upgrade shop.

**Ability cast audit (was the flagged "Open / next").** Done: a STATIC check
(`audit-probe.test.ts`) proves no castable special on any hull compiles to a
degenerate (all-zero) effect, and a DYNAMIC end-to-end suite
(`ability-cast.test.ts`, 24 tests) learns + casts **every** active `special` on
**every** player hull through the real specials module, asserting an
`abilityCast` event + an observable state change. All exotic kinds (acidBomb,
freezeWater, sailRipper, boardShip, devour, disrupt, mirrorImage, sendSpy) now
proven to fire.

**Toolchain note:** this environment had no Node/pnpm/Python≥3.10. A local Node
24 LTS is installed under `~/.bships-toolchain` (`source ~/.bships-toolchain/env.sh`
to put it on PATH); the extractor runs via a repo-local `.venv` (gitignored,
`mpyq` + `Pillow`). `package.json` gained `pnpm.onlyBuiltDependencies: [esbuild]`
so `pnpm install` is non-interactive.

## Done in the recent gameplay push

- **Pathfinding** routes ships around landmasses instead of hanging on them
  (`packages/core/src/sim/movement.ts`, NavField/water-mask).
- **AI trader** is seated in solo-vs-AI and runs trade routes / reaches the
  repair-refinery station (`packages/core/src/sim/ai.ts`, `packages/server/src/rooms.ts`).
- **Wave-imitating lane ribbons removed** from the client (`render/fieldoverlay.ts`).
- **Multi-ability HUD cast bar**: each hull shows one quick-key per castable
  ability incl. active `special`s (`hud/hudmath.ts` `shipAbilitySlots`).
- **Shop direction arrow** no longer overlaps an inventory hotkey (`hud/hud.ts`).
- **Ability learn flow fixed (was genuinely broken).** The "+1pt" level-up badge
  only rendered on *castable* slots, so the **passive** hero skills (Enforced/
  Reinforced/Super Hull, Onboard Mechanics Crew, Ship Sails, auras) — most of a
  hull's progression — had no badge anywhere and could never be ranked; hulls
  whose only castable skill was level-gated showed no badges at all ("other ships
  show no skills"). Fix: `shipPassiveLearnableSkills()` + a dedicated **SKILLS**
  strip above the inventory bar (`hud/inventory.ts`, `.bh-skillstrip` in
  `hud/hud.ts`) with the same +1pt badge, so every learnable skill on every hull
  is reachable. Distinct icons for hull/sails/repair/true-sight. A deterministic
  test asserts **0 orphan learnable skills** across all hulls. Verified live in a
  solo match by DOM/state reads: clicking a passive's + ranked it 0→1 and spent
  the point through the full client→server→sim→snapshot round-trip.
- **Distinct ship names.** Hulls compiled to the generic class name (several were
  all "Battle Ship" / "Cruiser"). Added `ShipSpec.properName` from the WC3 Proper
  Name (`upro`) field (`core/src/sim/ruleset.ts` `properShipName`): Sailor,
  Crusader, Interceptor, Sea Punisher, Dominator, Destroyer, Overlord, Juggernaut,
  Battle Royal, The Black Pearl, Elven predator, Ghost armada, Goblin Junker,
  Trader, Leviathian, Submarine. Shown in shop/scoreboard/banner/gallery; the
  renderer still keys the sprite off `.name`.

## Ability/skill model (faithful — don't "simplify")

Ships are hero units. You gain skill points (1 per level, Dota-style) and choose
what to rank. Bigger ships have more skills. Both **passive** skills (hull HP,
sail speed, mechanics/repair regen, auras — ranked in the SKILLS strip) and
**active** skills (Captain's Cannon, Fishing Net, Capsize, Hide, Dive, EMP, …
cast from the quick-key bar) are leveled with points. Innate abilities (Shore
Leave, True Sight) have no skill rule and are always available.

## Open / next

- **Phase 2 — engine kill-XP magnitude overrides.** war3mapMisc.txt (captured in
  gameplay-constants.json) overrides the ENGINE kill-XP magnitudes: GrantNormalXP=15
  (×0.15 of the 25/40/60… table), GrantHeroXP=50..240 (victim-level lookup),
  HeroFactorXP=80,70,…,10 (per-killer-level % scaling — a NEW mechanic, likely
  clamp-to-last = 10% for killer level ≥8), BuildingKillsGiveExp=1. **Confirmed from
  war3map.j that kill XP is engine-driven** (no AddHeroXP kill trigger; AddHeroXPSwapped
  is only quest/contract rewards). NOT yet wired — the exact WC3 formula is
  medium-confidence; verify against a primary source before changing leveling pace.
  `compileXpRules(misc)` already threads the data. (Leaving it at engine-default
  magnitudes was a deliberate "don't ship a half-verified balance number" call.)
- **Movement wobble / extreme cross-map player routing (cosmetic + edge).** Normal
  lane play is smooth (owner-confirmed live) and the AI trader now delivers 10/10
  (the old wedge is fixed — reachability + dock-approach + per-POI fields). REMAINS:
  (a) a faint flow-field heading wobble on long hauls (cell-granular following; the
  smoothing experiments were reverted because they regressed the trader — needs a
  trader-safe lookahead/string-pulling pass); (b) 1–2 EXTREME player targets
  (south ship → enemy-far-corner) still wedge ~2/10. Both are edge/cosmetic, not the
  "can't reach my shops/repair" blocker (that's fixed).
- **Minimap right-click doesn't issue a move order** (only left-click pans). Minor
  QoL gap noticed in the live playtest; the canvas right-click works fine.
- **Per-player gold/K-D breakdown.** Owner asked to see gold earned-from-kills /
  given-on-deaths and "each player, not just the team." Own running total is in the
  gold tooltip; a full per-player scoreboard breakdown needs a small server-side
  tally — confirm the exact ask first.
- **Phase 2 — engine kill-XP magnitude overrides** (see above; data captured, not
  wired — verify the WC3 formula against a primary source first).
- **In-game crash (task #15) — still unreproduced.** Likely client-side render/HUD.
  Capture *what action* triggered it (buy/cast/shop/level-up/death) to narrow it.
- **Map fidelity (task #14) — PARTIAL.** The owner noted "the map is not 100%
  correct"; wants to keep testing before a fidelity pass. Connectivity is now solid
  (all shops + repair + bases sea-connected, gated). Topology polish (lanes, islands,
  entrances) still owner-described and pending.

DONE this session: war3mapMisc constant recovery + ability cast-system audit (above),
the reachability/HUD/cross-land-routing work (top section), and the AI-trader-wedge
task — the terrain-integration trader test now runs on the natural seed 0x7ade (10/10
sampled seeds), un-pinned from the old fragile 0x3.

## Verifying UX reliably (lesson learned)

Screenshots/subagent "tests green" have missed real breakage. For HUD/ability
work: prove logic with deterministic tests, and confirm UI by reading **DOM +
store state** (e.g. `store.match.you.heroSkillLevels`, the `.bh-skillstrip`
chips) in a real browser — or have the owner confirm — before calling it done.
