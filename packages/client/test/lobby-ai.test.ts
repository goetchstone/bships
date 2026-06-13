/**
 * client-ai-lobby tests: the PURE lobby/AI decision logic exported from
 * lobby.ts (no DOM). Covers slot classification, host detection, open-slot
 * enumeration, the "Fill with AI" target set, and the "Play vs AI" plan
 * (human seat + opposite-team fill). The DOM rendering itself is a thin shell
 * over these helpers; the senders are covered in net.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { LOBBY_SLOTS } from '@bships/core';
import type { AiDifficulty, RoomPlayer, RoomStateMessage } from '@bships/core';

import {
  AI_DIFFICULTIES,
  FILL_DIFFICULTY,
  aiDisplayName,
  isRoomHost,
  openPickableSlots,
  planPlayVsAi,
  slotKind,
  teamOfSlot,
} from '../src/lobby/lobby.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function human(publicId: string, slot: number | null, isHost = false): RoomPlayer {
  return { publicId, name: publicId, slot, ready: false, connected: true, isHost, ai: null };
}

function bot(slot: number, difficulty: AiDifficulty = 'normal'): RoomPlayer {
  return {
    publicId: `ai-${slot}`,
    name: aiDisplayName(difficulty),
    slot,
    ready: true,
    connected: true,
    isHost: false,
    ai: difficulty,
  };
}

function room(players: RoomPlayer[], phase: RoomStateMessage['phase'] = 'lobby'): RoomStateMessage {
  return { type: 'roomState', roomId: 'r1', name: 'Test', phase, players };
}

// ---------------------------------------------------------------------------
// slotKind
// ---------------------------------------------------------------------------

describe('slotKind', () => {
  it('classifies human / ai / open slots', () => {
    const r = room([human('me', 2, true), bot(7, 'hard')]);
    expect(slotKind(r, 2)).toBe('human');
    expect(slotKind(r, 7)).toBe('ai');
    expect(slotKind(r, 3)).toBe('open');
  });

  it('treats an unseated human (slot null) as not occupying any slot', () => {
    const r = room([human('drifter', null)]);
    expect(slotKind(r, 2)).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// isRoomHost
// ---------------------------------------------------------------------------

describe('isRoomHost', () => {
  it('true only for the host publicId', () => {
    const r = room([human('host', 2, true), human('guest', 3)]);
    expect(isRoomHost(r, 'host')).toBe(true);
    expect(isRoomHost(r, 'guest')).toBe(false);
  });

  it('false for null / unknown id', () => {
    const r = room([human('host', 2, true)]);
    expect(isRoomHost(r, null)).toBe(false);
    expect(isRoomHost(r, 'nobody')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// teamOfSlot
// ---------------------------------------------------------------------------

describe('teamOfSlot', () => {
  it('maps slots to their team per LOBBY_SLOTS', () => {
    expect(teamOfSlot(2)).toBe('south');
    expect(teamOfSlot(6)).toBe('south');
    expect(teamOfSlot(7)).toBe('north');
    expect(teamOfSlot(11)).toBe('north');
  });

  it('returns null for non-pickable slots (AI empire 0/1, out of range)', () => {
    expect(teamOfSlot(0)).toBeNull();
    expect(teamOfSlot(1)).toBeNull();
    expect(teamOfSlot(99)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// openPickableSlots
// ---------------------------------------------------------------------------

describe('openPickableSlots', () => {
  it('lists every empty pickable slot, south then north, ascending', () => {
    const r = room([human('me', 2, true), bot(7), human('guest', 9)]);
    const expected = [
      ...LOBBY_SLOTS.south.filter((s) => s !== 2),
      ...LOBBY_SLOTS.north.filter((s) => s !== 7 && s !== 9),
    ];
    expect(openPickableSlots(r)).toEqual(expected);
  });

  it('is empty when every slot is taken (human or AI)', () => {
    const all = [...LOBBY_SLOTS.south, ...LOBBY_SLOTS.north].map((s) => bot(s));
    expect(openPickableSlots(room(all))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// planPlayVsAi
// ---------------------------------------------------------------------------

describe('planPlayVsAi', () => {
  it('keeps a seated human and fills the OPPOSITE team', () => {
    const r = room([human('me', 2, true)]);
    const plan = planPlayVsAi(r, 2);
    expect(plan.humanSlot).toBe(2);
    expect(plan.enemyTeam).toBe('north');
    expect(plan.aiSlots).toEqual(LOBBY_SLOTS.north);
  });

  it('north human -> fills south', () => {
    const r = room([human('me', 9, true)]);
    const plan = planPlayVsAi(r, 9);
    expect(plan.enemyTeam).toBe('south');
    expect(plan.aiSlots).toEqual(LOBBY_SLOTS.south);
  });

  it('seats an unseated human in the first open slot, then fills the other side', () => {
    // No one seated: first open slot is south[0]=2, so enemy is north.
    const r = room([human('me', null, true)]);
    const plan = planPlayVsAi(r, null);
    expect(plan.humanSlot).toBe(LOBBY_SLOTS.south[0]);
    expect(plan.enemyTeam).toBe('north');
    expect(plan.aiSlots).toEqual(LOBBY_SLOTS.north);
  });

  it('does not target enemy slots already filled by humans or AI', () => {
    const r = room([human('me', 2, true), human('rival', 7), bot(8, 'easy')]);
    const plan = planPlayVsAi(r, 2);
    expect(plan.aiSlots).toEqual(LOBBY_SLOTS.north.filter((s) => s !== 7 && s !== 8));
  });

  it('never lists the human seat among the AI fill slots', () => {
    const r = room([human('me', null, true)]);
    const plan = planPlayVsAi(r, null);
    expect(plan.humanSlot).not.toBeNull();
    expect(plan.aiSlots).not.toContain(plan.humanSlot);
  });

  it('yields no plan when there is nowhere to seat the human', () => {
    const all = [...LOBBY_SLOTS.south, ...LOBBY_SLOTS.north].map((s) => bot(s));
    const plan = planPlayVsAi(room(all), null);
    expect(plan.humanSlot).toBeNull();
    expect(plan.aiSlots).toEqual([]);
  });

  it('yields an empty AI set when the opposite team is already full', () => {
    const northFull = LOBBY_SLOTS.north.map((s) => bot(s));
    const r = room([human('me', 2, true), ...northFull]);
    const plan = planPlayVsAi(r, 2);
    expect(plan.enemyTeam).toBe('north');
    expect(plan.aiSlots).toEqual([]);
  });

  it('defaults difficulty to FILL_DIFFICULTY without affecting slot math', () => {
    const r = room([human('me', 2, true)]);
    expect(planPlayVsAi(r, 2)).toEqual(planPlayVsAi(r, 2, FILL_DIFFICULTY));
    expect(planPlayVsAi(r, 2).difficulty).toBe('normal');
  });

  it('echoes the requested difficulty for the caller to seat', () => {
    const r = room([human('me', 2, true)]);
    expect(planPlayVsAi(r, 2, 'hard').difficulty).toBe('hard');
  });
});

// ---------------------------------------------------------------------------
// labels / constants
// ---------------------------------------------------------------------------

describe('AI labels', () => {
  it('aiDisplayName mirrors the server synthetic name', () => {
    expect(aiDisplayName('easy')).toBe('AI (easy)');
    expect(aiDisplayName('normal')).toBe('AI (normal)');
    expect(aiDisplayName('hard')).toBe('AI (hard)');
  });

  it('offers exactly easy/normal/hard, with normal as the fill default', () => {
    expect([...AI_DIFFICULTIES]).toEqual(['easy', 'normal', 'hard']);
    expect(FILL_DIFFICULTY).toBe('normal');
  });
});
