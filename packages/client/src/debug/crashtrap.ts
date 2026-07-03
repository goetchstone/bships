/**
 * Client-side crash trap (STATUS.md task #15 — owner's unreproduced in-game
 * crash has no repro; this makes the NEXT one diagnosable). Two parts:
 *
 *  1. A tiny ring buffer of recent player-visible actions, fed from the
 *     single chokepoint where the client sends messages to the server
 *     (`net/socket.ts`'s `send()`) plus death/respawn/levelUp sim events
 *     (fanned out by `net/store.ts`'s `onEvent`). Recording is O(1) label
 *     strings only — no deep copies of commands/state.
 *  2. `window` `error`/`unhandledrejection` listeners that console.error a
 *     structured dump (error + ring buffer + cheap match context) and show a
 *     brief non-blocking on-screen toast so the owner knows to check the
 *     console. Installed from main.ts as early as practical so it covers the
 *     lobby too, not just live matches.
 *
 * Must never itself throw: every handler body is wrapped in try/catch, and
 * recording is deliberately cheap (fixed-size ring, no allocation beyond one
 * string per entry).
 */

import type { ClientMessage, SimEvent } from '@bships/core';

// ---------------------------------------------------------------------------
// Ring buffer (pure; unit-tested in test/crashtrap.test.ts without a DOM)
// ---------------------------------------------------------------------------

export interface CrashTrapEntry {
  label: string;
  /** performance.now()-style ms timestamp; caller supplies it (no Date.now() in shared logic). */
  atMs: number;
}

const RING_CAPACITY = 20;

/** Fixed-capacity FIFO ring: push() overwrites the oldest entry once full. */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  private head = 0;
  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error('RingBuffer capacity must be > 0');
  }

  push(item: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(item);
    } else {
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Oldest-to-newest snapshot. Allocates a new array; only called on crash. */
  toArray(): T[] {
    return [...this.items.slice(this.head), ...this.items.slice(0, this.head)];
  }

  get size(): number {
    return this.items.length;
  }
}

/**
 * Human label for an outgoing ClientMessage — cheap scalar picks, no deep
 * copies. Command messages get their sim command's `type`; lobby/chat frames
 * get their own type. Falls back to the raw `type` for anything unlisted.
 */
export function labelClientMessage(msg: ClientMessage): string {
  if (msg.type === 'command') {
    const cmd = msg.command;
    switch (cmd.type) {
      case 'move':
      case 'attackMove':
        return `${cmd.type}(${Math.round(cmd.x)},${Math.round(cmd.y)})`;
      case 'attackTarget':
        return `attackTarget(#${cmd.targetId})`;
      case 'buyItem':
        return `buyItem(${cmd.itemId})`;
      case 'sellItem':
        return `sellItem(slot ${cmd.slot})`;
      case 'useItem':
        return `useItem(slot ${cmd.slot})`;
      case 'dropItem':
        return `dropItem(slot ${cmd.slot})`;
      case 'pickupItem':
        return `pickupItem(#${cmd.groundItemId})`;
      case 'buyShip':
        return `buyShip(${cmd.shipTypeId})`;
      case 'castAbility':
        return `castAbility(${cmd.abilityId})`;
      case 'research':
        return `research(${cmd.upgradeId})`;
      case 'learnSkill':
        return `learnSkill(${cmd.abilityId})`;
      case 'setGoldDump':
        return `setGoldDump(${String(cmd.enabled)})`;
      default:
        return cmd.type;
    }
  }
  if (msg.type === 'chat') return `chat(${msg.scope})`;
  return msg.type;
}

/** Human label for a sim event worth recording (death/respawn/levelUp only). */
export function labelSimEvent(ev: SimEvent): string | null {
  switch (ev.type) {
    case 'death':
      return `death(#${ev.entityId} ${ev.entityTypeId})`;
    case 'respawn':
      return `respawn(#${ev.entityId})`;
    case 'levelUp':
      return `levelUp(player ${ev.player} -> L${ev.level})`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Live trap (stateful singleton; DOM + window wiring)
// ---------------------------------------------------------------------------

const ring = new RingBuffer<CrashTrapEntry>(RING_CAPACITY);

/** Record one player-visible action. Cheap: one string label, no copies. */
export function recordAction(label: string, atMs: number): void {
  try {
    ring.push({ label, atMs });
  } catch {
    // Recording must never break the caller (send()/event fan-out).
  }
}

/** Snapshot of the ring buffer, oldest-to-newest, for a crash dump. */
export function crashTrapSnapshot(): CrashTrapEntry[] {
  try {
    return ring.toArray();
  } catch {
    return [];
  }
}

const TOAST_ID = 'bh-crashtoast';
const TOAST_MS = 6000;

/** Minimal self-styled toast — installed before #hud may exist (lobby crashes too). */
function showCrashToast(): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById(TOAST_ID);
  if (existing !== null) existing.remove();

  if (document.getElementById(`${TOAST_ID}-style`) === null) {
    const style = document.createElement('style');
    style.id = `${TOAST_ID}-style`;
    style.textContent = `
#${TOAST_ID} {
  position: fixed; bottom: 16px; right: 16px; z-index: 99999;
  max-width: 320px; padding: 10px 14px;
  background: color-mix(in srgb, var(--bg-panel, #1a1a1a) 88%, transparent);
  border: 1px solid var(--danger, #c0392b);
  border-radius: 8px;
  color: var(--text, #eee); font: 13px/1.4 inherit;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}`;
    document.head.appendChild(style);
  }

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.textContent = 'A crash was trapped — details dumped to the browser console.';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_MS);
}

/** Cheap, best-effort match context — never throws even if the store shape is off. */
function safeMatchContext(): Record<string, unknown> {
  try {
    // Lazy require-style import would need async; instead this is populated via
    // a setter so debug/crashtrap.ts has no static dependency on net/store.ts
    // (keeps the trap installable before the store module is even loaded).
    return contextProvider?.() ?? {};
  } catch {
    return {};
  }
}

let contextProvider: (() => Record<string, unknown>) | null = null;

/** main.ts / net wiring may supply cheap match context (e.g. selected ship id). */
export function setCrashContextProvider(fn: () => Record<string, unknown>): void {
  contextProvider = fn;
}

function dump(source: string, err: unknown): void {
  try {
    console.error('[crashtrap] uncaught error', {
      source,
      error: err,
      recentActions: crashTrapSnapshot(),
      matchContext: safeMatchContext(),
    });
    showCrashToast();
  } catch {
    // The dump itself must never throw out of a window error handler.
  }
}

let installed = false;

/** Install the window error/unhandledrejection listeners. Idempotent. */
export function installCrashTrap(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => {
    dump('error', ev.error ?? ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    dump('unhandledrejection', ev.reason);
  });
}
