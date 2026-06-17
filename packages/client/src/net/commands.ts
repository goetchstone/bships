/**
 * Outbound message helpers (docs/ARCH.md "Module: client-net").
 *
 * `sendCommand` is the ONLY path for sim commands: it fills
 * `player = store.match.mySlot`, wraps the command in a CommandMessage and
 * warns+drops outside a live match. The server re-validates everything —
 * these helpers exist for ergonomics, not trust.
 */

import { MAX_CHAT_LENGTH, MAX_ROOM_NAME_LENGTH } from '@bships/core';
import type { AiDifficulty, Command } from '@bships/core';

import { serverTickAt } from './interpolation.js';
import { send } from './socket.js';
import { emitChange, resetMatchState, store } from './store.js';

/** Distributive Omit — plain Omit collapses a discriminated union. */
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A sim command as issued by UI code: `player` is filled in here. */
export type ClientCommand = DistributedOmit<Command, 'player'> & { player?: number };

/**
 * Send one sim command. The optional `tick` is the client's tick estimate,
 * diagnostics only per protocol.ts.
 */
export function sendCommand(cmd: ClientCommand): void {
  const slot = store.match.mySlot;
  if (store.match.phase !== 'playing' || slot === null) {
    console.warn(`[net] dropped command '${cmd.type}': not in a playing match`);
    return;
  }
  const command = { ...cmd, player: cmd.player ?? slot } as Command;
  send({
    type: 'command',
    tick: Math.max(0, Math.floor(serverTickAt(performance.now()))),
    command,
  });
}

// ---------------------------------------------------------------------------
// Lobby senders
// ---------------------------------------------------------------------------

export function createRoom(roomName: string): void {
  const name = roomName.replace(/\s+/g, ' ').trim().slice(0, MAX_ROOM_NAME_LENGTH);
  if (name === '') return;
  send({ type: 'createRoom', roomName: name });
}

export function joinRoom(roomId: string): void {
  send({ type: 'joinRoom', roomId });
}

export function listRooms(): void {
  send({ type: 'listRooms' });
}

export function pickSlot(slot: number): void {
  send({ type: 'pickSlot', slot });
}

export function setReady(ready: boolean): void {
  send({ type: 'setReady', ready });
}

export function startMatch(): void {
  send({ type: 'startMatch' });
}

/**
 * Host-only: seat a computer-controlled AI captain in an OPEN pickable slot.
 * Thin sender — the server re-validates host/lobby/slot before seating (an
 * occupied or out-of-range slot is answered with an error message).
 */
export function addAi(slot: number, difficulty: AiDifficulty): void {
  send({ type: 'addAi', slot, difficulty });
}

/** Host-only: remove the AI seated in `slot`, reopening it. */
export function removeAi(slot: number): void {
  send({ type: 'removeAi', slot });
}

/**
 * Drop the item in `slot` onto the water at (x, y) — the only way to get rid of
 * gear in BSP (there is NO sell-back in Classic). `x`/`y` should be the ship's
 * current position; the server (economy.dropItem) re-validates that the drop
 * point is within the ship's reach and rejects otherwise. Dropped gear can be
 * picked up by a teammate; buying a strictly better hull/sail "burns" (refunds)
 * the old one at full gold via the Only_One_* group.
 */
export function dropItem(slot: number, x: number, y: number): void {
  sendCommand({ type: 'dropItem', slot, x, y });
}

/**
 * Spend an unspent hero-skill point to rank up `abilityId` on the current hull
 * (Dota-style level-up picker). Thin sender — the sim + server re-validate that
 * the ability is on the hull, the player has an unspent point, the hero level
 * clears the rank's minimum, and the rank is below max (reasons surfaced in
 * chat on rejection). `abilityId` must be one of ships[shipTypeId].abilityIds.
 */
export function learnSkill(abilityId: string): void {
  sendCommand({ type: 'learnSkill', abilityId });
}

export function sendChat(scope: 'all' | 'team', text: string): void {
  const trimmed = text.trim().slice(0, MAX_CHAT_LENGTH);
  if (trimmed === '') return;
  send({ type: 'chat', scope, text: trimmed });
}

/**
 * Leave the current room entirely: tells the server, clears local room +
 * match + chat state, and refreshes the room browser.
 */
export function leaveRoom(): void {
  send({ type: 'leaveRoom' });
  store.lobby.room = null;
  resetMatchState(true);
  emitChange();
  listRooms();
}

/**
 * Post-match "back to lobby" (HUD banner calls this; lobby.ts re-exports
 * it). Keeps the room membership and chat — only the match UI state is
 * dropped. main.ts reacts to phase 'idle' by re-showing #screens and hiding
 * #hud; the renderer stays alive.
 */
export function returnToLobby(): void {
  resetMatchState(false);
  emitChange();
  listRooms();
}
