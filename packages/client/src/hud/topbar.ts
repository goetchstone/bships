/**
 * Top bar: gold / lumber / level + XP-to-next / K-D / connection RTT dot in a
 * raised panel docked top-center. Pure store consumer — rebuilt on the store's
 * coarse change signal. Display-only (pointer-events:none): the bar never
 * needs to capture clicks, so game clicks under it still reach the canvas.
 */

import { store } from '../net/store.js';
import type { HudContext } from './context.js';
import { el } from './context.js';
import { xpProgress } from './hudmath.js';

export function initTopbar(ctx: HudContext): void {
  const bar = el('div', 'bh-topbar', ctx.root);

  const gold = stat(bar, 'bh-gold', '\u{1FA99}', 'Gold');
  divider(bar);
  const lumber = stat(bar, 'bh-lumber', '\u{1FAB5}', 'Lumber (contracts)');
  divider(bar);

  // Level + XP-to-next progress bar.
  const levelWrap = el('div', 'bh-stat bh-level', bar);
  levelWrap.title = 'Hero level / XP to next';
  const levelValue = el('b', 'bh-stat-value', levelWrap);
  const xpBar = el('span', 'bh-xpbar', levelWrap);
  const xpFill = el('span', 'bh-xpfill', xpBar);
  const xpText = el('span', 'bh-xptext', levelWrap);
  divider(bar);

  const kd = stat(bar, 'bh-kd', '\u{2694}', 'Kills / Deaths');
  divider(bar);

  // Connection: a colored dot plus the numeric RTT for at-a-glance health.
  const rttWrap = el('div', 'bh-stat bh-rtt', bar);
  const rtt = el('span', 'bh-rtt-dot', rttWrap);
  const rttText = el('span', 'bh-rtt-text', rttWrap);

  function update(): void {
    const you = store.match.you;
    if (you !== null) {
      gold.value.textContent = String(Math.floor(you.gold));
      lumber.value.textContent = String(Math.floor(you.lumber));
      levelValue.textContent = `Lv ${you.level}`;
      const prog = xpProgress(you.xp, you.level, ctx.catalog.xp.xpToLevel, ctx.catalog.xp.heroLevelCap);
      if (prog.needed === null) {
        xpFill.style.width = '100%';
        xpText.textContent = 'MAX';
      } else {
        const pct = prog.needed > 0 ? (prog.into / prog.needed) * 100 : 100;
        xpFill.style.width = `${pct.toFixed(1)}%`;
        xpText.textContent = `${prog.into}/${prog.needed}`;
      }
    }
    const slot = store.match.mySlot;
    const me = slot === null ? undefined : store.match.players.find((p) => p.slot === slot);
    kd.value.textContent = me !== undefined ? `${me.kills}/${me.deaths}` : '0/0';

    const { status, rttMs } = store.connection;
    let cls = 'bh-rtt-dot ';
    if (status !== 'open') cls += 'bh-rtt-dead';
    else if (rttMs <= 80) cls += 'bh-rtt-good';
    else if (rttMs <= 160) cls += 'bh-rtt-warn';
    else cls += 'bh-rtt-bad';
    rtt.className = cls;
    rttText.textContent = status === 'open' ? `${Math.round(rttMs)}ms` : status;
    rttWrap.title = status === 'open' ? `Round-trip ${Math.round(rttMs)} ms` : `connection ${status}`;
  }

  update();
  store.subscribe(update);
}

/** A single icon + value stat cell. Returns the value element to fill. */
function stat(
  parent: Element,
  modifier: string,
  icon: string,
  title: string,
): { value: HTMLElement } {
  const wrap = el('div', `bh-stat ${modifier}`, parent);
  wrap.title = title;
  const ic = el('span', 'bh-stat-icon', wrap);
  ic.textContent = icon;
  const value = el('b', 'bh-stat-value', wrap);
  return { value };
}

function divider(parent: Element): void {
  el('span', 'bh-divider', parent);
}
