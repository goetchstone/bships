/**
 * Per-team sight-radius fog of war — THE security boundary of the server.
 *
 * The implementation moved into @bships/core (sim/vision.ts) so the SIM's
 * own targeting/AI plays by the same fog rules this module enforces on
 * snapshots (owner-reported: the AI used to see through the fog). This
 * module re-exports the shared model under its original server-side path;
 * the inclusion rule is unchanged: an entity for which `isEntityVisible`
 * returns false MUST NOT appear anywhere in the team's snapshot payload.
 */

export {
  computeTeamVision,
  coveredSight,
  teamVisionOf,
  coveredBy,
  isEntityVisible,
  collectVisibleEntities,
  isProjectileVisible,
} from '@bships/core';
export type { SightCircle, TeamVision } from '@bships/core';
