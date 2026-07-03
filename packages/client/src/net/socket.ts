/**
 * Auto-reconnecting WebSocket transport (docs/ARCH.md "Module: client-net").
 *
 * - `connect()` opens the socket (default `ws://localhost:DEFAULT_PORT`,
 *   overridable with a `?server=` query param) and keeps it open forever:
 *   exponential backoff 0.5 s -> 8 s, infinite retries. The ONE exception is
 *   a server `error{versionMismatch}` — retrying a stale client is pointless,
 *   so reconnects stop until the page reloads (or `reconnectNow()`).
 * - `hello` is sent on EVERY open (the token never appears anywhere else).
 * - Server `ping` is answered with `pong` immediately.
 * - Every parsed ServerMessage is dispatched into the store via
 *   `applyServerMessage`, stamped with performance.now() for the
 *   interpolation clock.
 */

import { DEFAULT_PORT, PROTOCOL_VERSION } from '@bships/core';
import type { ClientMessage, ServerMessage } from '@bships/core';

import { labelClientMessage, recordAction } from '../debug/crashtrap.js';
import { getIdentity } from './identity.js';
import { applyServerMessage, emitChange, store } from './store.js';

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

let ws: WebSocket | null = null;
let url = '';
let backoffMs = BACKOFF_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Set on versionMismatch: reconnecting cannot help until a reload. */
let reconnectDisabled = false;

/** Hosts the `?server=` override may target: same-origin or loopback (dev). */
function isAllowedOverrideHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true;
  try {
    return hostname.toLowerCase() === window.location.hostname.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Resolve the server URL. A `?server=` query param may override the default
 * (for local testing), but ONLY when it is a ws:// or wss:// URL whose host is
 * same-origin or loopback. Without this allowlist a crafted link
 * (`?server=ws://attacker.tld`) would point the socket at an attacker host,
 * and the hello frame would leak the persistent identity token (the resume
 * secret) to them — letting the attacker authenticate to the real server as
 * the victim. A rejected/absent override falls back to localhost:DEFAULT_PORT.
 */
export function defaultServerUrl(): string {
  const fallback = `ws://localhost:${DEFAULT_PORT}`;
  const override = new URLSearchParams(window.location.search).get('server');
  if (override === null || override === '') return fallback;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    console.warn('[net] ignoring malformed ?server= override');
    return fallback;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    console.warn(`[net] ignoring ?server= override with disallowed scheme ${parsed.protocol}`);
    return fallback;
  }
  if (!isAllowedOverrideHost(parsed.hostname)) {
    console.warn('[net] ignoring ?server= override pointing at a non-allowlisted host');
    return fallback;
  }
  return override;
}

function setStatus(status: typeof store.connection.status): void {
  if (store.connection.status === status) return;
  store.connection.status = status;
  emitChange();
}

function open(): void {
  reconnectTimer = null;
  setStatus('connecting');
  const socket = new WebSocket(url);
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    backoffMs = BACKOFF_MIN_MS;
    setStatus('open');
    // getIdentity() re-reads storage so a name chosen this session is used.
    const identity = getIdentity();
    store.identity.token = identity.token;
    sendOn(socket, {
      type: 'hello',
      version: PROTOCOL_VERSION,
      token: identity.token,
      name: store.identity.name !== '' ? store.identity.name : identity.name,
    });
  };

  socket.onmessage = (ev: MessageEvent) => {
    if (ws !== socket) return;
    handleRaw(socket, typeof ev.data === 'string' ? ev.data : '');
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setStatus('closed');
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose follows and handles the retry; nothing to do here.
  };
}

function handleRaw(socket: WebSocket, raw: string): void {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(raw) as ServerMessage;
  } catch {
    console.warn('[net] dropped unparseable server frame');
    return;
  }
  if (typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
    console.warn('[net] dropped malformed server frame');
    return;
  }
  if (msg.type === 'ping') {
    sendOn(socket, { type: 'pong', t: msg.t });
  }
  if (msg.type === 'error' && msg.code === 'versionMismatch') {
    reconnectDisabled = true;
    console.warn('[net] protocol version mismatch — reload the page to update');
  }
  // Defense-in-depth at the trust boundary: a malformed frame (e.g. a snapshot
  // with a null `you` or non-array entities/events from a hostile server
  // reachable via a crafted ?server= link) must not throw an uncaught
  // TypeError out of onmessage and break the game loop. Drop the frame instead.
  try {
    applyServerMessage(msg, performance.now());
  } catch (err) {
    console.warn('[net] dropped server frame that failed to apply:', err);
    return;
  }
  if (msg.type === 'welcome' && msg.resumed === null) {
    // Fresh session: populate the room browser right away.
    sendOn(socket, { type: 'listRooms' });
  }
}

function sendOn(socket: WebSocket, msg: ClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function scheduleReconnect(): void {
  if (reconnectDisabled || reconnectTimer !== null) return;
  reconnectTimer = setTimeout(open, backoffMs);
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}

/**
 * Open the connection (idempotent-ish: call once from main.ts). The url is
 * remembered for every reconnect.
 */
export function connect(serverUrl: string = defaultServerUrl()): void {
  url = serverUrl;
  reconnectDisabled = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws !== null) return; // already connected/connecting
  open();
}

/**
 * Force a clean reconnect immediately (used after a display-name change —
 * `hello` is per-connection, so a new name needs a new connection).
 */
export function reconnectNow(): void {
  reconnectDisabled = false;
  backoffMs = BACKOFF_MIN_MS;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws !== null) {
    const socket = ws;
    ws = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // ignore — socket may already be closing
    }
  }
  open();
}

/** True when messages can be sent right now. */
export function isOpen(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

/**
 * Send one ClientMessage. Returns false (with a warn) when the socket is not
 * open — callers treat that as a dropped message; there is no outbox queue
 * (lobby actions are user-retryable, sim commands are only valid in a live
 * match anyway).
 *
 * This is the single chokepoint every player-initiated command/action passes
 * through (commands.ts's `sendCommand` and lobby senders all funnel here), so
 * it doubles as the crash-trap ring-buffer hook (STATUS.md task #15).
 */
export function send(msg: ClientMessage): boolean {
  recordAction(labelClientMessage(msg), performance.now());
  if (ws === null || ws.readyState !== WebSocket.OPEN) {
    console.warn(`[net] dropped ${msg.type}: socket not open`);
    return false;
  }
  ws.send(JSON.stringify(msg));
  return true;
}
