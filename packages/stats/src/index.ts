#!/usr/bin/env node
/**
 * @bships/stats entry point + bin (`bships-stats`). Reads runtime config from
 * the environment, opens the SQLite database (creating + migrating on first
 * run), and starts the HTTP server.
 *
 * Determinism does NOT apply here (this is service IO, not the sim core): wall
 * clock + ordinary randomness are fine. node:sqlite is still flagged
 * experimental, so we silence ONLY that one warning to keep logs clean.
 *
 * Env (all optional except the ingest secret in production):
 *   STATS_PORT           HTTP port               (default 8088)
 *   STATS_DB_PATH        SQLite file path        (default packages/stats/.data/stats.db)
 *   STATS_INGEST_SECRET  shared secret for /ingest/match (empty => ingest 503)
 *   STATS_CORS_ORIGIN    allowed read-endpoint origin (default http://localhost:5173)
 */

import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createStatsServer } from './http.js';
import { loadConfig } from './config.js';

// Re-export the building blocks so other workspace packages (e.g. the server's
// end-to-end test) can boot a real stats service in-process on an ephemeral
// port + temp DB, exactly as main() does, without reaching into submodules.
export { openDatabase } from './db.js';
export { createStatsServer } from './http.js';
export type { StatsServer } from './http.js';
export { loadConfig } from './config.js';
export type { StatsConfig } from './types.js';

/** Hide the single 'SQLite is an experimental feature' ExperimentalWarning. */
function silenceSqliteWarning(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite is an experimental feature')) return;
    (original as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

export async function main(): Promise<void> {
  silenceSqliteWarning();
  const config = loadConfig(process.env);
  const repo = openDatabase(config.dbPath);
  const server = createStatsServer({ repo, config });
  const port = await server.listen();
  console.log(`[bships-stats] listening on :${port} (db ${config.dbPath})`);
  if (config.ingestSecret === '') {
    console.warn('[bships-stats] STATS_INGEST_SECRET unset — /ingest/match is DISABLED (503)');
  }
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error('[bships-stats] failed to start:', err);
    process.exitCode = 1;
  });
}
