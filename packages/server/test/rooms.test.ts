/**
 * server-rooms tests: validate.ts (wire validation), identity.ts (sessions),
 * rooms.ts (connection state machine, lobby, start flow, in-match routing,
 * heartbeat, rate limiting).
 *
 * server-match is mocked at the frozen seam (`createRuntime` injection) —
 * these tests run without src/match.ts. Sockets are in-memory fakes; timers
 * and Date are vitest fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MATCH_COUNTDOWN_SECONDS,
  MAX_NAME_LENGTH,
  MAX_PLAYERS_PER_ROOM,
  PROTOCOL_VERSION,
} from '@bships/core';
import type { Ruleset, ServerMessage } from '@bships/core';
import { createIdentityRegistry, FALLBACK_NAME } from '../src/identity.js';
import { parseClientMessage, parseCommand } from '../src/validate.js';
import {
  ABANDONED_ROOM_GRACE_MS,
  COMMAND_BUCKET_CAPACITY,
  createRoomManager,
  MAX_FRAME_BYTES,
  MAX_SEND_BUFFER_BYTES,
  RATE_BUCKET_CAPACITY,
} from '../src/rooms.js';
import type {
  ManagedConnection,
  MatchRuntime,
  MatchRuntimeDeps,
  RoomManager,
} from '../src/rooms.js';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);
const TOKEN_C = 'c'.repeat(32);

// ---------------------------------------------------------------------------
// validate.ts
// ---------------------------------------------------------------------------

describe('parseClientMessage', () => {
  it('accepts every message type and returns sanitized copies', () => {
    expect(
      parseClientMessage({ type: 'hello', version: 1, token: TOKEN_A, name: 'Bob', junk: 1 }),
    ).toEqual({ type: 'hello', version: 1, token: TOKEN_A, name: 'Bob' });
    expect(parseClientMessage({ type: 'createRoom', roomName: 'My Room' })).toEqual({
      type: 'createRoom',
      roomName: 'My Room',
    });
    expect(parseClientMessage({ type: 'joinRoom', roomId: 'abc123' })).toEqual({
      type: 'joinRoom',
      roomId: 'abc123',
    });
    expect(parseClientMessage({ type: 'listRooms', extra: true })).toEqual({ type: 'listRooms' });
    expect(parseClientMessage({ type: 'pickSlot', slot: 7 })).toEqual({ type: 'pickSlot', slot: 7 });
    expect(parseClientMessage({ type: 'setReady', ready: true })).toEqual({
      type: 'setReady',
      ready: true,
    });
    expect(parseClientMessage({ type: 'startMatch' })).toEqual({ type: 'startMatch' });
    expect(parseClientMessage({ type: 'addAi', slot: 7, difficulty: 'hard', junk: 1 })).toEqual({
      type: 'addAi',
      slot: 7,
      difficulty: 'hard',
    });
    expect(parseClientMessage({ type: 'removeAi', slot: 7, junk: 1 })).toEqual({
      type: 'removeAi',
      slot: 7,
    });
    expect(
      parseClientMessage({ type: 'command', tick: 41, command: { type: 'move', player: 2, x: 1.5, y: -2 } }),
    ).toEqual({ type: 'command', tick: 41, command: { type: 'move', player: 2, x: 1.5, y: -2 } });
    expect(parseClientMessage({ type: 'chat', scope: 'team', text: 'gl hf' })).toEqual({
      type: 'chat',
      scope: 'team',
      text: 'gl hf',
    });
    expect(parseClientMessage({ type: 'leaveRoom' })).toEqual({ type: 'leaveRoom' });
    expect(parseClientMessage({ type: 'pong', t: 123.5, x: 'junk' })).toEqual({
      type: 'pong',
      t: 123.5,
    });
  });

  it('rejects structurally invalid messages', () => {
    expect(parseClientMessage(null)).toBeNull();
    expect(parseClientMessage('hello')).toBeNull();
    expect(parseClientMessage([])).toBeNull();
    expect(parseClientMessage({ type: 'nope' })).toBeNull();
    // hello: token must match TOKEN_PATTERN, name bounded, version an int
    expect(parseClientMessage({ type: 'hello', version: 1, token: 'SHORT', name: 'x' })).toBeNull();
    expect(
      parseClientMessage({ type: 'hello', version: 1, token: TOKEN_A.toUpperCase(), name: 'x' }),
    ).toBeNull();
    expect(
      parseClientMessage({ type: 'hello', version: 1.5, token: TOKEN_A, name: 'x' }),
    ).toBeNull();
    expect(
      parseClientMessage({ type: 'hello', version: 1, token: TOKEN_A, name: 'x'.repeat(MAX_NAME_LENGTH + 1) }),
    ).toBeNull();
    // chat: scope whitelist + bounded non-empty text
    expect(parseClientMessage({ type: 'chat', scope: 'global', text: 'hi' })).toBeNull();
    expect(parseClientMessage({ type: 'chat', scope: 'all', text: '' })).toBeNull();
    expect(parseClientMessage({ type: 'chat', scope: 'all', text: 'x'.repeat(241) })).toBeNull();
    // numbers must be finite / integral where required
    expect(parseClientMessage({ type: 'pickSlot', slot: -1 })).toBeNull();
    expect(parseClientMessage({ type: 'pickSlot', slot: 2.5 })).toBeNull();
    expect(parseClientMessage({ type: 'pong', t: 'now' })).toBeNull();
    expect(parseClientMessage({ type: 'joinRoom', roomId: '' })).toBeNull();
    expect(parseClientMessage({ type: 'createRoom', roomName: 'x'.repeat(41) })).toBeNull();
    // addAi/removeAi: slot a non-negative integer, difficulty whitelisted
    expect(parseClientMessage({ type: 'addAi', slot: 2.5, difficulty: 'easy' })).toBeNull();
    expect(parseClientMessage({ type: 'addAi', slot: -1, difficulty: 'easy' })).toBeNull();
    expect(parseClientMessage({ type: 'addAi', slot: 7, difficulty: 'insane' })).toBeNull();
    expect(parseClientMessage({ type: 'addAi', slot: 7 })).toBeNull(); // missing difficulty
    expect(parseClientMessage({ type: 'removeAi', slot: 'x' })).toBeNull();
    expect(parseClientMessage({ type: 'removeAi' })).toBeNull();
    // command: tick must be finite when present, command must validate
    expect(
      parseClientMessage({ type: 'command', tick: Number.NaN, command: { type: 'stop', player: 2 } }),
    ).toBeNull();
    expect(parseClientMessage({ type: 'command', command: { type: 'warp', player: 2 } })).toBeNull();
  });
});

describe('parseCommand', () => {
  it('validates the full command union', () => {
    expect(parseCommand({ type: 'stop', player: 2 })).toEqual({ type: 'stop', player: 2 });
    expect(parseCommand({ type: 'holdPosition', player: 2 })).toEqual({ type: 'holdPosition', player: 2 });
    expect(parseCommand({ type: 'attackMove', player: 2, x: 0, y: 9 })).toEqual({
      type: 'attackMove',
      player: 2,
      x: 0,
      y: 9,
    });
    expect(parseCommand({ type: 'attackTarget', player: 2, targetId: 17 })).toEqual({
      type: 'attackTarget',
      player: 2,
      targetId: 17,
    });
    expect(parseCommand({ type: 'buyItem', player: 2, shopId: 5, itemId: 'I00A' })).toEqual({
      type: 'buyItem',
      player: 2,
      shopId: 5,
      itemId: 'I00A',
    });
    expect(parseCommand({ type: 'sellItem', player: 2, slot: 3 })).toEqual({
      type: 'sellItem',
      player: 2,
      slot: 3,
    });
    expect(parseCommand({ type: 'useItem', player: 2, slot: 0, targetId: 9 })).toEqual({
      type: 'useItem',
      player: 2,
      slot: 0,
      targetId: 9,
    });
    expect(parseCommand({ type: 'dropItem', player: 2, slot: 1, x: 3, y: 4 })).toEqual({
      type: 'dropItem',
      player: 2,
      slot: 1,
      x: 3,
      y: 4,
    });
    expect(parseCommand({ type: 'pickupItem', player: 2, groundItemId: 4 })).toEqual({
      type: 'pickupItem',
      player: 2,
      groundItemId: 4,
    });
    expect(parseCommand({ type: 'buyShip', player: 2, shopId: 8, shipTypeId: 'H00B' })).toEqual({
      type: 'buyShip',
      player: 2,
      shopId: 8,
      shipTypeId: 'H00B',
    });
    expect(parseCommand({ type: 'castAbility', player: 2, abilityId: 'A01X', x: 1, y: 2 })).toEqual({
      type: 'castAbility',
      player: 2,
      abilityId: 'A01X',
      x: 1,
      y: 2,
    });
    expect(parseCommand({ type: 'fireMissile', player: 2 })).toEqual({ type: 'fireMissile', player: 2 });
    expect(parseCommand({ type: 'research', player: 2, upgradeId: 'R001' })).toEqual({
      type: 'research',
      player: 2,
      upgradeId: 'R001',
    });
    expect(parseCommand({ type: 'learnSkill', player: 2, abilityId: 'A0SK' })).toEqual({
      type: 'learnSkill',
      player: 2,
      abilityId: 'A0SK',
    });
    expect(parseCommand({ type: 'setGoldDump', player: 2, enabled: false })).toEqual({
      type: 'setGoldDump',
      player: 2,
      enabled: false,
    });
  });

  it('rejects malformed commands', () => {
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand({ type: 'move', player: 2, x: Number.NaN, y: 0 })).toBeNull();
    expect(parseCommand({ type: 'move', player: 2, x: Number.POSITIVE_INFINITY, y: 0 })).toBeNull();
    expect(parseCommand({ type: 'move', x: 1, y: 2 })).toBeNull(); // missing player
    expect(parseCommand({ type: 'move', player: -1, x: 1, y: 2 })).toBeNull();
    expect(parseCommand({ type: 'move', player: 2.5, x: 1, y: 2 })).toBeNull();
    expect(parseCommand({ type: 'attackTarget', player: 2, targetId: 'hq' })).toBeNull();
    expect(parseCommand({ type: 'buyItem', player: 2, shopId: 5, itemId: 7 })).toBeNull();
    expect(parseCommand({ type: 'buyItem', player: 2, shopId: 5, itemId: 'x'.repeat(65) })).toBeNull();
    expect(parseCommand({ type: 'useItem', player: 2, slot: 0, x: 1 })).toBeNull(); // x without y
    expect(parseCommand({ type: 'useItem', player: 2, slot: 0, targetId: null })).toBeNull();
    expect(parseCommand({ type: 'setGoldDump', player: 2, enabled: 'yes' })).toBeNull();
    expect(parseCommand({ type: 'unknown', player: 2 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// identity.ts
// ---------------------------------------------------------------------------

describe('identity registry', () => {
  it('assigns short public ids never derived from the token', () => {
    const identity = createIdentityRegistry<object>();
    const session = identity.ensureSession(TOKEN_A, 'Bob');
    expect(session.publicId).toMatch(/^p[0-9a-f]{6}$/);
    expect(session.publicId).not.toBe(TOKEN_A);
    expect(TOKEN_A.includes(session.publicId)).toBe(false);
    // stable across re-hello
    expect(identity.ensureSession(TOKEN_A, 'Bob').publicId).toBe(session.publicId);
  });

  it('sanitizes and deduplicates display names', () => {
    const identity = createIdentityRegistry<object>();
    expect(identity.ensureSession(TOKEN_A, '  Bob   the   Bold ').name).toBe('Bob the Bold');
    expect(identity.ensureSession(TOKEN_B, 'bob THE bold').name).toBe('bob THE bold-2');
    expect(identity.ensureSession(TOKEN_C, '   ').name).toBe(FALLBACK_NAME);
    const long = 'x'.repeat(MAX_NAME_LENGTH + 10);
    expect(identity.ensureSession('d'.repeat(32), long).name).toHaveLength(MAX_NAME_LENGTH);
  });

  it('rejects tokens that fail TOKEN_PATTERN', () => {
    const identity = createIdentityRegistry<object>();
    expect(() => identity.ensureSession('nope', 'Bob')).toThrow();
  });

  it('binds one live socket per token, newest wins', () => {
    const identity = createIdentityRegistry<{ id: number }>();
    identity.ensureSession(TOKEN_A, 'Bob');
    const first = { id: 1 };
    const second = { id: 2 };
    expect(identity.bindSocket(TOKEN_A, first)).toBeNull();
    expect(identity.bindSocket(TOKEN_A, second)).toBe(first);
    expect(identity.getSocket(TOKEN_A)).toBe(second);
    // releasing a stale handle is a no-op
    expect(identity.releaseSocket(TOKEN_A, first)).toBe(false);
    expect(identity.getSocket(TOKEN_A)).toBe(second);
    expect(identity.releaseSocket(TOKEN_A, second)).toBe(true);
    expect(identity.getSocket(TOKEN_A)).toBeNull();
  });

  it('dropSession reclaims a record only when no socket is bound', () => {
    const identity = createIdentityRegistry<{ id: number }>();
    identity.ensureSession(TOKEN_A, 'Bob');
    expect(identity.sessionCount()).toBe(1);
    const sock = { id: 1 };
    identity.bindSocket(TOKEN_A, sock);
    // A still-bound session must NOT be dropped (resume would re-mint publicId).
    expect(identity.dropSession(TOKEN_A)).toBe(false);
    expect(identity.sessionCount()).toBe(1);
    // Once released, it can be reclaimed.
    identity.releaseSocket(TOKEN_A, sock);
    expect(identity.dropSession(TOKEN_A)).toBe(true);
    expect(identity.sessionCount()).toBe(0);
    expect(identity.getSession(TOKEN_A)).toBeUndefined();
    // Dropping an unknown token is a harmless false.
    expect(identity.dropSession(TOKEN_B)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rooms.ts
// ---------------------------------------------------------------------------

class FakeSocket {
  readonly sent: ServerMessage[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  /** Simulated server-side queued-but-unsent bytes (backpressure tests). */
  buffered = 0;

  send(text: string): void {
    this.sent.push(JSON.parse(text) as ServerMessage);
  }

  close(code?: number, reason?: string): void {
    if (this.closed === null) this.closed = { code, reason };
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((msg) => msg.type === type) as Extract<ServerMessage, { type: T }>[];
  }

  lastOfType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> {
    const list = this.ofType(type);
    const last = list[list.length - 1];
    if (last === undefined) throw new Error(`no ${type} message received`);
    return last;
  }
}

interface TestClient {
  socket: FakeSocket;
  conn: ManagedConnection;
  send(msg: unknown): void;
}

function connect(manager: RoomManager): TestClient {
  const socket = new FakeSocket();
  const conn = manager.handleConnection(socket);
  return { socket, conn, send: (msg) => conn.onMessage(JSON.stringify(msg)) };
}

function hello(client: TestClient, token: string, name: string): void {
  client.send({ type: 'hello', version: PROTOCOL_VERSION, token, name });
}

interface FakeRuntimeEntry {
  deps: MatchRuntimeDeps;
  runtime: MatchRuntime & {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    enqueueCommand: ReturnType<typeof vi.fn>;
    setConnected: ReturnType<typeof vi.fn>;
  };
}

function runtimeFactory(): { create(deps: MatchRuntimeDeps): MatchRuntime; created: FakeRuntimeEntry[] } {
  const created: FakeRuntimeEntry[] = [];
  return {
    created,
    create(deps) {
      const runtime = {
        status: 'running' as const,
        start: vi.fn(),
        stop: vi.fn(),
        enqueueCommand: vi.fn(),
        setConnected: vi.fn(),
      };
      created.push({ deps, runtime });
      return runtime;
    },
  };
}

const FAKE_RULESET = {} as Ruleset; // rooms only passes it through to the runtime
const TEST_SEED = 0x12345678;

function makeManager(): { manager: RoomManager; factory: ReturnType<typeof runtimeFactory> } {
  const factory = runtimeFactory();
  const manager = createRoomManager(FAKE_RULESET, {
    createRuntime: (deps) => factory.create(deps),
    drawSeed: () => TEST_SEED,
  });
  return { manager, factory };
}

/** host (slot 2, south) + guest (slot 7, north), match started. */
function setupMatch(manager: RoomManager): { host: TestClient; guest: TestClient; roomId: string } {
  const host = connect(manager);
  hello(host, TOKEN_A, 'Host');
  const guest = connect(manager);
  hello(guest, TOKEN_B, 'Guest');
  host.send({ type: 'createRoom', roomName: 'Test Room' });
  const roomId = host.socket.lastOfType('roomState').roomId;
  guest.send({ type: 'joinRoom', roomId });
  host.send({ type: 'pickSlot', slot: 2 });
  guest.send({ type: 'pickSlot', slot: 7 });
  host.send({ type: 'setReady', ready: true });
  guest.send({ type: 'setReady', ready: true });
  host.send({ type: 'startMatch' });
  vi.advanceTimersByTime(MATCH_COUNTDOWN_SECONDS * 1000);
  return { host, guest, roomId };
}

describe('room manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes connections whose first message is not hello', () => {
    const { manager } = makeManager();
    const client = connect(manager);
    client.send({ type: 'listRooms' });
    expect(client.socket.lastOfType('error').code).toBe('notAuthed');
    expect(client.socket.closed).not.toBeNull();
  });

  it('closes on protocol version mismatch', () => {
    const { manager } = makeManager();
    const client = connect(manager);
    client.send({ type: 'hello', version: PROTOCOL_VERSION + 1, token: TOKEN_A, name: 'Bob' });
    expect(client.socket.lastOfType('error').code).toBe('versionMismatch');
    expect(client.socket.closed).not.toBeNull();
  });

  it('welcomes a valid hello with a public id, settled name, no resume', () => {
    const { manager } = makeManager();
    const client = connect(manager);
    hello(client, TOKEN_A, '  Bob  ');
    const welcome = client.socket.lastOfType('welcome');
    expect(welcome.version).toBe(PROTOCOL_VERSION);
    expect(welcome.name).toBe('Bob');
    expect(welcome.publicId).not.toBe(TOKEN_A);
    expect(TOKEN_A.includes(welcome.publicId)).toBe(false);
    expect(welcome.resumed).toBeNull();
  });

  it('drops connections that never say hello', () => {
    const { manager } = makeManager();
    const client = connect(manager);
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 1);
    expect(client.socket.closed).not.toBeNull();
  });

  it('closes oversized and binary frames', () => {
    const { manager } = makeManager();
    const big = connect(manager);
    big.conn.onMessage('x'.repeat(MAX_FRAME_BYTES + 1));
    expect(big.socket.closed?.code).toBe(1009);
    const bin = connect(manager);
    bin.conn.onMessage('{}', { binary: true });
    expect(bin.socket.closed?.code).toBe(1003);
  });

  it('drops a stalled client whose send buffer exceeds the backpressure cap', () => {
    // Security finding: a client that stops reading lets the server-side send
    // buffer grow without bound (memory-exhaustion DoS). Once bufferedAmount
    // exceeds MAX_SEND_BUFFER_BYTES the manager must close it (1011) instead of
    // queuing more.
    const { manager } = makeManager();
    const client = connect(manager);
    hello(client, TOKEN_A, 'Bob');
    expect(client.socket.closed).toBeNull();

    // Simulate a stalled consumer: the server-side buffer is over the cap.
    client.socket.buffered = MAX_SEND_BUFFER_BYTES + 1;
    const sentBefore = client.socket.sent.length;

    // Any server-initiated send now drops the connection rather than buffering.
    client.send({ type: 'listRooms' });
    expect(client.socket.closed?.code).toBe(1011);
    // No further frame was queued onto the overflowing buffer.
    expect(client.socket.sent.length).toBe(sentBefore);
  });

  it('keeps a client open while its send buffer is within the cap', () => {
    const { manager } = makeManager();
    const client = connect(manager);
    hello(client, TOKEN_A, 'Bob');
    client.socket.buffered = MAX_SEND_BUFFER_BYTES; // at the cap, not over
    client.send({ type: 'listRooms' });
    expect(client.socket.closed).toBeNull();
    expect(client.socket.lastOfType('roomList')).toBeDefined();
  });

  it('answers malformed frames with badMessage and keeps authed connections open', () => {
    const { manager } = makeManager();
    const client = connect(manager);
    hello(client, TOKEN_A, 'Bob');
    client.conn.onMessage('this is not json');
    expect(client.socket.lastOfType('error').code).toBe('badMessage');
    expect(client.socket.closed).toBeNull();
    client.send({ type: 'hello', version: PROTOCOL_VERSION, token: TOKEN_A, name: 'Bob' });
    expect(client.socket.lastOfType('error').code).toBe('badMessage'); // duplicate hello
    expect(client.socket.closed).toBeNull();
  });

  it('runs create/list/join lobby flow with roomState broadcasts', () => {
    const { manager } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Bay Brawl' });
    const state = host.socket.lastOfType('roomState');
    expect(state.name).toBe('Bay Brawl');
    expect(state.phase).toBe('lobby');
    expect(state.players).toHaveLength(1);
    expect(state.players[0]?.isHost).toBe(true);
    expect(state.players[0]?.slot).toBeNull();

    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');
    guest.send({ type: 'listRooms' });
    const list = guest.socket.lastOfType('roomList');
    expect(list.rooms).toHaveLength(1);
    expect(list.rooms[0]?.playerCount).toBe(1);
    expect(list.rooms[0]?.maxPlayers).toBe(MAX_PLAYERS_PER_ROOM);

    guest.send({ type: 'joinRoom', roomId: state.roomId });
    expect(guest.socket.lastOfType('roomState').players).toHaveLength(2);
    expect(host.socket.lastOfType('roomState').players).toHaveLength(2);

    guest.send({ type: 'createRoom', roomName: 'Second' });
    expect(guest.socket.lastOfType('error').code).toBe('alreadyInRoom');
    guest.send({ type: 'joinRoom', roomId: 'ffffff' });
    expect(guest.socket.lastOfType('error').code).toBe('alreadyInRoom');

    const stranger = connect(manager);
    hello(stranger, TOKEN_C, 'Stranger');
    stranger.send({ type: 'joinRoom', roomId: 'ffffff' });
    expect(stranger.socket.lastOfType('error').code).toBe('roomNotFound');
  });

  it('validates slot picks against LOBBY_SLOTS and occupancy', () => {
    const { manager } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');
    guest.send({ type: 'joinRoom', roomId });

    host.send({ type: 'pickSlot', slot: 0 }); // AI empire slot
    expect(host.socket.lastOfType('error').code).toBe('invalidSlot');
    host.send({ type: 'pickSlot', slot: 12 });
    expect(host.socket.lastOfType('error').code).toBe('invalidSlot');
    host.send({ type: 'pickSlot', slot: 2 });
    guest.send({ type: 'pickSlot', slot: 2 });
    expect(guest.socket.lastOfType('error').code).toBe('slotTaken');
    guest.send({ type: 'pickSlot', slot: 7 });
    const players = guest.socket.lastOfType('roomState').players;
    expect(players.map((p) => p.slot)).toEqual([2, 7]);
  });

  it('gates startMatch on host + seated readiness', () => {
    const { manager, factory } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');
    guest.send({ type: 'joinRoom', roomId });

    guest.send({ type: 'startMatch' });
    expect(guest.socket.lastOfType('error').code).toBe('notHost');
    host.send({ type: 'startMatch' });
    expect(host.socket.lastOfType('error').code).toBe('playersNotReady'); // nobody seated
    host.send({ type: 'pickSlot', slot: 2 });
    guest.send({ type: 'pickSlot', slot: 7 });
    host.send({ type: 'setReady', ready: true });
    host.send({ type: 'startMatch' });
    expect(host.socket.lastOfType('error').code).toBe('playersNotReady'); // guest not ready
    expect(factory.created).toHaveLength(0);
  });

  it('refuses to start a one-team (opponent-less) match — anti Elo/W-L farm', () => {
    const { manager, factory } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Farm' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');
    guest.send({ type: 'joinRoom', roomId });

    // Both seat on SOUTH (slots 2 and 3) — no north opponent.
    host.send({ type: 'pickSlot', slot: 2 });
    guest.send({ type: 'pickSlot', slot: 3 });
    host.send({ type: 'setReady', ready: true });
    guest.send({ type: 'setReady', ready: true });
    host.send({ type: 'startMatch' });

    expect(host.socket.lastOfType('error').code).toBe('playersNotReady');
    expect(factory.created).toHaveLength(0); // no runtime, no ranked match

    // Move the guest to a north slot — now both teams are covered and it starts.
    guest.send({ type: 'pickSlot', slot: 7 });
    guest.send({ type: 'setReady', ready: true });
    host.send({ type: 'startMatch' });
    vi.advanceTimersByTime(MATCH_COUNTDOWN_SECONDS * 1000);
    expect(factory.created).toHaveLength(1);
  });

  it('counts down and creates the runtime with sorted seats and the drawn seed', () => {
    const { manager, factory } = makeManager();
    const { host, guest } = setupMatch(manager);

    const countdown = host.socket.ofType('matchStarting').map((m) => m.countdownSeconds);
    expect(countdown).toEqual([MATCH_COUNTDOWN_SECONDS, 2, 1, 0]);
    expect(guest.socket.ofType('matchStarting').map((m) => m.countdownSeconds)).toEqual(countdown);

    expect(factory.created).toHaveLength(1);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');
    expect(entry.deps.seed).toBe(TEST_SEED);
    expect(entry.deps.ruleset).toBe(FAKE_RULESET);
    expect(entry.deps.seats).toEqual([
      { slot: 2, name: 'Host' },
      { slot: 7, name: 'Guest' },
    ]);
    expect(entry.runtime.start).toHaveBeenCalledTimes(1);
    expect(host.socket.lastOfType('roomState').phase).toBe('playing');
  });

  it('draws a crypto uint32 seed by default', () => {
    const factory = runtimeFactory();
    const manager = createRoomManager(FAKE_RULESET, { createRuntime: (d) => factory.create(d) });
    setupMatch(manager);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');
    expect(Number.isInteger(entry.deps.seed)).toBe(true);
    expect(entry.deps.seed).toBeGreaterThanOrEqual(0);
    expect(entry.deps.seed).toBeLessThanOrEqual(0xffffffff);
  });

  it('routes commands only for the connection\'s own slot', () => {
    const { manager, factory } = makeManager();
    const { host, guest } = setupMatch(manager);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');

    guest.send({ type: 'command', command: { type: 'stop', player: 7 } });
    expect(entry.runtime.enqueueCommand).toHaveBeenCalledWith(7, { type: 'stop', player: 7 });

    host.send({ type: 'command', command: { type: 'move', player: 7, x: 1, y: 2 } });
    expect(host.socket.lastOfType('error').code).toBe('invalidCommand');
    expect(entry.runtime.enqueueCommand).toHaveBeenCalledTimes(1);
  });

  it('rejects commands outside a live match', () => {
    const { manager } = makeManager();
    const client = connect(manager);
    hello(client, TOKEN_A, 'Bob');
    client.send({ type: 'command', command: { type: 'stop', player: 2 } });
    expect(client.socket.lastOfType('error').code).toBe('notInMatch');
  });

  it('relays chat respecting scope', () => {
    const { manager } = makeManager();
    const { host, guest } = setupMatch(manager);

    host.send({ type: 'chat', scope: 'all', text: 'hello everyone' });
    expect(guest.socket.lastOfType('chat').text).toBe('hello everyone');
    expect(host.socket.lastOfType('chat').from.publicId).not.toBe(TOKEN_A);

    const guestChatsBefore = guest.socket.ofType('chat').length;
    host.send({ type: 'chat', scope: 'team', text: 'south secrets' }); // host slot 2 = south, guest slot 7 = north
    expect(host.socket.lastOfType('chat').text).toBe('south secrets');
    expect(guest.socket.ofType('chat')).toHaveLength(guestChatsBefore);
  });

  it('promotes the oldest member when the host leaves, deletes empty rooms', () => {
    const { manager } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');
    guest.send({ type: 'joinRoom', roomId });

    host.send({ type: 'leaveRoom' });
    const state = guest.socket.lastOfType('roomState');
    expect(state.players).toHaveLength(1);
    expect(state.players[0]?.isHost).toBe(true);

    guest.send({ type: 'leaveRoom' });
    expect(manager.roomCount()).toBe(0);
  });

  it('marks lobby members disconnected on drop and deletes fully-abandoned lobbies', () => {
    const { manager } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');
    guest.send({ type: 'joinRoom', roomId });

    guest.conn.onClose();
    const state = host.socket.lastOfType('roomState');
    expect(state.players.find((p) => p.name === 'Guest')?.connected).toBe(false);

    host.conn.onClose();
    expect(manager.roomCount()).toBe(0);
    // membership was cleaned up: a fresh hello does not resume
    const back = connect(manager);
    hello(back, TOKEN_B, 'Guest');
    expect(back.socket.lastOfType('welcome').resumed).toBeNull();
  });

  it('supersedes the old socket when the same token says hello again', () => {
    const { manager } = makeManager();
    const first = connect(manager);
    hello(first, TOKEN_A, 'Host');
    first.send({ type: 'createRoom', roomName: 'Room' });

    const second = connect(manager);
    hello(second, TOKEN_A, 'Host');
    expect(first.socket.closed?.code).toBe(4000);
    const welcome = second.socket.lastOfType('welcome');
    expect(welcome.resumed?.phase).toBe('lobby');
    // the seat stayed connected throughout — no disconnected flap broadcast
    expect(second.socket.lastOfType('roomState').players[0]?.connected).toBe(true);
    expect(manager.roomCount()).toBe(1);
  });

  it('handles disconnect + resume during a match via the runtime', () => {
    const { manager, factory } = makeManager();
    const { guest, roomId } = setupMatch(manager);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');

    guest.conn.onClose();
    expect(entry.runtime.setConnected).toHaveBeenCalledWith(7, false);

    const back = connect(manager);
    hello(back, TOKEN_B, 'Guest');
    const welcome = back.socket.lastOfType('welcome');
    expect(welcome.resumed).toEqual({ roomId, phase: 'playing' });
    expect(entry.runtime.setConnected).toHaveBeenLastCalledWith(7, true);
  });

  it('keeps the seat on mid-match leaveRoom and allows rejoining the same room', () => {
    const { manager, factory } = makeManager();
    const { host, guest, roomId } = setupMatch(manager);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');

    guest.send({ type: 'leaveRoom' });
    expect(entry.runtime.setConnected).toHaveBeenCalledWith(7, false);
    const state = host.socket.lastOfType('roomState');
    expect(state.players).toHaveLength(2); // no mid-match unseating
    expect(state.players.find((p) => p.name === 'Guest')?.connected).toBe(false);

    guest.send({ type: 'createRoom', roomName: 'Elsewhere' });
    expect(guest.socket.lastOfType('error').code).toBe('alreadyInRoom');

    guest.send({ type: 'joinRoom', roomId });
    expect(entry.runtime.setConnected).toHaveBeenLastCalledWith(7, true);
  });

  it('sendToSlot delivers to the seat\'s live socket and no-ops while disconnected', () => {
    const { manager, factory } = makeManager();
    const { guest } = setupMatch(manager);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');

    entry.deps.sendToSlot(7, { type: 'ping', t: 42 });
    expect(guest.socket.ofType('ping').some((p) => p.t === 42)).toBe(true);

    guest.conn.onClose();
    expect(() => entry.deps.sendToSlot(7, { type: 'ping', t: 43 })).not.toThrow();
    expect(guest.socket.ofType('ping').some((p) => p.t === 43)).toBe(false);
    expect(() => entry.deps.sendToSlot(11, { type: 'ping', t: 44 })).not.toThrow(); // unseated slot
  });

  it('returns the room to a reusable lobby when the match ends', () => {
    const { manager, factory } = makeManager();
    const { host, guest } = setupMatch(manager);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');

    entry.deps.onEnded({ winnerTeam: 'south', stats: [], seed: TEST_SEED, rulesetId: 'classic', durationTicks: 100, goldEarned: new Map() });
    expect(entry.runtime.stop).toHaveBeenCalled();
    const state = host.socket.lastOfType('roomState');
    expect(state.phase).toBe('lobby');
    expect(state.players.every((p) => !p.ready)).toBe(true);
    expect(guest.socket.lastOfType('roomState').phase).toBe('lobby');
  });

  it('deletes abandoned playing rooms after the grace period', () => {
    const { manager, factory } = makeManager();
    const { host, guest } = setupMatch(manager);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');

    host.conn.onClose();
    guest.conn.onClose();
    expect(manager.roomCount()).toBe(1);
    vi.advanceTimersByTime(ABANDONED_ROOM_GRACE_MS + 1);
    expect(manager.roomCount()).toBe(0);
    expect(entry.runtime.stop).toHaveBeenCalled();
  });

  it('sends heartbeat pings and drops silent connections', () => {
    const { manager } = makeManager();
    const client = connect(manager);
    hello(client, TOKEN_A, 'Bob');
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(client.socket.ofType('ping').length).toBeGreaterThanOrEqual(1);
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS);
    expect(client.socket.closed?.code).toBe(4001);
  });

  it('keeps responsive connections alive past the heartbeat timeout', () => {
    const { manager } = makeManager();
    const client = connect(manager);
    hello(client, TOKEN_A, 'Bob');
    for (let i = 0; i < 8; i += 1) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      client.send({ type: 'pong', t: 1 });
    }
    expect(client.socket.closed).toBeNull();
  });

  it('rate limits the general message budget and closes repeat offenders', () => {
    const { manager } = makeManager();
    const client = connect(manager);
    hello(client, TOKEN_A, 'Bob');
    for (let i = 0; i < RATE_BUCKET_CAPACITY + 10; i += 1) {
      client.send({ type: 'listRooms' });
    }
    const rateErrors = client.socket.ofType('error').filter((e) => e.code === 'rateLimited');
    expect(rateErrors.length).toBeGreaterThanOrEqual(1);
    expect(client.socket.closed?.code).toBe(1008);
  });

  it('caps command messages at their own bucket', () => {
    const { manager, factory } = makeManager();
    const { guest } = setupMatch(manager);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');

    vi.advanceTimersByTime(2000); // refill the general bucket after lobby traffic
    for (let i = 0; i < COMMAND_BUCKET_CAPACITY + 5; i += 1) {
      guest.send({ type: 'command', command: { type: 'stop', player: 7 } });
    }
    expect(entry.runtime.enqueueCommand).toHaveBeenCalledTimes(COMMAND_BUCKET_CAPACITY);
    const rateErrors = guest.socket.ofType('error').filter((e) => e.code === 'rateLimited');
    expect(rateErrors.length).toBeGreaterThanOrEqual(1);
  });

  it('enforces room capacity', () => {
    const { manager } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM - 1; i += 1) {
      const filler = connect(manager);
      hello(filler, `${i}`.padStart(32, '0'), `Filler ${i}`);
      filler.send({ type: 'joinRoom', roomId });
      expect(filler.socket.lastOfType('roomState').players).toHaveLength(i + 2);
    }
    const late = connect(manager);
    hello(late, 'e'.repeat(32), 'Latecomer');
    late.send({ type: 'joinRoom', roomId });
    expect(late.socket.lastOfType('error').code).toBe('roomFull');
  });

  // -------------------------------------------------------------------------
  // AI seats (addAi / removeAi)
  // -------------------------------------------------------------------------

  it('lets the host add and remove an AI in an open slot, shown in roomState', () => {
    const { manager } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });

    host.send({ type: 'addAi', slot: 7, difficulty: 'normal' });
    const withAi = host.socket.lastOfType('roomState');
    const ai = withAi.players.find((p) => p.slot === 7);
    expect(ai).toMatchObject({
      slot: 7,
      ai: 'normal',
      ready: true,
      connected: true,
      isHost: false,
      name: 'AI (normal)',
    });
    // Human host still reports ai: null.
    expect(withAi.players.find((p) => p.name === 'Host')?.ai).toBeNull();

    host.send({ type: 'removeAi', slot: 7 });
    expect(host.socket.lastOfType('roomState').players.some((p) => p.slot === 7)).toBe(false);
  });

  it('rejects addAi from non-host and outside the lobby phase', () => {
    const { manager } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');
    guest.send({ type: 'joinRoom', roomId });

    guest.send({ type: 'addAi', slot: 7, difficulty: 'normal' });
    expect(guest.socket.lastOfType('error').code).toBe('notHost');

    // Once playing, AI seats are locked.
    host.send({ type: 'pickSlot', slot: 2 });
    host.send({ type: 'addAi', slot: 7, difficulty: 'normal' });
    host.send({ type: 'setReady', ready: true });
    host.send({ type: 'startMatch' });
    vi.advanceTimersByTime(MATCH_COUNTDOWN_SECONDS * 1000);
    host.send({ type: 'addAi', slot: 8, difficulty: 'easy' });
    expect(host.socket.lastOfType('error').code).toBe('matchInProgress');
  });

  it('rejects addAi on non-pickable or already-taken slots, removeAi on non-AI slots', () => {
    const { manager } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');
    guest.send({ type: 'joinRoom', roomId });

    host.send({ type: 'addAi', slot: 0, difficulty: 'easy' }); // AI empire slot
    expect(host.socket.lastOfType('error').code).toBe('invalidSlot');
    host.send({ type: 'addAi', slot: 12, difficulty: 'easy' }); // out of range
    expect(host.socket.lastOfType('error').code).toBe('invalidSlot');

    guest.send({ type: 'pickSlot', slot: 7 }); // human takes slot 7
    host.send({ type: 'addAi', slot: 7, difficulty: 'easy' });
    expect(host.socket.lastOfType('error').code).toBe('slotTaken');

    host.send({ type: 'addAi', slot: 8, difficulty: 'easy' });
    host.send({ type: 'addAi', slot: 8, difficulty: 'hard' }); // already AI
    expect(host.socket.lastOfType('error').code).toBe('slotTaken');

    host.send({ type: 'removeAi', slot: 9 }); // empty slot
    expect(host.socket.lastOfType('error').code).toBe('invalidSlot');
  });

  it('blocks a human from picking an AI-held slot', () => {
    const { manager } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });
    const roomId = host.socket.lastOfType('roomState').roomId;
    const guest = connect(manager);
    hello(guest, TOKEN_B, 'Guest');
    guest.send({ type: 'joinRoom', roomId });

    host.send({ type: 'addAi', slot: 7, difficulty: 'normal' });
    guest.send({ type: 'pickSlot', slot: 7 });
    expect(guest.socket.lastOfType('error').code).toBe('slotTaken');
  });

  it('counts an AI seat for the both-teams start gate: a single human vs AI starts', () => {
    const { manager, factory } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Solo vs AI' });

    host.send({ type: 'pickSlot', slot: 2 }); // human south
    host.send({ type: 'setReady', ready: true });
    host.send({ type: 'startMatch' });
    // No north player yet -> rejected.
    expect(host.socket.lastOfType('error').code).toBe('playersNotReady');
    expect(factory.created).toHaveLength(0);

    host.send({ type: 'addAi', slot: 7, difficulty: 'hard' }); // AI north
    host.send({ type: 'startMatch' });
    vi.advanceTimersByTime(MATCH_COUNTDOWN_SECONDS * 1000);

    expect(factory.created).toHaveLength(1);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');
    // Human seat passed as a seat; AI seat passed via aiSeats (excluded from seats).
    expect(entry.deps.seats).toEqual([{ slot: 2, name: 'Host' }]);
    // The sole north AI is auto-designated its team's trader (one per team).
    expect(entry.deps.aiSeats).toEqual([{ slot: 7, ai: { difficulty: 'hard', role: 'trader' } }]);
  });

  it('passes AI seats sorted ascending and excludes them from human seats/stats', () => {
    const { manager, factory } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });

    host.send({ type: 'pickSlot', slot: 2 });
    host.send({ type: 'setReady', ready: true });
    // Add AI out of slot order; expect them sorted in aiSeats.
    host.send({ type: 'addAi', slot: 8, difficulty: 'easy' });
    host.send({ type: 'addAi', slot: 7, difficulty: 'normal' });
    host.send({ type: 'startMatch' });
    vi.advanceTimersByTime(MATCH_COUNTDOWN_SECONDS * 1000);

    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');
    expect(entry.deps.seats).toEqual([{ slot: 2, name: 'Host' }]);
    // Both AIs are north; the lowest-slot one (7) is its team's trader, the
    // rest are captains (one trader per team, deterministic by slot).
    expect(entry.deps.aiSeats).toEqual([
      { slot: 7, ai: { difficulty: 'normal', role: 'trader' } },
      { slot: 8, ai: { difficulty: 'easy', role: 'captain' } },
    ]);
  });

  it('clears AI seats when a match ends and the room returns to lobby', () => {
    const { manager, factory } = makeManager();
    const host = connect(manager);
    hello(host, TOKEN_A, 'Host');
    host.send({ type: 'createRoom', roomName: 'Room' });

    host.send({ type: 'pickSlot', slot: 2 });
    host.send({ type: 'setReady', ready: true });
    host.send({ type: 'addAi', slot: 7, difficulty: 'normal' });
    host.send({ type: 'startMatch' });
    vi.advanceTimersByTime(MATCH_COUNTDOWN_SECONDS * 1000);
    const entry = factory.created[0];
    if (entry === undefined) throw new Error('runtime not created');

    entry.deps.onEnded({
      winnerTeam: 'south',
      stats: [],
      seed: TEST_SEED,
      rulesetId: 'classic',
      durationTicks: 50,
      goldEarned: new Map(),
    });
    const lobby = host.socket.lastOfType('roomState');
    expect(lobby.phase).toBe('lobby');
    expect(lobby.players.some((p) => p.ai !== null)).toBe(false); // AI seats cleared
  });
});
