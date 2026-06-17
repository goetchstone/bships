/**
 * THE shared client state singleton (docs/ARCH.md "Module: client-net").
 * Plain mutable object + a coarse subscribe signal: socket.ts dispatches
 * every ServerMessage through `applyServerMessage`, which updates the store,
 * feeds snapshot data to interpolation.ts, fans sim events out to `onEvent`
 * listeners (in order, exactly once), and notifies subscribers.
 *
 * No game logic: every field is verbatim server data or pure UI state.
 */

import { LOBBY_SLOTS } from '@bships/core';
import type {
  PublicPlayerStat,
  RoomStateMessage,
  RoomSummary,
  ServerChatMessage,
  ServerMessage,
  SimEvent,
  SnapshotYou,
  TeamId,
} from '@bships/core';

import { clockJitterMs, ingestDelta, ingestSnapshot, resetInterpolation } from './interpolation.js';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';
export type MatchPhase = 'idle' | 'starting' | 'playing' | 'ended';

const MAX_CHAT_LINES = 100;

export interface Store {
  connection: { status: ConnectionStatus; rttMs: number };
  identity: { token: string; name: string; publicId: string | null };
  lobby: { rooms: RoomSummary[]; room: RoomStateMessage | null };
  match: {
    phase: MatchPhase;
    countdown: number;
    mySlot: number | null;
    myTeam: TeamId | null;
    /** Latest private state, NOT interpolated (gold/inventory/cooldowns). */
    you: SnapshotYou | null;
    players: PublicPlayerStat[];
    latestTick: number;
    winnerTeam: TeamId | null;
    /** Capped at MAX_CHAT_LINES; includes system lines. */
    chat: ServerChatMessage[];
  };
  ui: {
    /** render writes, hud reads. */
    selectedEntityId: number | null;
    /** hud writes, render consumes. */
    pendingOrder: 'attackMove' | null;
    /**
     * Armed targeted ability/item awaiting a map click (hud writes, pointer
     * consumes). `targeting` decides whether the click resolves to a world
     * point (x/y) or a unit (targetId); on resolution pointer.ts sends the
     * pending useItem/castAbility with the target and clears this. Mutually
     * exclusive with pendingOrder (arming one clears the other).
     */
    pendingTarget:
      | {
          kind: 'item' | 'ability';
          targeting: 'point' | 'unit';
          slot?: number;
          abilityId?: string;
        }
      | null;
    /** hud derives + owns. */
    shopEntityId: number | null;
  };
  /** Coarse change signal: fired after every store mutation batch. */
  subscribe(fn: () => void): () => void;
}

const subscribers = new Set<() => void>();
const eventListeners = new Set<(e: SimEvent) => void>();

export const store: Store = {
  connection: { status: 'connecting', rttMs: 0 },
  identity: { token: '', name: '', publicId: null },
  lobby: { rooms: [], room: null },
  match: {
    phase: 'idle',
    countdown: 0,
    mySlot: null,
    myTeam: null,
    you: null,
    players: [],
    latestTick: 0,
    winnerTeam: null,
    chat: [],
  },
  ui: { selectedEntityId: null, pendingOrder: null, pendingTarget: null, shopEntityId: null },
  subscribe(fn: () => void): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },
};

/** Notify subscribers — call after any out-of-band store mutation. */
export function emitChange(): void {
  for (const fn of subscribers) fn();
}

/**
 * Sim-event fan-out: every snapshot/delta's events are delivered once, in
 * order (render: death flashes/impacts; hud: kill feed, level-ups, toasts).
 */
export function onEvent(fn: (e: SimEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

function fanOutEvents(events: SimEvent[]): void {
  for (const event of events) {
    for (const fn of eventListeners) fn(event);
  }
}

/** Team owning a lobby/sim slot, per the protocol's LOBBY_SLOTS. */
export function teamForSlot(slot: number): TeamId | null {
  for (const team of Object.keys(LOBBY_SLOTS) as TeamId[]) {
    if (LOBBY_SLOTS[team].includes(slot)) return team;
  }
  return null;
}

export function pushChat(line: ServerChatMessage): void {
  store.match.chat.push(line);
  if (store.match.chat.length > MAX_CHAT_LINES) {
    store.match.chat.splice(0, store.match.chat.length - MAX_CHAT_LINES);
  }
}

function pushSystemChat(text: string): void {
  pushChat({
    type: 'chat',
    from: { publicId: '', name: 'system', slot: null },
    scope: 'system',
    text,
  });
}

function applyYou(you: SnapshotYou): void {
  store.match.you = you;
  store.match.mySlot = you.slot;
  store.match.myTeam = you.team;
}

/**
 * Reset everything tied to a live match (returnToLobby / leaveRoom). Lobby
 * data and chat survive; pass `clearChat` when leaving the room entirely.
 */
export function resetMatchState(clearChat = false): void {
  store.match.phase = 'idle';
  store.match.countdown = 0;
  store.match.mySlot = null;
  store.match.myTeam = null;
  store.match.you = null;
  store.match.players = [];
  store.match.latestTick = 0;
  store.match.winnerTeam = null;
  if (clearChat) store.match.chat = [];
  store.ui.selectedEntityId = null;
  store.ui.pendingOrder = null;
  store.ui.pendingTarget = null;
  store.ui.shopEntityId = null;
  resetInterpolation();
}

/**
 * The single ServerMessage dispatch point (socket.ts calls this for every
 * inbound frame, stamped with performance.now()). Pong replies stay in
 * socket.ts — this only updates state.
 */
export function applyServerMessage(msg: ServerMessage, arrivalMs: number): void {
  switch (msg.type) {
    case 'welcome': {
      // Display copy only — the settled name is NOT persisted to storage
      // (a server dedupe suffix must not compound across sessions).
      store.identity.publicId = msg.publicId;
      store.identity.name = msg.name;
      break;
    }
    case 'roomList': {
      store.lobby.rooms = msg.rooms;
      break;
    }
    case 'roomState': {
      if (!Array.isArray(msg.players)) break; // malformed: ignore
      store.lobby.room = msg;
      // Pre-match slot/team hint; the first snapshot's `you` is authoritative.
      if (store.match.phase !== 'playing' && store.identity.publicId !== null) {
        const me = msg.players.find((p) => p.publicId === store.identity.publicId);
        const slot = me?.slot ?? null;
        store.match.mySlot = slot;
        store.match.myTeam = slot === null ? null : teamForSlot(slot);
      }
      break;
    }
    case 'matchStarting': {
      if (store.match.phase !== 'playing') store.match.phase = 'starting';
      store.match.countdown = msg.countdownSeconds;
      break;
    }
    case 'snapshot': {
      // Trust-boundary shape guards: a hostile/buggy server frame must not
      // throw out of the dispatch (e.g. null `you`, non-array entities/events).
      if (
        msg.you === null ||
        typeof msg.you !== 'object' ||
        !Array.isArray(msg.entities) ||
        !Array.isArray(msg.projectiles) ||
        !Array.isArray(msg.events) ||
        !Array.isArray(msg.players)
      ) {
        console.warn('[net] dropped malformed snapshot frame');
        break;
      }
      if (store.match.phase !== 'playing') {
        // First keyframe of a (new or resumed) match.
        store.match.phase = 'playing';
        store.match.winnerTeam = null;
        store.match.countdown = 0;
      }
      ingestSnapshot(msg, arrivalMs);
      store.match.latestTick = msg.tick;
      applyYou(msg.you);
      store.match.players = msg.players;
      store.connection.rttMs = Math.round(clockJitterMs() * 2);
      fanOutEvents(msg.events);
      break;
    }
    case 'snapshotDelta': {
      // Trust-boundary shape guards (see snapshot case).
      if (
        !Array.isArray(msg.upserts) ||
        !Array.isArray(msg.removed) ||
        !Array.isArray(msg.projectiles) ||
        !Array.isArray(msg.events) ||
        (msg.you !== undefined && (msg.you === null || typeof msg.you !== 'object')) ||
        (msg.players !== undefined && !Array.isArray(msg.players))
      ) {
        console.warn('[net] dropped malformed snapshotDelta frame');
        break;
      }
      const applied = ingestDelta(msg, arrivalMs);
      if (!applied) break; // gap: stall until the next keyframe
      store.match.latestTick = msg.tick;
      if (msg.you !== undefined) applyYou(msg.you);
      if (msg.players !== undefined) store.match.players = msg.players;
      store.connection.rttMs = Math.round(clockJitterMs() * 2);
      fanOutEvents(msg.events);
      break;
    }
    case 'matchEnded': {
      store.match.phase = 'ended';
      store.match.winnerTeam = msg.winnerTeam;
      if (Array.isArray(msg.stats)) store.match.players = msg.stats;
      break;
    }
    case 'chat': {
      pushChat(msg);
      break;
    }
    case 'error': {
      console.warn(`[net] server error ${msg.code}: ${msg.msg}`);
      pushSystemChat(`Error: ${msg.msg}`);
      break;
    }
    case 'ping':
      break; // socket.ts answers with pong
  }
  emitChange();
}

/** Test helper: restore the singleton to its initial state. */
export function resetStoreForTest(): void {
  store.connection.status = 'connecting';
  store.connection.rttMs = 0;
  store.identity.token = '';
  store.identity.name = '';
  store.identity.publicId = null;
  store.lobby.rooms = [];
  store.lobby.room = null;
  resetMatchState(true);
  subscribers.clear();
  eventListeners.clear();
}
