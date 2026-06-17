# Project status / session handoff

Snapshot for picking the project up in a new session. Durable rules are in
[CLAUDE.md](../CLAUDE.md); owner design decisions in [DESIGN.md](DESIGN.md);
engine semantics in [SEMANTICS.md](SEMANTICS.md); balance audit in
[BALANCE.md](BALANCE.md).

_Last updated: 2026-06-17._

## Where it stands

The game **boots and plays solo-vs-AI** end to end: core sim + authoritative
server + PixiJS client + stats board are all functional. Test counts at this
snapshot: **client 398, core 520, server 143**; lint clean; full build green;
determinism (AI-only seed-equal replay) intact.

To run: `pnpm install && pnpm dev`, open the client (`:5173`), **Create room →
Play vs AI** for a solo match.

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

- **In-game crash (task #15) — still unreproduced.** 150+ sim-minutes of headless
  AI play and this session's solo match threw nothing; likely client-side
  render/HUD. If it recurs, capture *what action* triggered it (buying a ship?
  casting? a shop? level-up? a death?) — that narrows it fast.
- **Exhaustive ability cast-system audit — re-run in the new session.** At the
  end of this session a multi-agent audit was running to *drive the sim and
  learn+cast every ability on every player hull* (proving each fires, not just
  the learn path), adversarially refute the results, and statically hunt the
  crash. Background workflows don't transfer across sessions — re-launch an
  equivalent audit and address any real defects it finds. The learn path and
  names are already verified; the broad **cast-fires-an-effect** path across all
  exotic `special` kinds is the main thing still to confirm end to end.
- **Map fidelity (task #14) — PARKED.** The color-key terrain is "pretty close";
  revisit later. Owner has described the topology (lanes, islands, entrances).

## Verifying UX reliably (lesson learned)

Screenshots/subagent "tests green" have missed real breakage. For HUD/ability
work: prove logic with deterministic tests, and confirm UI by reading **DOM +
store state** (e.g. `store.match.you.heroSkillLevels`, the `.bh-skillstrip`
chips) in a real browser — or have the owner confirm — before calling it done.
