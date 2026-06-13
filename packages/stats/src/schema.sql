-- @bships/stats schema (node:sqlite, STRICT tables).
--
-- Applied once at boot by stats-db (db.ts) inside a transaction; safe to run
-- repeatedly (every statement is IF NOT EXISTS). Bump SCHEMA_VERSION in db.ts
-- and add a migration when this changes — never edit a shipped statement.
--
-- Identity model (docs/DESIGN.md, anonymous-with-claim):
--   * Every player is keyed by `public_id` — a stable, non-reversible id the
--     game server derives from the secret token (deriveStatsPublicId). The
--     secret token itself is NEVER stored.
--   * A player is "claimed" once email + password_hash are set; until then the
--     row still accrues full stats tied to the token-derived public_id.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  -- Stable derived id (STATS_PUBLIC_ID_PATTERN: 's' + 16 hex). Primary key.
  public_id      TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  -- lowercased name, used for the claim-time name lock uniqueness check;
  -- NULL until the account is claimed (unclaimed names are NOT reserved).
  name_locked    TEXT,
  -- Claim fields: NULL until claimed.
  email          TEXT,             -- stored lowercased; UNIQUE among claimed
  password_hash  TEXT,             -- scrypt: 'scrypt$N$r$p$saltHex$hashHex'
  rating         INTEGER NOT NULL DEFAULT 1200,
  wins           INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL, -- epoch ms (wall clock; stats may use Date)
  updated_at     INTEGER NOT NULL
) STRICT;

-- One claimed email maps to exactly one player. Partial index so the many
-- unclaimed (NULL email) rows do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_email
  ON players (email) WHERE email IS NOT NULL;

-- Locked display names are unique among claimed accounts (case-insensitive,
-- via the lowercased name_locked column). Unclaimed players (NULL) excluded.
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name_locked
  ON players (name_locked) WHERE name_locked IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_players_rating ON players (rating DESC);

CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ruleset_id    TEXT    NOT NULL,
  seed          INTEGER NOT NULL,
  started_at    INTEGER NOT NULL, -- epoch ms
  ended_at      INTEGER NOT NULL, -- epoch ms (insert time)
  duration_ticks INTEGER NOT NULL,
  -- 'south' | 'north' | NULL (draw / aborted: no Elo, no W/L applied).
  winner_team   TEXT,
  -- Idempotency key for ingest retries: stable hash of the authoritative
  -- result (seed + startedAt + sorted participant publicIds). A repeat POST
  -- with the same key is a no-op (returns the existing row).
  result_key    TEXT    NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_result_key ON matches (result_key);
CREATE INDEX IF NOT EXISTS idx_matches_ended_at ON matches (ended_at DESC);

CREATE TABLE IF NOT EXISTS match_participants (
  match_id      INTEGER NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  player_id     TEXT    NOT NULL REFERENCES players (public_id),
  slot          INTEGER NOT NULL,
  team          TEXT    NOT NULL, -- 'south' | 'north'
  ship_type_id  TEXT    NOT NULL,
  kills         INTEGER NOT NULL,
  deaths        INTEGER NOT NULL,
  -- Cumulative gold earned over the match if the server tracks it; 0 when
  -- untracked (the current server reports 0 — the sim keeps only a live
  -- balance, not an earned tally). Read by no endpoint today.
  gold_earned   INTEGER NOT NULL,
  -- 1 if this participant's team won, else 0 (NULL winner -> 0 for both).
  won           INTEGER NOT NULL,
  -- Signed Elo delta this match applied to the player (0 on draw/aborted).
  rating_delta  INTEGER NOT NULL,
  -- Player rating AFTER this match (for profile history without recompute).
  rating_after  INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_participants_player
  ON match_participants (player_id, match_id DESC);
CREATE INDEX IF NOT EXISTS idx_participants_ship
  ON match_participants (player_id, ship_type_id);
