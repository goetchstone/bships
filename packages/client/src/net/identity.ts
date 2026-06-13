/**
 * Anonymous-with-claim identity (docs/DESIGN.md): a persistent random token
 * plus a chosen display name, both in localStorage. The token is the secret
 * key the server uses to resume room/match membership across reconnects —
 * it is sent ONLY inside the hello message, never displayed, never logged.
 */

import { MAX_NAME_LENGTH, TOKEN_PATTERN } from '@bships/core';

export const TOKEN_STORAGE_KEY = 'bships.token';
export const NAME_STORAGE_KEY = 'bships.name';

export interface Identity {
  token: string;
  name: string;
}

/** Session-scoped fallback when localStorage is unavailable (rare). */
let ephemeral: Identity | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Some privacy modes throw on any localStorage access.
    return null;
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Collapse whitespace, trim, cap at the protocol's MAX_NAME_LENGTH. */
export function sanitizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * Load (or mint and persist) the identity. The token is regenerated when the
 * stored value does not match TOKEN_PATTERN (corrupt / tampered storage).
 * Name may be '' on first run — the lobby prompts before play.
 */
export function getIdentity(): Identity {
  const store = storage();
  if (store === null) {
    ephemeral ??= { token: randomToken(), name: '' };
    return { ...ephemeral };
  }
  let token = store.getItem(TOKEN_STORAGE_KEY);
  if (token === null || !TOKEN_PATTERN.test(token)) {
    token = randomToken();
    store.setItem(TOKEN_STORAGE_KEY, token);
  }
  const name = sanitizeName(store.getItem(NAME_STORAGE_KEY) ?? '');
  return { token, name };
}

/** Persist a new display name; returns the sanitized value actually stored. */
export function setName(raw: string): string {
  const name = sanitizeName(raw);
  const store = storage();
  if (store === null) {
    ephemeral ??= { token: randomToken(), name: '' };
    ephemeral.name = name;
  } else {
    store.setItem(NAME_STORAGE_KEY, name);
  }
  return name;
}
