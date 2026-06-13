/**
 * Stats service base URL for the browser client (owned by client-stats).
 * Configurable via the Vite env var VITE_STATS_URL; defaults to the local
 * stats service on :8088. All client-stats fetches go through api.ts, which
 * reads this. Read endpoints are CORS-enabled on the service for the client
 * origin (see packages/stats/docs/ARCH.md).
 */

/** Base URL of the stats service (no trailing slash). */
export const STATS_BASE_URL: string = (
  import.meta.env.VITE_STATS_URL ?? 'http://localhost:8088'
).replace(/\/$/, '');
