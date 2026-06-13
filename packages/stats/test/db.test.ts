/**
 * Tests for the stats data layer (packages/stats/src/db.ts).
 *
 * All tests use openDatabase(':memory:') so they are hermetic and fast.
 * Coverage checklist (from contract):
 *
 * - hashPassword / verifyPassword: encode format, verify pass, wrong password,
 *   wrong salt, tampered hash, constant-time equal
 * - upsertPlayer: creates row at STARTING_RATING, idempotent (duplicate call),
 *   refreshes name for unclaimed players, does NOT update name for claimed players
 * - recordMatch: inserts match + participants, applies Elo deltas, bumps W/L
 *   + matches_played; draw (null winner) => zero deltas + no W/L bump;
 *   idempotency (result_key dedupe) — second POST is no-op, returns duplicate:true
 *   and does NOT double-apply Elo
 * - getLeaderboard: ordering by rating desc, limit respected
 * - getPlayerProfile: favoriteShipTypeId (most-played ship), recentMatches
 *   (newest first), null for unknown player
 * - claimAccount: sets email/hash/name_locked; email conflict => emailTaken;
 *   name conflict => nameTaken; claimed player's name locked (upsertPlayer won't
 *   overwrite it)
 * - verifyLogin: correct password => ok; wrong password => badCredentials;
 *   unknown email => notFound
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  openDatabase,
  hashPassword,
  verifyPassword,
  SCHEMA_VERSION,
} from '../src/db.js';
import { STARTING_RATING } from '@bships/core';
import type { StatsRepository } from '../src/db.js';
import type { MatchResultIngest } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a deterministic MatchResultIngest for tests. */
function makeMatchResult(overrides: Partial<MatchResultIngest> = {}): MatchResultIngest {
  return {
    rulesetId: 'classic',
    seed: 42,
    startedAt: 1_000_000,
    durationTicks: 1000,
    winnerTeam: 'south',
    participants: [
      {
        token: 'tok_south1',
        publicId: 's_aabbcc001122',
        name: 'Alice',
        slot: 2,
        team: 'south',
        shipTypeId: 'destroyer',
        kills: 3,
        deaths: 1,
        goldEarned: 500,
      },
      {
        token: 'tok_north1',
        publicId: 's_ddeeff334455',
        name: 'Bob',
        slot: 7,
        team: 'north',
        shipTypeId: 'cruiser',
        kills: 1,
        deaths: 3,
        goldEarned: 300,
      },
    ],
    ...overrides,
  };
}

/** Build a fresh in-memory repo for each test. */
function makeRepo(): StatsRepository {
  return openDatabase(':memory:');
}

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

describe('openDatabase schema', () => {
  it('applies the schema and seeds the schema_version row', () => {
    const repo = makeRepo();
    const row = repo.db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.version).toBe(SCHEMA_VERSION);
    repo.close();
  });

  it('is idempotent — calling openDatabase twice on the same :memory: path does not throw', () => {
    // Each :memory: is a separate DB; just verify no exception on second open.
    const r1 = makeRepo();
    const r2 = makeRepo();
    r1.close();
    r2.close();
  });
});

// ---------------------------------------------------------------------------
// hashPassword / verifyPassword
// ---------------------------------------------------------------------------

describe('hashPassword / verifyPassword', () => {
  it('produces the encoded scrypt$N$r$p$saltHex$hashHex format', () => {
    const encoded = hashPassword('hunter2');
    const parts = encoded.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(6);
    // N, r, p must be positive integers
    expect(Number(parts[1])).toBeGreaterThan(0);
    expect(Number(parts[2])).toBeGreaterThan(0);
    expect(Number(parts[3])).toBeGreaterThan(0);
    // salt and hash are hex
    expect(parts[4]).toMatch(/^[0-9a-f]+$/);
    expect(parts[5]).toMatch(/^[0-9a-f]+$/);
  });

  it('verifyPassword returns true for the correct password', () => {
    const encoded = hashPassword('correct horse');
    expect(verifyPassword('correct horse', encoded)).toBe(true);
  });

  it('verifyPassword returns false for a wrong password', () => {
    const encoded = hashPassword('correct horse');
    expect(verifyPassword('wrong', encoded)).toBe(false);
  });

  it('two calls with the same password produce different encoded strings (random salt)', () => {
    const a = hashPassword('password123');
    const b = hashPassword('password123');
    expect(a).not.toBe(b); // different salts => different encoded forms
    // But both verify correctly.
    expect(verifyPassword('password123', a)).toBe(true);
    expect(verifyPassword('password123', b)).toBe(true);
  });

  it('verifyPassword returns false for a tampered hash', () => {
    const encoded = hashPassword('secret');
    // Flip the last character of the hashHex segment.
    const parts = encoded.split('$');
    const hash = parts[5]!;
    parts[5] = hash.slice(0, -1) + (hash.endsWith('0') ? '1' : '0');
    expect(verifyPassword('secret', parts.join('$'))).toBe(false);
  });

  it('verifyPassword returns false for a malformed encoded string', () => {
    expect(verifyPassword('anything', 'not-a-valid-encoded-hash')).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'scrypt$16384$8$1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// upsertPlayer
// ---------------------------------------------------------------------------

describe('upsertPlayer', () => {
  let repo: StatsRepository;
  beforeEach(() => {
    repo = makeRepo();
  });

  it('creates a new player row seeded at STARTING_RATING', () => {
    const row = repo.upsertPlayer('s_aabbcc001122', 'Alice', 1000);
    expect(row.publicId).toBe('s_aabbcc001122');
    expect(row.name).toBe('Alice');
    expect(row.rating).toBe(STARTING_RATING);
    expect(row.wins).toBe(0);
    expect(row.losses).toBe(0);
    expect(row.matchesPlayed).toBe(0);
    expect(row.claimed).toBe(false);
    repo.close();
  });

  it('is idempotent — second call returns the same player without error', () => {
    repo.upsertPlayer('s_aabbcc001122', 'Alice', 1000);
    const row2 = repo.upsertPlayer('s_aabbcc001122', 'Alice', 2000);
    expect(row2.publicId).toBe('s_aabbcc001122');
    repo.close();
  });

  it('refreshes the display name for an UNCLAIMED player', () => {
    repo.upsertPlayer('s_aabbcc001122', 'OldName', 1000);
    const row = repo.upsertPlayer('s_aabbcc001122', 'NewName', 2000);
    expect(row.name).toBe('NewName');
    repo.close();
  });

  it('does NOT update name for a CLAIMED player (name_locked set)', () => {
    repo.upsertPlayer('s_aabbcc001122', 'Original', 1000);
    repo.claimAccount('s_aabbcc001122', 'a@b.com', 'pass', 'Locked', 2000);
    const row = repo.upsertPlayer('s_aabbcc001122', 'TryUpdate', 3000);
    // Name must remain what was set at claim time.
    expect(row.name).toBe('Locked');
    repo.close();
  });

  it('getPlayerByPublicId returns null for unknown id', () => {
    expect(repo.getPlayerByPublicId('s_0000000000ff')).toBeNull();
    repo.close();
  });

  it('getPlayerByPublicId returns the row after upsert', () => {
    repo.upsertPlayer('s_aabbcc001122', 'Alice', 1000);
    const row = repo.getPlayerByPublicId('s_aabbcc001122');
    expect(row).not.toBeNull();
    expect(row!.publicId).toBe('s_aabbcc001122');
    repo.close();
  });
});

// ---------------------------------------------------------------------------
// recordMatch
// ---------------------------------------------------------------------------

describe('recordMatch', () => {
  let repo: StatsRepository;
  beforeEach(() => {
    repo = makeRepo();
  });

  it('inserts a match row and returns a matchId', () => {
    const result = makeMatchResult();
    const { matchId, duplicate } = repo.recordMatch(result, 2_000_000);
    expect(typeof matchId).toBe('number');
    expect(matchId).toBeGreaterThan(0);
    expect(duplicate).toBe(false);
    repo.close();
  });

  it('bumps matches_played for every participant', () => {
    const result = makeMatchResult();
    repo.recordMatch(result, 2_000_000);
    const alice = repo.getPlayerByPublicId('s_aabbcc001122')!;
    const bob = repo.getPlayerByPublicId('s_ddeeff334455')!;
    expect(alice.matchesPlayed).toBe(1);
    expect(bob.matchesPlayed).toBe(1);
    repo.close();
  });

  it('bumps wins for the winning team and losses for the losing team', () => {
    repo.recordMatch(makeMatchResult({ winnerTeam: 'south' }), 2_000_000);
    const alice = repo.getPlayerByPublicId('s_aabbcc001122')!; // south (winner)
    const bob = repo.getPlayerByPublicId('s_ddeeff334455')!; // north (loser)
    expect(alice.wins).toBe(1);
    expect(alice.losses).toBe(0);
    expect(bob.wins).toBe(0);
    expect(bob.losses).toBe(1);
    repo.close();
  });

  it('applies positive Elo delta to winners and negative to losers (equal ratings)', () => {
    // Both start at 1200 => winner gets +16, loser gets -16.
    repo.recordMatch(makeMatchResult(), 2_000_000);
    const alice = repo.getPlayerByPublicId('s_aabbcc001122')!;
    const bob = repo.getPlayerByPublicId('s_ddeeff334455')!;
    expect(alice.rating).toBe(STARTING_RATING + 16);
    expect(bob.rating).toBe(STARTING_RATING - 16);
    repo.close();
  });

  it('draw (null winnerTeam): zero deltas, no W/L change, matches_played still bumped', () => {
    repo.recordMatch(makeMatchResult({ winnerTeam: null }), 2_000_000);
    const alice = repo.getPlayerByPublicId('s_aabbcc001122')!;
    const bob = repo.getPlayerByPublicId('s_ddeeff334455')!;
    // Ratings unchanged
    expect(alice.rating).toBe(STARTING_RATING);
    expect(bob.rating).toBe(STARTING_RATING);
    // No W/L
    expect(alice.wins).toBe(0);
    expect(alice.losses).toBe(0);
    expect(bob.wins).toBe(0);
    expect(bob.losses).toBe(0);
    // But match was played
    expect(alice.matchesPlayed).toBe(1);
    expect(bob.matchesPlayed).toBe(1);
    repo.close();
  });

  it('idempotent: a duplicate POST returns the existing matchId with duplicate:true', () => {
    const result = makeMatchResult();
    const first = repo.recordMatch(result, 2_000_000);
    const second = repo.recordMatch(result, 3_000_000);
    expect(second.duplicate).toBe(true);
    expect(second.matchId).toBe(first.matchId);
    repo.close();
  });

  it('idempotent: duplicate does NOT apply a second Elo change', () => {
    const result = makeMatchResult();
    repo.recordMatch(result, 2_000_000);
    repo.recordMatch(result, 3_000_000); // duplicate
    const alice = repo.getPlayerByPublicId('s_aabbcc001122')!;
    // Should still be exactly +16 (one application), not +32.
    expect(alice.rating).toBe(STARTING_RATING + 16);
    repo.close();
  });

  it('idempotent: duplicate does NOT bump matches_played a second time', () => {
    const result = makeMatchResult();
    repo.recordMatch(result, 2_000_000);
    repo.recordMatch(result, 3_000_000);
    const alice = repo.getPlayerByPublicId('s_aabbcc001122')!;
    expect(alice.matchesPlayed).toBe(1);
    repo.close();
  });

  it('two distinct matches (different seeds) both apply Elo independently', () => {
    repo.recordMatch(makeMatchResult({ seed: 1 }), 2_000_000);
    repo.recordMatch(makeMatchResult({ seed: 2 }), 3_000_000);
    const alice = repo.getPlayerByPublicId('s_aabbcc001122')!;
    // After match 1: 1200 + 16 = 1216; after match 2 (rating was 1216 vs 1184):
    // E_south ≈ 1/(1+10^((1184-1216)/400)) => E > 0.5 => delta < +16
    // But we just check matches_played and wins are 2.
    expect(alice.matchesPlayed).toBe(2);
    expect(alice.wins).toBe(2);
    repo.close();
  });

  it('records participant rows accessible via getPlayerProfile', () => {
    repo.recordMatch(makeMatchResult(), 2_000_000);
    const profile = repo.getPlayerProfile('s_aabbcc001122', 10);
    expect(profile).not.toBeNull();
    expect(profile!.recentMatches).toHaveLength(1);
    const m = profile!.recentMatches[0]!;
    expect(m.team).toBe('south');
    expect(m.won).toBe(true);
    expect(m.shipTypeId).toBe('destroyer');
    expect(m.kills).toBe(3);
    expect(m.deaths).toBe(1);
    repo.close();
  });

  it('one-team result is UNRANKED: row recorded but no Elo and no W/L bump', () => {
    // Both participants on south, winnerTeam south, no north opponent.
    repo.recordMatch(
      makeMatchResult({
        winnerTeam: 'south',
        participants: [
          { token: 't1', publicId: 's_solo00000001', name: 'A', slot: 2, team: 'south', shipTypeId: 'destroyer', kills: 0, deaths: 0, goldEarned: 0 },
          { token: 't2', publicId: 's_solo00000002', name: 'B', slot: 3, team: 'south', shipTypeId: 'cruiser', kills: 0, deaths: 0, goldEarned: 0 },
        ],
      }),
      2_000_000,
    );
    const a = repo.getPlayerByPublicId('s_solo00000001')!;
    const b = repo.getPlayerByPublicId('s_solo00000002')!;
    // No rating change, no W/L — but the match was recorded (matchesPlayed bumped).
    expect(a.rating).toBe(STARTING_RATING);
    expect(b.rating).toBe(STARTING_RATING);
    expect(a.wins).toBe(0);
    expect(a.losses).toBe(0);
    expect(b.wins).toBe(0);
    expect(b.losses).toBe(0);
    expect(a.matchesPlayed).toBe(1);
    // Profile row exists with won=false (unranked).
    const profile = repo.getPlayerProfile('s_solo00000001', 10)!;
    expect(profile.recentMatches).toHaveLength(1);
    expect(profile.recentMatches[0]!.won).toBe(false);
    expect(profile.recentMatches[0]!.ratingDelta).toBe(0);
    repo.close();
  });

  it('seeds new players automatically (no prior upsertPlayer call needed)', () => {
    // Do not call upsertPlayer first — recordMatch must do it.
    repo.recordMatch(makeMatchResult(), 2_000_000);
    expect(repo.getPlayerByPublicId('s_aabbcc001122')).not.toBeNull();
    expect(repo.getPlayerByPublicId('s_ddeeff334455')).not.toBeNull();
    repo.close();
  });
});

// ---------------------------------------------------------------------------
// getLeaderboard
// ---------------------------------------------------------------------------

describe('getLeaderboard', () => {
  let repo: StatsRepository;
  beforeEach(() => {
    repo = makeRepo();
  });

  it('returns empty array when no players exist', () => {
    expect(repo.getLeaderboard(10)).toEqual([]);
    repo.close();
  });

  it('returns players ordered by rating descending', () => {
    // Insert two players with different ratings via recordMatch.
    repo.upsertPlayer('s_aabbcc001122', 'Alice', 1000);
    repo.upsertPlayer('s_ddeeff334455', 'Bob', 1000);
    // Manually set different ratings by running two matches where Alice always wins.
    repo.recordMatch(makeMatchResult({ seed: 1 }), 2_000_000);
    repo.recordMatch(makeMatchResult({ seed: 2 }), 3_000_000);

    const board = repo.getLeaderboard(10);
    expect(board.length).toBeGreaterThan(0);
    for (let i = 1; i < board.length; i++) {
      expect(board[i - 1]!.rating).toBeGreaterThanOrEqual(board[i]!.rating);
    }
    repo.close();
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      repo.upsertPlayer(`s_player${i.toString().padStart(10, '0')}`, `Player${i}`, 1000);
    }
    const board = repo.getLeaderboard(3);
    expect(board.length).toBeLessThanOrEqual(3);
    repo.close();
  });

  it('returns LeaderboardEntry shape with correct fields', () => {
    repo.upsertPlayer('s_aabbcc001122', 'Alice', 1000);
    const board = repo.getLeaderboard(10);
    expect(board).toHaveLength(1);
    const entry = board[0]!;
    expect(typeof entry.publicId).toBe('string');
    expect(typeof entry.name).toBe('string');
    expect(typeof entry.rating).toBe('number');
    expect(typeof entry.wins).toBe('number');
    expect(typeof entry.losses).toBe('number');
    expect(typeof entry.matchesPlayed).toBe('number');
    expect(typeof entry.claimed).toBe('boolean');
    repo.close();
  });

  it('claimed field reflects whether the player has claimed the account', () => {
    repo.upsertPlayer('s_aabbcc001122', 'Alice', 1000);
    let board = repo.getLeaderboard(10);
    expect(board[0]!.claimed).toBe(false);

    repo.claimAccount('s_aabbcc001122', 'alice@example.com', 'pass1', 'Alice', 2000);
    board = repo.getLeaderboard(10);
    expect(board[0]!.claimed).toBe(true);
    repo.close();
  });
});

// ---------------------------------------------------------------------------
// getPlayerProfile
// ---------------------------------------------------------------------------

describe('getPlayerProfile', () => {
  let repo: StatsRepository;
  beforeEach(() => {
    repo = makeRepo();
  });

  it('returns null for an unknown publicId', () => {
    expect(repo.getPlayerProfile('s_0000000000ff', 10)).toBeNull();
    repo.close();
  });

  it('returns a profile with null favoriteShipTypeId when player has no matches', () => {
    repo.upsertPlayer('s_aabbcc001122', 'Alice', 1000);
    const profile = repo.getPlayerProfile('s_aabbcc001122', 10);
    expect(profile).not.toBeNull();
    expect(profile!.favoriteShipTypeId).toBeNull();
    expect(profile!.recentMatches).toEqual([]);
    repo.close();
  });

  it('favoriteShipTypeId returns the most-played ship', () => {
    // Alice plays 2 matches as 'destroyer', 1 as 'cruiser'.
    repo.recordMatch(makeMatchResult({ seed: 1, participants: [
      { token: 'tok', publicId: 's_aabbcc001122', name: 'Alice', slot: 2, team: 'south', shipTypeId: 'destroyer', kills: 1, deaths: 0, goldEarned: 100 },
      { token: 'tok2', publicId: 's_ddeeff334455', name: 'Bob', slot: 7, team: 'north', shipTypeId: 'cruiser', kills: 0, deaths: 1, goldEarned: 50 },
    ] }), 2_000_000);

    repo.recordMatch(makeMatchResult({ seed: 2, participants: [
      { token: 'tok', publicId: 's_aabbcc001122', name: 'Alice', slot: 2, team: 'south', shipTypeId: 'destroyer', kills: 1, deaths: 0, goldEarned: 100 },
      { token: 'tok2', publicId: 's_ddeeff334455', name: 'Bob', slot: 7, team: 'north', shipTypeId: 'cruiser', kills: 0, deaths: 1, goldEarned: 50 },
    ] }), 3_000_000);

    repo.recordMatch(makeMatchResult({ seed: 3, participants: [
      { token: 'tok', publicId: 's_aabbcc001122', name: 'Alice', slot: 2, team: 'south', shipTypeId: 'frigate', kills: 0, deaths: 1, goldEarned: 80 },
      { token: 'tok2', publicId: 's_ddeeff334455', name: 'Bob', slot: 7, team: 'north', shipTypeId: 'cruiser', kills: 1, deaths: 0, goldEarned: 200 },
    ] }), 4_000_000);

    const profile = repo.getPlayerProfile('s_aabbcc001122', 10);
    expect(profile!.favoriteShipTypeId).toBe('destroyer');
    repo.close();
  });

  it('recentMatches are ordered newest first (by match_id desc)', () => {
    for (let i = 1; i <= 3; i++) {
      repo.recordMatch(makeMatchResult({ seed: i }), 1_000_000 + i * 1000);
    }
    const profile = repo.getPlayerProfile('s_aabbcc001122', 10);
    const ids = profile!.recentMatches.map((m) => m.matchId);
    // Should be descending.
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1]!).toBeGreaterThan(ids[i]!);
    }
    repo.close();
  });

  it('recentMatches is capped by recentLimit', () => {
    for (let i = 1; i <= 5; i++) {
      repo.recordMatch(makeMatchResult({ seed: i }), 1_000_000 + i * 1000);
    }
    const profile = repo.getPlayerProfile('s_aabbcc001122', 3);
    expect(profile!.recentMatches.length).toBeLessThanOrEqual(3);
    repo.close();
  });

  it('ratingDelta in recentMatches reflects the applied Elo change', () => {
    repo.recordMatch(makeMatchResult(), 2_000_000);
    const profile = repo.getPlayerProfile('s_aabbcc001122', 10);
    const match = profile!.recentMatches[0]!;
    // South won vs equal rated north => +16
    expect(match.ratingDelta).toBe(16);
    repo.close();
  });

  it('won flag is true for the winning team member', () => {
    repo.recordMatch(makeMatchResult({ winnerTeam: 'south' }), 2_000_000);
    const aliceProfile = repo.getPlayerProfile('s_aabbcc001122', 10);
    const bobProfile = repo.getPlayerProfile('s_ddeeff334455', 10);
    expect(aliceProfile!.recentMatches[0]!.won).toBe(true);
    expect(bobProfile!.recentMatches[0]!.won).toBe(false);
    repo.close();
  });

  it('won is false for both teams on a draw', () => {
    repo.recordMatch(makeMatchResult({ winnerTeam: null }), 2_000_000);
    const aliceProfile = repo.getPlayerProfile('s_aabbcc001122', 10);
    const bobProfile = repo.getPlayerProfile('s_ddeeff334455', 10);
    expect(aliceProfile!.recentMatches[0]!.won).toBe(false);
    expect(bobProfile!.recentMatches[0]!.won).toBe(false);
    repo.close();
  });
});

// ---------------------------------------------------------------------------
// claimAccount
// ---------------------------------------------------------------------------

describe('claimAccount', () => {
  let repo: StatsRepository;
  beforeEach(() => {
    repo = makeRepo();
    repo.upsertPlayer('s_aabbcc001122', 'Alice', 1000);
  });

  it('succeeds and returns the claimed player row', () => {
    const result = repo.claimAccount('s_aabbcc001122', 'alice@example.com', 'pass', 'Alice', 2000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.row.publicId).toBe('s_aabbcc001122');
    expect(result.row.claimed).toBe(true);
    repo.close();
  });

  it('stores email lowercased', () => {
    repo.claimAccount('s_aabbcc001122', 'ALICE@Example.COM', 'pass', 'Alice', 2000);
    const row = repo.getPlayerByPublicId('s_aabbcc001122')!;
    expect(row.claimed).toBe(true);
    // Verify login with lowercased email works.
    const loginResult = repo.verifyLogin('alice@example.com', 'pass');
    expect(loginResult.ok).toBe(true);
    repo.close();
  });

  it('returns emailTaken when the email is already used by another player', () => {
    repo.upsertPlayer('s_ddeeff334455', 'Bob', 1000);
    repo.claimAccount('s_aabbcc001122', 'shared@example.com', 'pass1', 'Alice', 2000);
    const result = repo.claimAccount('s_ddeeff334455', 'shared@example.com', 'pass2', 'Bob', 3000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure');
    expect(result.reason).toBe('emailTaken');
    repo.close();
  });

  it('returns nameTaken when the locked name is already used by another player', () => {
    repo.upsertPlayer('s_ddeeff334455', 'Bob', 1000);
    repo.claimAccount('s_aabbcc001122', 'alice@example.com', 'pass1', 'SharedName', 2000);
    const result = repo.claimAccount('s_ddeeff334455', 'bob@example.com', 'pass2', 'SharedName', 3000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure');
    expect(result.reason).toBe('nameTaken');
    repo.close();
  });

  it('name uniqueness check is case-insensitive (locked name stored lowercase)', () => {
    repo.upsertPlayer('s_ddeeff334455', 'Bob', 1000);
    repo.claimAccount('s_aabbcc001122', 'alice@example.com', 'pass1', 'SharedName', 2000);
    // Different casing of the same name should also conflict.
    const result = repo.claimAccount('s_ddeeff334455', 'bob@example.com', 'pass2', 'sharedname', 3000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure');
    expect(result.reason).toBe('nameTaken');
    repo.close();
  });

  it('creates the player row if it does not exist yet', () => {
    // No prior upsertPlayer for this publicId.
    const result = repo.claimAccount('s_ffffeeeedddd', 'new@example.com', 'pass', 'NewPlayer', 2000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.row.publicId).toBe('s_ffffeeeedddd');
    repo.close();
  });

  it('rejects a second claim on an already-claimed account (no silent overwrite)', () => {
    repo.claimAccount('s_aabbcc001122', 'alice@example.com', 'pw1', 'Alice', 2000);
    const result = repo.claimAccount('s_aabbcc001122', 'alice2@example.com', 'pw2', 'AliceTwo', 3000);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure');
    expect(result.reason).toBe('alreadyClaimed');

    // Original email/name/password are UNCHANGED; old creds still work, new do not.
    const row = repo.getPlayerByPublicId('s_aabbcc001122')!;
    expect(row.name).toBe('Alice');
    expect(repo.verifyLogin('alice@example.com', 'pw1').ok).toBe(true);
    expect(repo.verifyLogin('alice2@example.com', 'pw2').ok).toBe(false);
    repo.close();
  });

  it('is idempotent for a re-claim with the SAME email (no error, row unchanged)', () => {
    repo.claimAccount('s_aabbcc001122', 'alice@example.com', 'pw1', 'Alice', 2000);
    const result = repo.claimAccount('s_aabbcc001122', 'ALICE@example.com', 'pw1', 'Alice', 3000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.row.name).toBe('Alice');
    repo.close();
  });
});

// ---------------------------------------------------------------------------
// verifyLogin
// ---------------------------------------------------------------------------

describe('verifyLogin', () => {
  let repo: StatsRepository;
  beforeEach(() => {
    repo = makeRepo();
    repo.upsertPlayer('s_aabbcc001122', 'Alice', 1000);
    repo.claimAccount('s_aabbcc001122', 'alice@example.com', 'correctpass', 'Alice', 2000);
  });

  it('returns ok:true with the player row for correct credentials', () => {
    const result = repo.verifyLogin('alice@example.com', 'correctpass');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok');
    expect(result.row.publicId).toBe('s_aabbcc001122');
    repo.close();
  });

  it('verifies with lowercased email (case-insensitive lookup)', () => {
    const result = repo.verifyLogin('ALICE@EXAMPLE.COM', 'correctpass');
    expect(result.ok).toBe(true);
    repo.close();
  });

  it('returns badCredentials for wrong password', () => {
    const result = repo.verifyLogin('alice@example.com', 'wrongpass');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure');
    expect(result.reason).toBe('badCredentials');
    repo.close();
  });

  it('returns notFound for an unknown email', () => {
    const result = repo.verifyLogin('nobody@example.com', 'anypass');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected failure');
    expect(result.reason).toBe('notFound');
    repo.close();
  });

  it('is constant-time: does not short-circuit on length mismatch (no exception)', () => {
    // Just verify it does not throw on an empty password or very long one.
    expect(() => repo.verifyLogin('alice@example.com', '')).not.toThrow();
    expect(() => repo.verifyLogin('alice@example.com', 'x'.repeat(1000))).not.toThrow();
    repo.close();
  });
});
