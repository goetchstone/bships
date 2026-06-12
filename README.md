# BShips

A faithful, standalone browser recreation of **BattleShips Pro v1.187**, the
classic Warcraft III custom map by **Sked**, edited by **Quantum_Theory** —
5v5 naval combat across three lanes: ships, item weapons that fire on their
own arcs, creep waves, upgradeable towers, traders, and missile silos.

This project recreates the *gameplay* (rules, numbers, map layout) with
original code and art. It does not redistribute the map file or any
Blizzard/Warcraft III assets. All credit for the game design belongs to Sked,
Quantum_Theory, and the wider Battle Ships community.

## Architecture

| Piece | Where | What |
| --- | --- | --- |
| `packages/core` | shared | Deterministic fixed-tick simulation: movement, weapon arcs, creeps, towers, income, missiles. Runs identically on server and client (deterministic trig + seeded RNG). |
| `packages/client` | browser | PixiJS 2D top-down client, WC3-style controls. *(planned)* |
| `packages/server` | node | Authoritative WebSocket game server: lobbies, 5v5 rooms, reconnect. *(planned)* |
| `packages/stats` | node | Global stats board: anonymous-claim accounts, match history, ELO ladder. *(planned)* |
| `tools/extractor` | python | Extracts object data + script from the original `.w3x` into `data/json/`. |

## Game data

Balance data (122 items, 78 units, 209 abilities, 63 buffs, 6 upgrades, all
strings) is extracted from the original map into versioned JSON under
[data/json/](data/json/). To regenerate, place the map at
`reference/BattleShipsPro_v1.187.w3x` (it is on the public archives, e.g.
Epic War map #821) and run:

```sh
make extract
```

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Requires Node ≥ 22 and pnpm 10. The extractor requires Python ≥ 3.10.
