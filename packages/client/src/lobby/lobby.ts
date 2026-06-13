/**
 * Lobby/menu screens (docs/ARCH.md "Module: client-net" behavior). Plain DOM
 * inside #screens using the index.html `.panel` styles + CSS vars. Views:
 *
 *   connect status -> name entry -> room browser -> room lobby -> countdown
 *
 * All state comes from the store; all actions go through commands.ts. The
 * lobby never runs game logic and never touches #stage / #hud internals —
 * screen visibility itself is main.ts's job.
 *
 * Rendering: full rebuild on store change, skipped when a signature of the
 * lobby-relevant state is unchanged (so 20 Hz snapshot notifies are free and
 * typing in inputs is never clobbered — drafts live outside the DOM).
 * All user-provided text (names, chat) is set via textContent: XSS-safe.
 */

import { LOBBY_SLOTS, MAX_NAME_LENGTH, MAX_ROOM_NAME_LENGTH } from '@bships/core';
import type { RoomPlayer, RoomStateMessage, TeamId } from '@bships/core';

import {
  createRoom,
  joinRoom,
  leaveRoom,
  listRooms,
  pickSlot,
  sendChat,
  setReady,
  startMatch,
} from '../net/commands.js';
import { setName } from '../net/identity.js';
import { isOpen, reconnectNow } from '../net/socket.js';
import { emitChange, store } from '../net/store.js';

// HUD banner entry point lives in commands.ts; re-exported here per ARCH.md.
export { returnToLobby } from '../net/commands.js';

const ROOM_REFRESH_MS = 5000;

const TEAM_LABELS: Record<TeamId, string> = { south: 'South Empire', north: 'North Empire' };
const TEAM_VARS: Record<TeamId, string> = { south: '--team-south', north: '--team-north' };

// --- local (non-store) UI state ---------------------------------------------
let rootEl: HTMLElement | null = null;
let editingName = false;
let chatScope: 'all' | 'team' = 'all';
const drafts = new Map<string, string>();
let lastSignature = '';

// --- tiny DOM helpers --------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, className = 'bs-btn'): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/** Draft-preserving input: value survives rebuilds without DOM reuse. */
function draftInput(id: string, placeholder: string, maxLength: number): HTMLInputElement {
  const node = el('input', 'bs-input');
  node.id = id;
  node.placeholder = placeholder;
  node.maxLength = maxLength;
  node.value = drafts.get(id) ?? '';
  node.addEventListener('input', () => drafts.set(id, node.value));
  return node;
}

function markDirtyAndRender(): void {
  lastSignature = '';
  render();
}

// --- styles ------------------------------------------------------------------

const LOBBY_CSS = `
.bs-lobby { width: 560px; max-width: 92vw; display: flex; flex-direction: column; gap: 12px; }
.bs-title { font-size: 20px; letter-spacing: 0.04em; }
.bs-sub { color: var(--text-dim); font-size: 12px; }
.bs-row { display: flex; gap: 8px; align-items: center; }
.bs-grow { flex: 1; }
.bs-btn {
  background: var(--bg-panel-raised); border: 1px solid var(--border);
  color: var(--text); padding: 6px 12px; border-radius: 4px; cursor: pointer; font: inherit;
}
.bs-btn:hover:not(:disabled) { border-color: var(--accent); }
.bs-btn:disabled { opacity: 0.45; cursor: default; }
.bs-btn-primary { background: var(--accent); border-color: var(--accent); color: #04121f; font-weight: 600; }
.bs-btn-small { padding: 2px 8px; font-size: 12px; }
.bs-input {
  background: var(--bg-deep); border: 1px solid var(--border); color: var(--text);
  padding: 6px 10px; border-radius: 4px; font: inherit; min-width: 0;
}
.bs-list { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
.bs-room-row {
  display: flex; gap: 10px; align-items: center; justify-content: space-between;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 4px;
}
.bs-teams { display: flex; gap: 12px; }
.bs-team { flex: 1; border: 1px solid var(--border); border-top: 3px solid; border-radius: 6px; padding: 8px 10px; }
.bs-team-title { font-weight: 600; margin-bottom: 6px; }
.bs-slot {
  display: flex; justify-content: space-between; align-items: center; gap: 6px;
  padding: 3px 6px; min-height: 30px; border-radius: 3px;
}
.bs-slot-me { background: var(--bg-panel-raised); }
.bs-ready { color: #7fdc8a; font-size: 12px; }
.bs-chat-log {
  height: 140px; overflow-y: auto; background: var(--bg-deep);
  border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px;
  font-size: 13px; user-select: text; display: flex; flex-direction: column; gap: 2px;
}
.bs-chat-line .bs-chat-from { color: var(--accent); }
.bs-chat-line .bs-chat-system { color: var(--text-dim); font-style: italic; }
.bs-status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.bs-countdown { font-size: 110px; font-weight: 700; text-align: center; padding: 24px 64px; }
`;

function injectStylesOnce(): void {
  if (document.getElementById('bships-lobby-css') !== null) return;
  const style = el('style');
  style.id = 'bships-lobby-css';
  style.textContent = LOBBY_CSS;
  document.head.appendChild(style);
}

// --- views -------------------------------------------------------------------

function connectionRow(): HTMLElement {
  const status = store.connection.status;
  const row = el('div', 'bs-row bs-sub');
  const dot = el('span', 'bs-status-dot');
  dot.style.background =
    status === 'open' ? '#7fdc8a' : status === 'connecting' ? 'var(--gold)' : 'var(--danger)';
  const label =
    status === 'open'
      ? 'Connected'
      : status === 'connecting'
        ? 'Connecting…'
        : 'Disconnected — retrying…';
  row.append(dot, el('span', '', label));
  if (store.identity.name !== '') {
    const name = el('span', 'bs-grow', '');
    name.style.textAlign = 'right';
    name.textContent = store.identity.name;
    const change = button('Change name', () => {
      editingName = true;
      markDirtyAndRender();
    }, 'bs-btn bs-btn-small');
    row.append(name, change);
  }
  return row;
}

function namePanel(): HTMLElement {
  const panel = el('div', 'panel bs-lobby');
  panel.append(
    el('div', 'bs-title', 'BattleShips Pro'),
    el('div', 'bs-sub', 'Choose your captain name'),
  );
  const row = el('div', 'bs-row');
  const input = draftInput('bships-name-input', 'Captain name', MAX_NAME_LENGTH);
  if (input.value === '' && store.identity.name !== '') input.value = store.identity.name;
  input.classList.add('bs-grow');
  const submit = (): void => {
    const name = setName(input.value);
    if (name === '') return;
    drafts.delete('bships-name-input');
    store.identity.name = name;
    editingName = false;
    // hello is per-connection: a live connection must re-auth with the new
    // name, so force a clean reconnect.
    if (isOpen()) reconnectNow();
    emitChange();
    markDirtyAndRender();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  row.append(input, button('Set sail', submit, 'bs-btn bs-btn-primary'));
  panel.append(row, connectionRow());
  return panel;
}

function browserPanel(): HTMLElement {
  const panel = el('div', 'panel bs-lobby');
  panel.append(el('div', 'bs-title', 'BattleShips Pro — Harbor'), connectionRow());

  const createRow = el('div', 'bs-row');
  const nameInput = draftInput('bships-create-input', 'New room name', MAX_ROOM_NAME_LENGTH);
  nameInput.classList.add('bs-grow');
  const create = (): void => {
    const roomName = nameInput.value.trim();
    if (roomName === '') return;
    createRoom(roomName);
    nameInput.value = '';
    drafts.delete('bships-create-input');
  };
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') create();
  });
  createRow.append(nameInput, button('Create room', create, 'bs-btn bs-btn-primary'));
  panel.append(createRow);

  const header = el('div', 'bs-row');
  header.append(
    el('div', 'bs-grow bs-sub', `${store.lobby.rooms.length} room(s)`),
    button('Refresh', () => listRooms(), 'bs-btn bs-btn-small'),
  );
  panel.append(header);

  const list = el('div', 'bs-list');
  if (store.lobby.rooms.length === 0) {
    list.append(el('div', 'bs-sub', 'No rooms yet — create one!'));
  }
  for (const room of store.lobby.rooms) {
    const row = el('div', 'bs-room-row');
    const title = el('div', 'bs-grow');
    title.textContent = room.name;
    const meta = el('div', 'bs-sub', `${room.phase} · ${room.playerCount}/${room.maxPlayers}`);
    const join = button('Join', () => joinRoom(room.roomId));
    join.disabled = room.phase !== 'lobby' || room.playerCount >= room.maxPlayers;
    row.append(title, meta, join);
    list.append(row);
  }
  panel.append(list);
  return panel;
}

function slotRow(room: RoomStateMessage, slot: number): HTMLElement {
  const occupant = room.players.find((p) => p.slot === slot);
  const row = el('div', 'bs-slot');
  const isMe = occupant !== undefined && occupant.publicId === store.identity.publicId;
  if (isMe) row.classList.add('bs-slot-me');
  if (occupant !== undefined) {
    const name = el('span', '');
    name.textContent = `${occupant.isHost ? '★ ' : ''}${occupant.name}`;
    if (!occupant.connected) {
      name.style.opacity = '0.5';
      name.textContent += ' (dc)';
    }
    row.append(name, el('span', 'bs-ready', occupant.ready ? 'READY' : ''));
  } else {
    row.append(el('span', 'bs-sub', 'Open'));
    if (room.phase === 'lobby') {
      row.append(button('Take', () => pickSlot(slot), 'bs-btn bs-btn-small'));
    }
  }
  return row;
}

function chatBox(): HTMLElement {
  const wrap = el('div', '');
  const log = el('div', 'bs-chat-log');
  log.id = 'bships-chat-log';
  for (const line of store.match.chat) {
    const div = el('div', 'bs-chat-line');
    if (line.scope === 'system') {
      const body = el('span', 'bs-chat-system');
      body.textContent = line.text;
      div.append(body);
    } else {
      const from = el('span', 'bs-chat-from');
      from.textContent = `${line.from.name}${line.scope === 'team' ? ' (team)' : ''}: `;
      const body = el('span', '');
      body.textContent = line.text;
      div.append(from, body);
    }
    log.append(div);
  }
  const row = el('div', 'bs-row');
  row.style.marginTop = '6px';
  const scope = button(chatScope === 'all' ? 'All' : 'Team', () => {
    chatScope = chatScope === 'all' ? 'team' : 'all';
    markDirtyAndRender();
  }, 'bs-btn bs-btn-small');
  const input = draftInput('bships-chat-input', 'Say something…', 240);
  input.classList.add('bs-grow');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendChat(chatScope, input.value);
      input.value = '';
      drafts.delete('bships-chat-input');
    }
  });
  row.append(scope, input);
  wrap.append(log, row);
  return wrap;
}

function roomPanel(room: RoomStateMessage): HTMLElement {
  const panel = el('div', 'panel bs-lobby');
  const header = el('div', 'bs-row');
  const title = el('div', 'bs-title bs-grow');
  title.textContent = room.name;
  header.append(title, button('Leave', () => {
    leaveRoom();
    markDirtyAndRender();
  }, 'bs-btn bs-btn-small'));
  panel.append(header, connectionRow());

  const teams = el('div', 'bs-teams');
  for (const team of ['south', 'north'] as TeamId[]) {
    const col = el('div', 'bs-team');
    col.style.borderTopColor = `var(${TEAM_VARS[team]})`;
    const colTitle = el('div', 'bs-team-title', TEAM_LABELS[team]);
    colTitle.style.color = `var(${TEAM_VARS[team]})`;
    col.append(colTitle);
    for (const slot of LOBBY_SLOTS[team]) col.append(slotRow(room, slot));
    teams.append(col);
  }
  panel.append(teams);

  const unseated = room.players.filter((p) => p.slot === null);
  if (unseated.length > 0) {
    const line = el('div', 'bs-sub');
    line.textContent = `Picking a slot: ${unseated.map((p) => p.name).join(', ')}`;
    panel.append(line);
  }

  const me: RoomPlayer | undefined = room.players.find(
    (p) => p.publicId === store.identity.publicId,
  );
  const actions = el('div', 'bs-row');
  const readyBtn = button(me?.ready === true ? 'Unready' : 'Ready', () => {
    setReady(!(me?.ready === true));
  }, me?.ready === true ? 'bs-btn' : 'bs-btn bs-btn-primary');
  readyBtn.disabled = me === undefined || me.slot === null || room.phase !== 'lobby';
  actions.append(readyBtn);
  if (me?.isHost === true) {
    const seated = room.players.filter((p) => p.slot !== null);
    const startBtn = button('Start match', () => startMatch(), 'bs-btn bs-btn-primary');
    startBtn.disabled =
      room.phase !== 'lobby' || seated.length === 0 || !seated.every((p) => p.ready);
    actions.append(startBtn);
  }
  actions.append(el('div', 'bs-grow'));
  panel.append(actions, chatBox());
  return panel;
}

function countdownPanel(): HTMLElement {
  const panel = el('div', 'panel');
  const n = store.match.countdown;
  panel.append(
    el('div', 'bs-countdown', n > 0 ? String(n) : 'GO!'),
    el('div', 'bs-sub', 'Match starting — man the cannons!'),
  );
  return panel;
}

function buildView(): HTMLElement {
  const phase = store.match.phase;
  if (phase === 'starting') return countdownPanel();
  if (phase === 'playing' || phase === 'ended') return el('div', ''); // #screens hidden by main.ts
  if (editingName || store.identity.name === '') return namePanel();
  if (store.lobby.room !== null) return roomPanel(store.lobby.room);
  return browserPanel();
}

// --- render loop --------------------------------------------------------------

/** Lobby-relevant state fingerprint: rebuild only when this changes. */
function signature(): string {
  return JSON.stringify([
    store.connection.status,
    store.identity.name,
    store.identity.publicId,
    store.lobby.rooms,
    store.lobby.room,
    store.match.phase,
    store.match.countdown,
    store.match.chat.length,
    store.match.chat[store.match.chat.length - 1]?.text ?? '',
    editingName,
    chatScope,
  ]);
}

function render(): void {
  if (rootEl === null) return;
  const sig = signature();
  if (sig === lastSignature) return;
  lastSignature = sig;
  const active = document.activeElement;
  const focusedId = active instanceof HTMLElement ? active.id : '';
  rootEl.replaceChildren(buildView());
  if (focusedId !== '') {
    const refocus = document.getElementById(focusedId);
    if (refocus instanceof HTMLElement) refocus.focus();
  }
  const log = document.getElementById('bships-chat-log');
  if (log !== null) log.scrollTop = log.scrollHeight;
}

/**
 * Mount the lobby into #screens and keep it in sync with the store. Called
 * once from main.ts; visibility of #screens itself stays with main.ts.
 */
export function initLobby(root: HTMLElement): void {
  rootEl = root;
  injectStylesOnce();
  store.subscribe(render);
  render();
  // Keep the room browser fresh while it is the active view.
  setInterval(() => {
    if (store.lobby.room === null && store.match.phase === 'idle' && isOpen()) listRooms();
  }, ROOM_REFRESH_MS);
}
