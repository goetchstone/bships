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
import { initShopCue } from './shopcue.js';
import { initMinimap } from './minimap.js';
import { initScoreboard } from './scoreboard.js';
import { initChat } from './chat.js';
import { initBanner } from './banner.js';
import { initKillFeed } from './killfeed.js';
import { initOnboarding } from './onboarding.js';

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
  initShopCue(ctx);
  initMinimap(ctx);
  initScoreboard(ctx);
  initChat(ctx);
  initBanner(ctx);
  initKillFeed(ctx);
  // Onboarding (objective banner, opening tip, help/controls panel, first-shop
  // reminder). Owned by the ONBOARDING module; this registration line must
  // stay. initOnboarding injects its OWN <style> (not HUD_CSS).
  initOnboarding(ctx);

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

/**
 * All HUD styling. #hud root is pointer-events:none; children opt back in.
 *
 * LAYOUT CONTRACT (docs/RENDER.md "z-order & pointer-events"):
 *   - top-center : top bar (display-only)
 *   - bottom-left corner : minimap (framed) with the chat block stacked above
 *   - bottom-center : inventory + orders (interactive, hugs the bottom edge)
 *   - right : shop panel (interactive, opens on proximity)
 * Interactive children (pointer-events:auto) are kept to the screen edges so
 * they never cover the central ~60% play rectangle and steal a game click.
 */
export const HUD_CSS = `
#hud {
  font-size: 13px; --mini-px: 210px;
  --bh-radius: 8px; --bh-radius-sm: 5px;
  --bh-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  --bh-glass: color-mix(in srgb, var(--bg-panel) 88%, transparent);
}
#hud .bh-panel {
  background: var(--bh-glass);
  border: 1px solid var(--border);
  border-radius: var(--bh-radius);
  backdrop-filter: blur(3px);
}

/* ---- top bar (display-only; clicks fall through to the canvas) ---- */
.bh-topbar {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  display: flex; align-items: stretch; gap: 0;
  padding: 6px 16px;
  background: linear-gradient(180deg, var(--bg-panel-raised), var(--bg-panel));
  border: 1px solid var(--border); border-top: none;
  border-radius: 0 0 12px 12px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.bh-stat {
  display: flex; align-items: center; gap: 7px;
  padding: 0 14px; color: var(--text-dim);
}
.bh-stat-icon { font-size: 15px; line-height: 1; opacity: 0.9; }
.bh-stat-value {
  color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
}
.bh-divider {
  width: 1px; align-self: stretch; margin: 3px 0;
  background: var(--border); opacity: 0.6;
}
.bh-gold .bh-stat-value { color: var(--gold); }
.bh-lumber .bh-stat-value { color: var(--lumber); }
.bh-level { gap: 8px; }
.bh-xpbar {
  width: 80px; height: 7px; border-radius: 4px; overflow: hidden;
  background: var(--bg-deep);
  border: 1px solid var(--border); display: inline-block;
}
.bh-xpfill {
  display: block; height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--gold));
  transition: width 0.25s ease-out;
}
.bh-xptext { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.bh-rtt { gap: 6px; }
.bh-rtt-dot {
  width: 9px; height: 9px; border-radius: 50%;
  box-shadow: 0 0 6px currentColor;
}
.bh-rtt-text { font-size: 11px; font-variant-numeric: tabular-nums; }
.bh-rtt-good { background: var(--ready); color: var(--ready); }
.bh-rtt-warn { background: var(--gold); color: var(--gold); }
.bh-rtt-bad { background: var(--danger); color: var(--danger); }
.bh-rtt-dead { background: var(--text-dim); color: var(--text-dim); box-shadow: none; }

/* ---- inventory (bottom-center, hugs the bottom edge) ---- */
.bh-inventory {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: flex-end; gap: 12px;
  padding: 8px 11px;
  background: linear-gradient(180deg, var(--bg-panel), var(--bg-panel-raised));
  border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--bh-shadow);
  pointer-events: auto;
}
.bh-slots { display: flex; gap: 6px; }
.bh-slot {
  position: relative; width: 52px; height: 52px;
  background: radial-gradient(circle at 32% 26%, var(--bg-panel-raised), var(--bg-deep));
  border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); cursor: pointer; font: inherit;
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.05);
  transition: border-color 0.12s, box-shadow 0.12s, transform 0.08s;
}
.bh-slot:hover {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), 0 0 12px rgba(58, 169, 255, 0.4);
}
.bh-slot:active { transform: translateY(1px); }
.bh-slot.bh-empty {
  opacity: 0.45; cursor: default;
  background: var(--bg-deep);
}
.bh-slot.bh-empty:hover { border-color: var(--border); box-shadow: none; }
.bh-slot.bh-ability {
  margin-left: 10px; border-color: var(--gold);
  background: radial-gradient(circle at 32% 26%, var(--bg-panel-raised), #1a2236);
}
.bh-slot.bh-ability:not(.bh-empty):hover {
  box-shadow: 0 0 0 1px var(--gold), 0 0 12px rgba(244, 201, 92, 0.45);
}
.bh-slot-icon {
  display: flex; align-items: center; justify-content: center;
  width: 100%; height: 100%; font-size: 24px;
}
.bh-slot-key {
  position: absolute; top: 2px; left: 4px;
  font-size: 11px; font-weight: 700; color: var(--accent);
  text-shadow: 0 1px 2px #000; letter-spacing: 0.3px;
}
.bh-slot.bh-ability .bh-slot-key { color: var(--gold); }
.bh-slot-charges {
  position: absolute; bottom: 1px; right: 5px;
  font-size: 12px; font-weight: 700; color: var(--gold);
  text-shadow: 0 1px 2px #000;
}
.bh-slot-cd { position: absolute; inset: 0; border-radius: 8px; pointer-events: none; }
.bh-slot-cdtext {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 700; color: var(--text); pointer-events: none;
  text-shadow: 0 1px 3px #000;
}
.bh-orders { display: flex; flex-direction: column; gap: 5px; }
.bh-order {
  position: relative; width: 44px; height: 23px;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-panel-raised); border: 1px solid var(--border); border-radius: var(--bh-radius-sm);
  color: var(--text); cursor: pointer; font-size: 13px;
  transition: border-color 0.12s, background 0.12s, box-shadow 0.12s;
}
.bh-order:hover { border-color: var(--accent); }
.bh-order.bh-armed {
  border-color: var(--danger); background: var(--danger); color: var(--bg-deep);
  box-shadow: 0 0 10px rgba(255, 92, 92, 0.55);
}
.bh-order-icon { font-size: 13px; line-height: 1; }
.bh-order .bh-slot-key {
  position: absolute; top: -1px; right: 3px; left: auto;
  font-size: 9px; color: var(--text-dim); text-shadow: none;
}
.bh-order.bh-armed .bh-slot-key { color: var(--bg-deep); }

/* ---- shop ---- */
.bh-shop-pill {
  position: absolute; bottom: 84px; left: 50%; transform: translateX(-50%);
  padding: 6px 15px; border-radius: 999px;
  background: var(--bg-panel-raised); border: 1px solid var(--accent);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
  pointer-events: none;
}
.bh-shop-pill .bh-slot-key { position: static; font-size: 13px; }

/* ---- shop proximity cue (off-screen base shop, click to frame) ---- */
.bh-shopcue {
  position: absolute; bottom: 84px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  padding: 6px 15px; border-radius: 999px;
  background: var(--bg-panel-raised); border: 1px solid var(--gold);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
  color: var(--gold); font: inherit; font-weight: 600; cursor: pointer;
  transition: box-shadow 0.12s;
  pointer-events: auto;
}
.bh-shopcue:hover { box-shadow: 0 0 12px rgba(244, 201, 92, 0.55); }
.bh-shopcue-arrow {
  display: inline-block; font-size: 16px; line-height: 1;
  transform-origin: 50% 50%;
}
.bh-shopcue-label { font-variant-numeric: tabular-nums; }
.bh-shop {
  position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
  width: 326px; max-height: 74vh; overflow-y: auto;
  pointer-events: auto; padding: 12px;
  box-shadow: var(--bh-shadow);
}
.bh-shop-header {
  display: flex; align-items: center; gap: 8px;
  margin: -2px -2px 8px; padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.bh-shop-title { font-weight: 600; flex: 1; letter-spacing: 0.2px; }
.bh-shop-gold { color: var(--gold); font-variant-numeric: tabular-nums; font-weight: 600; }
.bh-close {
  width: 22px; height: 22px; border-radius: var(--bh-radius-sm); cursor: pointer;
  background: var(--bg-panel-raised); border: 1px solid var(--border); color: var(--text-dim);
  transition: color 0.12s, border-color 0.12s;
}
.bh-close:hover { color: var(--text); border-color: var(--accent); }
.bh-shop-section {
  color: var(--text-dim); font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.8px; margin: 11px 0 5px;
}
.bh-shop-rows { display: flex; flex-direction: column; gap: 3px; }
.bh-shop-row {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 6px 8px; border-radius: var(--bh-radius-sm); text-align: left;
  background: var(--bg-panel-raised); border: 1px solid transparent;
  color: var(--text); cursor: pointer; font: inherit; font-size: 13px;
  transition: border-color 0.1s, background 0.1s;
}
.bh-shop-row:hover:not(:disabled) {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--bg-panel-raised) 80%, var(--accent));
}
.bh-shop-row:disabled { opacity: 0.4; cursor: default; }
.bh-shop-row .bh-slot-key {
  position: static; width: 14px; flex: none; text-align: center;
  color: var(--text-dim); text-shadow: none;
}
.bh-shop-icon { flex: none; font-size: 15px; }
.bh-shop-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bh-shop-stock { flex: none; color: var(--text-dim); font-size: 11px; }
.bh-shop-stock.bh-soldout { color: var(--danger); }
.bh-shop-cost { flex: none; font-variant-numeric: tabular-nums; font-weight: 600; }
.bh-gold-text { color: var(--gold); }
.bh-lumber-text { color: var(--lumber); }

/* ---- minimap (bottom-left corner, framed; chat docks just above it) ---- */
.bh-minimap {
  position: absolute; left: 12px; bottom: 12px;
  padding: 6px;
  background: linear-gradient(180deg, var(--bg-panel-raised), var(--bg-panel));
  border: 1px solid var(--border); border-radius: var(--bh-radius);
  box-shadow: var(--bh-shadow);
  line-height: 0;
}
.bh-minimap canvas {
  cursor: crosshair; pointer-events: auto;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg-deep);
}

/* ---- scoreboard ---- */
.bh-scoreboard {
  position: absolute; top: 15%; left: 50%; transform: translateX(-50%);
  min-width: 420px; padding: 16px 20px;
  box-shadow: var(--bh-shadow);
}
.bh-score-team { font-weight: 600; margin: 10px 0 5px; letter-spacing: 0.3px; }
.bh-team-south { color: var(--team-south); }
.bh-team-north { color: var(--team-north); }
.bh-score-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.bh-score-table th, .bh-score-table td { padding: 3px 9px; text-align: right; font-size: 13px; }
.bh-score-table .bh-l { text-align: left; }
.bh-score-table th {
  color: var(--text-dim); font-weight: 400; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.6px;
  border-bottom: 1px solid var(--border);
}
.bh-score-table tr.bh-me td { color: var(--gold); }
.bh-score-table tr.bh-dc td { color: var(--text-dim); }

/* ---- chat (docked bottom-LEFT, above the minimap; never centered) ----
   The block is a fixed bottom-left-anchored flex column: justify-content
   flex-end pins the input row to the block's bottom and lets the log grow
   UPWARD above it. Only the input row captures pointer events; log lines are
   display-only so clicks fall through to the game canvas. */
.bh-chat {
  position: absolute; left: 12px; bottom: 244px;
  width: 360px; max-width: calc(100vw - 24px); max-height: 38vh;
  display: flex; flex-direction: column; justify-content: flex-end;
  gap: 4px; pointer-events: none;
}
.bh-chat-log {
  display: flex; flex-direction: column; justify-content: flex-end;
  align-items: flex-start;
  gap: 3px; overflow: hidden; min-height: 0;
  pointer-events: none;
}
.bh-chat-line {
  padding: 3px 8px; border-radius: var(--bh-radius-sm); width: fit-content; max-width: 100%;
  background: rgba(6, 16, 25, 0.8);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
  font-size: 13px; line-height: 1.4; word-break: break-word;
  transition: opacity 1.2s;
}
.bh-chat-line.bh-fade { opacity: 0; }
.bh-chat-line.bh-system { color: var(--text-dim); }
.bh-chat-line.bh-reject { color: var(--danger); }
.bh-chat-line.bh-kill { color: var(--gold); }
.bh-chat-line.bh-team-msg { color: var(--lumber); }
.bh-chat-input {
  display: flex; gap: 5px; flex: none; pointer-events: auto;
  padding-top: 2px;
}
.bh-chat-scope {
  flex: none; cursor: pointer; border-radius: var(--bh-radius-sm); font-size: 12px;
  background: var(--bg-panel-raised); border: 1px solid var(--border); color: var(--text);
}
.bh-chat-scope.bh-team-scope { color: var(--lumber); }
.bh-chat-input input {
  flex: 1; padding: 5px 9px; border-radius: var(--bh-radius-sm); font: inherit;
  background: var(--bg-panel); border: 1px solid var(--accent); color: var(--text);
  box-shadow: 0 0 0 2px rgba(58, 169, 255, 0.18); outline: none;
}

/* ---- kill feed ---- */
.bh-killfeed {
  position: absolute; top: 48px; right: 12px;
  display: flex; flex-direction: column; gap: 3px;
  align-items: flex-end;
  pointer-events: none;
}
.bh-killfeed-line {
  padding: 4px 9px; border-radius: var(--bh-radius-sm);
  background: rgba(6, 16, 25, 0.82);
  font-size: 13px; white-space: nowrap;
  transition: opacity ${1200}ms;
}
.bh-kf-player { color: var(--gold); font-weight: 600; }
.bh-kf-dim { color: var(--text-dim); }
.bh-kf-fade { opacity: 0; }

/* ---- banners ---- */
.bh-countdown {
  position: absolute; top: 22%; left: 50%; transform: translateX(-50%);
  font-size: 72px; font-weight: 700; color: var(--gold);
  text-shadow: 0 2px 16px rgba(0, 0, 0, 0.7);
  font-variant-numeric: tabular-nums;
}
.bh-toast {
  position: absolute; top: 34%; left: 50%; transform: translateX(-50%);
  font-size: 28px; font-weight: 700; color: var(--accent);
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7);
}
.bh-end {
  position: absolute; top: 18%; left: 50%; transform: translateX(-50%);
  min-width: 440px; padding: 20px 24px; text-align: center;
  box-shadow: var(--bh-shadow);
  pointer-events: auto;
}
.bh-end-title { font-size: 40px; font-weight: 700; letter-spacing: 4px; }
.bh-end-title.bh-victory { color: var(--gold); }
.bh-end-title.bh-defeat { color: var(--danger); }
.bh-end-title.bh-draw { color: var(--text-dim); }
.bh-end-sub { color: var(--text-dim); margin-bottom: 10px; }
.bh-back-btn {
  margin-top: 14px; padding: 9px 24px; border-radius: var(--bh-radius); cursor: pointer;
  background: var(--bg-panel-raised); border: 1px solid var(--accent);
  color: var(--text); font: inherit; font-weight: 600;
  transition: background 0.12s, color 0.12s;
}
.bh-back-btn:hover { background: var(--accent); color: var(--bg-deep); }
`;
