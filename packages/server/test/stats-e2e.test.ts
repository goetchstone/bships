/**
 * Full-stack stats E2E: a REAL stats HTTP service (in-process, ephemeral port,
 * throwaway SQLite DB) + the REAL game server (startServer, ephemeral ws port)
 * wired to it with a REAL ingest poster, driven by two REAL `ws` clients
 * through lobby -> match -> completion.
 *
 * What this proves end-to-end (the wiring the integrator owns):
 *   1. matchEnded on the game server POSTs the authoritative MatchResultIngest
 *      to the stats service over HTTP with the shared-secret bearer.
 *   2. The stats service persists it: GET /leaderboard shows BOTH participants
 *      with updated Elo (winner up, loser down from the 1200 seed), and W/L
 *      reflects the winner; GET /players/:id returns the match in history.
 *   3. The publicId the server derives from the secret token (deriveStatsPublicId)
 *      is the SAME id the stats service keys + serves — the cross-process key.
 *   4. ANTI-SPOOFING: an UNAUTHENTICATED POST /ingest/match is REJECTED (401),
 *      so a browser client can never fabricate a result.
 *
 * Driving a genuine HQ-death end over gameplay would take far too long, so the
 * test injects a createRuntime wrapper (server.ts test seam) that, after a few
 * ticks, marks the north HQ dead via the runtime's getState() — the real sim's
 * own win check then fires the real matchEnded + onEnded + ingest path. Every
 * other hop (ws frames, rooms, snapshot/fog, stats HTTP, Elo, SQLite) is real.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@bships/core';
import type {
  ClientMessage,
  LeaderboardResponse,
  PlayerProfile,
  RoomStateMessage,
  ServerMessage,
  StructureEntity,
  WelcomeMessage,
} from '@bships/core';
import { createStatsServer, loadConfig, openDatabase } from '@bships/stats';
import type { StatsServer } from '@bships/stats';
import { startServer } from '../src/server.js';
import type { RunningServer } from '../src/server.js';
import { createMatchRuntime } from '../src/match.js';
import type { MatchRuntime, MatchRuntimeDeps } from '../src/match.js';
import { createStatsPoster, deriveStatsPublicId } from '../src/stats/index.js';

const INGEST_SECRET = 'e2e-test-secret-do-not-reuse';
const SOUTH_SLOT = 2;
const NORTH_SLOT = 7;

function randomToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Minimal protocol-speaking ws client: answers pings, collects messages, and
 * exposes waitFor for the handful of lobby/match transitions this test needs.
 */
class Client {
  readonly token: string;
  readonly messages: ServerMessage[] = [];
  welcome: WelcomeMessage | null = null;
  private ws: WebSocket;
  private readonly listeners = new Set<() => void>();

  private constructor(port: number, token: string) {
    this.token = token;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (data) => this.onRaw(String(data)));
  }

  static async connect(port: number, name: string, token = randomToken()): Promise<Client> {
    const c = new Client(port, token);
    await new Promise<void>((resolve, reject) => {
      c.ws.once('open', () => resolve());
      c.ws.once('error', (err) => reject(err));
    });
    c.send({ type: 'hello', version: PROTOCOL_VERSION, token, name });
    c.welcome = await c.waitFor((m): m is WelcomeMessage => m.type === 'welcome');
    return c;
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.terminate();
  }

  waitFor<T extends ServerMessage>(
    pred: (m: ServerMessage) => m is T,
    timeoutMs = 10_000,
  ): Promise<T> {
    let idx = 0;
    return new Promise<T>((resolve, reject) => {
      const scan = (): boolean => {
        while (idx < this.messages.length) {
          const m = this.messages[idx];
          idx += 1;
          if (m !== undefined && pred(m)) {
            cleanup();
            resolve(m);
            return true;
          }
        }
        return false;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitFor timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners.delete(scan);
      };
      if (!scan()) this.listeners.add(scan);
    });
  }

  private onRaw(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === 'ping') this.send({ type: 'pong', t: msg.t });
    this.messages.push(msg);
    for (const fn of [...this.listeners]) fn();
  }
}

function isRoomState(m: ServerMessage): m is RoomStateMessage {
  return m.type === 'roomState';
}

/** Poll a thunk until it returns a non-null value or the deadline passes. */
async function poll<T>(fn: () => T | null | Promise<T | null>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`poll timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('stats E2E: real game server + real stats service + 2 ws clients', () => {
  let stats: StatsServer;
  let statsBase: string;
  let game: RunningServer;
  let tmp: string;
  const southToken = randomToken();
  const northToken = randomToken();
  const southPublicId = deriveStatsPublicId(southToken);
  const northPublicId = deriveStatsPublicId(northToken);

  beforeAll(async () => {
    // 1. Real stats service: throwaway DB file, ephemeral port, real ingest secret.
    tmp = mkdtempSync(join(tmpdir(), 'bships-stats-e2e-'));
    const config = loadConfig({
      STATS_PORT: '0',
      STATS_DB_PATH: join(tmp, 'stats.db'),
      STATS_INGEST_SECRET: INGEST_SECRET,
      STATS_CORS_ORIGIN: '*',
    });
    const repo = openDatabase(config.dbPath);
    stats = createStatsServer({ repo, config });
    const statsPort = await stats.listen();
    statsBase = `http://127.0.0.1:${statsPort}`;

    // 2. Real ingest poster pointed at the live stats service (tiny backoff so a
    //    transient miss retries within the test budget).
    const poster = createStatsPoster({
      url: statsBase,
      secret: INGEST_SECRET,
      maxAttempts: 5,
      baseBackoffMs: 25,
    });

    // 3. Runtime wrapper that forces a fast, deterministic HQ-death end. After a
    //    handful of real ticks the north HQ is marked dead; the sim's own win
    //    check (sim.ts finalize) then ends the match -> matchEnded -> onEnded ->
    //    poster.postMatchResult, exactly as a natural end would.
    const createRuntime = (deps: MatchRuntimeDeps): MatchRuntime => {
      const runtime = createMatchRuntime(deps);
      const originalStart = runtime.start.bind(runtime);
      const wrapped: MatchRuntime = {
        ...runtime,
        get status() {
          return runtime.status;
        },
        get replay() {
          return runtime.replay;
        },
        getState: () => runtime.getState(),
        start() {
          originalStart();
          // Give the loop a few ticks of real life, then sink the north HQ.
          setTimeout(() => {
            const state = runtime.getState();
            const northHq = Object.values(state.entities).find(
              (e): e is StructureEntity =>
                e.kind === 'structure' && e.role === 'hq' && e.team === 'north',
            );
            if (northHq) {
              northHq.hp = 0;
              northHq.dead = true;
            }
          }, 50);
        },
      };
      return wrapped;
    };

    // 4. Real game server (burst pacing, instant countdown), poster + runtime injected.
    game = await startServer({
      port: 0,
      quiet: true,
      tickIntervalMs: 0,
      countdownSeconds: 0,
      statsPoster: poster,
      createRuntime,
    });
  }, 30_000);

  afterAll(async () => {
    await game.close();
    await stats.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('the anti-spoofing guarantee: UNAUTHENTICATED POST /ingest/match is rejected', async () => {
    const res = await fetch(`${statsBase}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rulesetId: 'classic',
        seed: 1,
        startedAt: Date.now(),
        durationTicks: 1,
        winnerTeam: 'south',
        participants: [],
      }),
    });
    // No bearer -> 401 (and certainly not a 2xx success). A browser can never write.
    expect(res.status).toBe(401);
    // And a wrong secret is also rejected.
    const res2 = await fetch(`${statsBase}/ingest/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-secret' },
      body: JSON.stringify({ rulesetId: 'classic', seed: 1, startedAt: 1, durationTicks: 1, winnerTeam: null, participants: [] }),
    });
    expect(res2.status).toBe(401);

    // Sanity: leaderboard is empty before any real match is recorded.
    const lb = (await (await fetch(`${statsBase}/leaderboard`)).json()) as LeaderboardResponse;
    expect(lb.entries).toHaveLength(0);
  });

  it('plays a match to completion (north HQ dies); the result is recorded with Elo + W/L', async () => {
    const south = await Client.connect(game.port, 'Southlord', southToken);
    const north = await Client.connect(game.port, 'Northlord', northToken);

    // Lobby flow: create -> join -> pick distinct slots -> ready -> start.
    south.send({ type: 'createRoom', roomName: 'stats e2e' });
    const created = await south.waitFor(isRoomState);
    const roomId = created.roomId;

    north.send({ type: 'joinRoom', roomId });
    await north.waitFor((m): m is RoomStateMessage => isRoomState(m) && m.players.length === 2);

    south.send({ type: 'pickSlot', slot: SOUTH_SLOT });
    north.send({ type: 'pickSlot', slot: NORTH_SLOT });
    await south.waitFor(
      (m): m is RoomStateMessage =>
        isRoomState(m) &&
        m.players.some((p) => p.slot === SOUTH_SLOT) &&
        m.players.some((p) => p.slot === NORTH_SLOT),
    );

    south.send({ type: 'setReady', ready: true });
    north.send({ type: 'setReady', ready: true });
    await south.waitFor(
      (m): m is RoomStateMessage => isRoomState(m) && m.players.every((p) => p.ready),
    );

    south.send({ type: 'startMatch' });

    // Both clients see the authoritative match end with south the winner.
    const southEnded = await south.waitFor(
      (m): m is Extract<ServerMessage, { type: 'matchEnded' }> => m.type === 'matchEnded',
      20_000,
    );
    const northEnded = await north.waitFor(
      (m): m is Extract<ServerMessage, { type: 'matchEnded' }> => m.type === 'matchEnded',
      20_000,
    );
    expect(southEnded.winnerTeam).toBe('south');
    expect(northEnded.winnerTeam).toBe('south');

    south.close();
    north.close();

    // The poster is fire-and-forget; poll the public read API until the match lands.
    const lb = await poll(async () => {
      const r = (await (await fetch(`${statsBase}/leaderboard`)).json()) as LeaderboardResponse;
      return r.entries.length >= 2 ? r : null;
    }, 'leaderboard reflects the recorded match', 15_000);

    // Both participants present, keyed by the server-derived publicId.
    const southEntry = lb.entries.find((e) => e.publicId === southPublicId);
    const northEntry = lb.entries.find((e) => e.publicId === northPublicId);
    expect(southEntry).toBeDefined();
    expect(northEntry).toBeDefined();

    // W/L reflects the winner (south won, north lost).
    expect(southEntry?.wins).toBe(1);
    expect(southEntry?.losses).toBe(0);
    expect(northEntry?.wins).toBe(0);
    expect(northEntry?.losses).toBe(1);
    expect(southEntry?.matchesPlayed).toBe(1);
    expect(northEntry?.matchesPlayed).toBe(1);

    // Standard Elo from an equal 1200 seed: winner gains, loser loses the same.
    expect(southEntry?.rating).toBeGreaterThan(1200);
    expect(northEntry?.rating).toBeLessThan(1200);
    if (southEntry && northEntry) {
      expect(southEntry.rating - 1200).toBe(1200 - northEntry.rating);
    }

    // GET /players/:id returns the match in history with the right outcome.
    const southProfile = (await (
      await fetch(`${statsBase}/players/${southPublicId}`)
    ).json()) as PlayerProfile;
    expect(southProfile.publicId).toBe(southPublicId);
    expect(southProfile.name).toBe('Southlord');
    expect(southProfile.recentMatches).toHaveLength(1);
    const sm = southProfile.recentMatches[0];
    expect(sm?.won).toBe(true);
    expect(sm?.team).toBe('south');
    expect(sm?.ratingDelta).toBeGreaterThan(0);

    const northProfile = (await (
      await fetch(`${statsBase}/players/${northPublicId}`)
    ).json()) as PlayerProfile;
    expect(northProfile.recentMatches).toHaveLength(1);
    expect(northProfile.recentMatches[0]?.won).toBe(false);
    expect(northProfile.recentMatches[0]?.ratingDelta).toBeLessThan(0);

    // The stats service NEVER echoes the secret token on a read endpoint.
    const profileJson = JSON.stringify(southProfile) + JSON.stringify(northProfile) + JSON.stringify(lb);
    expect(profileJson).not.toContain(southToken);
    expect(profileJson).not.toContain(northToken);
  }, 40_000);
});
