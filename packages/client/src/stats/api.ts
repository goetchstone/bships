/**
 * Typed fetch wrapper for the stats service (owned by client-stats). Thin: one
 * function per read/auth endpoint, returning the core wire DTOs. The client
 * NEVER calls /ingest/match (server-only). Pure-ish — `fetchImpl` is injectable
 * so tests drive it with a mocked fetch (no network, no jsdom needed).
 *
 * Errors: a non-2xx response throws StatsApiError carrying the status + the
 * service's StatsErrorResponse.error message; callers render it inline.
 */

import type {
  ClaimRequest,
  ClaimResponse,
  LeaderboardResponse,
  LoginRequest,
  PlayerProfile,
  StatsErrorResponse,
} from '@bships/core';
import { STATS_BASE_URL } from './config.js';

export class StatsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'StatsApiError';
  }
}

export interface StatsApiDeps {
  /** Base URL override (default STATS_BASE_URL). */
  baseUrl?: string;
  /** fetch override for tests (default global fetch). */
  fetchImpl?: typeof fetch;
}

export interface StatsApi {
  getLeaderboard(limit?: number): Promise<LeaderboardResponse>;
  getPlayer(publicId: string): Promise<PlayerProfile>;
  claim(req: ClaimRequest): Promise<ClaimResponse>;
  login(req: LoginRequest): Promise<ClaimResponse>;
}

/** Build a stats API client. Defaults to the configured base URL + global fetch. */
export function createStatsApi(deps: StatsApiDeps = {}): StatsApi {
  const baseUrl = (deps.baseUrl ?? STATS_BASE_URL).replace(/\/$/, '');
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const opts: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${baseUrl}${path}`, opts);
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const err = (await res.json()) as StatsErrorResponse;
        if (typeof err.error === 'string') message = err.error;
      } catch {
        // ignore parse failure, keep generic message
      }
      throw new StatsApiError(res.status, message);
    }
    return (await res.json()) as T;
  }

  return {
    getLeaderboard(limit?: number): Promise<LeaderboardResponse> {
      const query = limit !== undefined ? `?limit=${limit}` : '';
      return request<LeaderboardResponse>('GET', `/leaderboard${query}`);
    },

    getPlayer(publicId: string): Promise<PlayerProfile> {
      return request<PlayerProfile>('GET', `/players/${encodeURIComponent(publicId)}`);
    },

    claim(req: ClaimRequest): Promise<ClaimResponse> {
      return request<ClaimResponse>('POST', '/claim', req);
    },

    login(req: LoginRequest): Promise<ClaimResponse> {
      return request<ClaimResponse>('POST', '/login', req);
    },
  };
}
