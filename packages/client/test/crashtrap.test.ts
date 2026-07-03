/**
 * crashtrap tests — pure logic only (no DOM): the ring buffer's FIFO/overwrite
 * behavior and the ClientMessage/SimEvent label functions (STATUS.md task #15).
 */

import { describe, expect, it } from 'vitest';

import { RingBuffer, crashTrapSnapshot, labelClientMessage, labelSimEvent, recordAction } from '../src/debug/crashtrap.js';
import type { ClientMessage, SimEvent } from '@bships/core';

describe('RingBuffer', () => {
  it('returns entries oldest-to-newest under capacity', () => {
    const ring = new RingBuffer<number>(5);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    expect(ring.toArray()).toEqual([1, 2, 3]);
    expect(ring.size).toBe(3);
  });

  it('overwrites the oldest entry once full, staying oldest-to-newest', () => {
    const ring = new RingBuffer<number>(3);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    ring.push(4); // evicts 1
    ring.push(5); // evicts 2
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.size).toBe(3);
  });

  it('handles capacity 1', () => {
    const ring = new RingBuffer<string>(1);
    ring.push('a');
    ring.push('b');
    expect(ring.toArray()).toEqual(['b']);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow();
  });
});

describe('labelClientMessage', () => {
  it('labels move/attackMove commands with rounded coordinates', () => {
    const msg: ClientMessage = {
      type: 'command',
      command: { type: 'move', player: 2, x: 10.6, y: -3.2 },
    };
    expect(labelClientMessage(msg)).toBe('move(11,-3)');
  });

  it('labels buyItem/sellItem/learnSkill/castAbility commands', () => {
    expect(
      labelClientMessage({
        type: 'command',
        command: { type: 'buyItem', player: 2, shopId: 7, itemId: 'I000' },
      }),
    ).toBe('buyItem(I000)');
    expect(
      labelClientMessage({
        type: 'command',
        command: { type: 'sellItem', player: 2, slot: 3 },
      }),
    ).toBe('sellItem(slot 3)');
    expect(
      labelClientMessage({
        type: 'command',
        command: { type: 'learnSkill', player: 2, abilityId: 'A000' },
      }),
    ).toBe('learnSkill(A000)');
    expect(
      labelClientMessage({
        type: 'command',
        command: { type: 'castAbility', player: 2, abilityId: 'A001' },
      }),
    ).toBe('castAbility(A001)');
  });

  it('labels lobby/chat frames by their own type', () => {
    expect(labelClientMessage({ type: 'chat', scope: 'team', text: 'gg' })).toBe('chat(team)');
    expect(labelClientMessage({ type: 'startMatch' })).toBe('startMatch');
  });
});

describe('labelSimEvent', () => {
  it('labels death/respawn/levelUp', () => {
    const death: SimEvent = {
      type: 'death',
      tick: 1,
      entityId: 5,
      entityTypeId: 'h000',
      victimPlayer: 2,
      killerPlayer: 3,
      x: 0,
      y: 0,
    };
    expect(labelSimEvent(death)).toBe('death(#5 h000)');
    expect(labelSimEvent({ type: 'respawn', tick: 1, player: 2, entityId: 9 })).toBe('respawn(#9)');
    expect(labelSimEvent({ type: 'levelUp', tick: 1, player: 2, level: 4 })).toBe('levelUp(player 2 -> L4)');
  });

  it('returns null for events not worth recording', () => {
    expect(
      labelSimEvent({ type: 'hit', tick: 1, targetEntityId: 1, attackerPlayer: 2, weaponId: null, amount: 5 }),
    ).toBeNull();
  });
});

describe('recordAction / crashTrapSnapshot', () => {
  it('accumulates and caps recent actions, oldest-to-newest', () => {
    for (let i = 0; i < 25; i++) recordAction(`action-${i}`, i);
    const snap = crashTrapSnapshot();
    expect(snap.length).toBe(20);
    expect(snap[0]?.label).toBe('action-5');
    expect(snap[snap.length - 1]?.label).toBe('action-24');
  });
});
