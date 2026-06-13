# Design requirements

Decisions confirmed with the project owner. These override defaults; change
only with explicit sign-off.

## Platform

Web-based multiplayer. Browser client (PixiJS, 2D top-down, WC3-style
readability), authoritative Node WebSocket game server, global stats board as
a web page. No install. Identity: anonymous play with a persistent token and
chosen name, claimable later with email/password.

## Fidelity vs. balance

- **Classic ruleset**: the extracted BattleShips Pro v1.187 numbers, verbatim.
  Always available, never edited. This is the reference implementation.
- **Balanced ruleset(s)**: versioned data patches applied on top of Classic
  (e.g. `bships-1.1`), each with a changelog. Lobby host picks the ruleset.
- Balance changes must be evidence-driven: ladder win rates per ship/weapon
  from the global stats board, plus the static DPS-per-gold audit in
  [BALANCE.md](BALANCE.md). No drive-by nerfs.
- Rulesets are pure data (JSON overrides) — the simulation core never
  hardcodes balance numbers.

## Camera & rendering

- 2.5D "slight angle": WC3-style tilted-camera look on the PixiJS 2D renderer —
  slight vertical foreshortening of the world plane, ship/structure sprites
  authored from a 3/4 angled view, y-sorted draw order so tall objects (sails,
  towers) read as standing up. Not flat top-down, not full 3D. A true
  perspective tilt (pixi-projection) is an allowed later upgrade; the renderer
  must keep world-space and screen-space transforms behind one camera
  abstraction so this can change without touching game code.
- Zoom: mouse-wheel zoom-to-cursor, smooth, clamped [close-up … overview].
  The allowed zoom range is a lobby/ruleset setting and is capped in ranked
  play (zoom-out grants screen real estate; vision itself stays server-side
  fog of war, so zoom never reveals unexplored/unscouted areas).
- Camera pan: edge scroll + middle-drag + minimap click, WC3 muscle memory.

## Art direction (confirmed 2026-06-13)

Owner deferred to judgment: "more 3D-ish but lets just get the mechanics and
decent graphics". Decision:
- **Procedural, no external assets** — everything drawn in PixiJS code.
  License-clean for the public repo, scales to all 18 ship classes, full
  control, stays readable for competitive play. (3D models are out of scope:
  this is a 2D renderer. We fake depth instead.)
- **Pseudo-3D depth** to satisfy "more 3D-ish": the existing 2.5D tilt plus
  drop shadows on the water under every unit/structure, beveled/shaded hulls
  lit from a consistent angle, elevated structures with height, layered/
  depth-shaded animated water, and correct y-sorted draw order.
- **Modern-clean tone**: crisp, high-contrast, class/team/HP instantly
  legible — polished-indie-RTS look over nostalgia.
- Fix known placeholder problems: ship sprites read as crude "crayons";
  structure markers (flags) render wildly oversized; flat water; HUD chat box
  floats mid-screen and the minimap overlaps the play area. All addressed in
  the graphics-overhaul pass.

## Controls

- All frequently-used keys must sit in the left-hand home cluster
  (`Q W E R / A S D F` region) — requirement from competitive play. The
  original WC3 numpad item hotkeys are explicitly rejected.
- Default preset: 6 inventory/weapon slots on `W E R A S D`, ship ability on
  `F`, with `Q` reserved (shop/interact candidate). Exact assignments get
  tuned in playtesting; treat this as the starting point, not gospel.
- Every binding is rebindable per user; presets include "Cluster" (default)
  and "WC3 Classic" (numpad nostalgia option).
- Movement stays WC3-style: right-click to move, with attack-move and stop
  available but not occupying prime cluster keys (weapons auto-fire in BSP;
  stop/attack-move are secondary).

## Non-goals

- No redistribution of the original map file or any Blizzard assets; all art
  is original. Credit Sked and Quantum_Theory prominently.
- No gameplay features absent from 1.187 until Classic parity is reached.
