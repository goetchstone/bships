/**
 * Stats ingest client (owned by server-integration). On matchEnded the game
 * server builds the authoritative MatchResultIngest and POSTs it to the stats
 * service at STATS_URL/ingest/match with the STATS_INGEST_SECRET bearer.
 *
 * HARD RULES:
 * - Fire-and-forget: NEVER block or crash the tick loop / room teardown. A
 *   failed post is logged and retried with backoff on a detached promise; the
 *   match-end path returns immediately.
 * - No-op when unconfigured: if STATS_URL or STATS_INGEST_SECRET is unset the
 *   poster is disabled (returns a null/no-op poster) so local dev and tests
 *   run without a stats service.
 * - The server is the sole source of truth for outcomes; this is the only code
 *   that may include the secret identity TOKEN in an outbound request, and it
 *   only ever sends it to the configured stats service over the auth header.
 *
 * Env: STATS_URL (e.g. http://localhost:8088), STATS_INGEST_SECRET.
 * Uses global fetch (Node >= 18) — zero new deps.
 */

import type { MatchResultIngest } from '@bships/core';

export interface StatsPosterConfig {
  /** Base URL of the stats service (no trailing slash needed). */
  url: string;
  /** Shared secret presented as `Authorization: Bearer <secret>`. */
  secret: string;
  /** Max attempts before giving up (default 4). */
  maxAttempts?: number;
  /** Base backoff ms; attempt N waits baseBackoffMs * 2^(N-1) (default 500). */
  baseBackoffMs?: number;
  /** fetch override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface StatsPoster {
  /**
   * Queue an authoritative result for delivery. Returns immediately; delivery
   * (with retry/backoff) happens on a detached promise. Safe to call from the
   * match-end path. A no-op poster (unconfigured) silently drops the result.
   */
  postMatchResult(result: MatchResultIngest): void;
}

/** A poster that drops everything — used when stats is not configured. */
export function createNoopStatsPoster(): StatsPoster {
  return { postMatchResult: () => {} };
}

/**
 * Build a poster from explicit config. index.ts calls createStatsPosterFromEnv
 * (below) for the real process; tests construct this directly with a fake
 * fetch + tiny backoff.
 */
export function createStatsPoster(config: StatsPosterConfig): StatsPoster {
  const maxAttempts = config.maxAttempts ?? 4;
  const baseBackoffMs = config.baseBackoffMs ?? 500;
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = `${config.url.replace(/\/$/, '')}/ingest/match`;
  const authHeader = `Bearer ${config.secret}`;

  return {
    postMatchResult(result: MatchResultIngest): void {
      // Fire-and-forget: never throw into the caller, never await.
      void (async () => {
        const body = JSON.stringify(result);
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const res = await fetchImpl(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: authHeader,
              },
              body,
            });
            if (res.ok) return; // success
            console.warn(`[stats] ingest attempt ${attempt}/${maxAttempts} failed: HTTP ${res.status}`);
          } catch (err) {
            console.warn(`[stats] ingest attempt ${attempt}/${maxAttempts} error:`, err);
          }
          if (attempt < maxAttempts) {
            // Exponential backoff: baseBackoffMs * 2^(attempt-1)
            const delayMs = baseBackoffMs * Math.pow(2, attempt - 1);
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          }
        }
        console.error(`[stats] ingest gave up after ${maxAttempts} attempts`);
      })();
    },
  };
}

/**
 * Read STATS_URL + STATS_INGEST_SECRET from env; returns a no-op poster when
 * either is unset (so unconfigured deploys/tests are silent). index.ts wires
 * the result into the room manager's match-end hook.
 */
export function createStatsPosterFromEnv(env: NodeJS.ProcessEnv): StatsPoster {
  const url = env['STATS_URL'];
  const secret = env['STATS_INGEST_SECRET'];
  if (url === undefined || url === '' || secret === undefined || secret === '') {
    return createNoopStatsPoster();
  }
  return createStatsPoster({ url, secret });
}
