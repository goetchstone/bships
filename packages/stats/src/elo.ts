/**
 * Pure Elo module (owned by stats-elo). NO IO, NO node:sqlite, NO http — just
 * arithmetic on rating snapshots. Heavily unit-tested in test/elo.test.ts.
 *
 * Scheme (HARD RULE, docs/ARCH.md): standard Elo, K = ELO_K_FACTOR (32),
 * team-vs-team using each team's MEAN rating. Every participating player on
 * the winning team gains, every player on the losing team loses, by the same
 * team-level expected-score delta. New players seed at STARTING_RATING (1200);
 * that seeding happens in stats-db (createPlayer), not here.
 *
 * KNOWN, ACCEPTED PROPERTY — uneven teams are NOT zero-sum. Because every player
 * on a team receives that team's full delta (per the HARD RULE), an N-vs-M match
 * conserves rating only when N === M. A 3-vs-1 win, for example, adds +delta to
 * three winners but subtracts only one -delta, injecting net rating. Equal-size
 * matches (1v1, 3v3, ...) are exactly zero-sum. Scaling per-player deltas by the
 * opposing-team size would restore conservation but would VIOLATE the HARD RULE
 * (each player must get the team delta), so it is intentionally left as-is; over
 * many uneven matches the global pool drifts upward. This is by design.
 */

import { ELO_K_FACTOR } from '@bships/core';
import type { TeamId } from '@bships/core';
import type { RatingChange, RatingSnapshot } from './types.js';

export { ELO_K_FACTOR };

/**
 * Standard Elo expected score for `ratingA` against `ratingB`:
 * 1 / (1 + 10^((ratingB - ratingA) / 400)). Pure; in (0, 1).
 */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Per-player rating deltas for one finished match.
 *
 * - `participants` carries each player's CURRENT rating + team.
 * - `winnerTeam` null => draw/aborted: every delta is 0 (caller still records
 *   the match but applies no rating/W-L change).
 * - Team expected score uses the mean rating of each team; the winning team
 *   scores 1, the losing team 0; K = ELO_K_FACTOR. Each player on a team
 *   receives that team's delta (rounded to an integer). ratingAfter clamps at
 *   >= 0.
 *
 * Returns one RatingChange per input participant, in input order.
 */
export function computeRatingChanges(
  participants: readonly RatingSnapshot[],
  winnerTeam: TeamId | null,
): RatingChange[] {
  // Draw/abort: every delta is 0, ratingAfter equals current rating.
  if (winnerTeam === null) {
    return participants.map((p) => ({
      publicId: p.publicId,
      delta: 0,
      ratingAfter: p.rating,
    }));
  }

  // Group participants by team and compute each team's mean rating.
  const teamRatings = new Map<TeamId, number[]>();
  for (const p of participants) {
    const bucket = teamRatings.get(p.team) ?? [];
    bucket.push(p.rating);
    teamRatings.set(p.team, bucket);
  }

  // Unranked guard: a match with only ONE team present has no opponent. Without
  // this, the opponent-mean fallback below would use myMean (E = 0.5) and hand
  // every participant +16 for a "win" against nobody — a free Elo/W-L farm.
  // Treat it like a draw: zero deltas (callers also skip the W/L bump when the
  // delta is 0, see recordMatch).
  if (teamRatings.size < 2) {
    return participants.map((p) => ({
      publicId: p.publicId,
      delta: 0,
      ratingAfter: p.rating,
    }));
  }

  const teamMean = (team: TeamId): number => {
    const ratings = teamRatings.get(team);
    if (!ratings || ratings.length === 0) return 0;
    return ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
  };

  // Collect the two distinct teams (could be more but BSP is always 2).
  const teams = [...teamRatings.keys()];

  // Compute per-team delta: S=1 for winning team, S=0 for the loser.
  // E is computed from that team's mean vs the OTHER team's mean.
  // For >2 teams we compare against the average of all opposing team means,
  // but BSP is always 2-team so the simple case applies.
  const teamDelta = new Map<TeamId, number>();
  for (const team of teams) {
    const myMean = teamMean(team);
    // Opponent mean: average of all other teams' means.
    const opponentMeans = teams.filter((t) => t !== team).map(teamMean);
    const opponentMean =
      opponentMeans.length > 0
        ? opponentMeans.reduce((s, r) => s + r, 0) / opponentMeans.length
        : myMean;

    const S = team === winnerTeam ? 1 : 0;
    const E = expectedScore(myMean, opponentMean);
    const delta = Math.round(ELO_K_FACTOR * (S - E));
    teamDelta.set(team, delta);
  }

  // Build one RatingChange per participant in input order.
  return participants.map((p) => {
    const delta = teamDelta.get(p.team) ?? 0;
    const ratingAfter = Math.max(0, p.rating + delta);
    return { publicId: p.publicId, delta, ratingAfter };
  });
}
