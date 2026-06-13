/**
 * In-game KILL FEED — separated from player chat (owned by client-stats as the
 * kill-feed polish task; see packages/stats sharedNotes). Lives in its OWN UI
 * region (top-right by convention), distinct from the bottom-left chat log, so
 * combat spam never floods conversation.
 *
 * REQUIREMENTS (the polish):
 *   (a) Distinct region from chat (this module owns it; chat.ts stops rendering
 *       kill lines).
 *   (b) Cap to ~5 recent lines with fade-out (older lines fade + drop).
 *   (c) De-emphasize / aggregate neutral & empire-vs-empire lane-creep deaths:
 *       prefer player-involved kills prominently; collapse repeated neutral
 *       deaths (e.g. "+3 lane losses") rather than one line each — or drop them
 *       entirely and show only player ship kills (the cleaner v1 default).
 *
 * Pure classification lives in hudmath.ts (classifyKillEvent) so it is unit-
 * tested without DOM; this module is the thin DOM renderer subscribed to the
 * store's onEvent fan-out.
 */

import { onEvent, store } from '../net/store.js';
import type { HudContext } from './context.js';
import { el } from './context.js';
import { classifyKillEvent } from './hudmath.js';

const MAX_LINES = 5;
const LINE_TTL_MS = 7000;
const FADE_MS = 1200;

/**
 * Mount the kill-feed region into the HUD and subscribe to death events.
 * Called once from hud.ts (the single HUD wiring seam). chat.ts no longer
 * renders kill lines once this is active.
 */
export function initKillFeed(ctx: HudContext): void {
  const feed = el('div', 'bh-killfeed', ctx.root);

  function nameOf(slot: number): string {
    const stat = store.match.players.find((p) => p.slot === slot);
    if (stat !== undefined) return stat.name;
    return slot <= 1 ? 'The Empire' : `Player ${slot}`;
  }

  /** TTL timer per live line, so eviction can cancel it (no DOM 'remove' event). */
  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

  function evict(node: Element): void {
    const t = timers.get(node);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(node);
    }
    node.remove();
  }

  function pushLine(text: string, isPlayerKill: boolean): void {
    const line = el('div', `bh-killfeed-line${isPlayerKill ? ' bh-kf-player' : ' bh-kf-dim'}`, feed);
    line.textContent = text;

    // Cap at MAX_LINES: evict the oldest (first child) when over limit, clearing
    // its pending TTL timer (Element.remove() dispatches no event, so the old
    // 'remove' listener never fired and stale timers lingered for LINE_TTL_MS).
    while (feed.children.length > MAX_LINES) {
      const first = feed.firstElementChild;
      if (first === null) break;
      evict(first);
    }

    timers.set(
      line,
      setTimeout(() => {
        timers.delete(line);
        line.classList.add('bh-kf-fade');
        setTimeout(() => line.remove(), FADE_MS);
      }, LINE_TTL_MS),
    );
  }

  onEvent((ev) => {
    const kind = classifyKillEvent(ev, ctx.catalog);

    if (kind === null || kind === 'neutral') {
      // Suppress creep/structure deaths — they spam the feed.
      return;
    }

    // Both playerKill and playerDeath are shown; playerKill gets prominence.
    if (ev.type !== 'death') return;
    const isPlayerKill = kind === 'playerKill';

    const victim = nameOf(ev.victimPlayer ?? -1);
    let text: string;
    if (ev.killerPlayer !== null) {
      text = `${nameOf(ev.killerPlayer)} sunk ${victim}`;
    } else {
      text = `${victim} was sunk`;
    }

    pushLine(text, isPlayerKill);
  });
}
