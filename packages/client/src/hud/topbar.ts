/**
 * Top bar: gold / lumber / level + XP-to-next / K-D / connection RTT dot.
 * Pure store consumer — rebuilt on the store's coarse change signal.
 */

import { store } from '../net/store.js';
import type { HudContext } from './context.js';
import { el } from './context.js';
import { xpProgress } from './hudmath.js';

export function initTopbar(ctx: HudContext): void {
  const bar = el('div', 'bh-topbar', ctx.root);

  const gold = el('span', 'bh-res bh-gold', bar);
  const goldValue = el('b', undefined, gold);

  const lumber = el('span', 'bh-res bh-lumber', bar);
  const lumberValue = el('b', undefined, lumber);

  const levelWrap = el('span', 'bh-res bh-level', bar);
  const levelValue = el('b', undefined, levelWrap);
  const xpBar = el('span', 'bh-xpbar', levelWrap);
  const xpFill = el('span', 'bh-xpfill', xpBar);
  const xpText = el('span', 'bh-xptext', levelWrap);

  const kd = el('span', 'bh-res bh-kd', bar);
  const kdValue = el('b', undefined, kd);

  const rtt = el('span', 'bh-rtt-dot', bar);

  function update(): void {
    const you = store.match.you;
    if (you !== null) {
      goldValue.textContent = String(Math.floor(you.gold));
      gold.title = 'Gold';
      lumberValue.textContent = String(Math.floor(you.lumber));
      lumber.title = 'Lumber (contracts)';
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
    const stat = slot === null ? undefined : store.match.players.find((p) => p.slot === slot);
    kdValue.textContent = stat !== undefined ? `${stat.kills}/${stat.deaths}` : '0/0';
    kd.title = 'Kills / Deaths';

    const { status, rttMs } = store.connection;
    let cls = 'bh-rtt-dot ';
    if (status !== 'open') cls += 'bh-rtt-dead';
    else if (rttMs <= 80) cls += 'bh-rtt-good';
    else if (rttMs <= 160) cls += 'bh-rtt-warn';
    else cls += 'bh-rtt-bad';
    rtt.className = cls;
    rtt.title = status === 'open' ? `RTT ${Math.round(rttMs)} ms` : `connection ${status}`;
  }

  update();
  store.subscribe(update);
}
