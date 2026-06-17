# CLAUDE.md — working rules for this repo

A faithful, standalone **browser** recreation of the Warcraft III custom map
**BattleShips Pro v1.187** (by Sked, edited by Quantum_Theory): 5v5 naval
combat, three lanes, auto-firing weapon arcs, creeps, towers, traders, missile
silos. Original code and art only — see the design intent in [README.md](README.md)
and [docs/DESIGN.md](docs/DESIGN.md). **For current state / where to pick up, read
[docs/STATUS.md](docs/STATUS.md) first.**

## Hard rules (do not violate)

1. **Never commit the map or decoded game assets.** The original
   `reference/BattleShipsPro_v1.187.w3x` and decoded imagery under
   `data/reference/` are NOT redistributed (both are `.gitignore`d). The project
   ships extracted *numbers* (`data/json/`), never Blizzard/WC3 assets or the map
   file. If you regenerate data, do it from your own copy via `make extract`.
2. **The simulation is deterministic and must stay that way.** `packages/core`
   runs at a fixed 20 ticks/s with a seeded `mulberry32` RNG and produces
   bit-identical replays for seed-equal inputs (`hashState`; an AI-only
   seed-equal replay test enforces this). Never use `Date.now()`/`Math.random()`
   or wall-clock/iteration-order nondeterminism in the sim — take randomness from
   the seeded `Rng`. A change that breaks the determinism test is a regression.
3. **The server is authoritative.** The client compiles the ruleset only for
   *display* (`packages/client/src/catalog.ts` `getCatalog()`); every gameplay
   outcome is decided by `packages/server` running the same `@bships/core` sim.
   Never make the client trust its own sim for outcomes.
4. **Fidelity to the original beats everything else.** Gameplay numbers and
   behaviors come from the map script (`data/extracted/war3map.j`) and object
   data; deliberate divergences are documented in [docs/SEMANTICS.md](docs/SEMANTICS.md)
   and [docs/BALANCE.md](docs/BALANCE.md). The owner is a former competitive
   player and prioritizes gameplay TRUTH over graphics. When unsure, match the
   JASS, and don't "improve" balance silently.
5. **Green before commit/merge.** `pnpm build`, `pnpm test`, and `pnpm lint` must
   all pass. Don't mark work done or merge on red.

## Verify like the owner plays

UX claims have repeatedly been "verified" via screenshots/subagent reports and
then failed in real play. Don't trust those for live behavior. Prove logic with
**deterministic tests** (drive the real sim / pure HUD functions), and prove UI
by reading **DOM + game state** (not screenshots) in a real browser, or by the
owner confirming. Don't declare a UX fix working until one of those holds.

## Architecture

| Package | Runtime | Role |
| --- | --- | --- |
| `packages/core` (`@bships/core`) | shared | Deterministic fixed-tick sim: movement/pathfinding, weapon arcs, creeps, towers, income, abilities, AI. `compileClassicRuleset(rawDataFiles)` builds the `Ruleset` from `data/json/`. |
| `packages/server` (`@bships/server`) | node | Authoritative WebSocket server: lobbies, 5v5 rooms, solo-vs-AI, reconnect. Per tick: `applyCommands` → `stepTick`, sends snapshots. |
| `packages/client` (`@bships/client`) | browser | PixiJS v8 + Vite, WC3-style HUD. Pure HUD logic lives in `src/hud/hudmath.ts` (unit-tested with no DOM). |
| `packages/stats` (`@bships/stats`) | node | Global stats board (`node:sqlite`): anonymous-claim accounts, match history, ladder. |
| `tools/extractor` | python | `.w3x` → `data/json/` object data + script. |

## Commands

```sh
pnpm install
pnpm build          # pnpm -r build
pnpm test           # pnpm -r test  (vitest)
pnpm lint           # eslint .
pnpm dev            # client :5173, server :8787, stats :8088
make extract        # regenerate data/json from reference/BattleShipsPro_v1.187.w3x (yours)
```

Requires Node ≥ 22, pnpm 10; the extractor needs Python ≥ 3.10. TypeScript is
strict, ESM throughout, tests are vitest.

## Conventions

- Match the surrounding code's style, naming, and comment density.
- HUD logic that can be pure goes in `hudmath.ts` with a unit test; DOM wiring in
  the panel modules (`inventory.ts`, `shop.ts`, …).
- Ships are WC3 **hero units**: `ShipSpec.name` is the generic class (drives the
  sprite); `ShipSpec.properName` is the distinct hull name shown in UI.
- Commit messages end with the co-author trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Branch off `main` for changes; open a PR to merge.
