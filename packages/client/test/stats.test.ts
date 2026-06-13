/**
 * client-stats tests: format helpers, API wiring (mocked fetch), session
 * round-trip, and classifyKillEvent. No DOM / network required.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  displayLeaderboard,
  matchSummaryLine,
  rankLabel,
  ratingDeltaLabel,
  relativeTime,
  winRate,
} from '../src/stats/format.js';
import { StatsApiError, createStatsApi } from '../src/stats/api.js';
import { STATS_SESSION_KEY, clearSession, loadSession, saveSession } from '../src/stats/session.js';
import { classifyKillEvent } from '../src/hud/hudmath.js';

import type {
  ClaimResponse,
  LeaderboardEntry,
  LeaderboardResponse,
  ProfileMatchSummary,
  Ruleset,
  SimEvent,
} from '@bships/core';

// ---------------------------------------------------------------------------
// format.ts helpers
// ---------------------------------------------------------------------------

describe('format: winRate', () => {
  it('returns em-dash with no matches', () => {
    expect(winRate(0, 0)).toBe('—');
  });
  it('rounds to nearest integer percentage', () => {
    expect(winRate(1, 1)).toBe('50%');
    expect(winRate(2, 1)).toBe('67%');
    expect(winRate(1, 0)).toBe('100%');
    expect(winRate(0, 5)).toBe('0%');
  });
});

describe('format: ratingDeltaLabel', () => {
  it('prefixes positive delta with +', () => {
    expect(ratingDeltaLabel(12)).toBe('+12');
  });
  it('uses minus for negative delta', () => {
    expect(ratingDeltaLabel(-8)).toBe('-8');
  });
  it('shows ±0 for zero delta', () => {
    expect(ratingDeltaLabel(0)).toBe('\xb10');
  });
});

describe('format: rankLabel', () => {
  it('converts zero-based index to 1-based rank string', () => {
    expect(rankLabel(0)).toBe('#1');
    expect(rankLabel(4)).toBe('#5');
  });
});

describe('format: relativeTime', () => {
  it('returns "just now" for less than 60 seconds', () => {
    const now = 1000000;
    expect(relativeTime(now - 30 * 1000, now)).toBe('just now');
    expect(relativeTime(now, now)).toBe('just now');
  });
  it('returns minutes ago', () => {
    const now = 1000000;
    expect(relativeTime(now - 3 * 60 * 1000, now)).toBe('3m ago');
  });
  it('returns hours ago', () => {
    const now = 1000000;
    expect(relativeTime(now - 5 * 60 * 60 * 1000, now)).toBe('5h ago');
  });
  it('returns days ago', () => {
    const now = 1000000;
    expect(relativeTime(now - 2 * 24 * 60 * 60 * 1000, now)).toBe('2d ago');
  });
  it('returns "just now" for future timestamps', () => {
    const now = 1000000;
    expect(relativeTime(now + 5000, now)).toBe('just now');
  });
});

describe('format: matchSummaryLine', () => {
  const m: ProfileMatchSummary = {
    matchId: 1,
    endedAt: 0,
    rulesetId: 'classic',
    team: 'south',
    won: true,
    shipTypeId: 'H001',
    kills: 5,
    deaths: 2,
    ratingDelta: 14,
  };
  it('formats a win line', () => {
    const line = matchSummaryLine(m);
    expect(line).toContain('W');
    expect(line).toContain('H001');
    expect(line).toContain('5/2');
    expect(line).toContain('+14');
  });
  it('formats a loss line', () => {
    const loss = { ...m, won: false, ratingDelta: -8 };
    const line = matchSummaryLine(loss);
    expect(line).toContain('L');
    expect(line).toContain('-8');
  });
});

describe('format: displayLeaderboard', () => {
  const entries: LeaderboardEntry[] = [
    { publicId: 'sa', name: 'Alice', rating: 1300, wins: 5, losses: 2, matchesPlayed: 7, claimed: true },
    { publicId: 'sb', name: 'Bob', rating: 1100, wins: 3, losses: 6, matchesPlayed: 9, claimed: false },
    { publicId: 'sc', name: 'Carol', rating: 1500, wins: 8, losses: 1, matchesPlayed: 9, claimed: true },
  ];

  it('sorts by rating descending', () => {
    const sorted = displayLeaderboard(entries, 10);
    expect(sorted[0]?.publicId).toBe('sc');
    expect(sorted[1]?.publicId).toBe('sa');
    expect(sorted[2]?.publicId).toBe('sb');
  });

  it('clamps to the given limit', () => {
    const clamped = displayLeaderboard(entries, 2);
    expect(clamped).toHaveLength(2);
    expect(clamped[0]?.publicId).toBe('sc');
  });

  it('does not mutate the original array', () => {
    const copy = [...entries];
    displayLeaderboard(entries, 10);
    expect(entries).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// api.ts — mocked fetch
// ---------------------------------------------------------------------------

function makeOkFetch(body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

function makeErrorFetch(status: number, errorMsg: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: errorMsg }),
  }) as unknown as typeof fetch;
}

describe('api: getLeaderboard', () => {
  it('GETs /leaderboard and returns the response', async () => {
    const mockRes: LeaderboardResponse = {
      entries: [
        { publicId: 'sa', name: 'Alice', rating: 1300, wins: 5, losses: 2, matchesPlayed: 7, claimed: true },
      ],
    };
    const mockFetch = makeOkFetch(mockRes);
    const api = createStatsApi({ baseUrl: 'http://test', fetchImpl: mockFetch });
    const res = await api.getLeaderboard();
    expect(res).toEqual(mockRes);
    expect(mockFetch).toHaveBeenCalledWith('http://test/leaderboard', expect.objectContaining({ method: 'GET' }));
  });

  it('appends ?limit= query param when provided', async () => {
    const mockFetch = makeOkFetch({ entries: [] });
    const api = createStatsApi({ baseUrl: 'http://test', fetchImpl: mockFetch });
    await api.getLeaderboard(50);
    expect(mockFetch).toHaveBeenCalledWith('http://test/leaderboard?limit=50', expect.anything());
  });

  it('throws StatsApiError on non-2xx', async () => {
    const mockFetch = makeErrorFetch(503, 'service unavailable');
    const api = createStatsApi({ baseUrl: 'http://test', fetchImpl: mockFetch });
    await expect(api.getLeaderboard()).rejects.toThrow(StatsApiError);
    await expect(api.getLeaderboard()).rejects.toMatchObject({ status: 503, message: 'service unavailable' });
  });
});

describe('api: getPlayer', () => {
  it('GETs /players/:publicId', async () => {
    const profile = {
      publicId: 'sa',
      name: 'Alice',
      claimed: true,
      rating: 1300,
      wins: 5,
      losses: 2,
      matchesPlayed: 7,
      favoriteShipTypeId: 'H001',
      recentMatches: [],
    };
    const mockFetch = makeOkFetch(profile);
    const api = createStatsApi({ baseUrl: 'http://test', fetchImpl: mockFetch });
    const res = await api.getPlayer('sa');
    expect(res).toEqual(profile);
    expect(mockFetch).toHaveBeenCalledWith('http://test/players/sa', expect.anything());
  });
});

describe('api: claim', () => {
  it('POSTs to /claim with the request body', async () => {
    const claimRes: ClaimResponse = {
      publicId: 'sa',
      name: 'Alice',
      email: 'alice@example.com',
      sessionToken: 'tok123',
    };
    const mockFetch = makeOkFetch(claimRes);
    const api = createStatsApi({ baseUrl: 'http://test', fetchImpl: mockFetch });
    const req = {
      token: 'a'.repeat(32),
      email: 'alice@example.com',
      password: 'secret',
      name: 'Alice',
    };
    const res = await api.claim(req);
    expect(res).toEqual(claimRes);
    const [url, opts] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/claim');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual(req);
  });

  it('throws StatsApiError with the service message on 422', async () => {
    const mockFetch = makeErrorFetch(422, 'email already claimed');
    const api = createStatsApi({ baseUrl: 'http://test', fetchImpl: mockFetch });
    await expect(
      api.claim({ token: 'a'.repeat(32), email: 'x@x.com', password: 'p', name: 'X' }),
    ).rejects.toMatchObject({ status: 422, message: 'email already claimed' });
  });
});

describe('api: login', () => {
  it('POSTs to /login', async () => {
    const loginRes: ClaimResponse = {
      publicId: 'sb',
      name: 'Bob',
      email: 'bob@example.com',
      sessionToken: 'tok456',
    };
    const mockFetch = makeOkFetch(loginRes);
    const api = createStatsApi({ baseUrl: 'http://test', fetchImpl: mockFetch });
    const res = await api.login({ email: 'bob@example.com', password: 'secret' });
    expect(res).toEqual(loginRes);
    expect(mockFetch).toHaveBeenCalledWith('http://test/login', expect.objectContaining({ method: 'POST' }));
  });
});

describe('api: error mapping falls back to generic message', () => {
  it('uses HTTP status message when response body is not a StatsErrorResponse', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('bad json')),
    }) as unknown as typeof fetch;
    const api = createStatsApi({ baseUrl: 'http://test', fetchImpl: mockFetch });
    await expect(api.getLeaderboard()).rejects.toMatchObject({ status: 500 });
  });
});

// ---------------------------------------------------------------------------
// session.ts — round-trip via localStorage stub
// ---------------------------------------------------------------------------

describe('session: round-trip', () => {
  const store: Record<string, string> = {};
  const localStorageStub = {
    getItem: (k: string): string | null => store[k] ?? null,
    setItem: (k: string, v: string): void => { store[k] = v; },
    removeItem: (k: string): void => { delete store[k]; },
  };

  beforeEach(() => {
    // Clear the stub store between tests.
    Object.keys(store).forEach((k) => delete store[k]);
    // Replace global localStorage with the stub.
    vi.stubGlobal('localStorage', localStorageStub);
  });

  it('loadSession returns null when nothing is stored', () => {
    expect(loadSession()).toBeNull();
  });

  it('saveSession + loadSession round-trip', () => {
    const res: ClaimResponse = {
      publicId: 'sa',
      name: 'Alice',
      email: 'alice@example.com',
      sessionToken: 'tok999',
    };
    saveSession(res);
    const loaded = loadSession();
    expect(loaded).toEqual({
      publicId: 'sa',
      name: 'Alice',
      email: 'alice@example.com',
      sessionToken: 'tok999',
    });
  });

  it('saveSession uses the correct storage key', () => {
    const res: ClaimResponse = {
      publicId: 'sa',
      name: 'Alice',
      email: 'a@b.com',
      sessionToken: 'x',
    };
    saveSession(res);
    expect(STATS_SESSION_KEY in store).toBe(true);
  });

  it('clearSession removes the stored session', () => {
    const res: ClaimResponse = {
      publicId: 'sa',
      name: 'Alice',
      email: 'a@b.com',
      sessionToken: 'x',
    };
    saveSession(res);
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it('loadSession returns null when stored value is malformed', () => {
    store[STATS_SESSION_KEY] = 'not-json{{{';
    expect(loadSession()).toBeNull();
  });

  it('loadSession returns null when stored value is missing fields', () => {
    store[STATS_SESSION_KEY] = JSON.stringify({ publicId: 'sa' });
    expect(loadSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyKillEvent
// ---------------------------------------------------------------------------

type MinimalRuleset = Pick<Ruleset, 'ships'>;

// Minimal ruleset with two player ship types.
const ruleset: MinimalRuleset = {
  ships: {
    H001: {} as Ruleset['ships'][string],
    H002: {} as Ruleset['ships'][string],
  },
};

function deathEvent(
  entityTypeId: string,
  victimPlayer: number | null,
  killerPlayer: number | null,
): SimEvent {
  return {
    type: 'death',
    tick: 1,
    entityId: 42,
    entityTypeId,
    victimPlayer,
    killerPlayer,
    x: 0,
    y: 0,
  };
}

describe('classifyKillEvent', () => {
  it('returns null for non-death events', () => {
    const ev: SimEvent = { type: 'levelUp', tick: 1, player: 3, level: 4 };
    expect(classifyKillEvent(ev, ruleset)).toBeNull();
  });

  it('returns "playerKill" when a player ship is killed by another player', () => {
    const ev = deathEvent('H001', 3, 8);
    expect(classifyKillEvent(ev, ruleset)).toBe('playerKill');
  });

  it('returns "playerDeath" when a player ship dies with no killer', () => {
    const ev = deathEvent('H001', 3, null);
    expect(classifyKillEvent(ev, ruleset)).toBe('playerDeath');
  });

  it('returns "neutral" for creep deaths (typeId not in ruleset.ships)', () => {
    // Creeps have a non-null victimPlayer (AI slot 0/1), but their typeId
    // is a unit type like 'u000', NOT a ship type.
    const ev = deathEvent('u000', 0, 3);
    expect(classifyKillEvent(ev, ruleset)).toBe('neutral');
  });

  it('returns "neutral" for empire-vs-empire creep deaths', () => {
    const ev = deathEvent('u001', 0, 1);
    expect(classifyKillEvent(ev, ruleset)).toBe('neutral');
  });

  it('returns "neutral" for structure deaths', () => {
    const ev = deathEvent('n003', null, null);
    expect(classifyKillEvent(ev, ruleset)).toBe('neutral');
  });

  it('classifies all player ship types correctly', () => {
    for (const typeId of Object.keys(ruleset.ships)) {
      expect(classifyKillEvent(deathEvent(typeId, 3, 8), ruleset)).toBe('playerKill');
      expect(classifyKillEvent(deathEvent(typeId, 3, null), ruleset)).toBe('playerDeath');
    }
  });
});
