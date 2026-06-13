# @bships/stats — architecture

The global stats board: a standalone service that records finished matches and
serves a leaderboard + per-player profiles. It is the persistence half of the
anonymous-with-claim identity model (see `docs/DESIGN.md`).

## Constraints (HARD RULES)

- **Zero deps beyond `workspace:@bships/core`.** Storage is Node's built-in
  `node:sqlite` (no `better-sqlite3`, no native module). Password hashing is
  `node:crypto` scrypt. HTTP is `node:http` (no framework).
- **The game server is the only writer.** `POST /ingest/match` requires the
  shared secret `STATS_INGEST_SECRET`. A browser client can read but never
  write match results.
- **Determinism does not apply here.** This service may use wall-clock time and
  ordinary randomness. (Those rules bind only the `@bships/core` sim.)
- The SQLite file lives under the gitignored `packages/stats/.data/` (override
  with `STATS_DB_PATH`).

## Modules / seam

```
index.ts ── boot: loadConfig(env) -> openDatabase(path) -> createStatsServer({repo,config}).listen()
config.ts ─ env -> StatsConfig (pure)
db.ts ───── StatsRepository: node:sqlite wrapper, migration, repo fns  (stats-db)
elo.ts ──── computeRatingChanges / expectedScore (pure)               (stats-elo)
http.ts ─── createStatsServer: node:http routing/auth/CORS/validation (stats-api)
schema.sql ─ canonical DDL, applied by openDatabase
types.ts ── service-internal types (config, repo rows, Elo seam); re-exports core DTOs
```

Wire DTOs (`MatchResultIngest`, `LeaderboardEntry`, `PlayerProfile`,
`ClaimRequest`/`ClaimResponse`, ...) live in **`@bships/core` `protocol.ts`** —
the single shared-types home both the game server (writer) and browser client
(reader) already import. `types.ts` re-exports them for local ergonomics.

`http.ts` depends on `db.ts` (a `StatsRepository`) and `config.ts` only.
`db.ts` depends on `elo.ts` (pure) only. `elo.ts` depends on nothing but core
constants. This DAG lets the three implementers work disjointly.

## HTTP routes

| Method | Path                  | Auth                  | Body / query        | Response (2xx)         |
|--------|-----------------------|-----------------------|---------------------|------------------------|
| POST   | `/ingest/match`       | Bearer ingest secret  | `MatchResultIngest` | `MatchIngestResponse`  |
| POST   | `/claim`              | none (rate-limited)   | `ClaimRequest`      | `ClaimResponse`        |
| POST   | `/login`              | none (rate-limited)   | `LoginRequest`      | `ClaimResponse`        |
| GET    | `/leaderboard?limit=` | none (CORS)           | `limit` (1..max)    | `LeaderboardResponse`  |
| GET    | `/players/:publicId`  | none (CORS)           | path `publicId`     | `PlayerProfile`        |
| GET    | `/healthz`            | none                  | —                   | `{ ok: true }`         |

Errors are JSON `StatsErrorResponse` (`{ error }`) with the appropriate status:
400 (bad/invalid body), 401 (bad ingest secret), 403/404 (claim conflicts /
unknown player), 429 (rate limit), 503 (ingest disabled — secret unset).

### Auth scheme

`/ingest/match` reads `Authorization: Bearer <secret>` and compares it to
`config.ingestSecret` with `crypto.timingSafeEqual` (constant time; length
mismatch => false). An empty configured secret disables the endpoint (503), so
a misconfigured deploy can never accept unauthenticated writes. All other
mutating endpoints are public but **rate-limited per client IP** (token bucket;
e.g. burst 5, refill ~1/30 s) to blunt credential stuffing on `/login` and
spam on `/claim`.

### CORS

The read endpoints (`/leaderboard`, `/players/:id`, `/healthz`) answer with
`Access-Control-Allow-Origin: <config.corsOrigin>` (default the Vite client
`http://localhost:5173`; `*` allowed). The client fetches these directly.
`/ingest/match` is server-to-server (no browser Origin) and not CORS-relaxed.

## Schema

Canonical DDL: `src/schema.sql` (STRICT tables; applied once at boot inside a
transaction; bump `SCHEMA_VERSION` in `db.ts` + add a migration when it
changes). Three tables:

- **`players`** — keyed by `public_id` (the token-derived stable id,
  `STATS_PUBLIC_ID_PATTERN`). Holds the running `rating` (default 1200),
  `wins`/`losses`/`matches_played`, and the claim fields (`email`,
  `password_hash`, `name_locked`) which are NULL until claimed. Partial unique
  indices enforce one email per claimed account and a unique locked name;
  `idx_players_rating` powers the leaderboard.
- **`matches`** — one row per recorded match (`ruleset_id`, `seed`,
  `started_at`, `ended_at`, `duration_ticks`, `winner_team` nullable). A unique
  `result_key` (hash of seed + startedAt + sorted participant ids) makes ingest
  **idempotent**: a retried POST returns the existing row, applies no second
  Elo change.
- **`match_participants`** — `(match_id, player_id)` PK, with `slot`, `team`,
  `ship_type_id`, `kills`, `deaths`, `gold_earned`, `won`, and the
  `rating_delta` / `rating_after` snapshot so profiles render history without
  recomputation. Indexed by `(player_id, match_id desc)` for recent-match
  queries and `(player_id, ship_type_id)` for the favorite-ship aggregate.

### recordMatch transaction

`StatsRepository.recordMatch` runs in ONE transaction:

1. `upsertPlayer` for every participant (seeds new players at 1200).
2. `computeRatingChanges(snapshots, winnerTeam)` from the just-read ratings.
3. Insert the `matches` row + all `match_participants` rows (with deltas).
4. Bump each player's `rating`, `wins`/`losses` (winner team +win, loser +loss;
   draw/aborted: neither), `matches_played`.

Idempotent on `result_key` — a duplicate is a no-op returning the existing
`matchId`. A draw (`winner_team` NULL) records the match with all
`rating_delta = 0` and no W/L change.

## ELO

Standard Elo, **K = 32**, team-vs-team on each team's **mean** rating.
Expected score for the team with mean `Ra` vs the other team mean `Rb`:

```
E = 1 / (1 + 10^((Rb - Ra) / 400))
delta = round(K * (S - E))     // S = 1 for the winning team, 0 for the loser
```

Every participating player on a team receives that team's delta; new players
start at `STARTING_RATING` (1200). `winnerTeam === null` => all deltas 0.
Ratings clamp at `>= 0`. Provisional/placement handling is optional and out of
scope for v1. Implemented purely in `elo.ts` (no IO), called from
`recordMatch`.

## publicId derivation

The stats primary key is **not** the WebSocket server's per-process
`RoomPlayer.publicId` (a throwaway `p`+hex handle that changes every restart).
Stats must key the same player across restarts AND devices, so the game server
derives it deterministically and non-reversibly from the secret token:

```
deriveStatsPublicId(token) = 's' + sha256(token).hex.slice(0, 16)
```

(`STATS_PUBLIC_ID_PATTERN` = `^s[0-9a-f]{16}$`.) The token never leaves the
authenticated ingest/claim/login paths and is never stored or echoed. See the
server-integration module (`packages/server/src/stats/`).
