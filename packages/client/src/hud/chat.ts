/**
 * Chat log + kill feed, bottom-left above the minimap. Enter opens the
 * input (keymap suppresses all hotkeys while it is focused); Esc closes;
 * the scope button toggles all/team. Kill feed lines come from death
 * events via the store's onEvent fan-out; the server's own command
 * rejections surface here too as dim system lines.
 */

import type { ServerChatMessage } from '@bships/core';
import { sendChat } from '../net/commands.js';
import { onEvent, store } from '../net/store.js';
import { bindingFor, onAction } from '../input/keymap.js';
import type { HudContext } from './context.js';
import { el } from './context.js';
import { keyLabel } from './hudmath.js';

const MAX_LINES = 9;
const LINE_TTL_MS = 12000;

export function initChat(ctx: HudContext): void {
  const wrap = el('div', 'bh-chat', ctx.root);
  const log = el('div', 'bh-chat-log', wrap);
  const inputRow = el('div', 'bh-chat-input', wrap);
  inputRow.hidden = true;
  const scopeBtn = el('button', 'bh-chat-scope', inputRow);
  scopeBtn.type = 'button';
  scopeBtn.tabIndex = -1;
  const input = el('input', undefined, inputRow);
  input.type = 'text';
  input.maxLength = 240;
  input.placeholder = `chat… (${keyLabel(bindingFor('chat'))} to send, ESC to cancel)`;

  let scope: 'all' | 'team' = 'all';

  function syncScope(): void {
    scopeBtn.textContent = scope === 'all' ? '[ALL]' : '[TEAM]';
    scopeBtn.classList.toggle('bh-team-scope', scope === 'team');
  }
  syncScope();
  // preventDefault on mousedown so clicking the button does not blur (and
  // thereby close) the input before the click lands.
  scopeBtn.addEventListener('mousedown', (e) => e.preventDefault());
  scopeBtn.addEventListener('click', () => {
    scope = scope === 'all' ? 'team' : 'all';
    syncScope();
    input.focus();
  });

  function pushLine(text: string, className: string): void {
    const line = el('div', `bh-chat-line ${className}`, log);
    line.textContent = text;
    while (log.children.length > MAX_LINES) log.firstChild?.remove();
    const node = line;
    setTimeout(() => {
      node.classList.add('bh-fade');
      setTimeout(() => node.remove(), 1200);
    }, LINE_TTL_MS);
  }

  // -- incoming chat ----------------------------------------------------------
  const seen = new WeakSet<ServerChatMessage>();
  function drainChat(): void {
    for (const msg of store.match.chat) {
      if (seen.has(msg)) continue;
      seen.add(msg);
      if (msg.scope === 'system') {
        pushLine(msg.text, 'bh-system');
      } else {
        const prefix = msg.scope === 'team' ? '[team] ' : '';
        pushLine(`${prefix}${msg.from.name}: ${msg.text}`, msg.scope === 'team' ? 'bh-team-msg' : '');
      }
    }
  }
  drainChat();
  store.subscribe(drainChat);

  // -- own command rejections (kill lines are now in killfeed.ts) -------------
  onEvent((ev) => {
    if (ev.type === 'commandRejected' && ev.player === store.match.mySlot) {
      pushLine(`Cannot ${ev.commandType}: ${ev.reason}`, 'bh-system bh-reject');
    }
  });

  // -- input handling -----------------------------------------------------------
  function openInput(): void {
    inputRow.hidden = false;
    input.value = '';
    input.focus();
  }
  function closeInput(): void {
    inputRow.hidden = true;
    input.value = '';
    input.blur();
  }

  onAction((action, e) => {
    if (action !== 'chat' || e.type !== 'keydown') return;
    // keymap suppresses dispatch while the input is focused, so this only
    // fires when the input is closed.
    openInput();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = input.value.trim();
      if (text.length > 0) sendChat(scope, text);
      closeInput();
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Escape') {
      closeInput();
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Tab') {
      // Tab toggles scope while typing (does not leave the input).
      scope = scope === 'all' ? 'team' : 'all';
      syncScope();
      e.preventDefault();
    }
  });
  input.addEventListener('blur', () => {
    // Click-away closes the input but keeps any typed text loss acceptable.
    if (!inputRow.hidden) closeInput();
  });
}
