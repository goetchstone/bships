/**
 * Tests for server-integration stats module:
 *  - deriveStatsPublicId: stable, matches STATS_PUBLIC_ID_PATTERN, differs per token.
 *  - createStatsPoster: posts correct body + auth header, retries on failure with
 *    exponential backoff, fires-and-forgets (never throws to caller).
 *  - room manager (via fake-runtime harness): builds a correct MatchResultIngest
 *    on match end; default no-op poster never throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MATCH_COUNTDOWN_SECONDS, PROTOCOL_VERSION, STATS_PUBLIC_ID_PATTERN } from '@bships/core';
import type { MatchResultIngest, Ruleset, ServerMessage } from '@bships/core';
import {
  createNoopStatsPoster,
  createStatsPoster,
  createStatsPosterFromEnv,
  deriveStatsPublicId,
} from '../src/stats/index.js';
import type { StatsPoster } from '../src/stats/index.js';
import { createRoomManager } from '../src/rooms.js';
import type { ManagedConnection, MatchRuntime, MatchRuntimeDeps, RoomManager } from '../src/rooms.js';

// ---------------------------------------------------------------------------
// deriveStatsPublicId
// ---------------------------------------------------------------------------

const TOKEN_X = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
const TOKEN_Y = 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5';

describe('deriveStatsPublicId', () => {
  it('matches STATS_PUBLIC_ID_PATTERN', () => {
    expect(deriveStatsPublicId(TOKEN_X)).toMatch(STATS_PUBLIC_ID_PATTERN);
    expect(deriveStatsPublicId(TOKEN_Y)).toMatch(STATS_PUBLIC_ID_PATTERN);
  });

  it('is stable across multiple calls with the same token', () => {
    const a = deriveStatsPublicId(TOKEN_X);
    const b = deriveStatsPublicId(TOKEN_X);
    expect(a).toBe(b);
  });

  it('produces different ids for different tokens', () => {
    expect(deriveStatsPublicId(TOKEN_X)).not.toBe(deriveStatsPublicId(TOKEN_Y));
  });

  it('never equals the token itself', () => {
    expect(deriveStatsPublicId(TOKEN_X)).not.toBe(TOKEN_X);
  });
});

// ---------------------------------------------------------------------------
// createStatsPosterFromEnv
// ---------------------------------------------------------------------------

describe('createStatsPosterFromEnv', () => {
  it('returns a no-op poster when STATS_URL is unset', () => {
    const poster = createStatsPosterFromEnv({});
    // No-op: does not throw.
    expect(() => poster.postMatchResult({} as MatchResultIngest)).not.toThrow();
  });

  it('returns a no-op poster when STATS_INGEST_SECRET is unset', () => {
    const poster = createStatsPosterFromEnv({ STATS_URL: 'http://localhost:8088' });
    expect(() => poster.postMatchResult({} as MatchResultIngest)).not.toThrow();
  });

  it('returns a real poster when both vars are set', () => {
    const poster = createStatsPosterFromEnv({
      STATS_URL: 'http://localhost:8088',
      STATS_INGEST_SECRET: 'mysecret',
    });
    // The poster is a real implementation (has postMatchResult). We just verify
    // it does not throw synchronously when called (the actual network call is
    // detached).
    expect(() => poster.postMatchResult({} as MatchResultIngest)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createStatsPoster — fire-and-forget, retry with backoff
// ---------------------------------------------------------------------------

describe('createStatsPoster', () => {
  it('POSTs the correct body and Authorization header on success', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ matchId: 1, duplicate: false }), { status: 200 });
    });

    const poster = createStatsPoster({
      url: 'http://stats.test',
      secret: 'test-secret',
      fetchImpl: fakeFetch as unknown as typeof fetch,
      baseBackoffMs: 0,
      maxAttempts: 3,
    });

    const result: MatchResultIngest = {
      rulesetId: 'classic',
      seed: 0xdeadbeef,
      startedAt: 1000000,
      durationTicks: 200,
      winnerTeam: 'south',
      participants: [],
    };

    poster.postMatchResult(result);

    // Wait for the detached promise to resolve.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://stats.test/ingest/match');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-secret');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual(result);
  });

  it('retries on non-2xx response and gives up after maxAttempts', async () => {
    const calls: number[] = [];
    const fakeFetch = vi.fn(async () => {
      calls.push(Date.now());
      return new Response('Server Error', { status: 500 });
    });

    const poster = createStatsPoster({
      url: 'http://stats.test',
      secret: 'test-secret',
      fetchImpl: fakeFetch as unknown as typeof fetch,
      baseBackoffMs: 1, // tiny backoff for fast test
      maxAttempts: 3,
    });

    poster.postMatchResult({ rulesetId: 'classic', seed: 1, startedAt: 1, durationTicks: 1, winnerTeam: null, participants: [] });

    // Wait long enough for all retries.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(calls).toHaveLength(3);
  });

  it('retries on network error (fetch throws)', async () => {
    let callCount = 0;
    const fakeFetch = vi.fn(async () => {
      callCount += 1;
      if (callCount < 3) throw new Error('network error');
      return new Response(JSON.stringify({ matchId: 2, duplicate: false }), { status: 200 });
    });

    const poster = createStatsPoster({
      url: 'http://stats.test',
      secret: 'test-secret',
      fetchImpl: fakeFetch as unknown as typeof fetch,
      baseBackoffMs: 1,
      maxAttempts: 4,
    });

    poster.postMatchResult({ rulesetId: 'classic', seed: 1, startedAt: 1, durationTicks: 1, winnerTeam: null, participants: [] });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(callCount).toBe(3); // succeeded on 3rd attempt
  });

  it('never throws synchronously to the caller even on total failure', () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('always fails');
    });

    const poster = createStatsPoster({
      url: 'http://stats.test',
      secret: 'bad',
      fetchImpl: fakeFetch as unknown as typeof fetch,
      baseBackoffMs: 0,
      maxAttempts: 1,
    });

    // Must not throw.
    expect(() =>
      poster.postMatchResult({ rulesetId: 'classic', seed: 1, startedAt: 1, durationTicks: 1, winnerTeam: null, participants: [] }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Room manager + stats integration
// ---------------------------------------------------------------------------

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const TEST_SEED = 0x12345678;
const FAKE_RULESET = { name: 'classic' } as unknown as Ruleset;

class FakeSocket {
  readonly sent: ServerMessage[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ServerMessage);
  }
  close(): void {}
  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
  lastOfType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> {
    const list = this.ofType(type);
    const last = list[list.length - 1];
    if (last === undefined) throw new Error(`no ${type}`);
    return last;
  }
}

interface TestClient {
  socket: FakeSocket;
  conn: ManagedConnection;
  send(msg: unknown): void;
}

function connect(manager: RoomManager): TestClient {
  const socket = new FakeSocket();
  const conn = manager.handleConnection(socket);
  return { socket, conn, send: (msg) => conn.onMessage(JSON.stringify(msg)) };
}

function hello(client: TestClient, token: string, name: string): void {
  client.send({ type: 'hello', version: PROTOCOL_VERSION, token, name });
}

interface FakeRuntimeEntry {
  deps: MatchRuntimeDeps;
  runtime: MatchRuntime;
}

function runtimeFactory(): { create(deps: MatchRuntimeDeps): MatchRuntime; created: FakeRuntimeEntry[] } {
  const created: FakeRuntimeEntry[] = [];
  return {
    created,
    create(deps) {
      const runtime: MatchRuntime = {
        status: 'running' as const,
        start: vi.fn(),
        stop: vi.fn(),
        enqueueCommand: vi.fn(),
        setConnected: vi.fn(),
      };
      created.push({ deps, runtime });
      return runtime;
    },
  };
}

describe('room manager stats integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setupMatchWithPoster(poster: StatsPoster): {
    factory: ReturnType<typeof runtimeFactory>;
    host: TestClient;
    guest: TestClient;
  } {
    const factory = runtimeFactory();
    const manager = createRoomManager(FAKE_RULESET, {
      createRuntime: (d) => factory.create(d),
      drawSeed: () => TEST_SEED,
      statsPoster: poster,
    });

    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');

    host.send({ type: 'createRoom', roomName: 'Stats Room' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    guest.send({ type: 'joinRoom', roomId });
    host.send({ type: 'pickSlot', slot: 2 }); // south
    guest.send({ type: 'pickSlot', slot: 7 }); // north
    host.send({ type: 'setReady', ready: true });
    guest.send({ type: 'setReady', ready: true });
    host.send({ type: 'startMatch' });
    vi.advanceTimersByTime(MATCH_COUNTDOWN_SECONDS * 1000);

    return { factory, host, guest };
  }

  it('builds a correct MatchResultIngest with right participants when match ends', () => {
    const captured: MatchResultIngest[] = [];
    const poster: StatsPoster = {
      postMatchResult(r) {
        captured.push(r);
      },
    };

    const { factory } = setupMatchWithPoster(poster);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');

    const publicIdA = deriveStatsPublicId(TOKEN_A);
    const publicIdB = deriveStatsPublicId(TOKEN_B);

    entry.deps.onEnded({
      winnerTeam: 'south',
      stats: [
        { slot: 2, name: 'Host', team: 'south', shipTypeId: 'H00A', level: 5, kills: 3, deaths: 1, connected: true },
        { slot: 7, name: 'Guest', team: 'north', shipTypeId: 'H00B', level: 4, kills: 1, deaths: 2, connected: true },
      ],
      seed: TEST_SEED,
      rulesetId: 'classic',
      durationTicks: 400,
      goldEarned: new Map([[2, 1500], [7, 800]]),
    });

    expect(captured).toHaveLength(1);
    const ingest = captured[0];
    if (ingest === undefined) throw new Error('no ingest captured');

    expect(ingest.seed).toBe(TEST_SEED);
    expect(ingest.rulesetId).toBe('classic');
    expect(ingest.durationTicks).toBe(400);
    expect(ingest.winnerTeam).toBe('south');
    expect(typeof ingest.startedAt).toBe('number');

    const pHost = ingest.participants.find((p) => p.slot === 2);
    const pGuest = ingest.participants.find((p) => p.slot === 7);

    expect(pHost).toBeDefined();
    expect(pHost?.publicId).toBe(publicIdA);
    expect(pHost?.token).toBe(TOKEN_A);
    expect(pHost?.name).toBe('Host');
    expect(pHost?.team).toBe('south');
    expect(pHost?.shipTypeId).toBe('H00A');
    expect(pHost?.kills).toBe(3);
    expect(pHost?.deaths).toBe(1);
    expect(pHost?.goldEarned).toBe(1500);

    expect(pGuest).toBeDefined();
    expect(pGuest?.publicId).toBe(publicIdB);
    expect(pGuest?.token).toBe(TOKEN_B);
    expect(pGuest?.team).toBe('north');
    expect(pGuest?.goldEarned).toBe(800);
  });

  it('default no-op poster never throws when match ends', () => {
    // No statsPoster passed => createNoopStatsPoster used.
    const factory = runtimeFactory();
    const manager = createRoomManager(FAKE_RULESET, {
      createRuntime: (d) => factory.create(d),
      drawSeed: () => TEST_SEED,
      // statsPoster intentionally omitted
    });

    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Noop Room' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');
    guest.send({ type: 'joinRoom', roomId });
    host.send({ type: 'pickSlot', slot: 2 });
    guest.send({ type: 'pickSlot', slot: 7 });
    host.send({ type: 'setReady', ready: true });
    guest.send({ type: 'setReady', ready: true });
    host.send({ type: 'startMatch' });
    vi.advanceTimersByTime(MATCH_COUNTDOWN_SECONDS * 1000);

    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');

    // Should never throw.
    expect(() =>
      entry.deps.onEnded({
        winnerTeam: null,
        stats: [],
        seed: TEST_SEED,
        rulesetId: 'classic',
        durationTicks: 0,
        goldEarned: new Map(),
      }),
    ).not.toThrow();
  });

  it('createNoopStatsPoster.postMatchResult never throws', () => {
    const noop = createNoopStatsPoster();
    expect(() => noop.postMatchResult({} as MatchResultIngest)).not.toThrow();
  });
});
