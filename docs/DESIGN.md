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
