/**
 * HUD composer: injects the HUD stylesheet, builds every panel inside the
 * #hud overlay root and drives the single HUD rAF loop (cooldown sweeps,
 * shop proximity, minimap redraw). All colors come from the index.html CSS
 * variables; everything stays legible at competitive pace (min 12px text,
 * no decorative fonts).
 */

import { getCatalog } from '../catalog.js';
import type { HudContext } from './context.js';
import { initTopbar } from './topbar.js';
import { initInventory } from './inventory.js';
import { initShop } from './shop.js';
import { initMinimap } from './minimap.js';
import { initScoreboard } from './scoreboard.js';
import { initChat } from './chat.js';
import { initBanner } from './banner.js';

const STYLE_ID = 'bh-hud-style';

let initialized = false;

export function initHud(opts: { root: HTMLElement }): void {
  if (initialized) return;
  initialized = true;

  injectStyles();

  const frameFns: ((nowMs: number) => void)[] = [];
  const ctx: HudContext = {
    root: opts.root,
    catalog: getCatalog(),
    onFrame(fn) {
      frameFns.push(fn);
    },
  };

  initTopbar(ctx);
  initInventory(ctx);
  initShop(ctx);
  initMinimap(ctx);
  initScoreboard(ctx);
  initChat(ctx);
  initBanner(ctx);

  function loop(nowMs: number): void {
    for (const fn of frameFns) {
      try {
        fn(nowMs);
      } catch (err) {
        // One broken panel must not stall the whole HUD.
        console.error('[hud] frame handler failed', err);
      }
    }
    requestAnimationFrame(loop);
  }
  if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(loop);
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = HUD_CSS;
  document.head.appendChild(style);
}

/** All HUD styling. #hud root is pointer-events:none; children opt back in. */
const HUD_CSS = `
#hud { font-size: 13px; }
#hud .bh-panel {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 6px;
}

/* ---- top bar ---- */
.bh-topbar {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 18px;
  padding: 6px 16px;
  background: var(--bg-panel); border: 1px solid var(--border);
  border-top: none; border-radius: 0 0 6px 6px;
  pointer-events: auto;
}
.bh-res { color: var(--text-dim); display: flex; align-items: center; gap: 5px; }
.bh-res b { color: var(--text); font-variant-numeric: tabular-nums; }
.bh-gold b { color: var(--gold); }
.bh-gold::before { content: '\\1FA99'; }
.bh-lumber b { color: var(--lumber); }
.bh-lumber::before { content: '\\1FAB5'; }
.bh-xpbar {
  width: 72px; height: 6px; border-radius: 3px; overflow: hidden;
  background: var(--bg-deep); border: 1px solid var(--border); display: inline-block;
}
.bh-xpfill { display: block; height: 100%; background: var(--accent); }
.bh-xptext { font-size: 12px; font-variant-numeric: tabular-nums; }
.bh-rtt-dot { width: 10px; height: 10px; border-radius: 50%; }
.bh-rtt-good { background: var(--lumber); }
.bh-rtt-warn { background: var(--gold); }
.bh-rtt-bad { background: var(--danger); }
.bh-rtt-dead { background: var(--text-dim); }

/* ---- inventory ---- */
.bh-inventory {
  position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: flex-end; gap: 10px;
  pointer-events: auto;
}
.bh-slots { display: flex; gap: 6px; }
.bh-slot {
  position: relative; width: 52px; height: 52px;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px;
  color: var(--text); cursor: pointer; font: inherit;
}
.bh-slot:hover { border-color: var(--accent); }
.bh-slot.bh-empty { opacity: 0.55; cursor: default; }
.bh-slot.bh-ability { border-color: var(--accent); margin-left: 8px; }
.bh-slot-icon { font-size: 22px; line-height: 50px; }
.bh-slot-key {
  position: absolute; top: 1px; left: 3px;
  font-size: 12px; font-weight: 700; color: var(--accent);
  text-shadow: 0 1px 2px #000;
}
.bh-slot-charges {
  position: absolute; bottom: 1px; right: 4px;
  font-size: 12px; font-weight: 700; color: var(--gold);
  text-shadow: 0 1px 2px #000;
}
.bh-slot-cd { position: absolute; inset: 0; border-radius: 6px; pointer-events: none; }
.bh-slot-cdtext {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; color: var(--text); pointer-events: none;
  text-shadow: 0 1px 2px #000;
}
.bh-orders { display: flex; flex-direction: column; gap: 4px; }
.bh-order {
  position: relative; width: 40px; height: 24px;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px;
  color: var(--text); cursor: pointer; font-size: 12px;
}
.bh-order:hover { border-color: var(--accent); }
.bh-order.bh-armed { border-color: var(--danger); background: var(--bg-panel-raised); }
.bh-order .bh-slot-key { position: absolute; top: -1px; left: 2px; font-size: 10px; }

/* ---- shop ---- */
.bh-shop-pill {
  position: absolute; bottom: 76px; left: 50%; transform: translateX(-50%);
  padding: 5px 14px; border-radius: 14px;
  background: var(--bg-panel-raised); border: 1px solid var(--accent);
  pointer-events: none;
}
.bh-shop-pill .bh-slot-key { position: static; font-size: 13px; }
.bh-shop {
  position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
  width: 320px; max-height: 72vh; overflow-y: auto;
  pointer-events: auto; padding: 10px;
}
.bh-shop-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.bh-shop-title { font-weight: 700; flex: 1; }
.bh-shop-gold { color: var(--gold); font-variant-numeric: tabular-nums; }
.bh-close {
  width: 22px; height: 22px; border-radius: 4px; cursor: pointer;
  background: var(--bg-panel-raised); border: 1px solid var(--border); color: var(--text);
}
.bh-shop-section { color: var(--text-dim); font-size: 12px; text-transform: uppercase; margin: 8px 0 4px; }
.bh-shop-rows { display: flex; flex-direction: column; gap: 3px; }
.bh-shop-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 4px 6px; border-radius: 4px; text-align: left;
  background: var(--bg-panel-raised); border: 1px solid var(--border);
  color: var(--text); cursor: pointer; font: inherit; font-size: 13px;
}
.bh-shop-row:hover:not(:disabled) { border-color: var(--accent); }
.bh-shop-row:disabled { opacity: 0.45; cursor: default; }
.bh-shop-row .bh-slot-key { position: static; width: 12px; flex: none; }
.bh-shop-icon { flex: none; }
.bh-shop-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bh-shop-stock { flex: none; color: var(--text-dim); font-size: 12px; }
.bh-shop-stock.bh-soldout { color: var(--danger); }
.bh-shop-cost { flex: none; font-variant-numeric: tabular-nums; }
.bh-gold-text { color: var(--gold); }
.bh-lumber-text { color: var(--lumber); }

/* ---- minimap ---- */
.bh-minimap {
  position: absolute; left: 12px; bottom: 12px;
  border: 1px solid var(--border); border-radius: 4px; overflow: hidden;
  background: var(--bg-deep);
  pointer-events: auto; line-height: 0;
}
.bh-minimap canvas { cursor: crosshair; }

/* ---- scoreboard ---- */
.bh-scoreboard {
  position: absolute; top: 15%; left: 50%; transform: translateX(-50%);
  min-width: 420px; padding: 14px 18px;
}
.bh-score-team { font-weight: 700; margin: 8px 0 4px; }
.bh-team-south { color: var(--team-south); }
.bh-team-north { color: var(--team-north); }
.bh-score-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.bh-score-table th, .bh-score-table td { padding: 2px 8px; text-align: right; font-size: 13px; }
.bh-score-table .bh-l { text-align: left; }
.bh-score-table th { color: var(--text-dim); font-weight: 400; border-bottom: 1px solid var(--border); }
.bh-score-table tr.bh-me td { color: var(--gold); }
.bh-score-table tr.bh-dc td { color: var(--text-dim); }

/* ---- chat ---- */
.bh-chat {
  position: absolute; left: 12px; bottom: 248px; width: 360px;
  display: flex; flex-direction: column; gap: 4px;
}
.bh-chat-line {
  padding: 2px 6px; border-radius: 3px; width: fit-content; max-width: 100%;
  background: rgba(7, 17, 28, 0.72);
  font-size: 13px; transition: opacity 1.2s;
}
.bh-chat-line.bh-fade { opacity: 0; }
.bh-chat-line.bh-system { color: var(--text-dim); }
.bh-chat-line.bh-reject { color: var(--danger); }
.bh-chat-line.bh-kill { color: var(--gold); }
.bh-chat-line.bh-team-msg { color: var(--lumber); }
.bh-chat-input { display: flex; gap: 4px; pointer-events: auto; }
.bh-chat-scope {
  flex: none; cursor: pointer; border-radius: 4px; font-size: 12px;
  background: var(--bg-panel-raised); border: 1px solid var(--border); color: var(--text);
}
.bh-chat-scope.bh-team-scope { color: var(--lumber); }
.bh-chat-input input {
  flex: 1; padding: 4px 8px; border-radius: 4px; font: inherit;
  background: var(--bg-panel); border: 1px solid var(--accent); color: var(--text);
  outline: none;
}

/* ---- banners ---- */
.bh-countdown {
  position: absolute; top: 22%; left: 50%; transform: translateX(-50%);
  font-size: 72px; font-weight: 800; color: var(--gold);
  text-shadow: 0 2px 12px #000;
}
.bh-toast {
  position: absolute; top: 34%; left: 50%; transform: translateX(-50%);
  font-size: 28px; font-weight: 800; color: var(--accent);
  text-shadow: 0 2px 8px #000;
}
.bh-end {
  position: absolute; top: 18%; left: 50%; transform: translateX(-50%);
  min-width: 440px; padding: 18px 22px; text-align: center;
  pointer-events: auto;
}
.bh-end-title { font-size: 40px; font-weight: 800; letter-spacing: 4px; }
.bh-end-title.bh-victory { color: var(--gold); }
.bh-end-title.bh-defeat { color: var(--danger); }
.bh-end-title.bh-draw { color: var(--text-dim); }
.bh-end-sub { color: var(--text-dim); margin-bottom: 10px; }
.bh-back-btn {
  margin-top: 14px; padding: 8px 22px; border-radius: 6px; cursor: pointer;
  background: var(--bg-panel-raised); border: 1px solid var(--accent);
  color: var(--text); font: inherit; font-weight: 700;
}
.bh-back-btn:hover { background: var(--accent); color: var(--bg-deep); }
`;
