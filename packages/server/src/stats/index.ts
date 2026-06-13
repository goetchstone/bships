/** Barrel: re-exports for the stats integration sub-module. */
export { createNoopStatsPoster, createStatsPoster, createStatsPosterFromEnv } from './ingest.js';
export type { StatsPoster, StatsPosterConfig } from './ingest.js';
export { deriveStatsPublicId } from './publicId.js';
