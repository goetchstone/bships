/**
 * defaultServerUrl() override allowlist (security regression).
 *
 * The `?server=` query param can override the WebSocket target for local
 * testing, but an unrestricted override let a crafted link point the socket at
 * an attacker host — the hello frame then leaks the persistent identity token
 * (the resume secret) to them. defaultServerUrl() must only honor a ws/wss
 * override whose host is same-origin or loopback, and fall back to the default
 * otherwise. These tests drive the REAL socket module (no module mock).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PORT } from '@bships/core';
import { defaultServerUrl } from '../src/net/socket.js';

const FALLBACK = `ws://localhost:${DEFAULT_PORT}`;

function stubLocation(search: string, hostname = 'game.example'): void {
  vi.stubGlobal('window', {
    location: { search, hostname, host: hostname, protocol: 'https:' },
  });
}

describe('defaultServerUrl override allowlist', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to the default when no override is present', () => {
    stubLocation('');
    expect(defaultServerUrl()).toBe(FALLBACK);
  });

  it('REJECTS an attacker-controlled ws host (token-exfil link)', () => {
    stubLocation('?server=ws://attacker.tld:9999');
    expect(defaultServerUrl()).toBe(FALLBACK);
  });

  it('REJECTS an attacker-controlled wss host', () => {
    stubLocation('?server=wss://attacker.tld/collect');
    expect(defaultServerUrl()).toBe(FALLBACK);
  });

  it('REJECTS a non-ws scheme (e.g. http/javascript)', () => {
    stubLocation('?server=http://game.example:8787');
    expect(defaultServerUrl()).toBe(FALLBACK);
  });

  it('REJECTS a malformed override URL', () => {
    stubLocation('?server=not a url');
    expect(defaultServerUrl()).toBe(FALLBACK);
  });

  it('ALLOWS a loopback override (local dev)', () => {
    stubLocation('?server=ws://localhost:8787');
    expect(defaultServerUrl()).toBe('ws://localhost:8787');
    stubLocation('?server=ws://127.0.0.1:9000');
    expect(defaultServerUrl()).toBe('ws://127.0.0.1:9000');
  });

  it('ALLOWS a same-origin host override (e.g. a custom port on the page host)', () => {
    stubLocation('?server=wss://game.example:8787/ws', 'game.example');
    expect(defaultServerUrl()).toBe('wss://game.example:8787/ws');
  });
});
