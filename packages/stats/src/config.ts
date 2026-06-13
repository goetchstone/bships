/**
 * Env -> StatsConfig parsing. Pure (takes an env record, returns config) so
 * tests can build a config without touching process.env. The defaults match
 * the project conventions: stats on :8088, DB under the gitignored .data dir,
 * CORS for the Vite client origin (:5173).
 */

import { fileURLToPath } from 'node:url';
import type { StatsConfig } from './types.js';

/** Default SQLite path: packages/stats/.data/stats.db, relative to this file. */
export function defaultDbPath(): string {
  // src/config.ts (dev via tsx) or dist/config.js (built) -> ../.data/stats.db.
  return fileURLToPath(new URL('../.data/stats.db', import.meta.url));
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Build the runtime config from an environment record (process.env). */
export function loadConfig(env: NodeJS.ProcessEnv): StatsConfig {
  return {
    port: intEnv(env['STATS_PORT'], 8088),
    dbPath: env['STATS_DB_PATH'] ?? defaultDbPath(),
    ingestSecret: env['STATS_INGEST_SECRET'] ?? '',
    corsOrigin: env['STATS_CORS_ORIGIN'] ?? 'http://localhost:5173',
    maxLeaderboardLimit: intEnv(env['STATS_MAX_LEADERBOARD'], 100),
    profileRecentLimit: intEnv(env['STATS_PROFILE_RECENT'], 10),
    trustProxy: env['STATS_TRUST_PROXY'] === '1' || env['STATS_TRUST_PROXY'] === 'true',
  };
}
