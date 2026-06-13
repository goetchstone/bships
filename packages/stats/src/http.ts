/**
 * Stats HTTP server (owned by stats-api). node:http only — no framework, no
 * deps. Routing + JSON body parsing + request validation + the ingest-auth
 * check + CORS (read endpoints, the configured origin) + rate limiting on the
 * claim/login endpoints. Delegates ALL persistence to the StatsRepository
 * (stats-db) and ALL Elo math to stats-elo (via the repository).
 *
 * Route table (full spec in docs/ARCH.md):
 *   POST /ingest/match   [auth: STATS_INGEST_SECRET]  body MatchResultIngest
 *   POST /claim          [rate-limited]                body ClaimRequest
 *   POST /login          [rate-limited]                body LoginRequest
 *   GET  /leaderboard?limit=N                          -> LeaderboardResponse
 *   GET  /players/:publicId                            -> PlayerProfile
 *   GET  /healthz                                      -> { ok: true }
 *
 * AUTH (HARD RULE): /ingest/match requires the shared secret presented as
 *   `Authorization: Bearer <STATS_INGEST_SECRET>`
 * and compared with node:crypto.timingSafeEqual (constant time). A browser
 * client can NEVER reach this endpoint without the secret, so match outcomes
 * cannot be fabricated. Read endpoints are public (CORS-enabled). When the
 * configured secret is empty, /ingest/match returns 503 (disabled) — never
 * open. claim/login are public but rate-limited per client IP.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { StatsConfig } from './types.js';
import type { StatsRepository } from './db.js';
import {
  STATS_PUBLIC_ID_PATTERN,
  MAX_INGEST_PARTICIPANTS,
  MAX_NAME_LENGTH,
  TOKEN_PATTERN,
} from '@bships/core';
import type {
  MatchResultIngest,
  MatchParticipantIngest,
  ClaimRequest,
  LoginRequest,
  StatsErrorResponse,
} from '@bships/core';

export interface StatsServer {
  /** Begin listening; resolves with the actually-bound port (0 => ephemeral). */
  listen(): Promise<number>;
  /** The bound port once listening (throws before listen resolves). */
  readonly port: number;
  close(): Promise<void>;
}

export interface StatsServerDeps {
  repo: StatsRepository;
  config: StatsConfig;
  /** Clock override for rate-limit windows + row stamping; default Date.now. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Token bucket rate limiter (per client IP)
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const RATE_BURST = 5;
const RATE_REFILL_PER_MS = 1 / 30000; // 1 token per 30 seconds

class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Returns true if the request should be allowed, false if it should be 429'd. */
  allow(ip: string): boolean {
    const t = this.now();
    let bucket = this.buckets.get(ip);
    if (bucket === undefined) {
      bucket = { tokens: RATE_BURST, lastRefill: t };
      this.buckets.set(ip, bucket);
    }

    // Refill based on elapsed time
    const elapsed = t - bucket.lastRefill;
    const refill = elapsed * RATE_REFILL_PER_MS;
    bucket.tokens = Math.min(RATE_BURST, bucket.tokens + refill);
    bucket.lastRefill = t;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Constant-time bearer-secret check for /ingest/match. Exposed for direct unit
 * testing. Returns false on any mismatch, missing header, or empty configured
 * secret (disabled).
 */
export function checkIngestAuth(authHeader: string | undefined, secret: string): boolean {
  // Empty configured secret => always disabled
  if (!secret) return false;
  if (authHeader === undefined) return false;

  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const presented = authHeader.slice(prefix.length);

  // Constant-time comparison — must handle length mismatch safely
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_TEAM_IDS = new Set<string>(['south', 'north']);

/**
 * Re-derive the stable stats public id from a secret token — same one-way
 * function the game server uses (deriveStatsPublicId): 's' + sha256(token) hex
 * truncated to 16. The token is the single source of truth, so the ingest path
 * re-derives and rejects any participant whose body publicId disagrees.
 */
function derivePublicId(token: string): string {
  return 's' + createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegInt(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && (v as number) >= 0;
}

function validateParticipant(p: unknown): p is MatchParticipantIngest {
  if (p === null || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  if (
    !(
      isString(obj['token']) &&
      TOKEN_PATTERN.test(obj['token'] as string) &&
      isString(obj['publicId']) &&
      STATS_PUBLIC_ID_PATTERN.test(obj['publicId'] as string) &&
      isString(obj['name']) &&
      (obj['name'] as string).length > 0 &&
      (obj['name'] as string).length <= MAX_NAME_LENGTH &&
      isNonNegInt(obj['slot']) &&
      (obj['slot'] as number) >= 2 &&
      (obj['slot'] as number) <= 11 &&
      isString(obj['team']) &&
      VALID_TEAM_IDS.has(obj['team'] as string) &&
      isString(obj['shipTypeId']) &&
      (obj['shipTypeId'] as string).length > 0 &&
      isNonNegInt(obj['kills']) &&
      isNonNegInt(obj['deaths']) &&
      isNonNegInt(obj['goldEarned'])
    )
  ) {
    return false;
  }
  // The token is authoritative: the body publicId must be the one derived from
  // it. Rejecting a mismatch keeps a buggy/second writer from forking a player
  // into a phantom record keyed by an arbitrary id (the token is otherwise only
  // carried, never validated against the id it keys on).
  return derivePublicId(obj['token'] as string) === (obj['publicId'] as string);
}

function validateMatchResultIngest(body: unknown): body is MatchResultIngest {
  if (body === null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  if (!isString(obj['rulesetId']) || (obj['rulesetId'] as string).length === 0) return false;
  if (!isNonNegInt(obj['seed'])) return false;
  if (!isFiniteNumber(obj['startedAt']) || (obj['startedAt'] as number) <= 0) return false;
  if (!isNonNegInt(obj['durationTicks'])) return false;
  if (obj['winnerTeam'] !== null && !VALID_TEAM_IDS.has(obj['winnerTeam'] as string))
    return false;
  if (!Array.isArray(obj['participants'])) return false;
  const parts = obj['participants'] as unknown[];
  if (parts.length === 0 || parts.length > MAX_INGEST_PARTICIPANTS) return false;
  if (!parts.every(validateParticipant)) return false;
  // Each player may appear at most once. A duplicate publicId would collide on
  // the match_participants PK (match_id, player_id) and surface as a 500 mid
  // transaction; fail closed at validation with a clean 400 instead.
  const publicIds = new Set((parts as MatchParticipantIngest[]).map((p) => p.publicId));
  if (publicIds.size !== parts.length) return false;
  return true;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateClaimRequest(body: unknown): body is ClaimRequest {
  if (body === null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return (
    isString(obj['token']) &&
    TOKEN_PATTERN.test(obj['token'] as string) &&
    isString(obj['email']) &&
    EMAIL_RE.test(obj['email'] as string) &&
    isString(obj['password']) &&
    (obj['password'] as string).length >= 1 &&
    isString(obj['name']) &&
    (obj['name'] as string).length >= 1
  );
}

function validateLoginRequest(body: unknown): body is LoginRequest {
  if (body === null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return (
    isString(obj['email']) &&
    EMAIL_RE.test(obj['email'] as string) &&
    isString(obj['password']) &&
    (obj['password'] as string).length >= 1
  );
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  headers?: Record<string, string>,
): void {
  const body: StatsErrorResponse = { error };
  sendJson(res, status, body, headers);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/**
 * Rate-limit key for a request. Defaults to the raw socket address (cannot be
 * forged). X-Forwarded-For is honored ONLY when config.trustProxy is set — i.e.
 * the service sits behind a proxy that SETS the header — otherwise a client
 * could spoof it to evade its own limit or weaponize a victim IP.
 */
function getClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (Array.isArray(xff)) return xff[0] ?? req.socket.remoteAddress ?? 'unknown';
    if (isString(xff)) return xff.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Construct (but do not yet start) the stats HTTP server over `repo`.
 * index.ts calls `.listen()`; tests drive it on an ephemeral port (config.port
 * 0) and hit it with real fetch.
 */
export function createStatsServer(deps: StatsServerDeps): StatsServer {
  const { repo, config } = deps;
  const now = deps.now ?? (() => Date.now());
  // Separate buckets so claim spam from one IP cannot lock out logins (and so a
  // login is throttled per target email + IP, not by a shared per-IP bucket).
  const claimLimiter = new RateLimiter(now);
  const loginLimiter = new RateLimiter(now);

  let _port = 0;

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendError(res, 500, 'internal server error');
      }
      console.error('[stats-api] unhandled error:', err);
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://localhost`);
    const pathname = url.pathname;

    // --------------- OPTIONS preflight ---------------
    if (method === 'OPTIONS') {
      // Preflight for CORS read endpoints
      if (
        pathname === '/leaderboard' ||
        pathname.startsWith('/players/') ||
        pathname === '/healthz'
      ) {
        res.writeHead(204, corsHeaders(config.corsOrigin));
        res.end();
        return;
      }
      sendError(res, 405, 'method not allowed');
      return;
    }

    // --------------- GET /healthz ---------------
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, corsHeaders(config.corsOrigin));
      return;
    }

    // --------------- GET /leaderboard ---------------
    if (method === 'GET' && pathname === '/leaderboard') {
      const limitParam = url.searchParams.get('limit');
      let limit = config.maxLeaderboardLimit;
      if (limitParam !== null) {
        const parsed = Number.parseInt(limitParam, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          sendError(res, 400, 'invalid limit', corsHeaders(config.corsOrigin));
          return;
        }
        limit = Math.min(parsed, config.maxLeaderboardLimit);
      }
      const entries = repo.getLeaderboard(limit);
      sendJson(res, 200, { entries }, corsHeaders(config.corsOrigin));
      return;
    }

    // --------------- GET /players/:publicId ---------------
    const playersMatch = pathname.match(/^\/players\/([^/]+)$/);
    if (method === 'GET' && playersMatch !== null) {
      const publicId = playersMatch[1] ?? '';
      if (!STATS_PUBLIC_ID_PATTERN.test(publicId)) {
        sendError(res, 404, 'player not found', corsHeaders(config.corsOrigin));
        return;
      }
      const profile = repo.getPlayerProfile(publicId, config.profileRecentLimit);
      if (profile === null) {
        sendError(res, 404, 'player not found', corsHeaders(config.corsOrigin));
        return;
      }
      sendJson(res, 200, profile, corsHeaders(config.corsOrigin));
      return;
    }

    // --------------- POST /ingest/match ---------------
    if (method === 'POST' && pathname === '/ingest/match') {
      // Empty secret => disabled
      if (!config.ingestSecret) {
        sendError(res, 503, 'ingest endpoint disabled: STATS_INGEST_SECRET not configured');
        return;
      }

      // Auth check
      if (!checkIngestAuth(req.headers['authorization'], config.ingestSecret)) {
        sendError(res, 401, 'unauthorized');
        return;
      }

      let raw: string;
      try {
        raw = await readBody(req);
      } catch {
        sendError(res, 400, 'failed to read request body');
        return;
      }

      const body = parseBody<unknown>(raw);
      if (body === null) {
        sendError(res, 400, 'invalid JSON');
        return;
      }

      if (!validateMatchResultIngest(body)) {
        sendError(res, 400, 'invalid MatchResultIngest body');
        return;
      }

      const result = repo.recordMatch(body, now());
      sendJson(res, 200, result);
      return;
    }

    // --------------- POST /claim ---------------
    if (method === 'POST' && pathname === '/claim') {
      const ip = getClientIp(req, config.trustProxy);
      if (!claimLimiter.allow(ip)) {
        sendError(res, 429, 'rate limit exceeded');
        return;
      }

      let raw: string;
      try {
        raw = await readBody(req);
      } catch {
        sendError(res, 400, 'failed to read request body');
        return;
      }

      const body = parseBody<unknown>(raw);
      if (body === null) {
        sendError(res, 400, 'invalid JSON');
        return;
      }

      if (!validateClaimRequest(body)) {
        sendError(res, 400, 'invalid ClaimRequest body');
        return;
      }

      // Derive publicId from token (same algorithm as server)
      const publicId = derivePublicId(body.token);

      const outcome = repo.claimAccount(publicId, body.email, body.password, body.name, now());
      if (!outcome.ok) {
        if (
          outcome.reason === 'emailTaken' ||
          outcome.reason === 'nameTaken' ||
          outcome.reason === 'alreadyClaimed'
        ) {
          sendError(res, 409, outcome.reason);
        } else {
          sendError(res, 404, outcome.reason);
        }
        return;
      }

      // Generate a session token
      const sessionToken = randomBytes(32).toString('hex');
      sendJson(res, 200, {
        publicId: outcome.row.publicId,
        name: outcome.row.name,
        email: body.email,
        sessionToken,
      });
      return;
    }

    // --------------- POST /login ---------------
    if (method === 'POST' && pathname === '/login') {
      // Parse the body first so we can key the limiter on email + IP: this
      // throttles attempts against ONE account without letting a single IP lock
      // out logins for unrelated accounts (NAT/CGNAT shared-IP fairness).
      let raw: string;
      try {
        raw = await readBody(req);
      } catch {
        sendError(res, 400, 'failed to read request body');
        return;
      }

      const body = parseBody<unknown>(raw);
      if (body === null) {
        sendError(res, 400, 'invalid JSON');
        return;
      }

      if (!validateLoginRequest(body)) {
        sendError(res, 400, 'invalid LoginRequest body');
        return;
      }

      const ip = getClientIp(req, config.trustProxy);
      const loginKey = `${ip}|${body.email.toLowerCase()}`;
      if (!loginLimiter.allow(loginKey)) {
        sendError(res, 429, 'rate limit exceeded');
        return;
      }

      const outcome = repo.verifyLogin(body.email, body.password);
      if (!outcome.ok) {
        sendError(res, 401, 'bad credentials');
        return;
      }

      const sessionToken = randomBytes(32).toString('hex');
      sendJson(res, 200, {
        publicId: outcome.row.publicId,
        name: outcome.row.name,
        email: body.email,
        sessionToken,
      });
      return;
    }

    // --------------- 404 fallthrough ---------------
    sendError(res, 404, 'not found');
  }

  return {
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, () => {
          const addr = server.address();
          if (addr === null || typeof addr === 'string') {
            reject(new Error('unexpected server address type'));
            return;
          }
          _port = addr.port;
          resolve(_port);
        });
      });
    },

    get port(): number {
      if (_port === 0 && !server.listening) {
        throw new Error('server not yet listening');
      }
      return _port;
    },

    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
