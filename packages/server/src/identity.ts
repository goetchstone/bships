/**
 * Identity registry (server-rooms): secret token -> session.
 *
 * - The token is the client's persistent random identity (TOKEN_PATTERN,
 *   localStorage). It is a SECRET: it must never appear in any broadcast
 *   message. Other players see only `publicId`.
 * - `publicId` is a fresh short random id drawn from crypto, NEVER derived
 *   from (nor equal to) the token; stable for the server's lifetime.
 * - Display names are settled here: sanitized (control chars stripped,
 *   whitespace collapsed, clamped to MAX_NAME_LENGTH, fallback when empty)
 *   and deduplicated against every other live session (`Name` -> `Name-2`).
 * - One live socket per token: `bindSocket` returns the displaced previous
 *   handle (newest hello wins) so the caller can close it.
 *
 * The handle type is generic — this module never touches ws directly, which
 * keeps it trivially testable.
 */

import { randomBytes } from 'node:crypto';
import { MAX_NAME_LENGTH, TOKEN_PATTERN } from '@bships/core';

/** Display name used when the requested name sanitizes to nothing. */
export const FALLBACK_NAME = 'Sailor';

export interface SessionRecord {
  readonly token: string;
  readonly publicId: string;
  /** Settled display name (sanitized + deduplicated). */
  name: string;
}

export interface IdentityRegistry<H> {
  /**
   * Create or refresh the session for `token`, settling `requestedName`.
   * Throws on tokens that do not match TOKEN_PATTERN (validate.ts gates the
   * wire; a violation here is a programming error).
   */
  ensureSession(token: string, requestedName: string): SessionRecord;
  getSession(token: string): SessionRecord | undefined;
  /**
   * Register `handle` as the one live socket for `token`. Returns the
   * displaced previous handle (caller must close it), or null.
   */
  bindSocket(token: string, handle: H): H | null;
  /** Unbind only if `handle` is still current. Returns true if released. */
  releaseSocket(token: string, handle: H): boolean;
  getSocket(token: string): H | null;
}

function sanitizeName(requested: string): string {
  const cleaned = requested
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : FALLBACK_NAME;
}

export function createIdentityRegistry<H>(): IdentityRegistry<H> {
  const sessions = new Map<string, SessionRecord>();
  const sockets = new Map<string, H>();

  const publicIdTaken = (id: string): boolean => {
    for (const session of sessions.values()) {
      if (session.publicId === id) return true;
    }
    return false;
  };

  const newPublicId = (): string => {
    for (;;) {
      // 'p' + 6 hex chars: short, random, structurally nothing like a token.
      const id = `p${randomBytes(3).toString('hex')}`;
      if (!publicIdTaken(id)) return id;
    }
  };

  const nameTakenByOther = (token: string, candidate: string): boolean => {
    const lower = candidate.toLowerCase();
    for (const session of sessions.values()) {
      if (session.token !== token && session.name.toLowerCase() === lower) return true;
    }
    return false;
  };

  const settleName = (token: string, requestedName: string): string => {
    const base = sanitizeName(requestedName);
    if (!nameTakenByOther(token, base)) return base;
    for (let n = 2; ; n += 1) {
      const suffix = `-${n}`;
      const candidate = base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
      if (!nameTakenByOther(token, candidate)) return candidate;
    }
  };

  return {
    ensureSession(token, requestedName) {
      if (!TOKEN_PATTERN.test(token)) {
        throw new Error('identity: token failed TOKEN_PATTERN (validate.ts must gate the wire)');
      }
      const existing = sessions.get(token);
      if (existing !== undefined) {
        existing.name = settleName(token, requestedName);
        return existing;
      }
      const session: SessionRecord = {
        token,
        publicId: newPublicId(),
        name: settleName(token, requestedName),
      };
      sessions.set(token, session);
      return session;
    },

    getSession(token) {
      return sessions.get(token);
    },

    bindSocket(token, handle) {
      const previous = sockets.get(token) ?? null;
      sockets.set(token, handle);
      return previous === handle ? null : previous;
    },

    releaseSocket(token, handle) {
      if (sockets.get(token) === handle) {
        sockets.delete(token);
        return true;
      }
      return false;
    },

    getSocket(token) {
      return sockets.get(token) ?? null;
    },
  };
}
