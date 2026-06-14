/**
 * Stats data layer (owned by stats-db). node:sqlite wrapper + schema migration
 * + repository functions. PURE DATA: no http, no env reads, no wall-clock
 * policy beyond stamping rows with the `now` the caller passes. The stats
 * service, unlike the sim core, may use ordinary time/randomness — but keep
 * `now` injectable so tests are deterministic.
 *
 * node:sqlite is built-in (Node >= 22.5; the repo runs Node >= 22). Types ship
 * with @types/node (sqlite.d.ts) — no extra dep, no ambient declaration. The
 * module is still flagged experimental at runtime; index.ts suppresses the
 * warning for the process. ALL writes that touch multiple rows (recordMatch:
 * insert match + participants + bump ratings/W-L) MUST run inside a single
 * transaction (db.exec('BEGIN') / 'COMMIT' / 'ROLLBACK') so a crash mid-ingest
 * cannot leave half a match recorded.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { STARTING_RATING } from '@bships/core';
import type {
  LeaderboardEntry,
  MatchResultIngest,
  PlayerProfile,
  ProfileMatchSummary,
} from '@bships/core';
import type { ClaimOutcome, PlayerRow } from './types.js';
import { computeRatingChanges } from './elo.js';

/** Bump when schema.sql changes (drives the migration table in openDatabase). */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Embedded schema DDL — avoids file-path resolution between src/ and dist/.
// Keep in sync with schema.sql (the canonical doc); openDatabase verifies via
// SCHEMA_VERSION.
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  public_id      TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  name_locked    TEXT,
  email          TEXT,
  password_hash  TEXT,
  rating         INTEGER NOT NULL DEFAULT 1200,
  wins           INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_players_email
  ON players (email) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_players_name_locked
  ON players (name_locked) WHERE name_locked IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_players_rating ON players (rating DESC);

CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ruleset_id    TEXT    NOT NULL,
  seed          INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER NOT NULL,
  duration_ticks INTEGER NOT NULL,
  winner_team   TEXT,
  result_key    TEXT    NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_result_key ON matches (result_key);
CREATE INDEX IF NOT EXISTS idx_matches_ended_at ON matches (ended_at DESC);

CREATE TABLE IF NOT EXISTS match_participants (
  match_id      INTEGER NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  player_id     TEXT    NOT NULL REFERENCES players (public_id),
  slot          INTEGER NOT NULL,
  team          TEXT    NOT NULL,
  ship_type_id  TEXT    NOT NULL,
  kills         INTEGER NOT NULL,
  deaths        INTEGER NOT NULL,
  gold_earned   INTEGER NOT NULL,
  won           INTEGER NOT NULL,
  rating_delta  INTEGER NOT NULL,
  rating_after  INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_participants_player
  ON match_participants (player_id, match_id DESC);
CREATE INDEX IF NOT EXISTS idx_participants_ship
  ON match_participants (player_id, ship_type_id);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
) STRICT;
`;

// ---------------------------------------------------------------------------
// Internal row types returned by prepared statements (null-prototype objects).
// The node:sqlite @types/node binding returns Record<string,SQLOutputValue>;
// we cast via `unknown` at each call site to our typed internal interfaces.
// ---------------------------------------------------------------------------

interface PlayerDbRow {
  public_id: string;
  name: string;
  name_locked: string | null;
  email: string | null;
  password_hash: string | null;
  rating: number;
  wins: number;
  losses: number;
  matches_played: number;
  created_at: number;
  updated_at: number;
}

interface MatchDbRow {
  id: number;
  result_key: string;
}

interface ParticipantDbRow {
  match_id: number;
  ended_at: number;
  ruleset_id: string;
  team: string;
  won: number;
  ship_type_id: string;
  kills: number;
  deaths: number;
  rating_delta: number;
}

interface FavoriteShipRow {
  ship_type_id: string;
}

interface SchemaVersionRow {
  version: number;
}

function rowToPlayerRow(r: PlayerDbRow): PlayerRow {
  return {
    publicId: r.public_id,
    name: r.name,
    claimed: r.email !== null,
    rating: r.rating,
    wins: r.wins,
    losses: r.losses,
    matchesPlayed: r.matches_played,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Compute the idempotency key for a match result: sha256 of the seed +
 * startedAt + sorted participant publicIds.
 */
function computeResultKey(result: MatchResultIngest): string {
  const parts = [
    String(result.seed),
    String(result.startedAt),
    ...result.participants.map((p) => p.publicId).sort(),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * The repository: every DB touch the service makes goes through these. The
 * implementation holds a single DatabaseSync handle (SQLite is synchronous;
 * one connection is correct and simplest). Construct via openDatabase.
 */
export interface StatsRepository {
  /** Underlying handle — exposed for tests (e.g. integrity_check) and close. */
  readonly db: DatabaseSync;
  close(): void;

  /** Resolve a player by derived public id, or null. */
  getPlayerByPublicId(publicId: string): PlayerRow | null;

  /**
   * Resolve-or-create the player row for `publicId`, seeding rating at
   * STARTING_RATING. Idempotent. `name` refreshes the display name for an
   * UNCLAIMED player; a CLAIMED player's name is locked and `name` is ignored.
   */
  upsertPlayer(publicId: string, name: string, now: number): PlayerRow;

  /**
   * Record a finished match atomically (single transaction):
   *   1. upsert every participant's player row,
   *   2. compute Elo deltas (stats-elo) from current ratings + winnerTeam,
   *   3. insert the match + participant rows (with rating_delta/after),
   *   4. bump each player's rating, wins/losses, matches_played.
   * Idempotent on the result key (see schema): a repeat of the same
   * authoritative result returns the existing matchId with duplicate: true and
   * applies NO second rating change. Returns the row id + duplicate flag.
   */
  recordMatch(result: MatchResultIngest, now: number): { matchId: number; duplicate: boolean };

  /** Top players by rating desc, capped at `limit`. */
  getLeaderboard(limit: number): LeaderboardEntry[];

  /** Full public profile (ratings, W/L, favorite ship, recent matches). */
  getPlayerProfile(publicId: string, recentLimit: number): PlayerProfile | null;

  /**
   * Attach email + scrypt password hash to the player keyed by `publicId`,
   * locking `name`. Enforces unique email (among claimed) + unique locked name.
   * Creating the row first if it does not exist. See ClaimOutcome for failures.
   */
  claimAccount(
    publicId: string,
    email: string,
    password: string,
    name: string,
    now: number,
  ): ClaimOutcome;

  /** Verify email + password against a claimed account. */
  verifyLogin(email: string, password: string): ClaimOutcome;
}

/**
 * Open (creating + migrating if needed) the SQLite database at `path`
 * (':memory:' for tests), apply schema.sql, and return the repository.
 */
export function openDatabase(path: string): StatsRepository {
  const db = new DatabaseSync(path);

  // Wait briefly for a lock instead of failing instantly with SQLITE_BUSY. The
  // single-connection design (one writer) makes contention unlikely, but a
  // second stats process / external tool would otherwise produce spurious 500s
  // that rely entirely on the ingest poster's retry. Cheap and safe.
  db.exec('PRAGMA busy_timeout = 5000');

  // Apply schema inside a transaction (idempotent: all statements are IF NOT EXISTS).
  db.exec('BEGIN');
  try {
    db.exec(SCHEMA_SQL);
    // Ensure the schema_version row exists.
    const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | SchemaVersionRow
      | undefined;
    if (versionRow === undefined) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // ---------------------------------------------------------------------------
  // Prepared statements (created once, reused for the lifetime of the repo).
  // The @types/node binding does not support generics on prepare(); we cast
  // results at each call site via `as unknown as T`.
  // ---------------------------------------------------------------------------

  const stmtGetPlayer = db.prepare('SELECT * FROM players WHERE public_id = ?');

  const stmtInsertPlayer = db.prepare(
    `INSERT INTO players (public_id, name, rating, wins, losses, matches_played, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, 0, ?, ?)
     ON CONFLICT (public_id) DO NOTHING`,
  );

  const stmtUpdateName = db.prepare(
    `UPDATE players SET name = ?, updated_at = ?
     WHERE public_id = ? AND name_locked IS NULL`,
  );

  const stmtCheckDuplicate = db.prepare('SELECT id, result_key FROM matches WHERE result_key = ?');

  const stmtInsertMatch = db.prepare(
    `INSERT INTO matches (ruleset_id, seed, started_at, ended_at, duration_ticks, winner_team, result_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const stmtInsertParticipant = db.prepare(
    `INSERT INTO match_participants
       (match_id, player_id, slot, team, ship_type_id, kills, deaths, gold_earned, won, rating_delta, rating_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const stmtBumpPlayerStats = db.prepare(
    `UPDATE players
     SET rating = ?, wins = wins + ?, losses = losses + ?, matches_played = matches_played + 1, updated_at = ?
     WHERE public_id = ?`,
  );

  const stmtLeaderboard = db.prepare('SELECT * FROM players ORDER BY rating DESC LIMIT ?');

  const stmtFavoriteShip = db.prepare(
    `SELECT ship_type_id
     FROM match_participants
     WHERE player_id = ?
     GROUP BY ship_type_id
     ORDER BY COUNT(*) DESC
     LIMIT 1`,
  );

  const stmtRecentMatches = db.prepare(
    `SELECT mp.match_id, m.ended_at, m.ruleset_id, mp.team, mp.won, mp.ship_type_id,
            mp.kills, mp.deaths, mp.rating_delta
     FROM match_participants mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ?
     ORDER BY m.ended_at DESC, mp.match_id DESC
     LIMIT ?`,
  );

  const stmtGetPlayerByEmail = db.prepare('SELECT * FROM players WHERE email = ?');

  // ---------------------------------------------------------------------------
  // Repository implementation
  // ---------------------------------------------------------------------------

  function getPlayerByPublicId(publicId: string): PlayerRow | null {
    const row = stmtGetPlayer.get(publicId) as unknown as PlayerDbRow | undefined;
    return row !== undefined ? rowToPlayerRow(row) : null;
  }

  function upsertPlayer(publicId: string, name: string, now: number): PlayerRow {
    // Insert if not exists (rating seeds at STARTING_RATING).
    stmtInsertPlayer.run(publicId, name, STARTING_RATING, now, now);
    // For unclaimed players: refresh the name (claimed players are locked via name_locked).
    stmtUpdateName.run(name, now, publicId);
    const row = stmtGetPlayer.get(publicId) as unknown as PlayerDbRow;
    return rowToPlayerRow(row);
  }

  function recordMatch(
    result: MatchResultIngest,
    now: number,
  ): { matchId: number; duplicate: boolean } {
    const resultKey = computeResultKey(result);

    // Check idempotency before starting the transaction (fast path for common case).
    const existing = stmtCheckDuplicate.get(resultKey) as unknown as MatchDbRow | undefined;
    if (existing !== undefined) {
      return { matchId: existing.id, duplicate: true };
    }

    db.exec('BEGIN');
    try {
      // Re-check inside the transaction to guard against a tight race.
      const existingInTx = stmtCheckDuplicate.get(resultKey) as unknown as MatchDbRow | undefined;
      if (existingInTx !== undefined) {
        db.exec('ROLLBACK');
        return { matchId: existingInTx.id, duplicate: true };
      }

      // 1. Upsert every participant (seeds new players at STARTING_RATING).
      for (const p of result.participants) {
        stmtInsertPlayer.run(p.publicId, p.name, STARTING_RATING, now, now);
        stmtUpdateName.run(p.name, now, p.publicId);
      }

      // 2. Read current ratings for Elo computation.
      const snapshots = result.participants.map((p) => {
        const row = stmtGetPlayer.get(p.publicId) as unknown as PlayerDbRow;
        return { publicId: p.publicId, team: p.team, rating: row.rating };
      });

      // 3. Compute Elo deltas.
      const ratingChanges = computeRatingChanges(snapshots, result.winnerTeam);
      const changeByPublicId = new Map(ratingChanges.map((c) => [c.publicId, c]));

      // A match is RANKED only when it has a determined winner AND at least two
      // distinct teams among participants. A one-team (opponent-less) result —
      // however it reaches us — applies no Elo (guarded in elo.ts) and must
      // likewise apply NO W/L bump, otherwise it is a free win farm. The row is
      // still recorded (won/delta = 0) for auditability.
      const distinctTeams = new Set(result.participants.map((p) => p.team));
      const ranked = result.winnerTeam !== null && distinctTeams.size >= 2;

      // 4. Insert the matches row.
      const matchResult = stmtInsertMatch.run(
        result.rulesetId,
        result.seed,
        result.startedAt,
        now,
        result.durationTicks,
        result.winnerTeam ?? null,
        resultKey,
      );
      const matchId = Number(matchResult.lastInsertRowid);

      // 5. Insert participant rows + bump player stats.
      for (const p of result.participants) {
        const change = changeByPublicId.get(p.publicId) ?? {
          delta: 0,
          ratingAfter: STARTING_RATING,
        };
        const won = ranked && p.team === result.winnerTeam ? 1 : 0;

        stmtInsertParticipant.run(
          matchId,
          p.publicId,
          p.slot,
          p.team,
          p.shipTypeId,
          p.kills,
          p.deaths,
          p.goldEarned,
          won,
          change.delta,
          change.ratingAfter,
        );

        // Bump wins/losses only for a RANKED result (determined winner + a real
        // opposing team). Unranked one-team results record a row but no W/L.
        const winBump = ranked && p.team === result.winnerTeam ? 1 : 0;
        const lossBump = ranked && p.team !== result.winnerTeam ? 1 : 0;

        stmtBumpPlayerStats.run(change.ratingAfter, winBump, lossBump, now, p.publicId);
      }

      db.exec('COMMIT');
      return { matchId, duplicate: false };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function getLeaderboard(limit: number): LeaderboardEntry[] {
    const rows = stmtLeaderboard.all(limit) as unknown as PlayerDbRow[];
    return rows.map((r) => ({
      publicId: r.public_id,
      name: r.name,
      rating: r.rating,
      wins: r.wins,
      losses: r.losses,
      matchesPlayed: r.matches_played,
      claimed: r.email !== null,
    }));
  }

  function getPlayerProfile(publicId: string, recentLimit: number): PlayerProfile | null {
    const playerRow = stmtGetPlayer.get(publicId) as unknown as PlayerDbRow | undefined;
    if (playerRow === undefined) return null;

    const favRow = stmtFavoriteShip.get(publicId) as unknown as FavoriteShipRow | undefined;
    const recentRows = stmtRecentMatches.all(publicId, recentLimit) as unknown as ParticipantDbRow[];

    const recentMatches: ProfileMatchSummary[] = recentRows.map((r) => ({
      matchId: r.match_id,
      endedAt: r.ended_at,
      rulesetId: r.ruleset_id,
      team: r.team as import('@bships/core').TeamId,
      won: r.won === 1,
      shipTypeId: r.ship_type_id,
      kills: r.kills,
      deaths: r.deaths,
      ratingDelta: r.rating_delta,
    }));

    return {
      publicId: playerRow.public_id,
      name: playerRow.name,
      claimed: playerRow.email !== null,
      rating: playerRow.rating,
      wins: playerRow.wins,
      losses: playerRow.losses,
      matchesPlayed: playerRow.matches_played,
      favoriteShipTypeId: favRow?.ship_type_id ?? null,
      recentMatches,
    };
  }

  function claimAccount(
    publicId: string,
    email: string,
    password: string,
    name: string,
    now: number,
  ): ClaimOutcome {
    const normalizedEmail = email.toLowerCase();
    const normalizedName = name.toLowerCase();
    const hash = hashPassword(password);

    // Ensure the player row exists (creates it if needed).
    stmtInsertPlayer.run(publicId, name, STARTING_RATING, now, now);

    // A claim LOCKS the account. Re-claiming an already-claimed publicId must
    // NOT silently overwrite email/password/locked-name (that would free the
    // old email + name for someone else and let a token holder churn the
    // record). Idempotent retry with the SAME email is accepted (returns the
    // existing row unchanged); any other re-claim is rejected.
    const existing = stmtGetPlayer.get(publicId) as unknown as PlayerDbRow;
    if (existing.email !== null || existing.password_hash !== null) {
      if (existing.email === normalizedEmail) {
        return { ok: true, row: rowToPlayerRow(existing) };
      }
      return { ok: false, reason: 'alreadyClaimed' };
    }

    try {
      db.prepare(
        `UPDATE players
         SET email = ?, password_hash = ?, name = ?, name_locked = ?, updated_at = ?
         WHERE public_id = ?`,
      ).run(normalizedEmail, hash, name, normalizedName, now, publicId);

      const row = stmtGetPlayer.get(publicId) as unknown as PlayerDbRow;
      return { ok: true, row: rowToPlayerRow(row) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('idx_players_email') || msg.includes('players.email')) {
        return { ok: false, reason: 'emailTaken' };
      }
      if (msg.includes('idx_players_name_locked') || msg.includes('players.name_locked')) {
        return { ok: false, reason: 'nameTaken' };
      }
      throw err;
    }
  }

  function verifyLogin(email: string, password: string): ClaimOutcome {
    const normalizedEmail = email.toLowerCase();
    const row = stmtGetPlayerByEmail.get(normalizedEmail) as unknown as PlayerDbRow | undefined;

    // Constant-time w.r.t. account existence: a missing row (or a row with no
    // password set) still runs one scrypt verification against a fixed dummy
    // hash, so the no-account and wrong-password paths take the same wall time.
    // Without this, "not found" returns in microseconds while "wrong password"
    // costs a full scrypt (~35 ms) — a remote timing oracle for account/email
    // enumeration. The dummy verification can never succeed (password != dummy).
    const hash = row?.password_hash ?? null;
    const ok = verifyPassword(password, hash ?? DUMMY_PASSWORD_HASH);
    if (row === undefined || hash === null || !ok) {
      return { ok: false, reason: row === undefined ? 'notFound' : 'badCredentials' };
    }
    return { ok: true, row: rowToPlayerRow(row) };
  }

  return {
    db,
    close() {
      db.close();
    },
    getPlayerByPublicId,
    upsertPlayer,
    recordMatch,
    getLeaderboard,
    getPlayerProfile,
    claimAccount,
    verifyLogin,
  };
}

// ---------------------------------------------------------------------------
// scrypt password helpers
// ---------------------------------------------------------------------------

/** scrypt parameters for hashPassword. Encoded as 'scrypt$N$r$p$saltHex$hashHex'. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;
const SCRYPT_SALT_LEN = 32;

/**
 * scrypt password hashing helpers (node:crypto, built-in). Encoded string form
 * 'scrypt$N$r$p$saltHex$hashHex'; verify with timingSafeEqual. Exposed for the
 * repository + direct unit tests.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_LEN);
  const key = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const hashHex = parts[5];

  if (!saltHex || !hashHex) return false;
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, salt, expected.length, { N, r, p });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A fixed, well-formed scrypt hash of a random secret, computed once at module
 * load. verifyLogin runs a verification against this on the account-not-found
 * (and no-password) paths so they cost the same scrypt work as a wrong-password
 * attempt — closing the login timing oracle. No real password can equal the
 * random secret, so this verification never spuriously succeeds.
 */
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('hex'));
