/**
 * Stats-service-INTERNAL types. The WIRE DTOs (MatchResultIngest,
 * LeaderboardEntry, PlayerProfile, ClaimRequest/Response, ...) live in
 * @bships/core's protocol.ts so the server and client share them — re-exported
 * here for ergonomic local imports. Everything below is service-private: the
 * repository row/seam shapes and runtime config. None of it crosses the wire.
 */

export type {
  ClaimRequest,
  ClaimResponse,
  LeaderboardEntry,
  LeaderboardResponse,
  LoginRequest,
  MatchIngestResponse,
  MatchParticipantIngest,
  MatchResultIngest,
  PlayerProfile,
  ProfileMatchSummary,
  StatsErrorResponse,
} from '@bships/core';

import type { TeamId } from '@bships/core';

// ---------------------------------------------------------------------------
// Runtime configuration (read from env in index.ts; injectable for tests)
// ---------------------------------------------------------------------------

export interface StatsConfig {
  /** HTTP listen port (env STATS_PORT, default 8088). */
  port: number;
  /** SQLite file path (env STATS_DB_PATH, default packages/stats/.data/stats.db). */
  dbPath: string;
  /**
   * Shared secret the game server presents on /ingest/match (env
   * STATS_INGEST_SECRET). When empty/unset the ingest endpoint is DISABLED
   * (503) — never silently open — so a misconfigured deploy cannot accept
   * unauthenticated writes.
   */
  ingestSecret: string;
  /**
   * Allowed browser Origin for CORS on the public READ endpoints (env
   * STATS_CORS_ORIGIN, default 'http://localhost:5173'). '*' allows any.
   * Ingest/claim/login are server- or form-driven and not CORS-relaxed.
   */
  corsOrigin: string;
  /** Max rows GET /leaderboard returns regardless of ?limit (default 100). */
  maxLeaderboardLimit: number;
  /** Recent matches included on a PlayerProfile (default 10). */
  profileRecentLimit: number;
  /**
   * Honor the X-Forwarded-For header for rate-limit keying (env
   * STATS_TRUST_PROXY, default false). Only enable when the service sits behind
   * a trusted reverse proxy that SETS this header — otherwise a client can spoof
   * it to evade its own limit or weaponize a victim IP. When false, the limiter
   * keys on the raw socket address, which cannot be forged.
   */
  trustProxy: boolean;
}

// ---------------------------------------------------------------------------
// Repository row shapes (stats-db's public surface; stats-api consumes these)
// ---------------------------------------------------------------------------

/** A players-table row as the repository hands it back (camelCased). */
export interface PlayerRow {
  publicId: string;
  name: string;
  claimed: boolean;
  rating: number;
  wins: number;
  losses: number;
  matchesPlayed: number;
  createdAt: number;
  updatedAt: number;
}

/** Current rating of a participant, fed to the Elo module. */
export interface RatingSnapshot {
  publicId: string;
  team: TeamId;
  rating: number;
}

/** Per-player Elo delta returned by stats-elo (see elo.ts). */
export interface RatingChange {
  publicId: string;
  delta: number;
  /** rating + delta (clamped to >= 0). */
  ratingAfter: number;
}

/** Result of claimAccount / verifyLogin in the repository. */
export type ClaimOutcome =
  | { ok: true; row: PlayerRow }
  | {
      ok: false;
      reason: 'emailTaken' | 'nameTaken' | 'notFound' | 'badCredentials' | 'alreadyClaimed';
    };
