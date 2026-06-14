/**
 * client-net tests: identity, interpolation (clock, keyframe+delta
 * resolution, sampling), store reducer, and command senders. Pure logic —
 * no DOM, no real sockets (socket.ts is mocked at the module boundary).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/net/socket.js', () => ({
  send: vi.fn(() => true),
  isOpen: vi.fn(() => true),
  reconnectNow: vi.fn(),
  connect: vi.fn(),
  defaultServerUrl: vi.fn(() => 'ws://localhost:8787'),
}));

import { TOKEN_PATTERN, wrapAngle } from '@bships/core';
import type {
  PlayerState,
  ServerChatMessage,
  SimEvent,
  SnapshotDeltaMessage,
  SnapshotEntity,
  SnapshotMessage,
  SnapshotProjectile,
} from '@bships/core';

import {
  addAi,
  dropItem,
  leaveRoom,
  removeAi,
  returnToLobby,
  sendChat,
  sendCommand,
} from '../src/net/commands.js';
import { getIdentity, sanitizeName, setName } from '../src/net/identity.js';
import {
  frameCount,
  ingestDelta,
  ingestSnapshot,
  newestFrameTick,
  resetInterpolation,
  sampleWorld,
  serverTickAt,
} from '../src/net/interpolation.js';
import { send } from '../src/net/socket.js';
import {
  applyServerMessage,
  onEvent,
  resetStoreForTest,
  store,
  teamForSlot,
} from '../src/net/store.js';

const sendMock = vi.mocked(send);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MS = 50; // ms per tick at 20 ticks/s

function makeEntity(id: number, x: number, y: number, facing = 0): SnapshotEntity {
  return {
    id,
    kind: 'ship',
    typeId: 'H000',
    x,
    y,
    facing,
    hp: 100,
    maxHp: 100,
    team: 'south',
    ownerSlot: 2,
    statuses: [],
  };
}

function makeProjectile(id: number, x: number, y: number): SnapshotProjectile {
  return { id, weaponId: 'I027', mechanic: 'phoenixFire', x, y, team: 'south' };
}

function makeYou(slot = 2): PlayerState {
  return {
    slot,
    team: teamForSlot(slot) ?? 'south',
    control: 'user',
    gold: 600,
    lumber: 0,
    xp: 0,
    level: 1,
    unspentSkillPoints: 0,
    heroSkillLevels: {},
    shipTypeId: 'H000',
    shipId: 10,
    inventory: [null, null, null, null, null, null],
    cooldownGroups: {},
    missileReadyAtTick: 0,
    respawnAtTick: null,
    goldDumpEnabled: false,
  };
}

function keyframe(
  tick: number,
  entities: SnapshotEntity[],
  projectiles: SnapshotProjectile[] = [],
  events: SimEvent[] = [],
): SnapshotMessage {
  return { type: 'snapshot', tick, you: makeYou(), entities, projectiles, events, players: [] };
}

function delta(
  tick: number,
  baseTick: number,
  upserts: SnapshotEntity[] = [],
  removed: number[] = [],
  projectiles: SnapshotProjectile[] = [],
  events: SimEvent[] = [],
): SnapshotDeltaMessage {
  return { type: 'snapshotDelta', tick, baseTick, upserts, removed, projectiles, events };
}

function chatLine(text: string): ServerChatMessage {
  return { type: 'chat', from: { publicId: 'p1', name: 'Bob', slot: 2 }, scope: 'all', text };
}

/** nowMs that puts renderTick exactly at `tick` (offset 0 clock). */
function nowFor(tickFloat: number): number {
  return (tickFloat + 120 / MS) * MS;
}

beforeEach(() => {
  resetStoreForTest();
  resetInterpolation();
  sendMock.mockClear();
});

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe('identity', () => {
  it('mints a TOKEN_PATTERN token, stable across calls', () => {
    const a = getIdentity();
    const b = getIdentity();
    expect(a.token).toMatch(TOKEN_PATTERN);
    expect(b.token).toBe(a.token);
  });

  it('sanitizes names: whitespace collapsed, trimmed, capped at 24', () => {
    expect(sanitizeName('  Salty   Dog  ')).toBe('Salty Dog');
    expect(sanitizeName('x'.repeat(40))).toHaveLength(24);
    expect(sanitizeName('   ')).toBe('');
  });

  it('setName persists for subsequent getIdentity calls', () => {
    setName('Captain Test');
    expect(getIdentity().name).toBe('Captain Test');
  });
});

// ---------------------------------------------------------------------------
// interpolation
// ---------------------------------------------------------------------------

describe('interpolation', () => {
  it('returns null before the first keyframe', () => {
    expect(sampleWorld(1000)).toBeNull();
  });

  it('estimates the server clock from arrival stamps', () => {
    // tick 100 arrives exactly at 100 * 50 ms -> offset 0.
    ingestSnapshot(keyframe(100, []), 100 * MS);
    expect(serverTickAt(100 * MS)).toBeCloseTo(100, 5);
    expect(serverTickAt(105 * MS)).toBeCloseTo(105, 5);
  });

  it('lerps entities present in both bracketing frames', () => {
    ingestSnapshot(keyframe(100, [makeEntity(1, 0, 0)]), 100 * MS);
    expect(ingestDelta(delta(101, 100, [makeEntity(1, 10, 20)]), 101 * MS)).toBe(true);
    const sample = sampleWorld(nowFor(100.5));
    expect(sample).not.toBeNull();
    expect(sample?.tickFloat).toBeCloseTo(100.5, 5);
    const e = sample?.entities.find((x) => x.id === 1);
    expect(e?.x).toBeCloseTo(5, 5);
    expect(e?.y).toBeCloseTo(10, 5);
  });

  it('interpolates facing via the shortest arc across the ±π seam', () => {
    ingestSnapshot(keyframe(100, [makeEntity(1, 0, 0, 3.0)]), 100 * MS);
    ingestDelta(delta(101, 100, [makeEntity(1, 0, 0, -3.0)]), 101 * MS);
    const e = sampleWorld(nowFor(100.5))?.entities[0];
    expect(e).toBeDefined();
    // Halfway between 3.0 and -3.0 the short way is ±π, NOT 0.
    expect(Math.abs(wrapAngle((e?.facing ?? 0) - Math.PI))).toBeLessThan(1e-6);
  });

  it('snaps newest-only entities and omits older-only entities', () => {
    ingestSnapshot(keyframe(100, [makeEntity(1, 0, 0)]), 100 * MS);
    ingestDelta(delta(101, 100, [makeEntity(2, 50, 50)], [1]), 101 * MS);
    const sample = sampleWorld(nowFor(100.5));
    expect(sample?.entities.map((e) => e.id)).toEqual([2]);
    expect(sample?.entities[0]?.x).toBe(50); // no lerp: just appeared
  });

  it('replaces and lerps projectiles by id', () => {
    ingestSnapshot(keyframe(100, [], [makeProjectile(1, 0, 0)]), 100 * MS);
    ingestDelta(
      delta(101, 100, [], [], [makeProjectile(1, 20, 0), makeProjectile(2, 100, 0)]),
      101 * MS,
    );
    const sample = sampleWorld(nowFor(100.5));
    const p1 = sample?.projectiles.find((p) => p.id === 1);
    const p2 = sample?.projectiles.find((p) => p.id === 2);
    expect(p1?.x).toBeCloseTo(10, 5);
    expect(p2?.x).toBe(100);
  });

  it('clamps the sample to the buffered range', () => {
    ingestSnapshot(keyframe(100, [makeEntity(1, 0, 0)]), 100 * MS);
    ingestDelta(delta(101, 100, [makeEntity(1, 10, 0)]), 101 * MS);
    expect(sampleWorld(0)?.tickFloat).toBe(100); // way in the past
    expect(sampleWorld(1e9)?.tickFloat).toBe(101); // way in the future
  });

  it('drops deltas after a baseTick gap until the next keyframe', () => {
    ingestSnapshot(keyframe(100, []), 100 * MS);
    expect(ingestDelta(delta(101, 100), 101 * MS)).toBe(true);
    // Gap: a delta chained off a tick we never applied.
    expect(ingestDelta(delta(106, 105), 106 * MS)).toBe(false);
    // Even a delta with a matching-looking baseTick is dropped now.
    expect(ingestDelta(delta(102, 101), 102 * MS)).toBe(false);
    // The next keyframe recovers.
    ingestSnapshot(keyframe(120, []), 120 * MS);
    expect(ingestDelta(delta(121, 120), 121 * MS)).toBe(true);
  });

  it('caps the ring buffer at 64 frames', () => {
    ingestSnapshot(keyframe(0, []), 0);
    for (let t = 1; t <= 80; t++) ingestDelta(delta(t, t - 1), t * MS);
    expect(frameCount()).toBe(64);
    expect(newestFrameTick()).toBe(80);
  });

  it('restarts cleanly when a keyframe goes back in time (new match)', () => {
    ingestSnapshot(keyframe(1000, [makeEntity(1, 0, 0)]), 1000 * MS);
    ingestSnapshot(keyframe(0, [makeEntity(2, 5, 5)]), 1001 * MS);
    expect(frameCount()).toBe(1);
    expect(newestFrameTick()).toBe(0);
    expect(sampleWorld(1001 * MS)?.entities.map((e) => e.id)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

describe('store.applyServerMessage', () => {
  it('welcome sets publicId and the settled display name', () => {
    applyServerMessage(
      { type: 'welcome', version: 1, publicId: 'p9', name: 'Bob (2)', resumed: null },
      0,
    );
    expect(store.identity.publicId).toBe('p9');
    expect(store.identity.name).toBe('Bob (2)');
  });

  it('roomState derives my slot and team pre-match', () => {
    applyServerMessage(
      { type: 'welcome', version: 1, publicId: 'me', name: 'Bob', resumed: null },
      0,
    );
    applyServerMessage(
      {
        type: 'roomState',
        roomId: 'r1',
        name: 'Test Room',
        phase: 'lobby',
        players: [
          {
            publicId: 'me',
            name: 'Bob',
            slot: 7,
            ready: false,
            connected: true,
            isHost: true,
            ai: null,
          },
        ],
      },
      0,
    );
    expect(store.lobby.room?.roomId).toBe('r1');
    expect(store.match.mySlot).toBe(7);
    expect(store.match.myTeam).toBe('north');
  });

  it('roomState carries AI members verbatim (ai = difficulty)', () => {
    applyServerMessage(
      { type: 'welcome', version: 1, publicId: 'me', name: 'Bob', resumed: null },
      0,
    );
    applyServerMessage(
      {
        type: 'roomState',
        roomId: 'r1',
        name: 'Test Room',
        phase: 'lobby',
        players: [
          {
            publicId: 'me',
            name: 'Bob',
            slot: 2,
            ready: false,
            connected: true,
            isHost: true,
            ai: null,
          },
          {
            publicId: 'ai-7',
            name: 'AI (hard)',
            slot: 7,
            ready: true,
            connected: true,
            isHost: false,
            ai: 'hard',
          },
        ],
      },
      0,
    );
    const bot = store.lobby.room?.players.find((p) => p.slot === 7);
    expect(bot?.ai).toBe('hard');
    expect(bot?.ready).toBe(true);
    // The AI member must not be mistaken for me: my slot stays the human seat.
    expect(store.match.mySlot).toBe(2);
  });

  it('matchStarting -> starting; first snapshot -> playing with you/players', () => {
    applyServerMessage({ type: 'matchStarting', countdownSeconds: 3 }, 0);
    expect(store.match.phase).toBe('starting');
    expect(store.match.countdown).toBe(3);
    applyServerMessage(keyframe(0, [makeEntity(1, 0, 0)]), 0);
    expect(store.match.phase).toBe('playing');
    expect(store.match.mySlot).toBe(2);
    expect(store.match.myTeam).toBe('south');
    expect(store.match.you?.gold).toBe(600);
    expect(store.match.latestTick).toBe(0);
  });

  it('delta updates you/players only when present and skips broken chains', () => {
    applyServerMessage(keyframe(10, []), 10 * MS);
    const richer = { ...makeYou(), gold: 9999 };
    applyServerMessage({ ...delta(11, 10), you: richer }, 11 * MS);
    expect(store.match.you?.gold).toBe(9999);
    expect(store.match.latestTick).toBe(11);
    // Broken chain: latestTick and you must NOT advance.
    applyServerMessage({ ...delta(20, 19), you: { ...richer, gold: 1 } }, 20 * MS);
    expect(store.match.latestTick).toBe(11);
    expect(store.match.you?.gold).toBe(9999);
  });

  it('fans out events once, in order', () => {
    const seen: string[] = [];
    onEvent((e) => seen.push(e.type));
    const events: SimEvent[] = [
      { type: 'levelUp', tick: 5, player: 2, level: 2 },
      { type: 'xpGained', tick: 5, player: 2, amount: 10, reason: 'kill' },
    ];
    applyServerMessage(keyframe(5, [], [], events), 5 * MS);
    expect(seen).toEqual(['levelUp', 'xpGained']);
  });

  it('caps chat at 100 lines', () => {
    for (let i = 0; i < 105; i++) applyServerMessage(chatLine(`m${i}`), 0);
    expect(store.match.chat).toHaveLength(100);
    expect(store.match.chat[0]?.text).toBe('m5');
    expect(store.match.chat[99]?.text).toBe('m104');
  });

  it('matchEnded sets winner and final stats', () => {
    applyServerMessage(keyframe(10, []), 10 * MS);
    applyServerMessage(
      {
        type: 'matchEnded',
        winnerTeam: 'north',
        stats: [
          {
            slot: 2,
            name: 'Bob',
            team: 'south',
            shipTypeId: 'H000',
            level: 3,
            kills: 1,
            deaths: 2,
            connected: true,
          },
        ],
      },
      0,
    );
    expect(store.match.phase).toBe('ended');
    expect(store.match.winnerTeam).toBe('north');
    expect(store.match.players).toHaveLength(1);
  });

  it('server errors land in chat as system lines', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    applyServerMessage({ type: 'error', code: 'slotTaken', msg: 'Slot taken' }, 0);
    expect(store.match.chat[0]?.scope).toBe('system');
    expect(store.match.chat[0]?.text).toContain('Slot taken');
    warn.mockRestore();
  });

  it('subscribe fires on every applied message', () => {
    const fn = vi.fn();
    store.subscribe(fn);
    applyServerMessage({ type: 'roomList', rooms: [] }, 0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('drops malformed snapshot/delta/roomState frames without throwing (trust boundary)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Each of these would previously throw an uncaught TypeError (null deref /
    // not-iterable) when applied — reachable from a hostile server via a
    // crafted ?server= link. They must now be dropped silently.
    const hostile: unknown[] = [
      { type: 'snapshot', tick: 1, you: null, entities: [], projectiles: [], events: [], players: [] },
      { type: 'snapshot', tick: 1, you: {}, entities: null, projectiles: [], events: [], players: [] },
      { type: 'snapshot', tick: 1, you: {}, entities: [], projectiles: [], events: null, players: [] },
      { type: 'snapshotDelta', tick: 2, baseTick: 1, upserts: null, removed: [], projectiles: [], events: [] },
      { type: 'snapshotDelta', tick: 2, baseTick: 1, upserts: [], removed: null, projectiles: [], events: [] },
      { type: 'roomState', roomId: 'r', name: 'n', phase: 'lobby', players: null },
    ];
    for (const frame of hostile) {
      expect(() => applyServerMessage(frame as never, 0)).not.toThrow();
    }
    // The store never entered a playing match from a malformed snapshot.
    expect(store.match.phase).not.toBe('playing');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

describe('commands', () => {
  it('drops sim commands outside a playing match', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sendCommand({ type: 'move', x: 1, y: 2 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('fills player = mySlot and wraps in a CommandMessage', () => {
    applyServerMessage(keyframe(10, []), 10 * MS); // phase playing, mySlot 2
    sendCommand({ type: 'move', x: 100, y: -50 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0]?.[0];
    expect(msg).toMatchObject({
      type: 'command',
      command: { type: 'move', player: 2, x: 100, y: -50 },
    });
  });

  it('dropItem sends a dropItem command with the slot and drop point (player filled)', () => {
    applyServerMessage(keyframe(10, []), 10 * MS); // phase playing, mySlot 2
    dropItem(3, 123, -456);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const msg = sendMock.mock.calls[0]?.[0];
    expect(msg).toMatchObject({
      type: 'command',
      command: { type: 'dropItem', player: 2, slot: 3, x: 123, y: -456 },
    });
  });

  it('dropItem is dropped (not sent) outside a playing match', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dropItem(0, 0, 0);
    expect(sendMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('sendChat trims and drops empty messages', () => {
    sendChat('all', '   ');
    expect(sendMock).not.toHaveBeenCalled();
    sendChat('team', '  ahoy  ');
    expect(sendMock).toHaveBeenCalledWith({ type: 'chat', scope: 'team', text: 'ahoy' });
  });

  it('addAi sends {type:addAi, slot, difficulty}', () => {
    addAi(7, 'hard');
    expect(sendMock).toHaveBeenCalledWith({ type: 'addAi', slot: 7, difficulty: 'hard' });
  });

  it('removeAi sends {type:removeAi, slot}', () => {
    removeAi(7);
    expect(sendMock).toHaveBeenCalledWith({ type: 'removeAi', slot: 7 });
  });

  it('leaveRoom clears room/match/chat state', () => {
    applyServerMessage(chatLine('hi'), 0);
    applyServerMessage(keyframe(10, []), 10 * MS);
    leaveRoom();
    expect(sendMock).toHaveBeenCalledWith({ type: 'leaveRoom' });
    expect(store.lobby.room).toBeNull();
    expect(store.match.phase).toBe('idle');
    expect(store.match.chat).toHaveLength(0);
    expect(sampleWorld(1e9)).toBeNull(); // interpolation reset too
  });

  it('returnToLobby resets match state but keeps chat, and refreshes rooms', () => {
    applyServerMessage(chatLine('gg'), 0);
    applyServerMessage(keyframe(10, []), 10 * MS);
    applyServerMessage({ type: 'matchEnded', winnerTeam: 'south', stats: [] }, 0);
    returnToLobby();
    expect(store.match.phase).toBe('idle');
    expect(store.match.you).toBeNull();
    expect(store.match.winnerTeam).toBeNull();
    expect(store.match.chat).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledWith({ type: 'listRooms' });
  });
});
