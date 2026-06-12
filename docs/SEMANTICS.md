# WC3 Engine Semantics — BattleShips Pro v1.187 recreation

Pins the Warcraft III (1.24-era) engine behaviors the deterministic sim must reproduce.
Format per topic: **RULE** (what WC3 does) / **SOURCE** / **CONFIDENCE** / **SIM DECISION**
(what `packages/core` implements, including deliberate divergences).

Conventions used throughout:

- Time: 1 tick = 0.05 s (`TICK_RATE = 20`). Data durations/cooldowns in seconds compile to
  `max(1, round(seconds * 20))` ticks at Ruleset-compile time.
  **Accepted quantization divergence:** two weapon cooldowns do not land on a tick
  multiple — Machinegun Cannon I00H 0.12 s rounds to 2 ticks (0.10 s, **+20% DPS**:
  80 vs the data's 66.67) and Multi-Rocket Cannon I00G 0.33 s rounds to 7 ticks
  (0.35 s, **−5.7% DPS**: 31.43 vs 33.33). All other 34 weapon cooldowns are exact
  tick multiples. Pinned by tests (`ruleset.test.ts`); revisit only if fractional
  fire-timers are ever adopted.
- Distance: WC3 map units, unchanged. Speeds compile to units/tick (`umvs / 20`).
- Randomness: every die roll / random pick draws from the match `Rng` (mulberry32), with
  candidate sets iterated in ascending entity-id order so draws are replay-stable.
- "Object data" = `data/json/*.json`; "script" = `data/extracted/war3map.j`.

---

## 1. Armor & damage pipeline

**RULE.** Every damage instance has an *attack type* and a *damage type*, applied as:
`final = base × typeMult(attackType, defenseType) × armorFactor × itemReductions`.

- Armor-value factor applies **only to physical damage** (`DAMAGE_TYPE_NORMAL`):
  `reduction = (armor × 0.06) / (1 + armor × 0.06)`; for negative armor the multiplier is
  `2 − 0.94^(−armor)` (amplification). Magic/spell damage **ignores armor value entirely**.
- All standard WC3 abilities deal `ATTACK_TYPE_SPELLS` + `DAMAGE_TYPE_MAGIC` — this covers
  every BSP item cannon (Phoenix Fire `Apxf`) and torpedo/Captain's Cannon (Storm Bolt
  `AHtb`). Spells attack type: **×0.70 vs Hero defense type, ×1.00 vs everything else**
  (Divine n/a in BSP). Blocked by spell immunity (no spell-immune units in BSP).
- **Kaboom (`Asds`/`Asdg`, the missile warheads) is the exception:** physical damage —
  reduced by the target's armor *value*, with **no** attack-type/defense-type multiplier.
  Building damage factor `DataE = 1` (not overridden), so structures take listed damage
  before armor.
- `AIsr` (Runed-Bracers-type "damage reduction" on hulls, `isr2` = 0.10/0.20/0.30) reduces
  spell damage multiplicatively **after** the type multiplier. Since BSP's weapons are all
  spell damage, hull reduction is the real "armor" of this game. Hulls/Kraken are
  trigger-exclusive, so reductions never stack.
- Hero ships' *effective* armor value = `udef − 2 + 0.3 × agility` (gameplay-constant hero
  agility armor: +0.30/point with a −2 base). Every BSP ship has Agi 1 ⇒ **effective armor
  = udef − 1.7** (e.g. starter H000: −1.7 → physical damage amplified ~10%). This only
  matters vs physical sources (lane ships, towers, native attacks, Kaboom).
- Defense types in BSP (`udty`): `fort` overridden on H00V, H00W, H00L, H00K, H00X, H00A,
  H00C; all other player ships keep the `Hpal` default **hero**. Consequence: item cannons
  and torpedoes deal **70%** to the small/mid ships and trade boats (hero armor) and
  **100%** to subs, flagships, Leviathan, Royal, Pirate (fort).
- TFT physical rows that matter (attack → hero / fortified / heavy / unarmored):
  normal 100/70/100/100 · pierce 50/35/100/150 · siege 50/150/100/150.
  The lane ships (`hdes` Frigate base) and tower/HQ (`nmer` Mercenary Camp base with
  map-enabled attacks, weapon class `artillery`/`missile`) take their **attack type and
  default defense type/armor from base-unit SLK data the map does not override** — these
  must be extracted from 1.24 SLKs, not guessed.

**SOURCE.** Formula & physical-only scope: liquipedia.net/warcraft/Armor,
liquipedia.net/warcraft/Damage_Calculation. Spells row: liquipedia.net/warcraft/Armor_and_Attack_types.
Ability attack/damage types: hiveworkshop.com threads 316271 ("Spell/Ability Damage Types"),
279673 ("WC3's Damage System"). Kaboom physical/armor-value behavior:
liquipedia.net/warcraft/Goblin_Sapper. Hero attribute constants (25 HP/Str, 0.3 armor/Agi):
wowpedia "Hero (Warcraft III)". `udty`/`udef`/attribute fields: `units.json`. AIsr-applies-to-cannons:
`equipment.json` audit + Battle Ships community lore.

**CONFIDENCE.** Formula, Spells×0.70-vs-hero, magic-ignores-armor-value: **high**.
Kaboom physical: **medium-high**. Agility −2 base offset: **medium** (standard constant,
verify the map didn't ship a `war3mapMisc.txt`). nmer/hdes attack-type defaults: **low**
until SLK extraction.

**SIM DECISION.** Implement the full pipeline: attackType × defenseType table (TFT
defaults baked into the Ruleset, overridable), armor-value factor gated on damage type
`physical`, AIsr as a post-multiplier. Tag Phoenix-Fire and Storm-Bolt weapons
`spells/magic`; Kaboom warheads `physical (no type mult)`; unit attacks `physical` with
their data attack type. Compute hero HP/armor as `uhpm + 25·str` and `udef − 2 + 0.3·agi`
in the Ruleset compiler (Classic keeps the engine math, so ships.json's `hp`/`armor`
columns are raw fields, not effective values — document this in the ruleset). Extract
`hdes`/`nmer`/`hpea` SLK defaults (attack type, defense type, armor, cooldown) into
`data/json` as a follow-up task; until then mark lane/tower attack types `pierce`/`siege`
provisional. The missile 2× question (BALANCE.md §9.4) stays open: Classic ships `Dda2`
values with a ruleset flag `missileExplodeOnDeathDoubling: false`.

---

## 2. Phoenix Fire (`Apxf`) — all standard cannons

**RULE.** Phoenix Fire is a *passive, autonomous* extra attack, fully independent of the
unit's orders and native attack:

- Each carried PF item grants an independent ability instance with **its own cooldown**;
  a ship with 5 cannons runs 5 independent timers, all firing simultaneously.
- Fires while moving, attacking, casting; needs no order and accepts none — you cannot
  focus-fire it and it does **not** prefer the unit's current attack target.
- Target acquisition: whenever the instance's cooldown is ready it picks a **uniformly
  random** unit among valid targets — passes `atar` filter, inside `aare` (the
  "range" column in weapons.json), **visible to the owner** (invisible/fogged units are
  excluded), and **not currently carrying this ability's buff**.
- The buff gate matters when buff duration > cooldown: Acid Bomber (BNab, 20 s) cannot
  re-hit the same ship until its acid buff expires — it sprays across the fleet; Nuclear
  Strike (B016, 4 s < 5 s CD) is barely gated; all other BSP weapons use 0.01 s buffs
  (ungated).
- Projectile: speed `amsp`, homing per `amho`. Homing missiles always connect; non-homing
  missiles fly to the target's position at launch and **whiff if the target has moved
  off that point** by impact.
- DoT (`pxf2` dmg/s for `adur`/`ahdu` via buff — Acid 20×20 s, Nuke fallout 100×4 s):
  re-application refreshes (never stacks), and the buff DoT is **non-lethal — it cannot
  reduce a unit below 1 HP** (slow-poison-style clamp). Direct hit damage kills normally.
- Effective fire-rate floor: the engine evaluates PF on its internal update; cooldowns at
  or below update granularity (Vulcan/Laser 0.05 s) realize ~1 shot per engine step.

**SOURCE.** Multishot/independence & random pick of unbuffed target: hiveworkshop.com
threads 157803 ("Barrage and Phoenix Fire"), 289725, 155264; thehelper.net 55869 +
hiveworkshop 149947 (PF DoT cannot kill). Buff/duration retarget gate: hive 157803.
Non-homing whiff: WE field "Missile Homing Enabled" semantics + BALANCE.md §7.2.
Stats: `weapons.json` (objectdata).

**CONFIDENCE.** Passive auto-fire, independence, fires-while-moving, invisibility
exclusion: **high**. Uniform-random target (vs nearest): **medium-high**. Buff retarget
gate & DoT 1-HP clamp: **medium** — flag for in-engine spot-check (changes Acid Bomber's
real value). Sub-tick fire rate: **low**, but sim tick = 0.05 s makes it moot.

**SIM DECISION.** Each weapon instance stores `readyAtTick`. On its tick: build candidate
list (atar filter + within `aare` of ship center + visible-to-owner + lacks weapon's
buff), iterate entities ascending id, pick uniformly with the match Rng; if empty, stay
ready and re-check next tick (cooldown not consumed). Spawn projectile: homing →
follows target, guaranteed hit on arrival (dist/speed ticks); non-homing → travels to
launch-time target point, hits the *intended target only* if its collision circle covers
the impact point at arrival. DoT: per-tick accrual (`pxf2/20` per tick), refresh on
re-hit, clamped so buff damage never takes HP below 1. **Divergences (accepted):** WC3's
internal RNG sequence and scan timing differ (distribution-equivalent); non-homing whiff
in WC3 may use the engine's projectile-vs-unit collision rather than launch-point check —
revisit after feel-testing. The ships' vestigial *native* attack (Hpal attack enabled,
~3 dmg `msplash`, range 1000) exists in data; implement it (it drives right-click attack
orders and the friendly-fire stop trigger) but expect it to be combat-irrelevant.
*Status:* the acquisition range (ua1r 1000) is compiled — attackTarget chases stop at
range instead of ramming — but the attack's DAMAGE is not: units.json carries no `ua1b`
override and the Hpal base value awaits the 1.24 SLK extraction (PROVISIONAL list,
`ruleset.ts` header). Ships currently deal no native-attack damage.

---

## 3. Movement, turning, collision

**RULE.**

- `umvs` is **map units per second** (ships 100–280). Speed modifiers: Endurance-aura
  style bonuses (`Oae1`, sails/ship-sails skill) are % of base speed, additive with each
  other before clamping. Engine clamps: gameplay-constant min/max default **150 / 400**
  (hard engine cap 522). BSP ships no `war3mapMisc.txt` was found in the extraction, so
  defaults presumably apply — meaning Silk Sail/Propeller stacks **cap at 400**, and slow
  effects floor at 150.
- Turn rate `umvr` is **radians per 0.03 s engine frame**; effective rotation is capped at
  ~0.20 rad/frame (≈382°/s). All BSP ships have `umvr` ≥ 0.25, i.e. **every ship turns at
  the engine cap** — the per-ship differences (1.0 starter vs 0.25 cruiser) only affect
  rotation acceleration via orientation interpolation, which no BSP ship overrides.
- Units do not decelerate while turning; for near-reversals they pivot before moving off.
- Collision: circle of radius `ucol` (ships 5–17.5, lane ships 5–30) against the pathing
  grid; `umvt = float` restricts ships to water-pathable cells. Units push around, not
  through, each other.

**SOURCE.** Turn rate radians/frame + 0.20 cap: hiveworkshop.com thread 300224 ("Unit
turning mechanics"). Speed cap 400 default / 522 hard: hiveworkshop 324497,
thehelper.net 110865, liquipedia Movement_Speed. Fields: `units.json` (`umvs`, `umvr`,
`ucol`, `umvt`). Pathing: `war3map.wpm`/`war3map.w3e` (extracted).

**CONFIDENCE.** Speed units & 522 hard cap: **high**. 400 soft cap applying to BSP:
**medium** (hinges on absent gameplay constants — verify the original MPQ really has no
`war3mapMisc.txt`). Turn-rate semantics: **medium-high**; "all ships at cap": **medium**.
Min-speed 150: **medium**.

**SIM DECISION.** Point-mass kinematics: position + heading per ship. Desired heading =
direction to current path waypoint; rotate by `min(umvr, 0.20) × (0.05/0.03)` rad/tick
(≈0.333 rad/tick for every ship); move `effSpeed/20` units along *current* heading each
tick when |heading error| ≤ 90°, else rotate in place. Speed = `umvs × (1 + Σ aura%)
× (1 + Σ item%)`, clamped to `[150, 400]` (Ruleset constants `minSpeed`/`maxSpeed` —
overridable if the misc.txt turns up). Collision: circle-vs-circle pushout (equal split,
deterministic entity-id processing order) + circle-vs-water-mask clamp from the extracted
pathing map. **Divergences (accepted):** no WC3 A*/grid pathing — open water makes
straight-line + pushout adequate; document that bridges/land funnels rely on the water
mask only. The 90° move-while-turning threshold is a feel approximation of WC3's pivot
behavior, tune in playtest.

---

## 4. Storm Bolt (`AHtb`) — torpedoes & Captain's Cannon

**RULE.** Unit-targeted active: requires a **visible, valid target** at cast (atar
`enemies,ground`; magic-immune untargetable). On cast, a homing projectile (speed 1000
default; 750 for Underwater Launch I026) tracks the target; it **cannot miss or be
dodged** — blink/run/invisibility after launch do not evade it. On impact: damage
(`Htb1`, spell pipeline §1 ⇒ ×0.70 vs hero-armor ships) + stun buff for `adur`/`ahdu`.
If the target dies mid-flight the projectile fizzles (no impact, no transfer). BSP
neutralizes every stun to 0.01 s and swaps the pause buff for cosmetic `B01D`/`BOac` —
so impacts are damage-only in practice. Casting breaks the caster's invisibility (§9).
Captain's Cannon (A01Y): 6 hero-skill levels 40/72/104/136/168/200, CD 25 s, range 900,
0 mana. Torpedo bays I02N/I02O/I026/I02P: 500/1000/3000/2500 dmg, CD 22.5/45/45/45, cast
time 3.5 s on I026 only.

**SOURCE.** Cannot-miss homing: hiveworkshop 178285 + thehelper projectile threads.
Spell typing: hive 316271. Stats: `abilities.json` (A01Y/A04X/A04Z), `weapons.json`.

**CONFIDENCE.** High (well-trodden ability), mid-flight edge cases **medium**.

**SIM DECISION.** Cast validation at order execution (range `aran`, visibility,
targetability); then a target-locked projectile entity that re-homes to the target's
position every tick and impacts when within `speed/20` of it. Impact applies damage via
the spell pipeline + applies the (cosmetic, 1-tick) buff. Target death in flight ⇒ remove
projectile. Target becoming invisible in flight ⇒ **still hits** (lock persists). Dive
(unit swap, §5) mid-flight: the sim keeps entity identity across morph, so the bolt
follows and hits the submerged form — matches WC3 morph identity; flag for verification.

---

## 5. Submarines, submerge, detection

**RULE.**

- **Dive Dive! (A04C, `AEme` Metamorphosis):** swaps unit type H00V (2000 HP, armor 5,
  speed 200, torpedo hero-skills) ⇄ H00W (1000 HP, armor 0, speed 100, no hero abilities),
  permanent until reversed, 5 s cooldown, 0 mana. H00W carries **`Agho` Ghost = permanent
  invisibility** (also sold standalone for 8500 g).
- WC3 invisibility (incl. Ghost): the unit cannot be **targeted** (orders, unit-target
  spells) or **auto-acquired** (Phoenix Fire ignores it) by enemies without detection;
  point/area effects at its location still hit. Ghost differs from timed invisibility in
  that it is *suppressed during* an attack/cast and resumes automatically afterward
  instead of being dispelled.
- Sub weapon economy is script-enforced (`script-rules.json`): torpedo items are
  submarine-only, max 1 carried torpedo bay across I02N/I02O/I02P/I026 (the two built-in
  H00V torpedo skills A04X/A04Z are separate); subs may carry only repair woods
  I00C/I00D/I00E/I01H + repair/Kraken items; violations auto-refund at full price.
- **Detectors counter all of it.** True sight reveals invisible units to the detector's
  whole team within radius: H001's `Adtg` (1200, passive), Spies ward `Atru` (sight 1600),
  Sentry Wards, Goblin Scout Crew I00F (`gemt` Gem of True Seeing — true sight in the
  carrier's line of sight, stock radius ~900), Echo-Location/Detector Flare (`AIfa`, area
  1500, 30/20 s, CD 120 — flares reveal the area **and** detect invisible in it), Flare Gun
  items (1200, 15 s). Motion Detectors (`whwd`/ohwd ward) are **not** detectors: sight 1,
  invisible+invulnerable, trigger-driven proximity *warning only*.
- A detected invisible unit is targetable/acquirable by the detecting team like a visible
  unit (it keeps no defensive benefit beyond the visual).

**SOURCE.** `abilities.json` A04C/A04D/A02X/Adtg, `units.json` H00V/H00W/ohwd/nvil,
`script-rules.json`, `equipment.json`. Invisibility/detection rules:
classic.battle.net/war3/basics/invisibility.shtml, liquipedia.net/warcraft/Invisibility.
Ghost behavior: hiveworkshop 230086 / thehelper 115667. Flare detects invisible:
wowpedia Flare Gun (Warcraft III).

**CONFIDENCE.** Dive = type swap, stats, whitelists: **high** (object data + script).
Ghost suppressed-while-acting: **medium**. gemt 900 radius: **medium**. Flare detection:
**medium-high**.

**SIM DECISION.** `visibleTo(team)` computed per tick: invisible flag (timed buff or
ghost) defeated by any team detector whose true-sight radius covers the unit (detector
sources: Adtg/Atru/gemt radii; AIfa flares create timed detection *zones*). PF target
scans and unit-target casts require `visibleTo(owner.team)`. Dive: same entity id, swap
the unit-type stat block, preserve HP **fraction** across differing max HP (flagged —
WC3 morph HP carryover needs verification), keep inventory. Ghost: while the sub executes
a cast (torpedo item), it is visible from cast start until the action completes (1 tick
for instant casts; 70 ticks for I026's 3.5 s cast), then instantly invisible again — no
fade timers. Motion Detector: pure trigger entity emitting an owner-only warning event
when an enemy enters its (script-defined) radius; grants no vision. **Divergence:** WC3
fade/transition times (~0.6 s) are collapsed to instant at tick boundaries.

---

## 6. Hero XP & levels (captains)

**RULE.**

- Cumulative XP to reach level *n*: `50·(n² + n − 2)` → 200 / 500 / 900 / 1400 / 2000 /
  2700 / 3500 / 4400 / 5400 …
- Kill XP from a normal unit of level L: 25, 40, 60, 85, 115, 150 … (`xp(L) = xp(L−1) +
  5L + 5`). Hero kills: 100/120/160/220/300, +100 per victim level above 5. Summons 50%.
  Structures grant **no** kill XP (bounty only). The "creeps stop giving XP at hero 5"
  melee rule is irrelevant here: the Imperial lane ships are owned by the team lead
  *players* (P0/P1), not neutral hostile, so they pay full XP at any level.
- Distribution: heroes of the killing side within **1200** of the dying unit split the XP
  evenly; if none is in range the killing player's heroes receive it anyway (global
  fallback).
- Lane-ship levels (`ulev`): h00I = 2 (25 XP? no — level 2 ⇒ 40), h00B default, h00H = 6
  (⇒ 150 XP); mirror-side h00E/h00F/h00G are `ulev` 1/1/1 — XP values come straight from
  `units.json` levels at compile time.
- BSP layers trigger XP on top: contracts 80/125/300/450/850, Captain Reward 80, suicide
  runs 1200, superbomb 1200, others up to 2500 (`AddHeroXPSwapped` calls); Tomes +200
  (texp, 2×AIem) and +500 (tgxp).
- Hero skills consume 1 skill point/level; BSP skills have `alsk = 2` (a new skill rank
  every 2 hero levels): Captain's Cannon & Hide & hulls/sails/mechanics are 6-rank →
  maxing needs **hero level 11**; "Basic Cannons" (A000 doubling as a 4-rank hero skill)
  needs level 7; Goblin Bomber unlocks at hero level 8 (`arlv = 8`). Therefore the map's
  hero level cap was raised above the melee default 10 — the gameplay-constants file with
  the exact cap and any XP-table overrides **was not extracted**.
- Attributes: every ship is Str/Agi/Int 1 with 0 growth ⇒ flat +25 max HP, −1.7 net armor
  (§1), +15 mana (unused; all costs 0), +0.05 HP/s regen, +1 native-attack damage.
  Attributes never change, so they're compile-time constants per ship.
- Death timer (scripted, not engine): respawn delay = `2 × heroLevel + 5 + random(0,3)`
  seconds (war3map.j:1836).

**SOURCE.** XP tables/formulas: liquipedia.net/warcraft/Experience, thehelper gameplay-
constants tutorial 68382; 1200 share radius: warcraft3.info article 232. Skill fields
`alsk`/`arlv`/`alev`: `abilities.json`. Trigger XP & death timer: `war3map.j`.
Attributes: wowpedia Hero (Warcraft III).

**CONFIDENCE.** Curves/tables: **high** (assuming default constants — same misc.txt
caveat). Share radius & global fallback: **medium**. Level cap: **unknown value**,
≥ 11 certain.

**SIM DECISION.** Ruleset carries `xpToLevel[]` (default-formula table), `killXpByLevel[]`,
`heroKillXp[]`, `xpShareRadius = 1200`, `summonXpFactor = 0.5`, `heroLevelCap` (set to
**12** provisionally — covers every learnable rank; single most important value to
recover from the original map's `war3mapMisc.txt`, flagged OPEN). On kill: collect the
killing team's heroes within 1200 of the death (ascending id), split evenly (integer
division, remainder to lowest id); if empty, full XP to the killing player's hero.
Trigger XP applied verbatim from script-rules. Skill points: 1/level, learn rules from
`alsk`/`arlv`. Death timer uses the match Rng for the 0–3 roll.

---

## 7. Bounties

**RULE.** Bounty fields on the dying unit: `ubba` base + `ubdi` dice × `ubsi` sides;
payout = `ubba + Σ_{i=1..ubdi} random(1..ubsi)` gold to the killing player, only if the
*dying unit's owner* has `PLAYER_STATE_GIVES_BOUNTY` on. BSP's Map_Start trigger enables
bounty for **every player** (war3map.j:1117–1127), so all kills pay. Key data
(`units.json`): player ships `ubba` 79–749 with 1d1 ⇒ deterministic **base+1** (H000 80,
H003/H00Y 125, H001 100, H004 150, H007 175, H006 200, H008/H009 300, H00V/H00W 450,
H00L/H00K/H00X 350, H00A/H00C 400, H00D 500, H005 750 — mirroring the trigger-XP tiers);
lane ships h00I 5+2d10 / h00B 12+2d25 / h00H 25+2d50, while mirror types h00E/h00F/h00G
are **0/0d0 — one side's lane ships pay no bounty (preserved data asymmetry)**; Cannon
Tower n004 499+1d1 = 500; Firing-Ramp n00D 999+1d1 = 1000; missile dummies 0.

**SOURCE.** Formula: hiveworkshop 34678 + thehelper 26359 (field semantics ubba/ubdi/ubsi).
Enable flag: `war3map.j`. Values: `units.json`.

**CONFIDENCE.** **High** (formula corroborated twice, values are local data). Per-die
independent rolls vs one roll×dice: **medium** — irrelevant for 1d1, minor variance
difference for lane ships; we roll per-die (matches attack-dice convention).

**SIM DECISION.** On death: if dying unit's bounty fields nonzero, pay
`ubba + Σ rng.int(1, ubsi)` (ubdi independent draws) to the killing player. Killer =
owner of the damage source of the killing blow; scripted deaths (suicide bombs, Goblin
Bomber) follow the script's explicit payouts instead. Keep the h00E/F/G zero-bounty
asymmetry verbatim in Classic.

---

## 8. Item shops, stock, refunds

**RULE.**

- Purchasing: shops sell their `usei` item lists to units in interact range (`Aneu`
  select radius, e.g. Main Harbor A057 = 400). Stock/restock per item fields
  (`isto`/`isst`): GrandMaster Craftsman restocks 1200 s, Leviathian Charm 300 s; the
  rest effectively always available. Enemy-side shop purchases are blocked by trigger
  (`Items_Not_Buyable`) with the gold refunded.
- Engine sell-back (50% of gold cost, the WC3 default) requires a shop owning the
  **Sell Items (`Asid`)** ability. **No BSP shop has it** (checked all `n*` shop units'
  ability lists) ⇒ players cannot voluntarily sell items back at all.
- All refunds are trigger-driven and pay **100%**: every stack-cap / class-restriction
  violation refunds `R2I(GetItemLifeBJ(item))` — the item's HP field, which the map sets
  equal to its gold price on every item (verified `ihtp == igol` across weapons/equipment).
- Contract/lumber purchases additionally gate on `udg_PlayerLumber` (script economy:
  I00S/I00W/I00M/I01I/I00Q need 4/10/10/18/25 lumber; refund tiers 25–80), independent of
  the WC3 lumber resource.

**SOURCE.** 50% engine default: liquipedia.net/warcraft/Items,
classic.battle.net/war3/basics/heroitembasics.shtml. Shop ability survey + `ihtp == igol`:
`units.json`/`items.json`. Refund mechanics & lumber: `script-rules.json` / `war3map.j`.

**CONFIDENCE.** No-sell-back: **medium-high** (override-level ability lists checked; base
units `nmer`/`nefm`/`ngol` have no Asid by default — confirm during SLK extraction).
Refund-at-full-price: **high** (script).

**SIM DECISION.** No sell action in the sim/UI for Classic. Shop model: per-shop item
list, per-item stock + restock ticks, interact radius, team gating. Rule-violation
refunds credit `igol` (= ihtp) and despawn the item, reproducing the 0.10 s
teleport-away pattern as same-tick removal. Lumber contracts implemented from
script-rules as player-scoped counters.

---

## 9. Invisibility (smoke) & true sight

**RULE.**

- Timed invisibility (`AIv1` Smoke Machine 10 s/CD 70; `A02Y` Integrated 30 s/CD 240;
  `Aivs` Hide 6–16 s/CD 25 and unit Smoke 12–32 s/CD 20–40): the buff makes the unit
  invisible to enemies; **any action other than move/stop/hold — attacking, casting,
  using an item — removes the buff permanently** (no re-fade). Casting the invisibility
  itself does not break it. Allies still see the unit (translucent).
- While invisible (and undetected): cannot be targeted by enemy orders/spells, never
  auto-acquired (PF skips, towers/lane ships skip); ground-point AoE at its position
  still damages it (BSP has effectively none that can).
- Ghost (`Agho`, H00W): permanent; suppressed during the unit's own actions instead of
  removed (§5).
- True sight (Adtg 1200 / Atru wards / gemt ~900 / AIfa flares 1500–1200 timed areas)
  reveals invisible units to the whole team in radius; revealed units are fully
  targetable. Nothing in BSP dispels buffs, so smoke always runs its timer otherwise.
- Stock transition/fade time (~0.6 s window after cast/break) exists in WC3.

**SOURCE.** Break rules: classic.battle.net invisibility basics ("reveal themselves if
they do anything but move or stop"), liquipedia.net/warcraft/Invisibility; map tooltips
agree ("If the unit uses an ability it becomes visible"). Durations/cooldowns/buffs:
`abilities.json` A034/A02Y/A047/A00A; detector data §5.

**CONFIDENCE.** Break-on-action & untargetability: **high**. Exact fade window: **low**
(deliberately simplified).

**SIM DECISION.** Invisibility = status with expiry tick + `breaksOnAction` flag; consumed
by attack-order execution, any cast, any item activation (movement/stop exempt). Ghost =
permanent status with action-suppression instead of removal. Detection per §5. Transition
times collapsed to tick boundaries (divergence accepted: max 0.6 s earlier visibility in
WC3; revisit only if competitive feedback demands the fade).

---

## 10. Regeneration & repair (`Arel`/`Arll`/`Arej`/`AIhx`)

**RULE.**

- `Arel`/`Arll` (Repair/Mechanics crews 2/10/30/70 HP/s; Kraken 20; Onboard Mechanics
  skill 1–10): flat, passive, **always-on** HP/s — never interrupted by combat or
  movement. Distinct abilities stack additively (e.g. Onboard skill + carried crew +
  Kraken); same-item stacking is trigger-blocked (1 repair crew/ship).
- Base unit regen `uhpr` adds on top (Royal Ship 5.0; everything else 0) plus hero Str
  regen (+0.05; negligible). Leviathan explicitly 0 despite tooltip.
- `Arej` (Rejuvenation actives — Goblin Mechanic 2500, Goblin Engineer 3750, GrandMaster
  20000, all over 20 s, range 100, targets `friend,mechanical,structure`, buff B00G):
  heal-over-time buff; ticks for `Rej1/20` HP/s for 20 s; **not interrupted by damage**;
  re-casting replaces/refreshes the same buff (no stacking); ends if the target dies.
  Target filter means structures and mechanical units — ships (non-mechanical heroes) are
  not valid targets.
- `AIhx` (repair woods 300/1500/4000/99999): **instant** HP restore on item use, clamped
  at max HP, endless charges, per-item cooldown (45/80/100/120 s; item CD groups via
  `icid`). Using one breaks invisibility (§9).

**SOURCE.** `equipment.json`, `abilities.json` (A009 Arll levels, A04I/A056/A030 Arej,
A00K AIhx), `units.json` `uhpr`. Stock semantics: Ring of Regeneration / Rejuvenation
liquipedia entries.

**CONFIDENCE.** **High** throughout (simple, data-driven); Arej non-interruptibility
**medium-high** (stock Rejuvenation behavior).

**SIM DECISION.** Single per-tick regen pass: `hp += (Σ flatRegen)/20`, capped at max.
HoT buffs as timed statuses accruing `total/duration/20` per tick, keyed by buff id so
re-application overwrites remaining duration (no stack). Instant heals apply on the item-
use tick, start the item-cooldown timer, and emit the action event that breaks
invisibility. Regen/heals never exceed max HP; fractional HP kept as numbers (IEEE
doubles are deterministic given identical op order — guaranteed by fixed iteration
order).

---

## Open questions (in-engine / extraction follow-ups)

1. **Hero level cap + any gameplay-constant overrides** — recover `war3mapMisc.txt` from
   the original MPQ (affects §1 agility offset, §3 speed clamps, §6 cap & XP tables).
2. **Missile effective damage 2×** (BALANCE.md §9.4) — gates W7–W9.
3. **PF buff retarget gate & DoT 1-HP clamp** — changes Acid Bomber/Nuke behavior (§2).
4. **`hdes`/`nmer` SLK defaults** (attack type, defense type, armor, attack cooldown) for
   lane ships, towers, HQ (§1) — extract into `data/json`, never guess.
5. **Morph HP carryover** on Dive (fraction vs flat) (§5).
6. **Ghost reveal-during-cast** exact window for H00W torpedo use (§5).
7. **Asid absence on shop base units** — confirm during SLK extraction (§8).
