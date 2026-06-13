/**
 * Headless end-to-end test: the REAL server (startServer, ephemeral port)
 * driven by two REAL `ws` clients speaking the full protocol.
 *
 * Phase A — realtime server (default tick pacing, 1 s countdown):
 *   hello/welcome, room create/list/join, slot picking (incl. slotTaken),
 *   ready, host-only start, countdown, tick-0 keyframe, ~20 Hz snapshot
 *   cadence with monotonic ticks, wrong-slot command rejection, and the
 *   privacy sweep (own gold visible, enemy private state and enemy ships
 *   absent, no token leak, delta chain gap-free).
 *
 * Phase B — burst server (tickIntervalMs: 0, countdownSeconds: 0): a real
 *   Classic match fast-forwarded — sail to the spawn-side shop, buy I001,
 *   sail both ships to an east-side rendezvous, enemy ship enters the
 *   snapshot only when adjacent, auto-fire hits, then a clean reconnect
 *   (same token -> welcome.resumed -> fresh keyframe -> resumed delta chain).
 *
 * Burst mode runs the sim as fast as the event loop allows, so the whole
 * suite stays well under a minute. Pacing options never feed the sim — see
 * src/server.ts.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@bships/core';
import type {
  ClientMessage,
  Command,
  ErrorMessage,
  PublicPlayerStat,
  RoomStateMessage,
  ServerMessage,
  SimEvent,
  SnapshotEntity,
  SnapshotMessage,
  SnapshotYou,
  WelcomeMessage,
} from '@bships/core';
import { getClassicRuleset } from '../src/data.js';
import { startServer } from '../src/server.js';
import type { RunningServer } from '../src/server.js';

const ruleset = getClassicRuleset();

const SOUTH_SLOT = 2;
const NORTH_SLOT = 7;

const start2 = ruleset.map.playerStarts[SOUTH_SLOT];
if (!start2) throw new Error('south playerStart missing');

/** The spawn-side item shop (sells I001 "Basic Cannon" for 200 gold). */
const SHOP_TYPE_ID = 'n001';
const shopPlacement = [...ruleset.map.structures]
  .filter((s) => s.typeId === SHOP_TYPE_ID)
  .sort(
    (a, b) =>
      Math.hypot(a.x - start2.x, a.y - start2.y) - Math.hypot(b.x - start2.x, b.y - start2.y),
  )[0];
if (!shopPlacement) throw new Error(`no ${SHOP_TYPE_ID} shop on the map`);

/** Sail to ~280 units short of the shop center (interactRadius is 450). */
const SHOP_APPROACH = (() => {
  const dx = start2.x - shopPlacement.x;
  const dy = start2.y - shopPlacement.y;
  const d = Math.hypot(dx, dy);
  return { x: shopPlacement.x + (dx / d) * 280, y: shopPlacement.y + (dy / d) * 280 };
})();

/**
 * East-edge rendezvous, far from every tower (range 1000, all at x <= 832)
 * and from the creep lanes (x in [-2320, 272]). The two points sit 500
 * apart: inside I001 range (700) and ship sight (1100).
 */
const RENDEZVOUS_SOUTH = { x: 4736, y: -500 };
const RENDEZVOUS_NORTH = { x: 4736, y: 0 };

function randomToken(): string {
  return randomBytes(16).toString('hex');
}

interface WaitOptions {
  timeoutMs?: number;
  /** Scan messages starting at this index (default 0 = include history). */
  from?: number;
}

/**
 * One protocol-speaking test client: collects every ServerMessage, answers
 * pings, and maintains the same keyframe+delta world view a real client
 * would (entities map, latest `you`, monotonic tick, gap counter).
 */
class E2EClient {
  readonly token: string;
  readonly name: string;
  readonly messages: ServerMessage[] = [];
  readonly events: SimEvent[] = [];
  readonly entities = new Map<number, SnapshotEntity>();
  /** ownerSlot -> first tick a SHIP owned by that slot entered the view. */
  readonly firstShipSeenTick = new Map<number, number>();
  you: SnapshotYou | null = null;
  players: PublicPlayerStat[] = [];
  lastTick = -1;
  droppedDeltas = 0;
  welcome: WelcomeMessage | null = null;

  private ws: WebSocket;
  private readonly listeners = new Set<() => void>();

  private constructor(port: number, name: string, token: string) {
    this.token = token;
    this.name = name;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (data) => this.onRaw(String(data)));
  }

  static async connect(port: number, name: string, token = randomToken()): Promise<E2EClient> {
    const client = new E2EClient(port, name, token);
    await new Promise<void>((resolve, reject) => {
      client.ws.once('open', () => resolve());
      client.ws.once('error', (err) => reject(err));
    });
    client.send({ type: 'hello', version: PROTOCOL_VERSION, token, name });
    client.welcome = await client.waitFor(
      (m): m is WelcomeMessage => m.type === 'welcome',
      { timeoutMs: 5000 },
    );
    return client;
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendCommand(command: Command): void {
    this.send({ type: 'command', command });
  }

  /** Abrupt drop (reconnect tests); the server sees a socket close. */
  close(): void {
    this.ws.terminate();
  }

  cursor(): number {
    return this.messages.length;
  }

  /** Resolve with the first message (>= from) matching the type guard. */
  waitFor<T extends ServerMessage>(
    pred: (m: ServerMessage) => m is T,
    opts: WaitOptions = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    let idx = opts.from ?? 0;
    return new Promise<T>((resolve, reject) => {
      const scan = (): boolean => {
        while (idx < this.messages.length) {
          const m = this.messages[idx];
          idx += 1;
          if (m !== undefined && pred(m)) {
            cleanup();
            resolve(m);
            return true;
          }
        }
        return false;
      };
      const onMsg = (): void => {
        scan();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitFor timed out after ${timeoutMs} ms (lastTick=${this.lastTick})`));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners.delete(onMsg);
      };
      if (!scan()) this.listeners.add(onMsg);
    });
  }

  /** Resolve once `pred()` is true (checked per message + every 50 ms). */
  waitUntil(pred: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (!pred()) return;
        cleanup();
        resolve();
      };
      const interval = setInterval(check, 50);
      const timer = setTimeout(() => {
        cleanup();
        const rejections = this.events
          .filter((e) => e.type === 'commandRejected')
          .map((e) => (e.type === 'commandRejected' ? `${e.commandType}:${e.reason}` : ''))
          .join(', ');
        reject(
          new Error(
            `timed out waiting for ${label} (lastTick=${this.lastTick}, ` +
              `rejections=[${rejections}])`,
          ),
        );
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        clearInterval(interval);
        this.listeners.delete(check);
      };
      this.listeners.add(check);
      check();
    });
  }

  shipOf(slot: number): SnapshotEntity | undefined {
    for (const e of this.entities.values()) {
      if (e.kind === 'ship' && e.ownerSlot === slot) return e;
    }
    return undefined;
  }

  private onRaw(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === 'ping') this.send({ type: 'pong', t: msg.t });
    this.messages.push(msg);
    this.applyView(msg);
    for (const fn of [...this.listeners]) fn();
  }

  private noteEntity(e: SnapshotEntity, tick: number): void {
    this.entities.set(e.id, e);
    if (e.kind === 'ship' && e.ownerSlot !== null && !this.firstShipSeenTick.has(e.ownerSlot)) {
      this.firstShipSeenTick.set(e.ownerSlot, tick);
    }
  }

  private applyView(msg: ServerMessage): void {
    if (msg.type === 'snapshot') {
      this.entities.clear();
      for (const e of msg.entities) this.noteEntity(e, msg.tick);
      this.you = msg.you;
      this.players = msg.players;
      this.lastTick = msg.tick;
      this.events.push(...msg.events);
      return;
    }
    if (msg.type === 'snapshotDelta') {
      if (msg.baseTick !== this.lastTick) {
        this.droppedDeltas += 1;
        return;
      }
      for (const e of msg.upserts) this.noteEntity(e, msg.tick);
      for (const id of msg.removed) this.entities.delete(id);
      if (msg.you !== undefined) this.you = msg.you;
      if (msg.players !== undefined) this.players = msg.players;
      this.lastTick = msg.tick;
      this.events.push(...msg.events);
    }
  }
}

function isRoomState(m: ServerMessage): m is RoomStateMessage {
  return m.type === 'roomState';
}

function isErrorMsg(m: ServerMessage): m is ErrorMessage {
  return m.type === 'error';
}

function isKeyframe(m: ServerMessage): m is SnapshotMessage {
  return m.type === 'snapshot';
}

function countInInventory(you: SnapshotYou | null, itemId: string): number {
  if (you === null) return 0;
  return you.inventory.filter((item) => item !== null && item.itemId === itemId).length;
}

/**
 * The privacy sweep — checks EVERY message the client ever received:
 * the only PlayerState on the wire is the client's own (`you.slot`), public
 * scoreboard rows carry no resources, and the other client's secret token
 * never appears anywhere.
 */
function sweepPrivacy(client: E2EClient, mySlot: number, otherToken: string): void {
  for (const m of client.messages) {
    if (m.type === 'snapshot') {
      expect(m.you.slot).toBe(mySlot);
      for (const p of m.players) expect('gold' in p).toBe(false);
    } else if (m.type === 'snapshotDelta') {
      if (m.you !== undefined) expect(m.you.slot).toBe(mySlot);
      if (m.players !== undefined) for (const p of m.players) expect('gold' in p).toBe(false);
    }
  }
  expect(JSON.stringify(client.messages)).not.toContain(otherToken);
}

/** Drive both clients through lobby -> picked slots -> ready -> started. */
async function startTwoPlayerMatch(
  south: E2EClient,
  north: E2EClient,
): Promise<{ roomId: string }> {
  south.send({ type: 'createRoom', roomName: 'e2e room' });
  const created = await south.waitFor(isRoomState);
  const roomId = created.roomId;

  north.send({ type: 'joinRoom', roomId });
  await north.waitFor(isRoomState);

  south.send({ type: 'pickSlot', slot: SOUTH_SLOT });
  north.send({ type: 'pickSlot', slot: NORTH_SLOT });
  await south.waitFor(
    (m): m is RoomStateMessage =>
      isRoomState(m) &&
      m.players.some((p) => p.slot === SOUTH_SLOT) &&
      m.players.some((p) => p.slot === NORTH_SLOT),
  );

  south.send({ type: 'setReady', ready: true });
  north.send({ type: 'setReady', ready: true });
  await south.waitFor(
    (m): m is RoomStateMessage => isRoomState(m) && m.players.every((p) => p.ready),
  );

  south.send({ type: 'startMatch' });
  return { roomId };
}

// ---------------------------------------------------------------------------
// Phase A — realtime pacing
// ---------------------------------------------------------------------------

describe('e2e phase A: realtime protocol flow, cadence, privacy', () => {
  let server: RunningServer;
  let south: E2EClient;
  let north: E2EClient;
  let roomId = '';

  beforeAll(async () => {
    server = await startServer({ port: 0, quiet: true, countdownSeconds: 1 });
    south = await E2EClient.connect(server.port, 'Alice');
    north = await E2EClient.connect(server.port, 'Bob');
  }, 15_000);

  afterAll(async () => {
    south.close();
    north.close();
    await server.close();
  });

  it('answers hello with welcome (publicId never the token, resumed null)', () => {
    for (const c of [south, north]) {
      const w = c.welcome;
      expect(w).not.toBeNull();
      expect(w?.version).toBe(PROTOCOL_VERSION);
      expect(w?.resumed).toBeNull();
      expect(w?.publicId).toBeTruthy();
      expect(w?.publicId).not.toBe(c.token);
    }
    expect(south.welcome?.name).toBe('Alice');
  });

  it('create/list/join room', async () => {
    south.send({ type: 'createRoom', roomName: 'e2e room' });
    const created = await south.waitFor(isRoomState);
    roomId = created.roomId;
    expect(created.phase).toBe('lobby');
    expect(created.players).toHaveLength(1);
    expect(created.players[0]?.isHost).toBe(true);

    north.send({ type: 'listRooms' });
    const list = await north.waitFor((m): m is Extract<ServerMessage, { type: 'roomList' }> =>
      m.type === 'roomList',
    );
    expect(list.rooms.some((r) => r.roomId === roomId)).toBe(true);

    north.send({ type: 'joinRoom', roomId });
    const joined = await north.waitFor(
      (m): m is RoomStateMessage => isRoomState(m) && m.players.length === 2,
    );
    expect(joined.roomId).toBe(roomId);
  });

  it('slot picking: taken slots rejected, distinct slots settle', async () => {
    south.send({ type: 'pickSlot', slot: SOUTH_SLOT });
    await south.waitFor(
      (m): m is RoomStateMessage =>
        isRoomState(m) && m.players.some((p) => p.slot === SOUTH_SLOT),
    );

    const cursor = north.cursor();
    north.send({ type: 'pickSlot', slot: SOUTH_SLOT });
    const taken = await north.waitFor(isErrorMsg, { from: cursor });
    expect(taken.code).toBe('slotTaken');

    north.send({ type: 'pickSlot', slot: NORTH_SLOT });
    const state = await north.waitFor(
      (m): m is RoomStateMessage =>
        isRoomState(m) && m.players.some((p) => p.slot === NORTH_SLOT),
    );
    const slots = state.players.map((p) => p.slot).sort();
    expect(slots).toEqual([SOUTH_SLOT, NORTH_SLOT]);
  });

  it('only the host starts; countdown counts down to 0; tick-0 keyframe', async () => {
    south.send({ type: 'setReady', ready: true });
    north.send({ type: 'setReady', ready: true });
    await south.waitFor(
      (m): m is RoomStateMessage => isRoomState(m) && m.players.every((p) => p.ready),
    );

    const cursor = north.cursor();
    north.send({ type: 'startMatch' });
    const notHost = await north.waitFor(isErrorMsg, { from: cursor });
    expect(notHost.code).toBe('notHost');

    south.send({ type: 'startMatch' });
    const starting = await south.waitFor(
      (m): m is Extract<ServerMessage, { type: 'matchStarting' }> => m.type === 'matchStarting',
    );
    expect(starting.countdownSeconds).toBe(1);
    await south.waitFor(
      (m): m is Extract<ServerMessage, { type: 'matchStarting' }> =>
        m.type === 'matchStarting' && m.countdownSeconds === 0,
      { timeoutMs: 5000 },
    );

    for (const [client, slot] of [
      [south, SOUTH_SLOT],
      [north, NORTH_SLOT],
    ] as const) {
      const keyframe = await client.waitFor(isKeyframe, { timeoutMs: 5000 });
      expect(keyframe.tick).toBe(0);
      expect(keyframe.you.slot).toBe(slot);
      expect(keyframe.you.gold).toBe(ruleset.constants.startingGold);
      expect(keyframe.entities.filter((e) => e.kind === 'structure')).toHaveLength(
        ruleset.map.structures.length,
      );
      expect(keyframe.entities.some((e) => e.kind === 'ship' && e.ownerSlot === slot)).toBe(true);
    }
  }, 15_000);

  it('snapshots arrive at ~20 Hz with strictly consecutive ticks', async () => {
    const cursor = south.cursor();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const window = south.messages
      .slice(cursor)
      .filter((m) => m.type === 'snapshot' || m.type === 'snapshotDelta');

    expect(window.length).toBeGreaterThanOrEqual(38);
    expect(window.length).toBeLessThanOrEqual(62);
    for (let i = 1; i < window.length; i++) {
      const prev = window[i - 1];
      const cur = window[i];
      if (prev === undefined || cur === undefined) throw new Error('unreachable');
      if (prev.type !== 'snapshot' && prev.type !== 'snapshotDelta') continue;
      if (cur.type !== 'snapshot' && cur.type !== 'snapshotDelta') continue;
      expect(cur.tick).toBe(prev.tick + 1);
      if (cur.type === 'snapshotDelta') expect(cur.baseTick).toBe(cur.tick - 1);
      if (cur.tick % 20 === 0) expect(cur.type).toBe('snapshot');
    }
  }, 10_000);

  it('rejects commands for a slot the connection does not own', async () => {
    const cursor = south.cursor();
    south.sendCommand({ type: 'stop', player: NORTH_SLOT });
    const err = await south.waitFor(isErrorMsg, { from: cursor });
    expect(err.code).toBe('invalidCommand');
  });

  it('privacy sweep: own you only, no enemy resources/ships/tokens, no delta gaps', () => {
    sweepPrivacy(south, SOUTH_SLOT, north.token);
    sweepPrivacy(north, NORTH_SLOT, south.token);
    // The fleets never approached each other: the enemy ship must never have
    // appeared in either view.
    expect(south.firstShipSeenTick.has(NORTH_SLOT)).toBe(false);
    expect(north.firstShipSeenTick.has(SOUTH_SLOT)).toBe(false);
    // Own gold was visible the whole time.
    expect(south.you?.gold).toBeTypeOf('number');
    // Ordered transport + keyframe resume: zero unusable deltas.
    expect(south.droppedDeltas).toBe(0);
    expect(north.droppedDeltas).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase B — burst pacing (full match flow fast-forwarded)
// ---------------------------------------------------------------------------

describe('e2e phase B: burst-mode match — shopping, fog of war, reconnect', () => {
  let server: RunningServer;
  let south: E2EClient;
  let north: E2EClient;
  let roomId = '';

  beforeAll(async () => {
    server = await startServer({ port: 0, quiet: true, tickIntervalMs: 0, countdownSeconds: 0 });
    south = await E2EClient.connect(server.port, 'Ada');
    north = await E2EClient.connect(server.port, 'Grace');
    ({ roomId } = await startTwoPlayerMatch(south, north));
    await south.waitFor(isKeyframe, { timeoutMs: 10_000 });
    await north.waitFor(isKeyframe, { timeoutMs: 10_000 });
  }, 30_000);

  afterAll(async () => {
    south.close();
    north.close();
    await server.close();
  });

  it('sails to the spawn-side shop and buys I001 (Basic Cannon)', async () => {
    expect(countInInventory(south.you, 'I001')).toBe(1); // start item

    const shop = [...south.entities.values()].find(
      (e) =>
        e.kind === 'structure' &&
        e.typeId === SHOP_TYPE_ID &&
        Math.hypot(e.x - shopPlacement.x, e.y - shopPlacement.y) < 50,
    );
    if (!shop) throw new Error('spawn-side shop entity not in keyframe');

    south.sendCommand({ type: 'move', player: SOUTH_SLOT, x: SHOP_APPROACH.x, y: SHOP_APPROACH.y });
    await south.waitUntil(() => {
      const ship = south.shipOf(SOUTH_SLOT);
      return ship !== undefined && Math.hypot(ship.x - shop.x, ship.y - shop.y) <= 400;
    }, 'own ship within shop interact range');

    south.sendCommand({ type: 'buyItem', player: SOUTH_SLOT, shopId: shop.id, itemId: 'I001' });
    await south.waitUntil(
      () => countInInventory(south.you, 'I001') >= 2,
      'I001 purchase landing in the inventory',
    );

    const purchase = south.events.find((e) => e.type === 'purchase' && e.itemId === 'I001');
    expect(purchase).toBeDefined();
    if (purchase?.type === 'purchase') expect(purchase.gold).toBe(200);
  }, 30_000);

  it('enemy ship stays out of the snapshot until adjacent, then appears', async () => {
    // Far apart so far: the enemy ship has never been seen by either side.
    expect(south.firstShipSeenTick.has(NORTH_SLOT)).toBe(false);
    expect(north.firstShipSeenTick.has(SOUTH_SLOT)).toBe(false);

    south.sendCommand({
      type: 'move',
      player: SOUTH_SLOT,
      x: RENDEZVOUS_SOUTH.x,
      y: RENDEZVOUS_SOUTH.y,
    });
    north.sendCommand({
      type: 'move',
      player: NORTH_SLOT,
      x: RENDEZVOUS_NORTH.x,
      y: RENDEZVOUS_NORTH.y,
    });

    await south.waitUntil(
      () => south.firstShipSeenTick.has(NORTH_SLOT),
      'enemy ship entering the south view',
      45_000,
    );

    // The spawns are ~12400 units apart at ~8.5 units/tick — first contact
    // cannot plausibly happen before tick 400. Earlier means a vision leak.
    const firstSeen = south.firstShipSeenTick.get(NORTH_SLOT);
    expect(firstSeen).toBeGreaterThan(400);

    const enemy = south.shipOf(NORTH_SLOT);
    expect(enemy).toBeDefined();
    expect(enemy?.team).toBe('north');
  }, 60_000);

  it('attack-move accepted; auto-fire lands hits on the enemy ship', async () => {
    const enemy = south.shipOf(NORTH_SLOT);
    if (!enemy) throw new Error('enemy not in view');
    south.sendCommand({ type: 'attackMove', player: SOUTH_SLOT, x: enemy.x, y: enemy.y });

    await south.waitUntil(
      () =>
        south.events.some(
          (e) => e.type === 'hit' && e.attackerPlayer === SOUTH_SLOT && e.amount > 0,
        ),
      'a hit event from the south player',
      30_000,
    );
    // attackMove passed validation: no rejection events for it.
    expect(
      south.events.some((e) => e.type === 'commandRejected' && e.commandType === 'attackMove'),
    ).toBe(false);
  }, 40_000);

  it('reconnect with the same token resumes: welcome.resumed, keyframe, gap-free deltas', async () => {
    const tickAtDrop = south.lastTick;
    south.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const resumed = await E2EClient.connect(server.port, 'Ada', south.token);
    expect(resumed.welcome?.resumed).toMatchObject({ roomId, phase: 'playing' });

    const keyframe = await resumed.waitFor(isKeyframe, { timeoutMs: 10_000 });
    expect(keyframe.tick).toBeGreaterThanOrEqual(tickAtDrop);
    expect(keyframe.you.slot).toBe(SOUTH_SLOT);
    // State persisted across the drop: both I001 cannons still owned.
    expect(countInInventory(keyframe.you, 'I001')).toBe(2);

    // The delta chain continues seamlessly from the reconnect keyframe.
    await resumed.waitUntil(
      () => resumed.lastTick >= keyframe.tick + 40,
      '40 ticks applied after the reconnect keyframe',
    );
    expect(resumed.droppedDeltas).toBe(0);

    sweepPrivacy(resumed, SOUTH_SLOT, north.token);
    resumed.close();
  }, 30_000);

  it('privacy sweep over the whole burst phase', () => {
    sweepPrivacy(south, SOUTH_SLOT, north.token);
    sweepPrivacy(north, NORTH_SLOT, south.token);
  });
});
