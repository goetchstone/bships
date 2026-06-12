# BattleShips Pro v1.187 — Balance Audit (Final)

**Scope:** complete quantitative audit of the standard weapon arsenal, equipment, ships, and upgrades for the BattleShips Pro v1.187 recreation, reconciled against the map script (`war3map.j`) and independently verified on a sample of 12 weapons. This document supersedes the earlier draft, which lacked object-data numbers.

**Primary sources:**

- Object data extracts: `/Users/goetchstone/bships/data/json/` (`items.json`, `abilities.json`, `units.json`, `buffs.json`, `upgrades.json`)
- Map script: `/Users/goetchstone/bships/data/extracted/war3map.j`
- WC3 1.24-era base data (SLK/TXT extracts) for fields the map does not override

---

## 1. Methodology

### 1.1 Source-of-truth hierarchy

1. **Object data is ground truth for the standard arsenal.** Every stat below comes from the map's own field overrides unless flagged otherwise. Standard cannons are item-granted **Phoenix Fire (`Apxf`) passives** — they auto-fire at targets in range with no player input; the engine resolves them entirely from object data. Torpedoes are manually-fired **Storm Bolt (`AHtb`)** actives; missile warheads detonate via **Kaboom/Self-Destruct (`Asdg`)** dummies.
2. **WC3 base defaults** fill fields the map left untouched (e.g. `Apxf Cool1=0.5`, `Missilespeed=900`, `Asdg` building damage factor = 1). Each such case is listed in the provenance appendix (§9.3) with its source file.
3. **The map script** governs trigger mechanics: missile launch throttling and targeting, friendly-fire auto-stop, enemy-shop purchase blocks, stack caps, suicide bombs, the Goblin Bomber kill, inventory transfer between ships.
4. **Tooltips are cross-checks only — never authoritative.** Where a tooltip disagrees with object data, the object-data value is reported and the mismatch logged in §9.2. One systematic exception is unresolved: all three missile tiers' tooltips claim exactly **2× the object-data damage**, and a plausible engine mechanism (Kaboom order + inherited explode-on-death both detonating) could make the tooltips right. Treated as a live risk (§9.4), not a resolved fact.

### 1.2 What DPS means here — and what it misses

`DPS = damage / cooldown`; `DPS/100g = DPS per 100 gold of item cost`. This is **theoretical sustained single-target output at 100% in-range uptime**. It ignores:

- range and kiting uptime (a 450-range gun is rarely at 100% uptime; a 2500-range gun nearly always is),
- projectile speed and homing (non-homing shots whiff against lateral movement),
- target-class filters (structures-only, hero-only, ships-only),
- DoT riders, AoE, burst-vs-sustain, stack caps, and trigger-driven mechanics.

Section 7 covers every case where the raw number actively misleads.

### 1.3 R005 "Ship Cannons" caveat

R005 does **not** touch player weapons. It applies only to the Imperial AI lane ships (`upgr='R005,R003,R004'` on h00I/h00E/h00B/h00F/h00H/h00G); player hero ships lack the upgrade reference, and item weapons deal ability (spell) damage immune to attack upgrades anyway. The per-level numbers are anomalous: object data is **base=1, mod=8 → +1 bonus damage die at level 1, then +8 dice per level thereafter, totalling +73 dice at level 10** (rowboat +73–219, battleship +73–584, cruiser +73–1022 per attack). The tooltip claims a flat +1 die/level. Classic preserves the data values verbatim; see watchlist item W14.

---

## 2. Weapons

### 2.1 Full arsenal, sorted by gold

`†` = tooltip mismatch, see §9.2. `‡` = verifier-disputed entry with corrections folded in, see §9.1. CD in seconds.

| Weapon | Code | Gold | Dmg | CD | Range | DPS | DPS/100g | Special |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Small Missile (warhead) †‡ | I01O | 40 | 50* | ~2 (script) | map-wide | 25 | 62.50 | Random structure of enemy **lead player only**; 200 AoE splashes enemy structures only; +1 lumber/shot; no aiming, cannot hit ships |
| Rocket Cannon | I002 | 155 | 3 | 0.50 | 1600 | 6 | 3.87 | Ships only; extreme-range chip; non-homing |
| Arrow Cannon | I000 | 160 | 7 | 0.55 | 625 | 12.73 | 7.96 | Ships only; homing; cosmetic "Damaged" buff |
| Cruiser Missile (warhead) † | I01P | 180 | 250* | ~2 (script) | map-wide | 125 | 69.44 | As Small Missile; +1 lumber/shot |
| Basic Cannon | I001 | 200 | 20 | 1.50 | 700 | 13.33 | 6.67 | Ships & structures; non-homing |
| Flame Cannon | I006 | 335 | 50 | 3.00 | 800 | 16.67 | 4.98 | Ships only; **no burn DoT** (visual only); non-homing |
| Grand Missile (warhead) †‡ | I01Q | 360 | 500* | ~2 (script) | map-wide | 250 | 69.44 | As Small Missile; +1 lumber/shot; fastest payload dummy (400) |
| Cruiser Cannon | I004 | 405 | 30 | 1.50 | 900 | 20 | 4.94 | Ships & structures; non-homing |
| Multi-Rocket Cannon | I00G | 650 | 11 | 0.33 | 550 | 33.33 | 5.13 | Ships only; rapid fire; non-homing |
| Cold-Arrows Cannon | I005 | 800 | 30 | 1.00 | 700 | 30 | 3.75 | Ships only; frost visual, **no slow** (tooltip agrees); non-homing |
| Bowmen Crew | I01B | 1000 | 8 | 0.20 | 800 | 40 | 4.00 | Ships & structures; homing; high arc |
| Machinegun Cannon | I00H | 1300 | 8 | 0.12 | 450 | 66.67 | 5.13 | Ships & structures; homing; very short range |
| Boulder Cannon | I010 | 1450 | 100 | 2.00 | 900 | 50 | 3.45 | Ships only; non-homing |
| Catapult Cannon | I00P | 1875 | 270 | 2.30 | 730 | 117.39 | 6.26 | **Structures only** — cannot hit ships; homing |
| Bombard Cannon | I00O | 2270 | 40 | 1.25 | 1600 | 32 | 1.41 | Ships only; extreme range; non-homing |
| Fire-Arrow Cannon | I00I | 2500 | 35 | 0.50 | 850 | 70 | 2.80 | Ships & structures; homing; no burn DoT |
| Hammer Cannon | I01C | 3200 | 110 | 1.25 | 700 | 88 | 2.75 | Ships only; non-homing |
| Acid Bomber | I027 | 3250 | 40 | 3.00 | 700 | 13.33 | 0.41 | Ships only; **+20 dmg/s acid DoT for 20 s** (≈ +400/hit, refresh not stack; no armor shred); effective ≈ 33 DPS; non-homing |
| Custom Torpedo Bay | I02N | 3325 | 500 | 22.50 | 900 | 22.22 | 0.67 | Sub-only, manual, ships only; stun neutralized (0.01 s); limit 1 extra/sub |
| Corpse Cannon | I02A | 3750 | 75 | 1.00 | 600 | 75 | 2.00 | Ships only; no disease DoT; non-homing |
| Guard Tower Cannon | I018 | 4200 | 50 | 0.50 | 900 | 100 | 2.38 | Ships & structures; non-homing |
| Glaive Thrower † | I00L | 4500 | 125 | 1.10 | 630 | 113.64 | 2.53 | Ships & structures; non-homing |
| Knuckle Cannon | I00Z | 4650 | 35 | 0.30 | 600 | 116.67 | 2.51 | Ships & structures; homing |
| Sniper Crew | I02F | 5100 | 115 | 2.20 | **2500** | 52.27 | 1.02 | **Enemy hero ships only** — no structures/non-heroes; longest range in game; non-homing |
| Molotov Cocktail Cannon | I00X | 6000 | 250 | 2.00 | 700 | 125 | 2.08 | Ships & structures; **no burn DoT**; homing; high arc |
| Chaos Cannon † | I01D | 6300 | 90 | 0.70 | 825 | 128.57 | 2.04 | Ships & structures; homing |
| High Yield Torpedo Bay † | I02O | 6750 | 1000 | 45.00 | 900 | 22.22 | 0.33 | Sub-only, manual, ships only; limit 1 extra/sub |
| Thor's Cannon | I019 | 6925 | 220 | 1.55 | 1000 | 141.94 | 2.05 | Ships only; hammer visual, no stun; homing |
| Advanced Sniper Rifle | I02M | 6955 | 157 | 2.20 | **2500** | 71.36 | 1.03 | Hero ships only; upgraded Sniper Crew (+42 dmg); non-homing |
| Underwater Launch † | I026 | 8950 | 3000 | 45.00 | 1200 | 66.67 | 0.74 | Sub-only, manual, **structures only**; 3.5 s wind-up cast; limit 1 |
| Frag-Fire Cannon | I01M | 10750 | 115 | 0.50 | 1125 | 230 | 2.14 | Ships & structures; long range; no DoT; non-homing |
| Laser Cannon | I00Y | 11000 | 15 | 0.05 | 600 | 300 | 2.73 | Ships & structures; fastest projectile (3000, effectively hitscan); non-homing; **no stack cap** |
| Nuclear Torpedo Bay † | I02P | 16875 | 2500 | 45.00 | 900 | 55.56 | 0.33 | Sub-only, manual, ships only; limit 1 extra/sub |
| Nuclear Strike † | I01Y | 18640 | 2000 | 5.00 | 1500 | 400 | 2.15 | Ships & structures; **+100 dmg/s fallout for 4 s** (≈ +400/hit, buff B016, refresh); single-target, no splash; **limit 1/ship**; shares `Aslo` item-cooldown group with warheads; non-homing, high arc |
| Vulcan Cannon | I01Z | 19750 | 30 | 0.05 | 450 | **600** | 3.04 | Ships & structures; highest DPS in game at shortest range; homing; **limit 1/ship** |

\* Missile damage values are object data (`Dda2`); tooltips claim exactly 2× on all three tiers and the effective value may genuinely be 2× — see §9.4.

**Not purchasable — Goblin Bomber (A055, Goblin Ship H00Y level-8 hero ability).** Base `Ashs` (Shadow Sight item spell) with its buff swapped to `Bstt`, reskinned as "Goblin Mine". 650 cast range, 1.5 s cast, 150 s cooldown, targets enemy hero ships. Scripted effect (GoblinBomber trigger, `war3map.j` 8752–8805): the marked ship **dies 5 s after it next uses an item or casts an ability — lethal regardless of HP**. Removal: visit your repair bay. The lookalike buff B011 "Boat Mine" is a different rawcode and does *not* trip the trigger.

### 2.2 Missile per-shot economics

Missiles are not DPS items; they are gold-and-lumber-for-structure-damage conversions. Each shot consumes the warhead **plus 1 Piece of Lumber (I01N, 0 g — but lumber gates the big contracts, see §8)**, fired via A032 from a Missile Firing-Ramp/Silo (n00D) at a ~2 s scripted per-player throttle. The hit lands on a **uniformly random structure owned by the enemy team's lead player** (Player Red/Blue) — never on ships, never on other enemy players' structures.

| Warhead | Gold/shot | Lumber/shot | Damage (data) | Gold per dmg | Dmg per 100g | Dmg per lumber | Max sustained DPS | Gold burn/s at cap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Small (I01O) | 40 | 1 | 50 | 0.80 | 125 | 50 | 25 | 20 |
| Cruiser (I01P) | 180 | 1 | 250 | 0.72 | 139 | 250 | 125 | 90 |
| Grand (I01Q) | 360 | 1 | 500 | 0.72 | 139 | 500 | 250 | 180 |

If the 2× effective-damage risk (§9.4) is real, every damage figure doubles (0.36–0.40 g per dmg). A 20 s "Buggfix" retry trigger that re-fires stuck missiles exists **only for the south team** — preserved asymmetry, see W5.

---

## 3. Equipment

All hull/sail/repair-crew items are non-stackable: 1 hull, 1 sail, 1 repair crew per ship; Kraken shell is exclusive with all three categories (script-enforced).

### 3.1 Hulls

| Item | Code | Gold | Max HP | Dmg reduction | Armor | Speed | Notes |
|---|---|---:|---:|---:|---:|---:|---|
| Stone Hull † | I009 | 200 | +100 | 10% | **+3** (tooltip claims +6) | −5% | Cheapest survivability per gold |
| Bronze Hull | I016 | 1100 | +250 | 20% | +6 | −10% | Matches tooltip exactly |
| Gold Hull | I00A | 2500 | +500 | 30% | +9 | −20% | Heaviest speed tax |
| Kraken shell | I01X | 6600 | — (+20 HP/s regen) | 20% | +6 | **+30%** | Only hull with no HP bonus and no speed penalty; **sub-legal** despite tooltip boilerplate |

Mechanics note: the damage reduction is the Runed-Bracers-type `AIsr` (spell-damage reduction in stock WC3). Because the map's item weapons are Phoenix-Fire/spell-damage based, **hull reduction applies to enemy cannon fire**, which makes the 30% on Gold Hull a genuine third-of-everything cut. The armor stat, by stock mechanics, matters mainly against lane-ship physical attacks. Neither helps against the true-damage suicide bombs (§7, §8).

### 3.2 Sails

| Item | Code | Gold | Move speed | Gold per +1% |
|---|---|---:|---:|---:|
| Light Sail | I007 | 100 | +10% | 10.0 |
| Great Sail | I008 | 610 | +25% | 24.4 |
| Goblin Sail | I01A | 1385 | +50% | 27.7 |
| Royal Sail | I01U | 2160 | +75% | 28.8 |
| Silk Sail | I01V | 2935 | +100% | 29.4 |
| Outboard Propeller | I01T | 5425 | +200% | 27.1 |

No sail grants attack speed (`Oae2=0` across the line). Pricing is nearly linear above the Light Sail, which is by far the cheapest %-for-gold and the only one whose value rests on the WC3 Endurance Aura default.

### 3.3 Repair

**Passive crews** (1 per ship; submarines may not carry — script whitelist):

| Item | Code | Gold | HP/s | Gold per HP/s |
|---|---|---:|---:|---:|
| Repair Crew | I017 | 145 | 2 | 72.5 |
| Mechanics Crew | I00B | 720 | 10 | 72.0 |
| Swedish Repair Crew | I011 | 2205 | 30 | 73.5 |
| Goblin Mechanics Crew | I01W | 5300 | 70 | 75.7 |

Remarkably flat pricing (~72–76 g per HP/s) — the crew line is the cleanest-priced item family in the map.

**Repair woods** (on-use burst, endless charges, **sub-legal** despite tooltip notes):

| Item | Code | Gold | HP restored | Cooldown | Amortized HP/s |
|---|---|---:|---:|---:|---:|
| Weak Repair Wood | I00C | 175 | 300 | 45 s | 6.7 |
| Normal Repair Wood | I00D | 765 | 1500 | 80 s | 18.8 |
| Swedish Repair Wood | I00E | 2910 | 4000 | 100 s | 40.0 |
| Goblin Repair Wood | I01H | 5510 | 99999 (full) | 120 s | full reset |

**Building repair** (active, target friendly mechanical/structure, 1 charge, perishable trade items):

| Item | Code | Gold | Repair | Notes |
|---|---|---:|---|---|
| Goblin Mechanic | I01J | 2 | 2500 HP over 20 s | Trade item — removed if dropped/given |
| Goblin Engineer | I031 | 2 | 3750 HP over 20 s | Trade item |
| GrandMaster Craftsman | I00T | 1250 | 20000 HP over 20 s (full building) | 1200 s shop restock |

### 3.4 Utility

| Item | Code | Gold | Effect |
|---|---|---:|---|
| Light Teleporter | I01L | 700 | Blink, max 1200 distance, 50 s CD, 0 mana, endless. Shallow-water-only (trigger/terrain enforced) |
| Smoke Machine | I01K | 1600 | Invisible 10 s, 70 s CD, endless (breaks on attack/cast/item use — stock rules) |
| Integrated Smoke Machine | I01S | 3200 | Invisible 30 s, 240 s CD, endless |
| Spies (×4 shop clones: I020/I024/I025/totw) | — | 900 | 4 charges; each summons a stationary, **visible but invulnerable**, true-sight Spy ward (1600 sight) for 540 s; no CD |
| Sentry Ward (×4 clones: I021/I022/I023/wswd) | — | 400 | 1 charge; **invisible + invulnerable** true-sight ward, 540 s. Shares `Aeye` cooldown group with other wards |
| Informant | wshs | 950 | Global-range (99999) targeted reveal of any enemy unit, even invulnerable; unlimited uses, ignores CD. Buff duration unresolved (§9.4) |
| Flare Gun (3 price variants: I028 425g / fgun 485g / I029 510g) | — | 425–510 | Reveals 1200-radius area 15 s, 60 s CD, unlimited. Invisible-detection unconfirmed (§9.4) |
| Motion Detectors | whwd | n/a | 5 charges; invisible+invulnerable proximity-warning ward (trigger-driven warning; heal aura stripped). Price & lifetime unresolved (§9.4) |
| Leviathian Charm | fgdg | 5125 | Summons Leviathian (8500 HP, fort armor, siege attack, range 1000, Eat Hero) for 1200 s; 1 charge; 300 s restock |
| Caribbean Music | tst2 | 50 | Pure flavor — plays the theme via trigger; ability list explicitly cleared |
| Tome of Experience (×3 clones: texp/I02D/I02E) † | — | n/a | **+200 XP by object data** (double `AIem` grant); tooltip claims 300 — verify trigger top-up |
| Tome of Greater Experience (×3 clones: tgxp/I02B/I02C) | — | n/a | +500 XP (stock, unmodified); trigger drop |

---

## 4. Ships

| Ship | Code | Gold | HP | Armor | Speed | Slots | Kit / notes |
|---|---|---:|---:|---:|---:|---:|---|
| Battle Ship (starter) | H000 | 200 | 200 | 0 | 170 | 6 | Captain's Cannon, Enforced Hull, Sails, Onboard Mechanics, Shore Leave |
| Battle Ship | H003 | 1000 | 600 | 2 | 230 | 6 | Intercept (Berserk base) |
| Battle Ship (hunter) | H001 | 1000 | 750 | 1 | 250 | 6 | Capsize (Cyclone), Fishing Net (Ensnare), Hide, **True Sight detector**; no Mechanics Crew |
| Battle Ship | H004 | 1200 | 700 | 3 | 170 | 6 | Hull Repair |
| Goblin Ship | H00Y | 1250 | 600 | 2 | 190 | **5** | **Goblin Bomber** (scripted kill, §2.1), Goblin Repair Crew (can repair team structures) |
| Cruiser | H007 | 2200 | 2000 | 5 | 160 | 6 | Board Ship, Disrupt Beacon (Silence) |
| Cruiser | H006 | 2400 | 1750 | 5 | 180 | 6 | Slow Aura, EMP (Thunder Clap) |
| Cruiser | H008 | 5000 | 4500 | 8 | 180 | 6 | Freeze Water, Send Spy |
| Cruiser | H009 | 5000 | 5000 | 10 | 160 | 6 | Spawn Seamonster, Sail Ripper Cannon |
| Submarine | H00V | 6000 | 2000 | 5 | 200 | 6 | Dive Dive! (submerge transform), 2× built-in Torpedo, Echo-Location, Repair Crew |
| Submarine (stealth) | H00W | 8500 | 1000 | 0 | 100 | 6 | **Permanently invisible** (Ghost); no other abilities |
| Flagship † | H00L | 9400 | 6800 | 9 | 160 (tooltip 190) | 6 | *Unique.* Ghost Crew (Locust Swarm), Ghost Cloud |
| Flagship (elven) | H00K | 9800 | 7200 | 10 | 160 | 6 | *Unique.* Detector Flare, Release Hunters |
| Leviathian † | H00X | 13250 | 8500 (tooltip 11000) | 0 | 100 | **2** | Eat Hero (Devour), Digest Hero; 0 regen (tooltip claims 15) |
| Royal Ship † | H00A | 14450 | 9800 | 7 | 185 (tooltip 175) | 6 | *Unique*, biggest ship; +5 HP/s real regen; Nautical Engineer Crew |
| Pirate Ship | H00C | 16000 | 9000 | 10 | **250** | 6 | *Unique*, fastest capital ship; Pirate Crew |
| Trade Boat | H00D | 300 | 75 | 0 | 250 | **3** | Trading; Barrier (Divine Shield), Hide, Shadow Replication |
| Merchant Boat † | H005 | 4525 | 75 | 5 (tooltip 0) | 280 (tooltip 250) | **4** | Trading; Barrier, Confuse, Integrated Smoke Machine, Mechanics Crew |

---

## 5. Upgrades

All team tech: researching any level auto-shares it to the whole team (script).

| Upgrade | Code | Applies to | Cost/level | Per-level effect | Max-level total | Notes |
|---|---|---|---:|---|---|---|
| Tower Defense | R000 | n004 Cannon Tower only, 10 levels, 180 s each | 400 | +500 max HP | +5000 (tower 6500 → 11500) | |
| Tower Damage | R001 | n004 Cannon Tower only, 10 levels, 180 s each | 325 | **L1 +40**, then +10/level (artillery class) | +130 (tower avg dmg 35 → 165) | Tooltip "avg 13/level" = 130/10 |
| Tower Mechanics | R002 | **Orphaned** — no unit lists it, absent from Upgrade Center research list | 2500 | +20 HP/s regen (tooltip: Main Harbor) | inert as extracted | Verify against triggers (§9.4) |
| Ship Hull | R003 | **Imperial AI lane ships only** | 800 | +25% of base max HP | +250% (tooltip stale: claims 275%) | Player ships unaffected |
| Ship Sails | R004 | Imperial AI lane ships only | 150 | +10 flat move speed | +100 | Does **not** speed up player ships despite the name |
| Ship Cannons | R005 | Imperial AI lane ships only | 600 | **L1 +1 die, L2–10 +8 dice/level** (anomalous; tooltip claims +1/level) | **+73 dice**: rowboat +73–219, battleship +73–584, cruiser +73–1022 per attack | Never touches player item weapons (§1.3); see W14 |

---

## 6. Cost-efficiency analysis

### 6.1 Early game (<1000 g)

- **Arrow Cannon (160 g, 7.96 DPS/100g)** is the single most gold-efficient direct-fire weapon in the entire game, and it homes. The correct first gun, full stop.
- **Basic Cannon (200 g, 6.67)** trades a little efficiency for structure damage — the budget pick if you intend to poke towers.
- **Rocket Cannon (155 g, 3.87)** is bad DPS but buys 1600 range for pocket change; it is a harassment/utility purchase, not a damage one.
- **Cold-Arrows Cannon (800 g, 3.75)** is the early-game trap: the frost is purely cosmetic (no slow, by data *and* its own tooltip), so you are paying 800 g for 30 DPS of nothing special.
- **Missile warheads (62.5–69.4 DPS/100g vs structures)** are an order of magnitude more gold-efficient than any cannon — but only against the enemy lead player's random structures (§2.2).

### 6.2 Mid game (1000–7000 g)

- **Catapult Cannon (1875 g, 6.26)** is the standout — best aimed anti-structure gold in the game — at the cost of being useless in ship fights.
- **Machinegun (1300 g, 5.13)** and **Multi-Rocket (650 g, 5.13)** lead the general-purpose pack, both gated by short range (450/550).
- From ~2500 g upward, everything converges to **2.0–2.8 DPS/100g** — the mid-tier cannon ladder is essentially flat, and the buy decision is range/homing/target-class, not efficiency.
- **Acid Bomber (3250 g, 0.41)** is plainly the worst weapon purchase in the game on paper. Even crediting full DoT uptime (13.3 direct + 20 DoT ≈ 33 effective DPS → ~1.0/100g) it still loses to every 600-gold gun. Its only argument is DoT pressure on disengaging targets.
- **Torpedoes are burst tools, not DPS buys** (0.33–0.67/100g): Custom Torpedo Bay (3325 g, 500 dmg/22.5 s) actually matches the High Yield Bay's sustained 22.2 DPS at **half the price** — see W10.

### 6.3 Late game (>7000 g)

- **Vulcan (19750 g, 3.04)** is, surprisingly, the most gold-efficient late purchase — better DPS/100g than anything else above 1000 g except the structures-only Catapult — *and* the highest raw DPS (600). Its costs are the 450 range and the 1-per-ship cap.
- **Laser (11000 g, 2.73)** is the next-best efficiency with a hitscan-speed projectile, and **has no cap** (see §6.5).
- **Frag-Fire (10750 g, 2.14)** is the best all-rounder: 230 DPS at 1125 range hits ships and structures alike — the flagship general-purpose cannon.
- **Nuclear Strike (18640 g, 2.15 nominal)** under-reads in the table: counting fallout, a single target on cooldown eats (2000+400)/5 ≈ **480 effective DPS at 1500 range** — better effective output than the Laser at 2.5× the range, capped at 1 per ship.
- **The sniper line (~1.0/100g)** is the worst sustained efficiency of any cannon family — but it buys 2500 range, 900 beyond anything else in the game.

### 6.4 Sniper stacking in default modes

Snipers are capped at 1 **only in ModeOnlySailors**; in default modes they stack without limit, and unlike Nuke/Vulcan their efficiency never decays with copies:

- Each Sniper Crew (5100 g) adds 52.27 DPS at 2500 range; each Advanced Rifle (6955 g) adds 71.36.
- **3× Advanced Sniper Rifle (20865 g) ≈ 214 DPS at 2500 range** — Frag-Fire-class damage delivered from more than double Frag-Fire's range, outside the reply range of every weapon in the game (next longest: 1600).
- 4× Sniper Crew (20400 g) ≈ 209 DPS at 2500 for similar money.
- The hero-only filter is barely a restriction in practice, since the targets that matter — player ships — are heroes. The real limits are inventory slots (6 minus hull/sail/repair) and the non-homing projectile.

This is the dominant uninteractive late-game pattern in default modes and the top candidate for the Balanced ruleset (W4).

### 6.5 The 0.05 s cooldown class: Vulcan and Laser

Two weapons live in their own fire-rate tier — cooldown 0.05 s, i.e. effectively one shot per engine tick:

| | Vulcan (I01Z) | Laser (I00Y) |
|---|---|---|
| Gold | 19750 | 11000 |
| Theoretical DPS | **600** | 300 |
| Range | 450 | 600 |
| Homing | Yes | No (but 3000 projectile speed ≈ hitscan) |
| Cap | **1 per ship** | **None** |
| DPS/100g | 3.04 | 2.73 |

Nothing else competes: the next-best sustained number is Frag-Fire at 230. Within brawling range the Vulcan roughly **quintuples** a Thor's Cannon (141.9) for under 3× the price.

Two caveats:

1. **Engine verification needed.** A 0.05 s cooldown sits at/below Phoenix Fire's effective scan granularity; the realized fire rate should be measured in-engine before treating 600/300 as exact. Whatever the realized number, the *relative* dominance stands.
2. **The cap asymmetry is exploitable: the Laser has no stack limit.** 2× Laser (22000 g) = 600 theoretical DPS at 600 range — Vulcan output, better range, no cap, for ~11% more gold. The Vulcan's 1-per-ship limit is undermined by its uncapped little brother (W12).

---

## 7. Where raw DPS misleads

1. **Range and kiting.** The DPS table assumes permanent in-range uptime. A Bombard (32 DPS @ 1600) or Rocket (6 @ 1600) lands every tick of its number against a 450-range Vulcan boat it kites; the Vulcan's 600 lands zero. Speed stacking (Outboard Propeller +200%) makes uptime, not paper DPS, the real currency. Snipers at 2500 convert ~1.0/100g "bad" efficiency into unanswerable damage.
2. **Projectile speed and homing.** Most cannons are non-homing — shots can whiff entirely against fast lateral movement, and slower projectiles (900) whiff more. Homing weapons (Arrow, Bowmen, Machinegun, Catapult, Fire-Arrow, Knuckle, Molotov, Chaos, Thor's, Vulcan, the torpedo line) deliver close to their listed number; the Laser's 3000-speed projectile is hitscan in practice despite not homing.
3. **Target-class filters.** Catapult (117 DPS) contributes nothing in a ship fight; snipers (52–71) contribute nothing to a base race; ships-only cannons (Boulder, Hammer, Thor's, Bombard…) cannot push structures at all. A ship's *effective* DPS is situational composition, not a column sum.
4. **DoTs and specials.** Acid Bomber is 13.3 on paper, ~33 with DoT uptime. Nuclear Strike is 400 on paper, ~480 with fallout. Goblin Bomber has no DPS at all and kills any ship outright. Cold-Arrows/Flame/Molotov/Fire-Arrow/Corpse look like they have riders and have none — visuals only.
5. **AoE.** Only the missile warheads splash (200 radius), and the splash hits **enemy structures only** — enemy ships and all allied units in the blast take zero (targets-allowed filter). No weapon in the game does AoE damage to ship waves.
6. **Stack caps.** Nuke and Vulcan cap at 1; torpedoes at 1 extra per sub; snipers cap only in ModeOnlySailors; Laser and everything else stack freely. Per-ship ceilings, not per-item DPS, decide late-game arms races.
7. **R005 scaling.** Player weapons never scale; Imperial lane ships at R005 L10 swing +73–1022 bonus damage per attack (data values). Late-lane interactions dwarf any player cannon table — and the data/tooltip anomaly (W14) decides whether that's intended.
8. **Missile randomness.** Warhead damage cannot be focused: expected shots to kill a *specific* structure scale with the enemy lead player's structure count, and non-lead structures can never be hit at all. The 69.4 DPS/100g figure is real in aggregate, unusable surgically.
9. **True-damage bombs.** The suicide missions deal flat `SetUnitLifeBJ` damage — armor, hull reduction, and HP upgrades do nothing against them. No defensive purchase in §3 mitigates a bomb run.

---

## 8. Watchlist — Balanced ruleset

**Classic stays verbatim: no number changes, bugs and all.** Everything below is scoped to the Balanced ruleset only. Merged from pass 1, renumbered, with the new quantitative findings folded in.

| # | Item | Finding |
|---|---|---|
| W1 | **Suicide-mission economy (I01E)** | 1000 g (Trade Ship H005 only, 80-lumber refund tier) buys 4000 flat true damage to the enemy HQ **and pays the pilot 8000 g / 1200 xp — net +7000 g**. A self-funding, armor-bypassing siege loop. Highest-priority Balanced change (payout below cost, or real counterplay). |
| W2 | **Superbomb chain (I032→I02Z + I02Q Book of Formulas)** | 6000 flat true damage + 12000 g / 1200 xp; total counterplay is a single 12 s minimap ping. |
| W3 | **Double-bomb single trip** | One trade ship can carry both bombs: 10000 true damage in one run = **half the Main Harbor's 20000 HP**, through any armor/reduction. |
| W4 | **Sniper stacking (default modes)** | Uncapped I02F/I02M: 3× Advanced Rifle ≈ 214 DPS at 2500 range (no weapon answers past 1600). Cap exists only in ModeOnlySailors. Quantified in §6.4. |
| W5 | **Buggfix side asymmetry** | The 20 s missile-retry trigger works only for the south team — south missiles are strictly more reliable. Preserved in Classic; fix in Balanced. |
| W6 | **Missile lead-player targeting** | Warheads only ever strike structures owned by the enemy team's *lead* player (Player 0/1); all other enemy players' structures are missile-immune. In team games this concentrates all missile attrition on one player and is "random enemy structure" only in a Red-vs-Blue 1v1. |
| W7 | **Missile attrition pacing** | 62.5–69.4 DPS/100g vs structures dwarfs every cannon (best: 7.96). Sustained Grand-missile fire burns 180 g/s for 250 structure DPS, map-wide, unanswerable except by killing the ramps. |
| W8 | **Missile 2× damage risk** | If the explode-on-death interaction (§9.4) doubles warhead damage to the tooltip values, all of W7's numbers double. Needs an in-engine test before Balanced numbers are set. |
| W9 | **Grand vs Small missile pricing** | Bigger tiers are strictly better per gold (0.72 vs 0.80 g/dmg) *and* 10× better per lumber (500 vs 50 dmg/lumber). The Small Missile is a trap once lumber matters; consider re-pricing so tiers trade off. |
| W10 | **Torpedo line pricing** | High Yield (6750 g) → Nuclear (16875 g) is +10125 g for 2.5× burst at identical 45 s CD and identical 0.33 DPS/100g — flat scaling with a huge step. Meanwhile Custom Bay (3325 g) matches High Yield's sustained DPS at half price. The line has no efficiency curve. |
| W11 | **Nuke vs Vulcan top end** | Near-equal gold (18640 vs 19750): Nuke ≈ 480 effective DPS at 1500 range + burst; Vulcan 600 at 450. A genuine playstyle choice — acceptable — but monitor alongside W12. |
| W12 | **Laser uncapped** | 2× Laser (22000 g) = Vulcan-tier theoretical DPS at 600 range with no cap, while the Vulcan itself is limited to 1. Cap parity (or pricing) question for Balanced. |
| W13 | **Sub sustain whitelist** | Subs may carry Kraken shell (+20 HP/s, 20% reduction, +30% speed) plus all four repair woods; combined with the permanently-invisible H00W this is a near-unkillable sustain loop with no carry restriction doing its advertised job (tooltips claim subs can't carry these — script says they can). |
| W14 | **R005 data anomaly** | Object data gives +1 die at L1 then **+8 dice/level** (total +73d at L10: lane cruisers +73–1022/attack) vs the tooltip's +1/level. Classic keeps the data values verbatim; Balanced must pick a side deliberately — this is likely an authoring slip with massive late-lane consequences. |
| W15 | **Goblin Bomber** | Scripted unconditional kill (any item/ability use → death in 5 s, HP-irrelevant) on a 150 s cooldown from a 1250 g ship; only counterplay is returning to the repair bay. Cheap hard-removal of capital ships; watch in Balanced. |

---

## 9. Data-quality appendix

### 9.1 Disputed entries (independent verifier corrections — folded into the report above)

**I01O Small Missile** — 3 corrections accepted:

1. *Targeting:* hits a uniformly random structure of the **enemy team's main player only** (Player 0/1), not any enemy structure (`war3map.j` Trig_Fire_Missiles, ~11030–11037).
2. *AoE wording:* the 200-radius splash damages only units passing the `atar=enemies,structure` filter — enemy ships and allied units take zero; only nearby enemy structures splash.
3. *Effective damage:* 50 confirmed in object data, but possibly 100 effective (see §9.4).

**I01Q Grand Missile** — 5 corrections accepted:

1. *Targeting:* same lead-player-only pool as I01O (lines ~11106–11114; team rosters at InitCustomTeams ~15478ff; Buggfix at 11130–11157 is Player(0)→Player(1) only).
2. *"500 equals the Asdg default" claim withdrawn:* unmodified Asdg Dda2 = **30** (AbilityData.slk); 500 is purely the map's override. "Fastest dummy of the three" stands (umvs 200/300/400).
3. *Item→ability link:* I01Q `iabi` is empty — A03R is granted by the payload dummy h00P (`uabi='A03R,Avul'`), reached via script branch, not by the item.
4. *Range:* effectively **map-wide** (scripted selfdestruct order anywhere), with a vestigial level-1 `aran=10` on A03R; reported as "map-wide" in §2.1 rather than null.
5. *Tooltip cross-check:* recorded as a mismatch (1000 claimed vs 500 data) rather than silent agreement.

**Verified clean (no corrections):** I01P, I005, I010, I00I, I02N, I00L, I00X, I019, I01M, I01Y.

### 9.2 Tooltip mismatches (object data wins unless noted)

| Where | Tooltip claims | Object data / script |
|---|---|---|
| Missiles I01O/I01P/I01Q | Damage 100 / 500 / 1000 | Dda2 = 50 / 250 / 500 — systematic exact 2×; see §9.4 |
| High Yield Torpedo I02O | Range 1050 | aran = 900 |
| Nuclear Torpedo I02P | Range 1200 | aran = 900 |
| Underwater Launch I026 | Item: range 900; ability sub-tooltip: damage 1500 | aran = 1200 (ability sub-tooltip agrees); Htb1 = 3000 (item tooltip agrees) — the two tooltips disagree with each other |
| Nuclear Strike I01Y | Fallout "100 dmg/s for 2 s" (=200) | adur/ahdu = 4.0 s (=~400) — data doubles the claim |
| Glaive Thrower I00L | Short desc: "Molotov Cocktail attack" | Copy-paste error; stats and extended tooltip are Glaive |
| Chaos Cannon I01D | Short desc: "an Arrow attack" | Copy-paste error; extended tooltip says Chaos |
| Stone Hull I009 | Armor +6 | AId3 not overridden → **+3** |
| Kraken shell I01X / repair woods I00C–I01H | "Submarines may not carry" | Script whitelist explicitly allows them on subs |
| Tome of Experience texp/I02D/I02E | +300 XP | 2× AIem = +200; possible trigger top-up unverified |
| R003 Ship Hull | 250%/275% at L9/L10 | 225%/250% |
| R005 Ship Cannons | +1 die/level; "Cruisers 1-12" | +1d at L1 then +8d/level; cruisers roll d14 |
| Flagship H00L | Speed 190 | 160 |
| Leviathian H00X | 11000 HP, 15 regen | 8500 HP, 0 regen |
| Royal Ship H00A | Speed 175 | 185 |
| Merchant Boat H005 | Armor 0, speed 250 | Armor 5, speed 280 |

### 9.3 Provenance — stats resting on WC3 base defaults (not map overrides)

These values are correct only if the recreation reproduces the 1.24-era base data; each should be hard-coded rather than inherited:

- **`Apxf Cool1 = 0.5`** → Rocket (I002), Fire-Arrow (I00I), Guard Tower (I018), Frag-Fire (I01M) cooldowns (all corroborated by tooltips).
- **`Apxf DataA1 = 20`** → Basic Cannon (I001) damage (corroborated by tooltip).
- **`Apxf Missilespeed = 900`** → projectile speed for Basic, Flame, Cruiser Cannon, Catapult, Bombard, Acid Bomber, Corpse, Nuclear Strike (HumanAbilityFunc.txt).
- **`Apxf Area1 = 600`** → range of Corpse (I02A), Knuckle (I00Z), Laser (I00Y) (corroborated by tooltips).
- **`Apxf amho` default = homing** → Catapult and other unflagged weapons home.
- **`AHtb Missilespeed = 1000`** → Custom/High Yield/Nuclear torpedo projectile speed.
- **`Asdg DataE = 1`** (building damage factor) → missiles deal listed damage to structures (AbilityData.slk).
- **Endurance Aura L1 = +10%** → Light Sail (I007) — the only sail relying on a base default.
- **`AId3 = +3` armor** → Stone Hull (the map overrode AId5/AId8 but not AId3).
- **`Arel = 2 HP/s`** → Repair Crew (I017) (Ring of Regeneration baseline; tooltip agrees).
- **`ckng goldcost = 1000`** → Bowmen Crew (I01B) price (ItemData.slk; shop tooltip agrees).
- **Stock item baselines** for Spies (totw), Sentry Wards (wswd), Flare Gun (fgun), Demonic Figurine (fgdg, 1 charge), Tomes (texp/tgxp), Wand of Shadowsight (wshs).
- **Battle Ship H003 / Goblin Ship H00Y armor = 2** → Hpal default (udef not overridden; tooltips agree).

### 9.4 Remaining unknowns — require in-engine testing or further script work

1. **Missile effective damage (the 2× question).** A03P/Q/R inherit Asdg's "Explodes on Death" = 1 (not overridden). If the selfdestruct-order detonation *and* the death explosion both apply Kaboom damage, effective damage is exactly the tooltip values (100/500/1000), not the Dda2 values (50/250/500). Every missile tooltip matching exactly 2× is suspicious. **Highest-priority engine test in this document** — it gates W7–W9.
2. **Vulcan/Laser realized fire rate** at 0.05 s cooldown vs Phoenix Fire scan granularity (§6.5).
3. **Informant (wshs) reveal duration** — Ashs buff duration not overridden and no authoritative stock value found (campaign-only item). Treat as long/until-dispelled; verify in-game.
4. **Motion Detectors (whwd)** — ward lifetime (stock Healing Ward ~20 s, likely trigger-managed here), shop price (absent from object data), and the proximity-warning trigger behavior must be implemented from the map script, not object data.
5. **Flare Gun invisible-detection** — stock flare behavior unconfirmed for this patch era; verify in-game.
6. **Leviathian Charm summon damage** — nba2's attack fields are partially zeroed (`ua1b=0`); damage likely flows through its custom A04* abilities; cross-check against the ability analysis.
7. **R002 Tower Mechanics** — orphaned in object data (unresearchable, no unit references it). Verify whether a trigger applies the Main Harbor regen anyway, or whether it is dead content.
8. **Tome of Experience trigger top-up** — whether a trigger adds the missing 100 XP to match the 300-XP tooltip.

