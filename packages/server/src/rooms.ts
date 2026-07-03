/**
 * Room manager (server-rooms): per-connection state machine, lobby flow,
 * match start, and in-match routing to the server-match runtime.
 *
 * Wall clock (Date.now / timers) is allowed THROUGHOUT this module because
 * nothing here feeds the sim: heartbeats, countdowns and rate limits only
 * decide when things happen on the wire. The one sim-relevant input drawn
 * here is the match `seed`, which comes from crypto at start (injectable
 * for tests), never from Math.random or the clock.
 *
 * Connection lifecycle:
 *   connect -> first frame MUST be `hello` (else error{notAuthed} + close)
 *           -> version check (error{versionMismatch} + close)
 *           -> welcome{publicId, name, resumed} -> lobby/match routing.
 *
 * The MatchRuntime factory is injected (options.createRuntime) so this
 * module compiles and tests independently of server-match; index.ts wires
 * the real `createMatchRuntime` from './match.js'. The seam types below
 * mirror the FROZEN contract in docs/ARCH.md verbatim — TypeScript's
 * structural typing makes the real factory assignable.
 */

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  LOBBY_SLOTS,
  MATCH_COUNTDOWN_SECONDS,
  MAX_PLAYERS_PER_ROOM,
  MAX_ROOM_NAME_LENGTH,
  PROTOCOL_VERSION,
} from '@bships/core';
import type {
  AiConfig,
  AiDifficulty,
  ClientChatMessage,
  ClientMessage,
  Command,
  CommandMessage,
  ErrorCode,
  HelloMessage,
  MatchParticipantIngest,
  MatchResultIngest,
  PublicPlayerStat,
  RoomPhase,
  RoomPlayer,
  RoomSummary,
  Ruleset,
  ServerMessage,
  TeamId,
} from '@bships/core';
import { createIdentityRegistry } from './identity.js';
import type { SessionRecord } from './identity.js';
import { parseClientMessage } from './validate.js';
import { createNoopStatsPoster, deriveStatsPublicId } from './stats/index.js';
import type { StatsPoster } from './stats/index.js';

// ---------------------------------------------------------------------------
// Limits (server policy, not wire protocol — hence defined here, not core)
// ---------------------------------------------------------------------------

/** Frames larger than this are answered with a close (1009). */
export const MAX_FRAME_BYTES = 16 * 1024;
/** General per-connection token bucket: burst 60, refill 30/s. */
export const RATE_BUCKET_CAPACITY = 60;
export const RATE_REFILL_PER_SEC = 30;
/** Additional cap for `command` messages: 40/s (burst 40). */
export const COMMAND_BUCKET_CAPACITY = 40;
export const COMMAND_REFILL_PER_SEC = 40;
/**
 * Additional cap for `chat` messages: a small dedicated bucket so one client
 * cannot flood the room with a 60-message burst (chat fans out to every member)
 * even while staying under the general bucket. Burst 5, refill 1/s.
 */
export const CHAT_BUCKET_CAPACITY = 5;
export const CHAT_REFILL_PER_SEC = 1;
/** Close the connection after this many CONSECUTIVE rate violations. */
export const MAX_RATE_VIOLATIONS = 5;
/** Playing rooms with zero attached sockets are deleted after this grace. */
export const ABANDONED_ROOM_GRACE_MS = 5 * 60_000;
/**
 * Outbound backpressure ceiling. Snapshots are queued every tick; a client that
 * stops reading (slow or malicious) would otherwise let the server-side send
 * buffer grow without bound (~100 KB/s/client at 20 Hz) until OOM. When a
 * socket's queued-but-unsent bytes exceed this, the connection is dropped
 * (1011) instead of buffering further — snapshots are idempotent keyframes, so
 * a reconnect re-syncs cleanly. ~1 MB tolerates a brief stall / one keyframe
 * burst (MAX_FRAME_BYTES = 16 KB) without nuking a momentarily slow client.
 */
export const MAX_SEND_BUFFER_BYTES = 1024 * 1024;
/**
 * Global ceilings (process-wide resource-exhaustion backstop). New connections
 * past MAX_CONNECTIONS are closed (1013, "try again later"); createRoom past
 * MAX_ROOMS is rejected. Generous for a single box — they exist to bound a
 * token-churning attacker, not to limit normal play.
 */
export const MAX_CONNECTIONS = 5000;
export const MAX_ROOMS = 1000;

// ---------------------------------------------------------------------------
// MatchRuntime seam — mirrors the FROZEN contract in docs/ARCH.md
// (server-match owns the implementation in src/match.ts; index.ts injects it)
// ---------------------------------------------------------------------------

export interface MatchSeat {
  slot: number;
  name: string;
}

/**
 * Computer-controlled captain seat (mirrors src/match.ts AiSeat). AI seats are
 * NOT human seats: they get no snapshots, no input, no scoreboard line and are
 * absent from stats participants — they only spawn an AI-brain-driven
 * `control: 'computer'` player and are thought for by the server AI runner.
 */
export interface AiSeat {
  slot: number;
  ai: AiConfig;
}

export interface MatchRuntimeDeps {
  ruleset: Ruleset;
  seed: number;
  seats: MatchSeat[];
  /** Computer-controlled captain seats (optional; default none). */
  aiSeats?: AiSeat[];
  sendToSlot(slot: number, msg: ServerMessage): void;
  onEnded(result: {
    winnerTeam: TeamId | null;
    stats: PublicPlayerStat[];
    seed: number;
    rulesetId: string;
    durationTicks: number;
    goldEarned: Map<number, number>;
  }): void;
  /** Test mode only: ms per sim tick (0 = burst). Default realtime. */
  tickIntervalMs?: number;
}

export interface MatchRuntime {
  readonly status: 'running' | 'ended';
  start(): void;
  stop(): void;
  enqueueCommand(slot: number, command: Command): void;
  setConnected(slot: number, connected: boolean): void;
}

export type CreateMatchRuntime = (deps: MatchRuntimeDeps) => MatchRuntime;

// ---------------------------------------------------------------------------
// Public manager API (index.ts wires ws sockets to this; tests use fakes)
// ---------------------------------------------------------------------------

/** Minimal socket surface the manager needs (ws WebSocket satisfies it). */
export interface ClientSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /**
   * Bytes queued for send but not yet flushed to the OS (ws.bufferedAmount).
   * Optional so non-ws transports/test fakes can omit it; when present, the
   * manager enforces MAX_SEND_BUFFER_BYTES to bound a stalled client.
   */
  bufferedAmount?(): number;
}

export interface FrameInfo {
  /** Raw frame size in bytes; computed from the text when omitted. */
  byteLength?: number;
  /** True for binary frames (unsupported — the protocol is JSON text). */
  binary?: boolean;
}

export interface ManagedConnection {
  onMessage(text: string, info?: FrameInfo): void;
  onClose(): void;
}

export interface RoomManagerOptions {
  /** The server-match factory (index.ts passes createMatchRuntime). */
  createRuntime: CreateMatchRuntime;
  /** Clock override for tests; defaults to Date.now. */
  now?: () => number;
  /** Seed source override for tests; defaults to crypto random uint32. */
  drawSeed?: () => number;
  /**
   * Test mode only: ms per sim tick passed to the runtime (0 = burst mode,
   * sim runs as fast as the event loop allows). Default realtime.
   */
  tickIntervalMs?: number;
  /** Lobby countdown override (tests); default MATCH_COUNTDOWN_SECONDS. */
  countdownSeconds?: number;
  /**
   * Stats ingest poster. Default: no-op (silent when stats service is not
   * configured). index.ts passes createStatsPosterFromEnv(process.env).
   */
  statsPoster?: StatsPoster;
}

export interface RoomManager {
  handleConnection(socket: ClientSocket): ManagedConnection;
  /** Number of live rooms (test/diagnostic helper). */
  roomCount(): number;
  /** Tear down every room (timers + runtimes) for clean process exit. */
  shutdown(): void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Timer = ReturnType<typeof setTimeout>;

interface Bucket {
  tokens: number;
  lastMs: number;
  readonly capacity: number;
  readonly refillPerSec: number;
}

function makeBucket(capacity: number, refillPerSec: number, nowMs: number): Bucket {
  return { tokens: capacity, lastMs: nowMs, capacity, refillPerSec };
}

function takeToken(bucket: Bucket, nowMs: number): boolean {
  const elapsed = Math.max(0, nowMs - bucket.lastMs);
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + (elapsed / 1000) * bucket.refillPerSec);
  bucket.lastMs = nowMs;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

interface Conn {
  socket: ClientSocket;
  session: SessionRecord | null;
  room: Room | null;
  lastInboundMs: number;
  generalBucket: Bucket;
  commandBucket: Bucket;
  chatBucket: Bucket;
  violations: number;
  helloTimer: Timer | null;
  pingTimer: Timer | null;
  tornDown: boolean;
}

interface Member {
  readonly token: string;
  readonly session: SessionRecord;
  slot: number | null;
  ready: boolean;
  conn: Conn | null;
  readonly joinOrder: number;
}

interface Room {
  readonly id: string;
  readonly name: string;
  phase: RoomPhase;
  /** token -> member; Map insertion order ~ join order. */
  readonly members: Map<string, Member>;
  hostToken: string;
  runtime: MatchRuntime | null;
  countdownTimer: Timer | null;
  abandonTimer: Timer | null;
  joinCounter: number;
  /**
   * AI-occupied pickable slots -> difficulty (lobby only). Emitted as synthetic
   * RoomPlayers in roomState and seated as `control: 'computer'` players when
   * the match starts. Cleared/ignored outside the lobby phase (slots lock on
   * start; a returning lobby starts AI-free).
   */
  readonly aiSlots: Map<number, AiDifficulty>;
}

/** Team a sim slot belongs to, or null for non-pickable slots (AI 0/1). */
function teamOfSlot(slot: number): TeamId | null {
  if (LOBBY_SLOTS.south.includes(slot)) return 'south';
  if (LOBBY_SLOTS.north.includes(slot)) return 'north';
  return null;
}

function defaultDrawSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

export function createRoomManager(ruleset: Ruleset, options: RoomManagerOptions): RoomManager {
  const { createRuntime } = options;
  const now = options.now ?? Date.now;
  const drawSeed = options.drawSeed ?? defaultDrawSeed;
  const countdownSeconds = options.countdownSeconds ?? MATCH_COUNTDOWN_SECONDS;
  const statsPoster: StatsPoster = options.statsPoster ?? createNoopStatsPoster();

  const identity = createIdentityRegistry<Conn>();
  const rooms = new Map<string, Room>();
  /** token -> room the token is a member of (resume routing). */
  const membershipByToken = new Map<string, Room>();
  /** Live (not-yet-torn-down) connections — global cap backstop. */
  let connectionCount = 0;

  // ---- send helpers -------------------------------------------------------

  const sendText = (conn: Conn, text: string): void => {
    if (conn.tornDown) return;
    // Backpressure guard: a client that stopped reading would otherwise let the
    // server-side send buffer grow without bound. Drop it (1011) before queuing
    // more; snapshots are idempotent keyframes so a reconnect re-syncs cleanly.
    const buffered = conn.socket.bufferedAmount?.();
    if (buffered !== undefined && buffered > MAX_SEND_BUFFER_BYTES) {
      closeConn(conn, 1011, 'send buffer overflow');
      return;
    }
    try {
      conn.socket.send(text);
    } catch {
      // Socket is dying; its close event will run the teardown path.
    }
  };

  const send = (conn: Conn, msg: ServerMessage): void => {
    sendText(conn, JSON.stringify(msg));
  };

  const sendError = (conn: Conn, code: ErrorCode, msg: string): void => {
    send(conn, { type: 'error', code, msg });
  };

  /** Serialize once, deliver to every attached member. */
  const broadcast = (room: Room, msg: ServerMessage): void => {
    const text = JSON.stringify(msg);
    for (const member of room.members.values()) {
      if (member.conn !== null) sendText(member.conn, text);
    }
  };

  const roomStateMessage = (room: Room): ServerMessage => {
    const players: RoomPlayer[] = [...room.members.values()]
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((member) => ({
        publicId: member.session.publicId,
        name: member.session.name,
        slot: member.slot,
        ready: member.ready,
        connected: member.conn !== null,
        isHost: member.token === room.hostToken,
        // Human members carry no AI marker.
        ai: null,
      }));
    // AI-filled slots are emitted as synthetic RoomPlayers (ascending slot for a
    // stable order): always ready + connected, never host, name "AI (<diff>)".
    // They count as their team's player for the both-teams start gate. publicId
    // is a stable synthetic handle ("ai" + slot) that cannot collide with a real
    // session publicId (those are "p" + hex).
    for (const slot of [...room.aiSlots.keys()].sort((a, b) => a - b)) {
      const difficulty = room.aiSlots.get(slot);
      if (difficulty === undefined) continue;
      players.push({
        publicId: `ai${slot}`,
        name: `AI (${difficulty})`,
        slot,
        ready: true,
        connected: true,
        isHost: false,
        ai: difficulty,
      });
    }
    return { type: 'roomState', roomId: room.id, name: room.name, phase: room.phase, players };
  };

  const broadcastRoomState = (room: Room): void => {
    broadcast(room, roomStateMessage(room));
  };

  // ---- room registry ------------------------------------------------------

  const newRoomId = (): string => {
    for (;;) {
      const id = randomBytes(3).toString('hex');
      if (!rooms.has(id)) return id;
    }
  };

  const deleteRoom = (room: Room): void => {
    if (room.countdownTimer !== null) clearTimeout(room.countdownTimer);
    if (room.abandonTimer !== null) clearTimeout(room.abandonTimer);
    room.countdownTimer = null;
    room.abandonTimer = null;
    room.runtime?.stop();
    room.runtime = null;
    for (const member of room.members.values()) {
      membershipByToken.delete(member.token);
      if (member.conn !== null) member.conn.room = null;
    }
    room.members.clear();
    rooms.delete(room.id);
  };

  const attachedCount = (room: Room): number => {
    let count = 0;
    for (const member of room.members.values()) {
      if (member.conn !== null) count += 1;
    }
    return count;
  };

  const memberBySlot = (room: Room, slot: number): Member | null => {
    for (const member of room.members.values()) {
      if (member.slot === slot) return member;
    }
    return null;
  };

  const promoteOldestHost = (room: Room): void => {
    let oldest: Member | null = null;
    for (const member of room.members.values()) {
      if (oldest === null || member.joinOrder < oldest.joinOrder) oldest = member;
    }
    if (oldest !== null) room.hostToken = oldest.token;
  };

  const cancelCountdown = (room: Room): void => {
    if (room.countdownTimer !== null) {
      clearTimeout(room.countdownTimer);
      room.countdownTimer = null;
    }
    if (room.phase === 'starting') room.phase = 'lobby';
  };

  const scheduleAbandonCheck = (room: Room): void => {
    if (room.phase !== 'playing' || attachedCount(room) > 0 || room.abandonTimer !== null) return;
    room.abandonTimer = setTimeout(() => {
      room.abandonTimer = null;
      if (room.phase === 'playing' && attachedCount(room) === 0) deleteRoom(room);
    }, ABANDONED_ROOM_GRACE_MS);
  };

  const cancelAbandonCheck = (room: Room): void => {
    if (room.abandonTimer !== null) {
      clearTimeout(room.abandonTimer);
      room.abandonTimer = null;
    }
  };

  // ---- connection teardown ------------------------------------------------

  /**
   * Detach `conn` from its room member (if it is still the member's current
   * connection) and run the disconnect side effects for the room phase.
   */
  const detachFromRoom = (conn: Conn): void => {
    const room = conn.room;
    conn.room = null;
    if (room === null || conn.session === null) return;
    const member = room.members.get(conn.session.token);
    if (member === undefined || member.conn !== conn) return; // superseded — new conn owns the seat

    member.conn = null;
    if (room.phase === 'lobby') member.ready = false;

    if (room.phase === 'playing') {
      if (member.slot !== null && room.runtime !== null) {
        room.runtime.setConnected(member.slot, false);
      }
      broadcastRoomState(room);
      scheduleAbandonCheck(room);
      return;
    }

    // lobby / starting / ended: delete the room once nobody is attached
    // (resume keeps working for partially-disconnected lobbies; an
    // all-disconnected lobby would otherwise leak forever).
    if (attachedCount(room) === 0) {
      deleteRoom(room);
      return;
    }
    broadcastRoomState(room);
  };

  /** Idempotent cleanup; safe to call from both close paths. */
  const teardown = (conn: Conn): void => {
    if (conn.tornDown) return;
    conn.tornDown = true;
    connectionCount -= 1;
    if (conn.helloTimer !== null) clearTimeout(conn.helloTimer);
    if (conn.pingTimer !== null) clearInterval(conn.pingTimer);
    conn.helloTimer = null;
    conn.pingTimer = null;
    const token = conn.session?.token ?? null;
    if (token !== null) identity.releaseSocket(token, conn);
    detachFromRoom(conn);
    // Reclaim the session record once the token has no live socket and no room
    // membership (resume routing). Without this, every distinct token minted a
    // permanent SessionRecord — an unbounded memory leak under token churn.
    if (token !== null && !membershipByToken.has(token)) identity.dropSession(token);
  };

  const closeConn = (conn: Conn, code: number, reason: string): void => {
    if (conn.tornDown) return;
    teardown(conn);
    try {
      conn.socket.close(code, reason);
    } catch {
      // Already closed — nothing to do.
    }
  };

  // ---- hello / identity ---------------------------------------------------

  const startHeartbeat = (conn: Conn): void => {
    conn.pingTimer = setInterval(() => {
      if (now() - conn.lastInboundMs > HEARTBEAT_TIMEOUT_MS) {
        closeConn(conn, 4001, 'heartbeat timeout');
        return;
      }
      send(conn, { type: 'ping', t: now() });
    }, HEARTBEAT_INTERVAL_MS);
  };

  const handleHello = (conn: Conn, msg: HelloMessage): void => {
    if (msg.version !== PROTOCOL_VERSION) {
      sendError(conn, 'versionMismatch', `server speaks protocol v${PROTOCOL_VERSION}`);
      closeConn(conn, 4004, 'protocol version mismatch');
      return;
    }

    const session = identity.ensureSession(msg.token, msg.name);
    conn.session = session;
    if (conn.helloTimer !== null) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }

    // Re-attach to an existing membership BEFORE displacing the old socket,
    // so the old connection's teardown sees member.conn !== itself and skips
    // the disconnect side effects (no spurious setConnected(false) flap).
    const room = membershipByToken.get(session.token) ?? null;
    const member = room?.members.get(session.token);
    if (room !== null && member !== undefined) {
      conn.room = room;
      member.conn = conn;
      cancelAbandonCheck(room);
    }

    const displaced = identity.bindSocket(session.token, conn);
    if (displaced !== null && displaced !== conn) {
      closeConn(displaced, 4000, 'superseded by a newer connection');
    }

    send(conn, {
      type: 'welcome',
      version: PROTOCOL_VERSION,
      publicId: session.publicId,
      name: session.name,
      resumed: room !== null ? { roomId: room.id, phase: room.phase } : null,
    });
    startHeartbeat(conn);

    if (room !== null && member !== undefined) {
      broadcastRoomState(room); // resumer included — this is the lobby resume payload
      if (room.phase === 'playing' && member.slot !== null && room.runtime !== null) {
        room.runtime.setConnected(member.slot, true); // runtime answers with a keyframe
      }
    }
  };

  // ---- lobby handlers -----------------------------------------------------

  const addMember = (room: Room, conn: Conn, session: SessionRecord): Member => {
    const member: Member = {
      token: session.token,
      session,
      slot: null,
      ready: false,
      conn,
      joinOrder: room.joinCounter,
    };
    room.joinCounter += 1;
    room.members.set(session.token, member);
    membershipByToken.set(session.token, room);
    conn.room = room;
    return member;
  };

  const handleCreateRoom = (conn: Conn, session: SessionRecord, roomName: string): void => {
    if (membershipByToken.has(session.token)) {
      sendError(conn, 'alreadyInRoom', 'leave your current room first');
      return;
    }
    if (rooms.size >= MAX_ROOMS) {
      sendError(conn, 'serverFull', 'server is at room capacity; try again later');
      return;
    }
    const trimmed = roomName.trim().slice(0, MAX_ROOM_NAME_LENGTH);
    const room: Room = {
      id: newRoomId(),
      name: trimmed.length > 0 ? trimmed : `${session.name}'s room`.slice(0, MAX_ROOM_NAME_LENGTH),
      phase: 'lobby',
      members: new Map(),
      hostToken: session.token,
      runtime: null,
      countdownTimer: null,
      abandonTimer: null,
      joinCounter: 0,
      aiSlots: new Map(),
    };
    rooms.set(room.id, room);
    addMember(room, conn, session);
    broadcastRoomState(room);
  };

  const handleJoinRoom = (conn: Conn, session: SessionRecord, roomId: string): void => {
    const existing = membershipByToken.get(session.token);
    if (existing !== undefined) {
      // Rejoining the room you are already a member of re-attaches (covers
      // "left a live match, came back" on the same connection).
      if (existing.id === roomId) {
        const member = existing.members.get(session.token);
        if (member !== undefined) {
          conn.room = existing;
          member.conn = conn;
          cancelAbandonCheck(existing);
          broadcastRoomState(existing);
          if (existing.phase === 'playing' && member.slot !== null && existing.runtime !== null) {
            existing.runtime.setConnected(member.slot, true);
          }
          return;
        }
      }
      sendError(conn, 'alreadyInRoom', 'leave your current room first');
      return;
    }
    const room = rooms.get(roomId);
    if (room === undefined) {
      sendError(conn, 'roomNotFound', `no room ${roomId}`);
      return;
    }
    if (room.phase !== 'lobby') {
      sendError(conn, 'matchInProgress', 'room is not in lobby phase');
      return;
    }
    if (room.members.size >= MAX_PLAYERS_PER_ROOM) {
      sendError(conn, 'roomFull', 'room is full');
      return;
    }
    addMember(room, conn, session);
    broadcastRoomState(room);
  };

  const handleListRooms = (conn: Conn): void => {
    const list: RoomSummary[] = [...rooms.values()].map((room) => ({
      roomId: room.id,
      name: room.name,
      phase: room.phase,
      playerCount: room.members.size,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
    }));
    send(conn, { type: 'roomList', rooms: list });
  };

  const handleLeaveRoom = (conn: Conn, session: SessionRecord): void => {
    const room = conn.room;
    if (room === null) {
      sendError(conn, 'notInRoom', 'not in a room');
      return;
    }
    const member = room.members.get(session.token);
    if (member === undefined) {
      conn.room = null;
      sendError(conn, 'notInRoom', 'not in a room');
      return;
    }

    if (room.phase === 'playing') {
      // No mid-match unseating: the seat (and membership, for resume) stays;
      // the connection detaches and the seat is marked disconnected.
      conn.room = null;
      if (member.conn === conn) {
        member.conn = null;
        if (member.slot !== null && room.runtime !== null) {
          room.runtime.setConnected(member.slot, false);
        }
        broadcastRoomState(room);
        scheduleAbandonCheck(room);
      }
      return;
    }

    // lobby / starting / ended: full removal.
    conn.room = null;
    room.members.delete(session.token);
    membershipByToken.delete(session.token);
    if (room.members.size === 0) {
      deleteRoom(room);
      return;
    }
    if (room.hostToken === session.token) promoteOldestHost(room);
    if (room.phase === 'starting') cancelCountdown(room); // membership changed — restart by hand
    broadcastRoomState(room);
  };

  const handlePickSlot = (conn: Conn, session: SessionRecord, slot: number): void => {
    const room = conn.room;
    const member = room?.members.get(session.token);
    if (room === null || member === undefined) {
      sendError(conn, 'notInRoom', 'not in a room');
      return;
    }
    if (room.phase !== 'lobby') {
      sendError(conn, 'matchInProgress', 'slots are locked outside the lobby phase');
      return;
    }
    if (teamOfSlot(slot) === null) {
      sendError(conn, 'invalidSlot', `slot ${slot} is not pickable`);
      return;
    }
    if (room.aiSlots.has(slot)) {
      sendError(conn, 'slotTaken', `slot ${slot} is held by an AI`);
      return;
    }
    const occupant = memberBySlot(room, slot);
    if (occupant !== null && occupant !== member) {
      sendError(conn, 'slotTaken', `slot ${slot} is taken`);
      return;
    }
    member.slot = slot;
    broadcastRoomState(room);
  };

  const handleSetReady = (conn: Conn, session: SessionRecord, ready: boolean): void => {
    const room = conn.room;
    const member = room?.members.get(session.token);
    if (room === null || member === undefined) {
      sendError(conn, 'notInRoom', 'not in a room');
      return;
    }
    if (room.phase !== 'lobby') {
      sendError(conn, 'matchInProgress', 'ready state is locked outside the lobby phase');
      return;
    }
    member.ready = ready;
    broadcastRoomState(room);
  };

  // ---- AI seats (host-only, lobby-only) -----------------------------------

  /**
   * Seat an AI captain in an open pickable slot. Host-only, lobby-only. The
   * slot must be a real pickable slot (LOBBY_SLOTS) and unoccupied by a human
   * OR another AI. Rejections reuse existing ErrorCode values (no protocol
   * version bump): notInRoom / matchInProgress / notHost / invalidSlot /
   * slotTaken.
   */
  const handleAddAi = (
    conn: Conn,
    session: SessionRecord,
    slot: number,
    difficulty: AiDifficulty,
  ): void => {
    const room = conn.room;
    const member = room?.members.get(session.token);
    if (room === null || member === undefined) {
      sendError(conn, 'notInRoom', 'not in a room');
      return;
    }
    if (room.phase !== 'lobby') {
      sendError(conn, 'matchInProgress', 'AI seats are locked outside the lobby phase');
      return;
    }
    if (room.hostToken !== session.token) {
      sendError(conn, 'notHost', 'only the host can add an AI');
      return;
    }
    if (teamOfSlot(slot) === null) {
      sendError(conn, 'invalidSlot', `slot ${slot} is not pickable`);
      return;
    }
    if (room.aiSlots.has(slot) || memberBySlot(room, slot) !== null) {
      sendError(conn, 'slotTaken', `slot ${slot} is taken`);
      return;
    }
    room.aiSlots.set(slot, difficulty);
    broadcastRoomState(room);
  };

  /**
   * Remove the AI seated in `slot`, reopening it. Host-only, lobby-only.
   * Rejects with `invalidSlot` when the slot is not occupied by an AI (it is
   * either empty or held by a human, so there is no AI to remove).
   */
  const handleRemoveAi = (conn: Conn, session: SessionRecord, slot: number): void => {
    const room = conn.room;
    const member = room?.members.get(session.token);
    if (room === null || member === undefined) {
      sendError(conn, 'notInRoom', 'not in a room');
      return;
    }
    if (room.phase !== 'lobby') {
      sendError(conn, 'matchInProgress', 'AI seats are locked outside the lobby phase');
      return;
    }
    if (room.hostToken !== session.token) {
      sendError(conn, 'notHost', 'only the host can remove an AI');
      return;
    }
    if (!room.aiSlots.has(slot)) {
      sendError(conn, 'invalidSlot', `slot ${slot} is not occupied by an AI`);
      return;
    }
    room.aiSlots.delete(slot);
    broadcastRoomState(room);
  };

  // ---- match start --------------------------------------------------------

  const beginMatch = (room: Room): void => {
    const seated = [...room.members.values()]
      .filter((member): member is Member & { slot: number } => member.slot !== null)
      .sort((a, b) => a.slot - b.slot);
    const seats: MatchSeat[] = seated.map((member) => ({
      slot: member.slot,
      name: member.session.name,
    }));
    const seed = drawSeed() >>> 0;
    const startedAt = now();

    // Capture per-slot identity for the stats ingest (done at match start so
    // the token + publicId are available even if the member disconnects before
    // the match ends). AI empire slots (0/1) are never in `seated`.
    const slotIdentity = new Map<number, { token: string; publicId: string; name: string; team: TeamId | null }>(
      seated.map((member) => [
        member.slot,
        {
          token: member.token,
          publicId: deriveStatsPublicId(member.token),
          name: member.session.name,
          team: teamOfSlot(member.slot),
        },
      ]),
    );

    // AI seats are NOT human seats: excluded from `seated`/`slotIdentity` (so
    // onEnded's ladder participants drop their stats rows); they seed
    // `control: 'computer'` AI players and get scoreboard-only stats lines.
    //
    // Trader designation (docs/AI.md "one trader per team"): the combat brain
    // never trades, so in solo-vs-AI the faithful trade-route / refinery /
    // repair-mission chains only fire if a bot is seated as a quest-runner.
    // Deterministically pick the LOWEST-slot AI seat on each team as its trader
    // (sorted ascending first, so iteration order is irrelevant); the rest are
    // captains. No lobby UI needed — traders are auto-assigned at start.
    const aiEntries = [...room.aiSlots.entries()].sort((a, b) => a[0] - b[0]);
    const traderSlotByTeam = new Map<TeamId, number>();
    for (const [slot] of aiEntries) {
      const team = teamOfSlot(slot);
      if (team !== null && !traderSlotByTeam.has(team)) traderSlotByTeam.set(team, slot);
    }
    const aiSeats: AiSeat[] = aiEntries.map(([slot, difficulty]) => {
      const team = teamOfSlot(slot);
      const role = team !== null && traderSlotByTeam.get(team) === slot ? 'trader' : 'captain';
      return { slot, ai: { difficulty, role } };
    });

    const runtime = createRuntime({
      ruleset,
      seed,
      seats,
      ...(aiSeats.length > 0 ? { aiSeats } : {}),
      ...(options.tickIntervalMs !== undefined ? { tickIntervalMs: options.tickIntervalMs } : {}),
      sendToSlot: (slot, msg) => {
        const member = memberBySlot(room, slot);
        if (member === null || member.conn === null) return; // no-op while disconnected
        send(member.conn, msg);
      },
      // matchEnded itself is sent by the runtime via sendToSlot; rooms only
      // needs to know that the match is over and assembles the stats report.
      onEnded: (report) => {
        // Build the authoritative MatchResultIngest from runtime report + identities.
        // Participants exclude AI slots 0/1 (slotIdentity only contains human seats).
        const participants = report.stats
          .map((stat) => {
            const identity = slotIdentity.get(stat.slot);
            if (identity === null || identity === undefined || identity.team === null) return null;
            const result: MatchParticipantIngest = {
              token: identity.token,
              publicId: identity.publicId,
              name: stat.name,
              slot: stat.slot,
              team: identity.team,
              shipTypeId: stat.shipTypeId,
              kills: stat.kills,
              deaths: stat.deaths,
              goldEarned: report.goldEarned.get(stat.slot) ?? 0,
            };
            return result;
          })
          .filter((p): p is MatchParticipantIngest => p !== null);

        const ingest: MatchResultIngest = {
          rulesetId: report.rulesetId,
          seed: report.seed,
          startedAt,
          durationTicks: report.durationTicks,
          winnerTeam: report.winnerTeam,
          participants,
        };

        statsPoster.postMatchResult(ingest);
        endMatch(room);
      },
    });
    room.runtime = runtime;
    room.phase = 'playing';
    runtime.start();
    // Seats that dropped during the countdown start disconnected.
    for (const member of seated) {
      if (member.conn === null) runtime.setConnected(member.slot, false);
    }
    broadcastRoomState(room);
    scheduleAbandonCheck(room);
  };

  const runCountdown = (room: Room, secondsLeft: number): void => {
    broadcast(room, { type: 'matchStarting', countdownSeconds: secondsLeft });
    if (secondsLeft <= 0) {
      room.countdownTimer = null;
      beginMatch(room);
      return;
    }
    room.countdownTimer = setTimeout(() => runCountdown(room, secondsLeft - 1), 1000);
  };

  const handleStartMatch = (conn: Conn, session: SessionRecord): void => {
    const room = conn.room;
    const member = room?.members.get(session.token);
    if (room === null || member === undefined) {
      sendError(conn, 'notInRoom', 'not in a room');
      return;
    }
    if (room.phase !== 'lobby') {
      sendError(conn, 'matchInProgress', 'match already starting or running');
      return;
    }
    if (room.hostToken !== session.token) {
      sendError(conn, 'notHost', 'only the host can start the match');
      return;
    }
    const seated = [...room.members.values()].filter((m) => m.slot !== null);
    if (seated.length === 0) {
      sendError(conn, 'playersNotReady', 'no seated players');
      return;
    }
    if (seated.some((m) => !m.ready)) {
      sendError(conn, 'playersNotReady', 'every seated player must be ready');
      return;
    }
    // Both teams need at least one player (human OR AI). Without this a lineup
    // could start opponent-less, let the AI/idle enemy HQ be sunk against
    // nobody. AI captains satisfy a team's requirement, so a single human can
    // play solo vs AI (host fills the enemy team — and optionally their own —
    // with AI seats). Note: filling the OPPOSING team with AI is what makes the
    // ranked stats ingest a real opponent matchup; the human-only anti-farm
    // case is preserved (two humans both on south still fails unless north has
    // a human or AI).
    const seatedTeams = new Set<TeamId>();
    for (const m of seated) {
      const team = teamOfSlot(m.slot as number);
      if (team !== null) seatedTeams.add(team);
    }
    for (const slot of room.aiSlots.keys()) {
      const team = teamOfSlot(slot);
      if (team !== null) seatedTeams.add(team);
    }
    if (seatedTeams.size < 2) {
      sendError(conn, 'playersNotReady', 'both teams need at least one player');
      return;
    }
    room.phase = 'starting';
    broadcastRoomState(room);
    runCountdown(room, countdownSeconds);
  };

  /**
   * Runtime finished (HQ death; matchEnded was already sent by the runtime
   * via sendToSlot). The room returns to a reusable lobby: members without a
   * live connection are purged, ready flags reset, host re-validated.
   */
  const endMatch = (room: Room): void => {
    room.runtime?.stop();
    room.runtime = null;
    cancelAbandonCheck(room);
    for (const [token, member] of room.members) {
      if (member.conn === null) {
        room.members.delete(token);
        membershipByToken.delete(token);
      }
    }
    if (room.members.size === 0) {
      deleteRoom(room);
      return;
    }
    if (!room.members.has(room.hostToken)) promoteOldestHost(room);
    room.phase = 'lobby';
    for (const member of room.members.values()) member.ready = false;
    // A returning lobby starts AI-free: AI seats were a one-match setup. The
    // host re-adds them for the next match if desired.
    room.aiSlots.clear();
    broadcastRoomState(room);
  };

  // ---- in-match routing ---------------------------------------------------

  const handleCommand = (conn: Conn, session: SessionRecord, msg: CommandMessage): void => {
    const room = conn.room;
    const member = room?.members.get(session.token);
    if (room === null || member === undefined || room.phase !== 'playing' || room.runtime === null) {
      sendError(conn, 'notInMatch', 'no live match');
      return;
    }
    if (member.slot === null) {
      sendError(conn, 'notInMatch', 'not seated in this match');
      return;
    }
    // A connection may only issue commands for its own player slot.
    if (msg.command.player !== member.slot) {
      sendError(conn, 'invalidCommand', `command.player must be ${member.slot}`);
      return;
    }
    room.runtime.enqueueCommand(member.slot, msg.command);
  };

  const handleChat = (conn: Conn, session: SessionRecord, msg: ClientChatMessage): void => {
    const room = conn.room;
    const member = room?.members.get(session.token);
    if (room === null || member === undefined) {
      sendError(conn, 'notInRoom', 'not in a room');
      return;
    }
    const relay: ServerMessage = {
      type: 'chat',
      from: { publicId: session.publicId, name: session.name, slot: member.slot },
      scope: msg.scope,
      text: msg.text,
    };
    if (msg.scope === 'all') {
      broadcast(room, relay);
      return;
    }
    // team scope: members seated on the sender's team; an unseated sender
    // only echoes to themselves.
    const senderTeam = member.slot !== null ? teamOfSlot(member.slot) : null;
    const text = JSON.stringify(relay);
    for (const other of room.members.values()) {
      if (other.conn === null) continue;
      const otherTeam = other.slot !== null ? teamOfSlot(other.slot) : null;
      const sameTeam = senderTeam !== null && otherTeam === senderTeam;
      if (other === member || sameTeam) sendText(other.conn, text);
    }
  };

  // ---- per-connection frame pump ------------------------------------------

  const onRateViolation = (conn: Conn): void => {
    conn.violations += 1;
    sendError(conn, 'rateLimited', 'message rate limit exceeded');
    if (conn.violations >= MAX_RATE_VIOLATIONS) {
      closeConn(conn, 1008, 'rate limit');
    }
  };

  const dispatch = (conn: Conn, msg: ClientMessage): void => {
    if (conn.session === null) {
      if (msg.type !== 'hello') {
        sendError(conn, 'notAuthed', 'first message must be hello');
        closeConn(conn, 4003, 'not authed');
        return;
      }
      handleHello(conn, msg);
      return;
    }
    const session = conn.session;
    switch (msg.type) {
      case 'hello':
        sendError(conn, 'badMessage', 'already authenticated');
        return;
      case 'pong':
        return; // lastInboundMs already refreshed
      case 'listRooms':
        handleListRooms(conn);
        return;
      case 'createRoom':
        handleCreateRoom(conn, session, msg.roomName);
        return;
      case 'joinRoom':
        handleJoinRoom(conn, session, msg.roomId);
        return;
      case 'leaveRoom':
        handleLeaveRoom(conn, session);
        return;
      case 'pickSlot':
        handlePickSlot(conn, session, msg.slot);
        return;
      case 'setReady':
        handleSetReady(conn, session, msg.ready);
        return;
      case 'startMatch':
        handleStartMatch(conn, session);
        return;
      case 'addAi':
        handleAddAi(conn, session, msg.slot, msg.difficulty);
        return;
      case 'removeAi':
        handleRemoveAi(conn, session, msg.slot);
        return;
      case 'command':
        if (!takeToken(conn.commandBucket, now())) {
          onRateViolation(conn);
          return;
        }
        handleCommand(conn, session, msg);
        return;
      case 'chat':
        if (!takeToken(conn.chatBucket, now())) {
          onRateViolation(conn);
          return;
        }
        handleChat(conn, session, msg);
        return;
    }
  };

  const onMessage = (conn: Conn, text: string, info?: FrameInfo): void => {
    if (conn.tornDown) return;
    if (info?.binary === true) {
      closeConn(conn, 1003, 'binary frames are not supported');
      return;
    }
    const byteLength = info?.byteLength ?? Buffer.byteLength(text, 'utf8');
    if (byteLength > MAX_FRAME_BYTES) {
      closeConn(conn, 1009, 'frame too large');
      return;
    }
    conn.lastInboundMs = now();
    if (!takeToken(conn.generalBucket, now())) {
      onRateViolation(conn);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const msg = parsed === undefined ? null : parseClientMessage(parsed);
    if (msg === null) {
      sendError(conn, 'badMessage', 'malformed message');
      if (conn.session === null) closeConn(conn, 4003, 'bad first message');
      return;
    }
    conn.violations = 0;
    dispatch(conn, msg);
  };

  // ---- public API ---------------------------------------------------------

  return {
    handleConnection(socket) {
      // Global connection cap: a resource-exhaustion backstop against many
      // concurrent sockets (token churn). Reject without ever creating a Conn
      // or counting it — close immediately with 1013 (try again later).
      if (connectionCount >= MAX_CONNECTIONS) {
        try {
          socket.close(1013, 'server at capacity');
        } catch {
          // already closing — nothing to do
        }
        // A no-op managed connection: it was never counted, so onClose must not
        // decrement. Drop any further frames silently.
        return { onMessage: () => {}, onClose: () => {} };
      }
      connectionCount += 1;
      const startMs = now();
      const conn: Conn = {
        socket,
        session: null,
        room: null,
        lastInboundMs: startMs,
        generalBucket: makeBucket(RATE_BUCKET_CAPACITY, RATE_REFILL_PER_SEC, startMs),
        commandBucket: makeBucket(COMMAND_BUCKET_CAPACITY, COMMAND_REFILL_PER_SEC, startMs),
        chatBucket: makeBucket(CHAT_BUCKET_CAPACITY, CHAT_REFILL_PER_SEC, startMs),
        violations: 0,
        helloTimer: null,
        pingTimer: null,
        tornDown: false,
      };
      // Connections that never say hello are dropped after the same silence
      // budget as the heartbeat.
      conn.helloTimer = setTimeout(() => closeConn(conn, 4002, 'hello timeout'), HEARTBEAT_TIMEOUT_MS);
      return {
        onMessage: (text, info) => onMessage(conn, text, info),
        onClose: () => teardown(conn),
      };
    },

    roomCount() {
      return rooms.size;
    },

    shutdown() {
      for (const room of [...rooms.values()]) deleteRoom(room);
    },
  };
}
