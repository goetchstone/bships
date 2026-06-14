/**
 * Claimed-account session persistence (owned by client-stats). After a
 * successful /claim or /login the client stores the returned ClaimResponse
 * (publicId, name, email) in localStorage so the account is remembered across
 * reloads. This is SEPARATE from the identity token in net/identity.ts: that
 * token is the anonymous play identity (sent only in the ws hello). There is no
 * session bearer — the server validates every privileged action with the
 * email + password on /login, so the stored fields are just a display marker.
 *
 * Mirrors net/identity.ts' resilient storage pattern (privacy modes can throw).
 */

import type { ClaimResponse } from '@bships/core';

export const STATS_SESSION_KEY = 'bships.statsSession';

export interface StatsSession {
  publicId: string;
  name: string;
  email: string;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Load the stored session, or null when unclaimed / storage unavailable. */
export function loadSession(): StatsSession | null {
  const store = storage();
  if (store === null) return null;
  const raw = store.getItem(STATS_SESSION_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['publicId'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['name'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['email'] === 'string'
    ) {
      return parsed as StatsSession;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist a session from a claim/login response. */
export function saveSession(res: ClaimResponse): void {
  const session: StatsSession = {
    publicId: res.publicId,
    name: res.name,
    email: res.email,
  };
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STATS_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Ignore storage errors (quota exceeded, privacy mode).
  }
}

/** Clear the stored session (logout). */
export function clearSession(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(STATS_SESSION_KEY);
  } catch {
    // Ignore storage errors.
  }
}
