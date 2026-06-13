/**
 * Integration tests for the stats HTTP server (stats-api / http.ts).
 * Drive a REAL server on an ephemeral port using a mock in-memory repository
 * (so we do not depend on stats-db being implemented yet).
 *
 * Coverage:
 *   - POST /ingest/match: happy path, 401 bad secret, 503 disabled, dedupe
 *   - POST /claim: happy path, email conflict, name conflict, 429 rate limit
 *   - POST /login: happy path, bad credentials, 429 rate limit
 *   - GET /leaderboard: happy, CORS headers, OPTIONS preflight
 *   - GET /players/:publicId: happy, 404 unknown, CORS headers
 *   - GET /healthz: ok + CORS headers
 *   - 404 unknown route
 *   - Malformed JSON => 400
 *   - checkIngestAuth unit tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createStatsServer, checkIngestAuth } from '../src/http.js';
import type { StatsRepository } from '../src/db.js';
import type { StatsConfig } from '../src/types.js';
import type {
  LeaderboardEntry,
  PlayerProfile,
  MatchResultIngest,
  ClaimRequest,
  LoginRequest,
  MatchIngestResponse,
  ClaimResponse,
} from '@bships/core';
import type { PlayerRow, ClaimOutcome } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePublicId(): string {
  return 's' + randomBytes(8).toString('hex');
}

function makeToken(): string {
  return randomBytes(16).toString('hex');
}

function derivePublicId(token: string): string {
  return 's' + createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function makeConfig(overrides: Partial<StatsConfig> = {}): StatsConfig {
  return {
    port: 0, // ephemeral
    dbPath: ':memory:',
    ingestSecret: 'test-secret-abc',
    corsOrigin: 'http://localhost:5173',
    maxLeaderboardLimit: 100,
    profileRecentLimit: 10,
    trustProxy: false,
    ...overrides,
  };
}

const INGEST_SECRET = 'test-secret-abc';
const BEARER = `Bearer ${INGEST_SECRET}`;

// ---------------------------------------------------------------------------
// Mock repository
// ---------------------------------------------------------------------------

interface MockDB {
  players: Map<string, PlayerRow & { email?: string; passwordHash?: string }>;
  matches: Array<{ id: number; resultKey: string; ingest: MatchResultIngest }>;
}

function makePlayerRow(publicId: string, name: string): PlayerRow {
  const now = Date.now();
  return {
    publicId,
    name,
    claimed: false,
    rating: 1200,
    wins: 0,
    losses: 0,
    matchesPlayed: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Build a minimal mock StatsRepository that exercises the http layer. */
function makeMockRepo(db: MockDB): StatsRepository {
  return {
    get db(): never {
      throw new Error('mock db handle not exposed');
    },
    close() {},

    getPlayerByPublicId(publicId) {
      return db.players.get(publicId) ?? null;
    },

    upsertPlayer(publicId, name) {
      let row = db.players.get(publicId);
      if (row === undefined) {
        row = makePlayerRow(publicId, name);
        db.players.set(publicId, row);
      } else if (!row.claimed) {
        row.name = name;
      }
      return row;
    },

    recordMatch(result) {
      const parts = result.participants.map((p) => p.publicId).sort();
      const resultKey = createHash('sha256')
        .update(`${result.seed}:${result.startedAt}:${parts.join(',')}`)
        .digest('hex');

      const existing = db.matches.find((m) => m.resultKey === resultKey);
      if (existing !== undefined) {
        return { matchId: existing.id, duplicate: true };
      }

      const matchId = db.matches.length + 1;
      db.matches.push({ id: matchId, resultKey, ingest: result });

      // Update player rows
      for (const p of result.participants) {
        const row = db.players.get(p.publicId) ?? makePlayerRow(p.publicId, p.name);
        row.matchesPlayed += 1;
        if (result.winnerTeam !== null) {
          if (p.team === result.winnerTeam) row.wins += 1;
          else row.losses += 1;
        }
        db.players.set(p.publicId, row);
      }

      return { matchId, duplicate: false };
    },

    getLeaderboard(limit) {
      const entries: LeaderboardEntry[] = [];
      for (const row of db.players.values()) {
        entries.push({
          publicId: row.publicId,
          name: row.name,
          rating: row.rating,
          wins: row.wins,
          losses: row.losses,
          matchesPlayed: row.matchesPlayed,
          claimed: row.claimed,
        });
      }
      return entries
        .sort((a, b) => b.rating - a.rating)
        .slice(0, limit);
    },

    getPlayerProfile(publicId, recentLimit) {
      const row = db.players.get(publicId);
      if (row === undefined) return null;
      const profile: PlayerProfile = {
        publicId: row.publicId,
        name: row.name,
        claimed: row.claimed,
        rating: row.rating,
        wins: row.wins,
        losses: row.losses,
        matchesPlayed: row.matchesPlayed,
        favoriteShipTypeId: null,
        recentMatches: db.matches
          .filter((m) => m.ingest.participants.some((p) => p.publicId === publicId))
          .slice(-recentLimit)
          .map((m) => ({
            matchId: m.id,
            endedAt: m.ingest.startedAt + m.ingest.durationTicks * 50,
            rulesetId: m.ingest.rulesetId,
            team: m.ingest.participants.find((p) => p.publicId === publicId)!.team,
            won: m.ingest.winnerTeam !== null &&
              m.ingest.participants.find((p) => p.publicId === publicId)!.team === m.ingest.winnerTeam,
            shipTypeId: m.ingest.participants.find((p) => p.publicId === publicId)!.shipTypeId,
            kills: m.ingest.participants.find((p) => p.publicId === publicId)!.kills,
            deaths: m.ingest.participants.find((p) => p.publicId === publicId)!.deaths,
            ratingDelta: 0,
          })),
      };
      return profile;
    },

    claimAccount(publicId, email, password, name) {
      // Check email uniqueness
      for (const [, row] of db.players) {
        if (row.claimed && (row as PlayerRow & { email?: string }).email === email.toLowerCase()) {
          const outcome: ClaimOutcome = { ok: false, reason: 'emailTaken' };
          return outcome;
        }
      }
      // Check name uniqueness among claimed
      const lowerName = name.toLowerCase();
      for (const [, row] of db.players) {
        if (row.claimed && row.name.toLowerCase() === lowerName && row.publicId !== publicId) {
          const outcome: ClaimOutcome = { ok: false, reason: 'nameTaken' };
          return outcome;
        }
      }

      // Upsert the player
      const row = db.players.get(publicId) ?? makePlayerRow(publicId, name);
      row.claimed = true;
      row.name = name;
      (row as PlayerRow & { email?: string; passwordHash?: string }).email = email.toLowerCase();
      (row as PlayerRow & { email?: string; passwordHash?: string }).passwordHash = password; // store plaintext for mock
      db.players.set(publicId, row);
      const outcome: ClaimOutcome = { ok: true, row };
      return outcome;
    },

    verifyLogin(email, password) {
      for (const [, row] of db.players) {
        const r = row as PlayerRow & { email?: string; passwordHash?: string };
        if (r.claimed && r.email === email.toLowerCase()) {
          if (r.passwordHash === password) {
            const outcome: ClaimOutcome = { ok: true, row };
            return outcome;
          } else {
            const outcome: ClaimOutcome = { ok: false, reason: 'badCredentials' };
            return outcome;
          }
        }
      }
      const outcome: ClaimOutcome = { ok: false, reason: 'badCredentials' };
      return outcome;
    },
  };
}

// ---------------------------------------------------------------------------
// Build a valid MatchResultIngest fixture
// ---------------------------------------------------------------------------

function makeIngestBody(overrides: Partial<MatchResultIngest> = {}): MatchResultIngest {
  const token1 = makeToken();
  const token2 = makeToken();
  return {
    rulesetId: 'classic',
    seed: 42,
    startedAt: 1_700_000_000_000,
    durationTicks: 1000,
    winnerTeam: 'south',
    participants: [
      {
        token: token1,
        publicId: derivePublicId(token1),
        name: 'PlayerA',
        slot: 2,
        team: 'south',
        shipTypeId: 'destroyer',
        kills: 5,
        deaths: 1,
        goldEarned: 3000,
      },
      {
        token: token2,
        publicId: derivePublicId(token2),
        name: 'PlayerB',
        slot: 7,
        team: 'north',
        shipTypeId: 'battleship',
        kills: 2,
        deaths: 3,
        goldEarned: 1500,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let baseUrl: string;
let server: Awaited<ReturnType<typeof createStatsServer>>;
let db: MockDB;
let clockMs = Date.now();

beforeAll(async () => {
  db = { players: new Map(), matches: [] };
  const config = makeConfig({ ingestSecret: INGEST_SECRET });
  server = createStatsServer({
    repo: makeMockRepo(db),
    config,
    now: () => clockMs,
  });
  const port = await server.listen();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  // Reset DB state between tests.
  db.players.clear();
  db.matches.length = 0;
  // Advance the clock by 200 s to fully refill the rate-limiter token bucket
  // (burst=5, refill=1/30s, so 5*30s=150s clears it) between tests. The shared
  // server instance re-uses the same RateLimiter; only the clock needs to move.
  clockMs += 200_000;
});

// ---------------------------------------------------------------------------
// checkIngestAuth unit tests
// ---------------------------------------------------------------------------

describe('checkIngestAuth', () => {
  it('returns true for matching Bearer token', () => {
    expect(checkIngestAuth('Bearer my-secret', 'my-secret')).toBe(true);
  });

  it('returns false for wrong token', () => {
    expect(checkIngestAuth('Bearer wrong', 'my-secret')).toBe(false);
  });

  it('returns false when header is undefined', () => {
    expect(checkIngestAuth(undefined, 'my-secret')).toBe(false);
  });

  it('returns false when configured secret is empty (disabled)', () => {
    expect(checkIngestAuth('Bearer anything', '')).toBe(false);
  });

  it('returns false for length mismatch (no false positive from timingSafeEqual)', () => {
    expect(checkIngestAuth('Bearer short', 'short-but-different')).toBe(false);
    expect(checkIngestAuth('Bearer a', 'ab')).toBe(false);
  });

  it('returns false when header has no Bearer prefix', () => {
    expect(checkIngestAuth('my-secret', 'my-secret')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /healthz
// ---------------------------------------------------------------------------

describe('GET /healthz', () => {
  it('returns ok:true with CORS header', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});

// ---------------------------------------------------------------------------
// OPTIONS preflight
// ---------------------------------------------------------------------------

describe('OPTIONS preflight', () => {
  it('responds 204 with CORS headers for /leaderboard', async () => {
    const res = await fetch(`${baseUrl}/leaderboard`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('responds 204 with CORS headers for /players/:id', async () => {
    const res = await fetch(`${baseUrl}/players/${makePublicId()}`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('responds 204 for /healthz preflight', async () => {
    const res = await fetch(`${baseUrl}/healthz`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });

  it('responds 405 for OPTIONS on unknown route', async () => {
    const res = await fetch(`${baseUrl}/unknown-route`, { method: 'OPTIONS' });
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// GET /leaderboard
// ---------------------------------------------------------------------------

describe('GET /leaderboard', () => {
  it('returns empty entries when no players', async () => {
    const res = await fetch(`${baseUrl}/leaderboard`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ entries: [] });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('returns entries sorted by rating desc', async () => {
    const idA = makePublicId();
    const idB = makePublicId();
    db.players.set(idA, { ...makePlayerRow(idA, 'Alpha'), rating: 1500 });
    db.players.set(idB, { ...makePlayerRow(idB, 'Beta'), rating: 1300 });

    const res = await fetch(`${baseUrl}/leaderboard`);
    const body = await res.json() as { entries: LeaderboardEntry[] };
    expect(body.entries[0]!.rating).toBeGreaterThanOrEqual(body.entries[1]!.rating);
    expect(body.entries[0]!.name).toBe('Alpha');
  });

  it('respects ?limit param', async () => {
    for (let i = 0; i < 5; i++) {
      const id = makePublicId();
      db.players.set(id, makePlayerRow(id, `P${i}`));
    }
    const res = await fetch(`${baseUrl}/leaderboard?limit=2`);
    const body = await res.json() as { entries: LeaderboardEntry[] };
    expect(body.entries.length).toBeLessThanOrEqual(2);
  });

  it('returns 400 for invalid limit', async () => {
    const res = await fetch(`${baseUrl}/leaderboard?limit=abc`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for limit=0', async () => {
    const res = await fetch(`${baseUrl}/leaderboard?limit=0`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /players/:publicId
// ---------------------------------------------------------------------------

describe('GET /players/:publicId', () => {
  it('returns 404 for unknown publicId', async () => {
    const res = await fetch(`${baseUrl}/players/${makePublicId()}`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not found/i);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('returns 404 for malformed publicId pattern', async () => {
    const res = await fetch(`${baseUrl}/players/invalid-id`);
    expect(res.status).toBe(404);
  });

  it('returns player profile for known player', async () => {
    const id = makePublicId();
    db.players.set(id, makePlayerRow(id, 'TestPlayer'));

    const res = await fetch(`${baseUrl}/players/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as PlayerProfile;
    expect(body.publicId).toBe(id);
    expect(body.name).toBe('TestPlayer');
    expect(body.rating).toBe(1200);
    expect(body.recentMatches).toEqual([]);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});

// ---------------------------------------------------------------------------
// POST /ingest/match
// ---------------------------------------------------------------------------

describe('POST /ingest/match', () => {
  it('ingests a match and returns matchId + duplicate:false', async () => {
    const body = makeIngestBody();
    const res = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const result = await res.json() as MatchIngestResponse;
    expect(typeof result.matchId).toBe('number');
    expect(result.duplicate).toBe(false);
  });

  it('returns duplicate:true on second POST of same result', async () => {
    const body = makeIngestBody();
    const res1 = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(200);
    const r1 = await res1.json() as MatchIngestResponse;

    const res2 = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    expect(res2.status).toBe(200);
    const r2 = await res2.json() as MatchIngestResponse;
    expect(r2.duplicate).toBe(true);
    expect(r2.matchId).toBe(r1.matchId);
  });

  it('returns 401 for wrong secret', async () => {
    const body = makeIngestBody();
    const res = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-secret' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for missing Authorization header', async () => {
    const body = makeIngestBody();
    const res = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when ingest secret is empty (disabled)', async () => {
    // Create a second server with no secret
    const db2: MockDB = { players: new Map(), matches: [] };
    const server2 = createStatsServer({
      repo: makeMockRepo(db2),
      config: makeConfig({ ingestSecret: '' }),
    });
    const port2 = await server2.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port2}/ingest/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: BEARER },
        body: JSON.stringify(makeIngestBody()),
      });
      expect(res.status).toBe(503);
    } finally {
      await server2.close();
    }
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: '{invalid json}',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify({ rulesetId: 'classic' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty participants array', async () => {
    const body = makeIngestBody({ participants: [] });
    const res = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid participant token pattern', async () => {
    const body = makeIngestBody();
    // Corrupt the token
    (body.participants[0] as MatchResultIngest['participants'][number]).token = 'not-a-valid-token';
    const res = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when publicId does not derive from the token', async () => {
    const body = makeIngestBody();
    // Keep a valid-shaped publicId but unrelated to the token.
    (body.participants[0] as MatchResultIngest['participants'][number]).publicId =
      's0000000000000000';
    const res = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(db.matches.length).toBe(0); // nothing persisted
  });

  it('returns 400 (not 500) for a duplicate publicId across participants', async () => {
    const token = makeToken();
    const dup = derivePublicId(token);
    const body = makeIngestBody();
    // Two participants sharing the same token-derived publicId.
    body.participants[0] = { ...body.participants[0]!, token, publicId: dup, team: 'south', slot: 2 };
    body.participants[1] = { ...body.participants[1]!, token, publicId: dup, team: 'north', slot: 7 };
    const res = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an over-long participant name', async () => {
    const body = makeIngestBody();
    (body.participants[0] as MatchResultIngest['participants'][number]).name = 'x'.repeat(100);
    const res = await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });

  it('records match and creates player rows', async () => {
    const body = makeIngestBody();
    await fetch(`${baseUrl}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    expect(db.players.size).toBe(2);
    expect(db.matches.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /claim
// ---------------------------------------------------------------------------

describe('POST /claim', () => {
  it('claims an account successfully', async () => {
    const token = makeToken();
    const claimBody: ClaimRequest = {
      token,
      email: 'alice@example.com',
      password: 'hunter2',
      name: 'Alice',
    };
    const res = await fetch(`${baseUrl}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(claimBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as ClaimResponse;
    expect(body.publicId).toBe(derivePublicId(token));
    expect(body.name).toBe('Alice');
    expect(body.email).toBe('alice@example.com');
    expect(typeof body.sessionToken).toBe('string');
    expect(body.sessionToken.length).toBeGreaterThan(0);
  });

  it('returns 409 when email is already taken', async () => {
    const token1 = makeToken();
    const token2 = makeToken();
    const id1 = derivePublicId(token1);

    // Seed a claimed player with this email
    db.players.set(id1, {
      ...makePlayerRow(id1, 'Alice'),
      claimed: true,
      email: 'alice@example.com',
      passwordHash: 'hunter2',
    });

    const res = await fetch(`${baseUrl}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token2, email: 'alice@example.com', password: 'pw', name: 'Bob' }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 409 when name is already taken', async () => {
    const token1 = makeToken();
    const id1 = derivePublicId(token1);
    const token2 = makeToken();

    // Seed a claimed player with this name
    db.players.set(id1, {
      ...makePlayerRow(id1, 'Alice'),
      claimed: true,
      email: 'other@example.com',
      passwordHash: 'pw',
    });

    const res = await fetch(`${baseUrl}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token2, email: 'new@example.com', password: 'pw', name: 'Alice' }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 400 for invalid body', async () => {
    const res = await fetch(`${baseUrl}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'bad', email: 'not-an-email', password: 'pw', name: 'X' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 429 after burst limit exceeded', async () => {
    // Make a server with overridden clock so we control token refill
    const fakeMs = Date.now();
    const db3: MockDB = { players: new Map(), matches: [] };
    const server3 = createStatsServer({
      repo: makeMockRepo(db3),
      config: makeConfig({ ingestSecret: INGEST_SECRET }),
      now: () => fakeMs,
    });
    const port3 = await server3.listen();
    const url3 = `http://127.0.0.1:${port3}`;
    try {
      const badClaim = { token: makeToken(), email: 'x@x.com', password: 'pw', name: 'X' };

      // Exhaust burst (5 allowed, 6th should 429)
      let lastStatus = 0;
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`${url3}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...badClaim, email: `u${i}@ex.com`, name: `U${i}`, token: makeToken() }),
        });
        lastStatus = r.status;
      }
      expect(lastStatus).toBe(429);
    } finally {
      await server3.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------

describe('POST /login', () => {
  it('logs in with correct credentials', async () => {
    const token = makeToken();
    const id = derivePublicId(token);
    db.players.set(id, {
      ...makePlayerRow(id, 'Bob'),
      claimed: true,
      email: 'bob@example.com',
      passwordHash: 'correctpass',
    });

    const loginBody: LoginRequest = { email: 'bob@example.com', password: 'correctpass' };
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as ClaimResponse;
    expect(body.publicId).toBe(id);
    expect(body.name).toBe('Bob');
    expect(body.email).toBe('bob@example.com');
    expect(typeof body.sessionToken).toBe('string');
  });

  it('returns 401 for wrong password', async () => {
    const token = makeToken();
    const id = derivePublicId(token);
    db.players.set(id, {
      ...makePlayerRow(id, 'Bob'),
      claimed: true,
      email: 'bob@example.com',
      passwordHash: 'correctpass',
    });

    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', password: 'wrongpass' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for unknown email', async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'pw' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid body', async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-email', password: 'pw' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 429 after burst limit exceeded', async () => {
    const fakeMs = Date.now();
    const db4: MockDB = { players: new Map(), matches: [] };
    const server4 = createStatsServer({
      repo: makeMockRepo(db4),
      config: makeConfig({ ingestSecret: INGEST_SECRET }),
      now: () => fakeMs,
    });
    const port4 = await server4.listen();
    const url4 = `http://127.0.0.1:${port4}`;
    try {
      // Hammer the SAME target email: a burst against one account must throttle.
      // (The limiter keys on IP+email, so distinct emails get distinct buckets —
      // see the fairness test below.)
      let lastStatus = 0;
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`${url4}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'victim@ex.com', password: 'pw' }),
        });
        lastStatus = r.status;
      }
      // Last request should be rate limited
      expect(lastStatus).toBe(429);
    } finally {
      await server4.close();
    }
  });

  it('keys login throttling on email+IP: spamming one account does NOT lock out a different one', async () => {
    const fakeMs = Date.now();
    const db5: MockDB = { players: new Map(), matches: [] };
    const server5 = createStatsServer({
      repo: makeMockRepo(db5),
      config: makeConfig({ ingestSecret: INGEST_SECRET }),
      now: () => fakeMs,
    });
    const port5 = await server5.listen();
    const url5 = `http://127.0.0.1:${port5}`;
    try {
      // Exhaust the bucket for accountA (6 attempts => last is 429).
      for (let i = 0; i < 6; i++) {
        await fetch(`${url5}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'accountA@ex.com', password: 'pw' }),
        });
      }
      // A DIFFERENT account from the same IP is unaffected (own bucket).
      const other = await fetch(`${url5}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'accountB@ex.com', password: 'pw' }),
      });
      expect(other.status).not.toBe(429); // 401 bad credentials, not throttled
    } finally {
      await server5.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 404 unknown route
// ---------------------------------------------------------------------------

describe('Unknown routes', () => {
  it('returns 404 for GET /unknown', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe('string');
  });

  it('returns 404 for POST /unknown', async () => {
    const res = await fetch(`${baseUrl}/unknown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// JSON error shape
// ---------------------------------------------------------------------------

describe('Error responses', () => {
  it('all non-2xx responses have { error } JSON shape', async () => {
    const cases = [
      fetch(`${baseUrl}/players/invalid-id`),
      fetch(`${baseUrl}/unknown`),
      fetch(`${baseUrl}/ingest/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    ];
    const responses = await Promise.all(cases);
    for (const res of responses) {
      const body = await res.json() as Record<string, unknown>;
      expect(typeof body['error']).toBe('string');
    }
  });
});
