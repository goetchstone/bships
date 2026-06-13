/**
 * Wire-message validation (server-rooms). Every inbound frame crosses
 * `parseClientMessage` before any handler sees it — trust nothing from the
 * wire. The full `ClientMessage` union, INCLUDING the sim `Command` union
 * carried by `command` messages, is structurally validated here: field
 * types, finite numbers (JSON.parse cannot produce NaN/Infinity, but the
 * caller hands us `unknown`, so we check anyway), length caps via the
 * protocol `MAX_*` constants, and `TOKEN_PATTERN` for identity tokens.
 *
 * On success a FRESH object is returned containing only the known fields
 * (unknown extras from the wire are dropped, never forwarded). On any
 * structural problem the result is `null` and the caller answers
 * `error{badMessage}`.
 */

import {
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_ROOM_NAME_LENGTH,
  TOKEN_PATTERN,
} from '@bships/core';
import type { ClientMessage, Command, CommandMessage, UseItemCommand, CastAbilityCommand } from '@bships/core';

/** Sane cap for free-form id strings (itemId, abilityId, roomId, ...). */
const MAX_ID_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Non-negative integer (slots, entity ids, player numbers). */
function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Non-empty string no longer than `maxLength`. */
function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength;
}

/**
 * Validate one sim Command from the wire. Structural only — semantic checks
 * (does the player own that slot? is the item buyable?) belong to rooms.ts
 * ownership checks and the sim's own `applyCommands` validation.
 */
export function parseCommand(raw: unknown): Command | null {
  if (!isRecord(raw)) return null;
  const player = raw['player'];
  if (!isIndex(player)) return null;

  switch (raw['type']) {
    case 'move': {
      if (!isFiniteNumber(raw['x']) || !isFiniteNumber(raw['y'])) return null;
      return { type: 'move', player, x: raw['x'], y: raw['y'] };
    }
    case 'attackMove': {
      if (!isFiniteNumber(raw['x']) || !isFiniteNumber(raw['y'])) return null;
      return { type: 'attackMove', player, x: raw['x'], y: raw['y'] };
    }
    case 'stop':
      return { type: 'stop', player };
    case 'holdPosition':
      return { type: 'holdPosition', player };
    case 'attackTarget': {
      if (!isIndex(raw['targetId'])) return null;
      return { type: 'attackTarget', player, targetId: raw['targetId'] };
    }
    case 'buyItem': {
      if (!isIndex(raw['shopId']) || !isBoundedString(raw['itemId'], MAX_ID_LENGTH)) return null;
      return { type: 'buyItem', player, shopId: raw['shopId'], itemId: raw['itemId'] };
    }
    case 'sellItem': {
      if (!isIndex(raw['slot'])) return null;
      return { type: 'sellItem', player, slot: raw['slot'] };
    }
    case 'useItem': {
      if (!isIndex(raw['slot'])) return null;
      const command: UseItemCommand = { type: 'useItem', player, slot: raw['slot'] };
      if (raw['targetId'] !== undefined) {
        if (!isIndex(raw['targetId'])) return null;
        command.targetId = raw['targetId'];
      }
      if (raw['x'] !== undefined || raw['y'] !== undefined) {
        if (!isFiniteNumber(raw['x']) || !isFiniteNumber(raw['y'])) return null;
        command.x = raw['x'];
        command.y = raw['y'];
      }
      return command;
    }
    case 'dropItem': {
      if (!isIndex(raw['slot']) || !isFiniteNumber(raw['x']) || !isFiniteNumber(raw['y'])) return null;
      return { type: 'dropItem', player, slot: raw['slot'], x: raw['x'], y: raw['y'] };
    }
    case 'pickupItem': {
      if (!isIndex(raw['groundItemId'])) return null;
      return { type: 'pickupItem', player, groundItemId: raw['groundItemId'] };
    }
    case 'buyShip': {
      if (!isIndex(raw['shopId']) || !isBoundedString(raw['shipTypeId'], MAX_ID_LENGTH)) return null;
      return { type: 'buyShip', player, shopId: raw['shopId'], shipTypeId: raw['shipTypeId'] };
    }
    case 'castAbility': {
      if (!isBoundedString(raw['abilityId'], MAX_ID_LENGTH)) return null;
      const command: CastAbilityCommand = { type: 'castAbility', player, abilityId: raw['abilityId'] };
      if (raw['targetId'] !== undefined) {
        if (!isIndex(raw['targetId'])) return null;
        command.targetId = raw['targetId'];
      }
      if (raw['x'] !== undefined || raw['y'] !== undefined) {
        if (!isFiniteNumber(raw['x']) || !isFiniteNumber(raw['y'])) return null;
        command.x = raw['x'];
        command.y = raw['y'];
      }
      return command;
    }
    case 'fireMissile':
      return { type: 'fireMissile', player };
    case 'research': {
      if (!isBoundedString(raw['upgradeId'], MAX_ID_LENGTH)) return null;
      return { type: 'research', player, upgradeId: raw['upgradeId'] };
    }
    case 'learnSkill': {
      if (!isBoundedString(raw['abilityId'], MAX_ID_LENGTH)) return null;
      return { type: 'learnSkill', player, abilityId: raw['abilityId'] };
    }
    case 'setGoldDump': {
      if (typeof raw['enabled'] !== 'boolean') return null;
      return { type: 'setGoldDump', player, enabled: raw['enabled'] };
    }
    default:
      return null;
  }
}

/**
 * Validate one client->server message (already JSON.parse'd by the caller).
 * Returns a sanitized copy, or null for anything malformed.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null;

  switch (raw['type']) {
    case 'hello': {
      const version = raw['version'];
      const token = raw['token'];
      const name = raw['name'];
      if (!isIndex(version)) return null;
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
      if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) return null;
      return { type: 'hello', version, token, name };
    }
    case 'createRoom': {
      if (!isBoundedString(raw['roomName'], MAX_ROOM_NAME_LENGTH)) return null;
      return { type: 'createRoom', roomName: raw['roomName'] };
    }
    case 'joinRoom': {
      if (!isBoundedString(raw['roomId'], MAX_ID_LENGTH)) return null;
      return { type: 'joinRoom', roomId: raw['roomId'] };
    }
    case 'listRooms':
      return { type: 'listRooms' };
    case 'pickSlot': {
      if (!isIndex(raw['slot'])) return null;
      return { type: 'pickSlot', slot: raw['slot'] };
    }
    case 'setReady': {
      if (typeof raw['ready'] !== 'boolean') return null;
      return { type: 'setReady', ready: raw['ready'] };
    }
    case 'startMatch':
      return { type: 'startMatch' };
    case 'addAi': {
      // AI-scoped lobby message (host-only/lobby-only checks live in rooms.ts).
      // Structural only: a non-negative integer slot and a whitelisted
      // difficulty. Slot pickability + occupancy are validated by the handler.
      if (!isIndex(raw['slot'])) return null;
      const difficulty = raw['difficulty'];
      if (difficulty !== 'easy' && difficulty !== 'normal' && difficulty !== 'hard') return null;
      return { type: 'addAi', slot: raw['slot'], difficulty };
    }
    case 'removeAi': {
      if (!isIndex(raw['slot'])) return null;
      return { type: 'removeAi', slot: raw['slot'] };
    }
    case 'command': {
      const command = parseCommand(raw['command']);
      if (command === null) return null;
      const message: CommandMessage = { type: 'command', command };
      if (raw['tick'] !== undefined) {
        if (!isFiniteNumber(raw['tick'])) return null;
        message.tick = raw['tick'];
      }
      return message;
    }
    case 'chat': {
      const scope = raw['scope'];
      if (scope !== 'all' && scope !== 'team') return null;
      if (!isBoundedString(raw['text'], MAX_CHAT_LENGTH)) return null;
      return { type: 'chat', scope, text: raw['text'] };
    }
    case 'leaveRoom':
      return { type: 'leaveRoom' };
    case 'pong': {
      if (!isFiniteNumber(raw['t'])) return null;
      return { type: 'pong', t: raw['t'] };
    }
    default:
      return null;
  }
}
