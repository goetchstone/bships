/**
 * Tests for the pure Elo module (packages/stats/src/elo.ts).
 *
 * Coverage checklist (from contract):
 * - symmetric even teams: equal mean => E=0.5 => winner +16, loser -16
 * - favorite vs underdog asymmetry (high-rated team wins less / loses more)
 * - 1v1 (simplest case)
 * - uneven team sizes (mean, not sum)
 * - null winner => all deltas 0, ratingAfter === rating
 * - rounding (Math.round applied to K*(S-E))
 * - >= 0 clamp (a 0-rated loser stays at 0)
 * - deltas summing toward zero across the two teams (conservation property)
 */

import { describe, expect, it } from 'vitest';
import { ELO_K_FACTOR, computeRatingChanges, expectedScore } from '../src/elo.js';
import type { RatingSnapshot } from '../src/types.js';

// ---------------------------------------------------------------------------
// expectedScore
// ---------------------------------------------------------------------------

describe('expectedScore', () => {
  it('returns 0.5 when both ratings are equal', () => {
    expect(expectedScore(1200, 1200)).toBeCloseTo(0.5);
  });

  it('returns > 0.5 when ratingA > ratingB (A is the favourite)', () => {
    expect(expectedScore(1400, 1200)).toBeGreaterThan(0.5);
  });

  it('returns < 0.5 when ratingA < ratingB (A is the underdog)', () => {
    expect(expectedScore(1000, 1200)).toBeLessThan(0.5);
  });

  it('is always strictly between 0 and 1', () => {
    const pairs = [
      [0, 3000],
      [3000, 0],
      [1200, 1200],
      [800, 1600],
    ] as const;
    for (const [a, b] of pairs) {
      const e = expectedScore(a, b);
      expect(e).toBeGreaterThan(0);
      expect(e).toBeLessThan(1);
    }
  });

  it('is symmetric: E(a,b) + E(b,a) === 1', () => {
    const a = 1100;
    const b = 1350;
    expect(expectedScore(a, b) + expectedScore(b, a)).toBeCloseTo(1);
  });

  it('matches the known formula value for a 200-point gap', () => {
    // E = 1 / (1 + 10^(200/400)) = 1 / (1 + 10^0.5) ≈ 0.2403
    const e = expectedScore(1000, 1200);
    expect(e).toBeCloseTo(1 / (1 + Math.pow(10, 0.5)), 10);
  });
});

// ---------------------------------------------------------------------------
// computeRatingChanges
// ---------------------------------------------------------------------------

describe('computeRatingChanges', () => {
  // Helper: build a RatingSnapshot.
  const snap = (publicId: string, team: 'south' | 'north', rating: number): RatingSnapshot => ({
    publicId,
    team,
    rating,
  });

  // ---------------------------------------------------------------------------
  // null winner (draw / abort)
  // ---------------------------------------------------------------------------

  it('null winnerTeam => all deltas 0 and ratingAfter === rating', () => {
    const participants = [
      snap('s1', 'south', 1200),
      snap('s2', 'north', 1400),
      snap('s3', 'south', 800),
    ];
    const changes = computeRatingChanges(participants, null);
    expect(changes).toHaveLength(3);
    for (const c of changes) {
      expect(c.delta).toBe(0);
    }
    expect(changes[0].ratingAfter).toBe(1200);
    expect(changes[1].ratingAfter).toBe(1400);
    expect(changes[2].ratingAfter).toBe(800);
  });

  it('null winnerTeam preserves input order', () => {
    const participants = [snap('a', 'south', 1000), snap('b', 'north', 1200)];
    const changes = computeRatingChanges(participants, null);
    expect(changes[0].publicId).toBe('a');
    expect(changes[1].publicId).toBe('b');
  });

  // ---------------------------------------------------------------------------
  // 1v1 even match
  // ---------------------------------------------------------------------------

  it('1v1 equal ratings: winner +16, loser -16 (K/2)', () => {
    const participants = [snap('alice', 'south', 1200), snap('bob', 'north', 1200)];
    const changes = computeRatingChanges(participants, 'south');

    const alice = changes.find((c) => c.publicId === 'alice')!;
    const bob = changes.find((c) => c.publicId === 'bob')!;

    expect(alice.delta).toBe(16); // Math.round(32 * (1 - 0.5))
    expect(bob.delta).toBe(-16); // Math.round(32 * (0 - 0.5))
    expect(alice.ratingAfter).toBe(1216);
    expect(bob.ratingAfter).toBe(1184);
  });

  it('1v1 equal ratings returns exactly ELO_K_FACTOR/2 for winner', () => {
    const participants = [snap('p1', 'south', 1200), snap('p2', 'north', 1200)];
    const changes = computeRatingChanges(participants, 'south');
    const winner = changes.find((c) => c.publicId === 'p1')!;
    expect(winner.delta).toBe(ELO_K_FACTOR / 2);
  });

  // ---------------------------------------------------------------------------
  // Favourite vs underdog
  // ---------------------------------------------------------------------------

  it('favourite winning gains fewer points than underdog would', () => {
    // south (favourite, 1600) beats north (underdog, 1000)
    const participants = [snap('fav', 'south', 1600), snap('dog', 'north', 1000)];
    const changes = computeRatingChanges(participants, 'south');

    const fav = changes.find((c) => c.publicId === 'fav')!;
    const dog = changes.find((c) => c.publicId === 'dog')!;

    // Favourite wins => small positive delta (< 16)
    expect(fav.delta).toBeGreaterThan(0);
    expect(fav.delta).toBeLessThan(ELO_K_FACTOR / 2);

    // Underdog loses => delta is negative
    expect(dog.delta).toBeLessThan(0);
  });

  it('underdog winning gains more points than favourite would', () => {
    // south (underdog, 1000) beats north (favourite, 1600)
    const participants = [snap('dog', 'south', 1000), snap('fav', 'north', 1600)];
    const changes = computeRatingChanges(participants, 'south');

    const dog = changes.find((c) => c.publicId === 'dog')!;
    const fav = changes.find((c) => c.publicId === 'fav')!;

    // Underdog wins => big positive delta (> 16)
    expect(dog.delta).toBeGreaterThan(ELO_K_FACTOR / 2);

    // Favourite loses => big negative delta
    expect(fav.delta).toBeLessThan(-(ELO_K_FACTOR / 2));
  });

  // ---------------------------------------------------------------------------
  // Team match (multi-player)
  // ---------------------------------------------------------------------------

  it('symmetric even 5v5: all winners +16, all losers -16', () => {
    const participants: RatingSnapshot[] = [
      snap('s1', 'south', 1200),
      snap('s2', 'south', 1200),
      snap('s3', 'south', 1200),
      snap('s4', 'south', 1200),
      snap('s5', 'south', 1200),
      snap('n1', 'north', 1200),
      snap('n2', 'north', 1200),
      snap('n3', 'north', 1200),
      snap('n4', 'north', 1200),
      snap('n5', 'north', 1200),
    ];
    const changes = computeRatingChanges(participants, 'south');

    for (const c of changes) {
      const expected = c.publicId.startsWith('s') ? 16 : -16;
      expect(c.delta).toBe(expected);
    }
  });

  it('uneven team sizes: mean not sum drives Elo (3v2)', () => {
    // south: 3 players at 1200 each => mean 1200
    // north: 2 players at 1200 each => mean 1200
    // Same means => equal expected scores => winner gets +16
    const participants: RatingSnapshot[] = [
      snap('s1', 'south', 1200),
      snap('s2', 'south', 1200),
      snap('s3', 'south', 1200),
      snap('n1', 'north', 1200),
      snap('n2', 'north', 1200),
    ];
    const changes = computeRatingChanges(participants, 'south');
    for (const c of changes) {
      const expected = c.publicId.startsWith('s') ? 16 : -16;
      expect(c.delta).toBe(expected);
    }
  });

  it('uneven ratings in same team: mean drives delta, not individual ratings', () => {
    // south: [2000, 400] => mean 1200  vs  north: [1200] => mean 1200
    // Equal means => each south player gets +16 regardless of own rating
    const participants: RatingSnapshot[] = [
      snap('s_high', 'south', 2000),
      snap('s_low', 'south', 400),
      snap('n1', 'north', 1200),
    ];
    const changes = computeRatingChanges(participants, 'south');

    const sHigh = changes.find((c) => c.publicId === 's_high')!;
    const sLow = changes.find((c) => c.publicId === 's_low')!;

    // Both south players get the same team delta
    expect(sHigh.delta).toBe(sLow.delta);
    expect(sHigh.delta).toBe(16);
  });

  // ---------------------------------------------------------------------------
  // >= 0 clamp
  // ---------------------------------------------------------------------------

  it('ratingAfter is clamped to >= 0 when losing would push rating negative', () => {
    // A low-rated player (10) losing to an equal-rated opponent:
    // delta = round(32 * (0 - 0.5)) = -16; 10 + (-16) = -6 => clamps to 0.
    const participants = [snap('low', 'south', 10), snap('equal', 'north', 10)];
    const changes = computeRatingChanges(participants, 'north');

    const low = changes.find((c) => c.publicId === 'low')!;
    expect(low.delta).toBeLessThan(0); // -16 without clamp
    expect(low.ratingAfter).toBe(0); // clamped from -6
  });

  it('ratingAfter equals rating + delta when no clamp is needed', () => {
    const participants = [snap('a', 'south', 1200), snap('b', 'north', 1200)];
    const changes = computeRatingChanges(participants, 'south');
    for (const c of changes) {
      const original = participants.find((p) => p.publicId === c.publicId)!.rating;
      expect(c.ratingAfter).toBe(Math.max(0, original + c.delta));
    }
  });

  // ---------------------------------------------------------------------------
  // Rounding
  // ---------------------------------------------------------------------------

  it('deltas are integers (Math.round applied)', () => {
    // Use ratings that produce a non-round E
    const participants = [snap('a', 'south', 1150), snap('b', 'north', 1300)];
    const changes = computeRatingChanges(participants, 'south');
    for (const c of changes) {
      expect(Number.isInteger(c.delta)).toBe(true);
    }
  });

  it('ratingAfter values are integers', () => {
    const participants = [snap('a', 'south', 1150), snap('b', 'north', 1300)];
    const changes = computeRatingChanges(participants, 'south');
    for (const c of changes) {
      expect(Number.isInteger(c.ratingAfter)).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Delta conservation: winner gains + loser loses ~ 0 sum (2-team)
  // The sum is not exactly 0 because rounding is applied per-team, not to the
  // total — but the two team totals together never diverge by more than
  // |teamA_size + teamB_size| (one rounding unit per player at most).
  // ---------------------------------------------------------------------------

  it('winning-team total delta + losing-team total delta is close to zero', () => {
    const participants: RatingSnapshot[] = [
      snap('s1', 'south', 1200),
      snap('s2', 'south', 1100),
      snap('n1', 'north', 1300),
      snap('n2', 'north', 1400),
    ];
    const changes = computeRatingChanges(participants, 'south');

    const totalDelta = changes.reduce((sum, c) => sum + c.delta, 0);
    // Within ±|participants| due to rounding of two integers
    expect(Math.abs(totalDelta)).toBeLessThanOrEqual(participants.length);
  });

  it('exact conservation: equal ratings => deltas sum to exactly 0', () => {
    // When E=0.5 exactly, delta_winner = +round(K*0.5) = +16 and
    // delta_loser = -round(K*0.5) = -16; each team has the same count, so
    // total sum is exactly 0 for equal-sized teams.
    const participants: RatingSnapshot[] = [
      snap('s1', 'south', 1200),
      snap('s2', 'south', 1200),
      snap('n1', 'north', 1200),
      snap('n2', 'north', 1200),
    ];
    const changes = computeRatingChanges(participants, 'south');
    const totalDelta = changes.reduce((sum, c) => sum + c.delta, 0);
    expect(totalDelta).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Output ordering
  // ---------------------------------------------------------------------------

  it('returns one RatingChange per participant in input order', () => {
    const participants = [
      snap('first', 'south', 1200),
      snap('second', 'north', 1100),
      snap('third', 'south', 900),
    ];
    const changes = computeRatingChanges(participants, 'north');
    expect(changes).toHaveLength(3);
    expect(changes[0].publicId).toBe('first');
    expect(changes[1].publicId).toBe('second');
    expect(changes[2].publicId).toBe('third');
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('empty participants list returns empty array', () => {
    expect(computeRatingChanges([], null)).toEqual([]);
    expect(computeRatingChanges([], 'south')).toEqual([]);
  });

  it('single-team match is UNRANKED: zero delta (no opponent to win against)', () => {
    // Only one team is present => no real opponent. Awarding +16 here was a free
    // Elo/W-L farm (a lone or one-team lineup beats an unmanned HQ). The unranked
    // guard must zero the delta, exactly like a draw.
    const participants = [snap('solo', 'south', 1200)];
    const changes = computeRatingChanges(participants, 'south');
    expect(changes).toHaveLength(1);
    expect(changes[0].delta).toBe(0);
    expect(changes[0].ratingAfter).toBe(1200);
  });

  it('single-team match with multiple players: every delta is zero', () => {
    const participants = [
      snap('a', 'south', 1200),
      snap('b', 'south', 1400),
      snap('c', 'south', 1000),
    ];
    const changes = computeRatingChanges(participants, 'south');
    expect(changes.every((c) => c.delta === 0)).toBe(true);
  });

  it('known asymmetric values: 1600 south beats 1200 north', () => {
    // E_south = 1/(1+10^((1200-1600)/400)) = 1/(1+10^(-1)) = 1/1.1 ≈ 0.9091
    // delta_south = round(32*(1-0.9091)) = round(32*0.0909) = round(2.909) = 3
    // delta_north = round(32*(0-0.0909)) = round(-2.909) = -3
    const participants = [snap('fav', 'south', 1600), snap('dog', 'north', 1200)];
    const changes = computeRatingChanges(participants, 'south');

    const fav = changes.find((c) => c.publicId === 'fav')!;
    const dog = changes.find((c) => c.publicId === 'dog')!;

    expect(fav.delta).toBe(3);
    expect(dog.delta).toBe(-3);
    expect(fav.ratingAfter).toBe(1603);
    expect(dog.ratingAfter).toBe(1197);
  });
});
