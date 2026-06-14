/**
 * Onboarding HUD: the first-time legibility layer that fixes the owner's "had
 * no idea what to do" feedback (CLAUDE.md "ONBOARDING"). Four pieces, all DOM
 * overlay inside #hud, all pointer-events-aware so they never steal a game
 * click:
 *
 *  1. OBJECTIVE banner — a persistent, unobtrusive line stating the goal
 *     ("Destroy the enemy Main Harbor"), shown for the first stretch of the
 *     match (or until dismissed), so the player always knows what winning is.
 *  2. OPENING TIP — a short first-actions hint ("Sail to your harbor shops to
 *     buy a cannon, then push a lane"), shown once at match start.
 *  3. HELP / CONTROLS panel — a toggleable (F1) reference of the current
 *     keybindings + how to buy / move / attack-move, built from the keymap so
 *     it always reflects the live (rebound) keys.
 *  4. "Buy here" prompt reinforcement — onboarding may add a one-line
 *     reminder when the player is near a shop for the FIRST time; the live
 *     "press B" affordance itself stays in hud/shop.ts (do not duplicate it).
 *
 * OWNERSHIP / boundaries (onboarding module):
 *  - This module injects its OWN <style> block (BH_ONBOARD_CSS, id
 *    'bh-onboard-style') so it does NOT touch hud.ts's HUD_CSS string — the
 *    POLISH module owns HUD_CSS + index.html palette + the layout-contract
 *    tests. Onboarding styles must REUSE the index.html CSS variables
 *    (var(--bg-panel), var(--text), var(--accent), var(--gold)...) so a palette
 *    change by polish flows through automatically. Keep min 12px text.
 *  - Reads game state ONLY through the client-net store (store.match.phase /
 *    .myTeam / .you) and the static catalog (ctx.catalog) — NO sim logic on the
 *    client. The objective ("which structure is the enemy HQ") is read from the
 *    static map (catalog.map.structures role 'hq') by team, never computed.
 *  - The help toggle key is the shared keymap action 'help' (default F1); use
 *    onAction + bindingFor/keyLabel from input/keymap so it stays rebindable.
 *    Do NOT add a second window key listener.
 *  - Driven by ctx.onFrame (the single HUD rAF loop) and store.subscribe for
 *    phase changes — never its own rAF/timer loop where avoidable.
 *
 * The pure helpers below (enemy-HQ resolution, help-row build, tip/reminder
 * state) are DOM-free and unit-tested in test/hud.test.ts; initOnboarding wires
 * them to the DOM + keymap + store.
 */

import type { Ruleset, TeamId } from '@bships/core';
import { store } from '../net/store.js';
import {
  bindingFor,
  onAction,
} from '../input/keymap.js';
import type { HudAction } from '../input/keymap.js';
import { recenterOnPlayer } from '../render/camera.js';
import type { HudContext } from './context.js';
import { el } from './context.js';
import { keyLabel } from './hudmath.js';

const STYLE_ID = 'bh-onboard-style';

/** Generic copy when the enemy HQ structure can't be resolved from the map. */
const FALLBACK_HQ_NAME = 'enemy Main Harbor';

/** First-actions hint shown once when the match begins. */
export const OPENING_TIP_TEXT =
  'Sail to your harbor shops to buy a cannon, then push a lane.';

// ---------------------------------------------------------------------------
// Pure logic (DOM-free, unit-tested)
// ---------------------------------------------------------------------------

/** Minimal shape of a catalog map structure for the objective lookup. */
interface ObjectiveStructureLike {
  role: string;
  owner: number | null;
  typeId: string;
}

/**
 * Resolve the enemy HQ ("Main Harbor") display name from the STATIC map. The
 * enemy HQ is the `hq` structure whose owner sits on the team that is NOT the
 * player's (owner slot -> team via `playerStarts`). Never computed from the
 * sim. Falls back to a generic name when the team is unknown (spectator /
 * pre-slot) or the map carries no opposing HQ.
 */
export function enemyHqName(
  structures: readonly ObjectiveStructureLike[],
  playerStarts: Record<number, { team: TeamId }>,
  unitTypeName: (typeId: string) => string | undefined,
  myTeam: TeamId | null,
): string {
  if (myTeam === null) return FALLBACK_HQ_NAME;
  for (const s of structures) {
    if (s.role !== 'hq' || s.owner === null) continue;
    const team = playerStarts[s.owner]?.team;
    if (team === undefined || team === myTeam) continue;
    const name = unitTypeName(s.typeId);
    return name !== undefined && name.length > 0 ? name : FALLBACK_HQ_NAME;
  }
  return FALLBACK_HQ_NAME;
}

/** A single help-panel control row: a key chip plus what it does. */
export interface HelpRow {
  /** Short key label(s), e.g. "W" / "TAB" / "Right-click". */
  keys: string;
  /** Plain-language action. */
  label: string;
}

/**
 * The help/controls rows, in reading order. Hotkey rows are labeled via the
 * LIVE keymap (bindingFor + keyLabel) so they track rebinds; mouse rows and
 * the W..D item-slot summary are static text. `actionLabel` resolves a key
 * label for an action so tests can inject a deterministic stub.
 */
export function helpRows(actionLabel: (action: HudAction) => string): HelpRow[] {
  const rows: HelpRow[] = [];
  // Movement / orders (mouse + the rebindable order keys).
  rows.push({ keys: 'Right-click', label: 'Move / attack a target' });
  rows.push({ keys: actionLabel('attackMove'), label: 'Attack-move (then click)' });
  rows.push({ keys: actionLabel('stop'), label: 'Stop' });
  rows.push({ keys: actionLabel('recenter'), label: 'Recenter on your ship' });
  // Shop.
  rows.push({ keys: actionLabel('shopToggle'), label: 'Buy at a shop (when near one)' });
  // Abilities / items — the six inventory slots collapse to one readable row.
  const slotKeys = [
    actionLabel('slot0'),
    actionLabel('slot1'),
    actionLabel('slot2'),
    actionLabel('slot3'),
    actionLabel('slot4'),
    actionLabel('slot5'),
  ].join(' ');
  rows.push({ keys: slotKeys, label: 'Use inventory items' });
  rows.push({ keys: actionLabel('shipAbility'), label: 'Ship ability' });
  // Info.
  rows.push({ keys: actionLabel('scoreboard'), label: 'Scoreboard (hold)' });
  rows.push({ keys: actionLabel('chat'), label: 'Chat' });
  rows.push({ keys: actionLabel('help'), label: 'Toggle this help' });
  return rows;
}

/**
 * Tracks the once-only onboarding cues across store updates. Pure so the
 * sequencing (tip shows once when phase first reaches 'playing'; the shop
 * reminder shows once on the first shop proximity while playing) is testable
 * without a DOM.
 */
export class OnboardingState {
  private tipShown = false;
  private reminderShown = false;
  private wasPlaying = false;

  /**
   * Call on every store change. Returns whether the opening tip should be
   * REVEALED on this transition: true exactly once, on the first edge into the
   * 'playing' phase.
   */
  onPhase(phase: string): boolean {
    const playing = phase === 'playing';
    const entered = playing && !this.wasPlaying;
    this.wasPlaying = playing;
    if (entered && !this.tipShown) {
      this.tipShown = true;
      return true;
    }
    return false;
  }

  /**
   * Call each frame with the live shop-proximity entity id (store.ui
   * .shopEntityId). Returns true exactly once — the first frame the player is
   * near any shop while playing — so the "press B" reminder fires a single
   * time. No-op before the match (so it doesn't burn on a stale id).
   */
  onShopProximity(shopEntityId: number | null, playing: boolean): boolean {
    if (!playing || shopEntityId === null || this.reminderShown) return false;
    this.reminderShown = true;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Stylesheet (reuses the index.html CSS variables; polish owns the palette)
// ---------------------------------------------------------------------------

/**
 * Onboarding's own stylesheet (kept OUT of hud.ts's HUD_CSS so polish owns that
 * string + its layout tests). Reuse the index.html CSS variables for every
 * color so the palette stays single-sourced. All text >= 12px, all panels
 * pointer-events-aware (only the interactive help/close opt in).
 */
export const BH_ONBOARD_CSS = `
/* ---- objective banner (top-left, display-only) ---- */
.bh-objective {
  position: absolute; top: 10px; left: 12px;
  display: flex; align-items: center; gap: 7px;
  padding: 5px 12px; border-radius: 7px;
  background: var(--bg-panel); border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  font-size: 13px; pointer-events: none;
}
.bh-objective-icon { font-size: 14px; line-height: 1; }
.bh-objective-label { color: var(--text-dim); }
.bh-objective-goal { color: var(--text); font-weight: 700; }
.bh-objective-hint {
  color: var(--text-dim); font-size: 11px; opacity: 0.85;
}
.bh-objective-hint .bh-key { font-size: 11px; }

/* ---- opening tip toast (top-center, below the top bar; display-only) ---- */
.bh-onboard-tip {
  position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
  max-width: min(560px, 92vw); text-align: center;
  padding: 7px 16px; border-radius: 8px;
  background: var(--bg-panel-raised); border: 1px solid var(--accent);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.5);
  color: var(--text); font-size: 14px; font-weight: 600;
  pointer-events: none;
  transition: opacity 0.6s ease-out;
}
.bh-onboard-tip.bh-fade { opacity: 0; }

/* ---- first-shop reminder (above the inventory; display-only) ---- */
.bh-onboard-shopreminder {
  position: absolute; bottom: 118px; left: 50%; transform: translateX(-50%);
  padding: 5px 14px; border-radius: 14px;
  background: var(--bg-panel-raised); border: 1px solid var(--gold);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  color: var(--gold); font-size: 13px; font-weight: 700;
  pointer-events: none;
  transition: opacity 0.6s ease-out;
}
.bh-onboard-shopreminder.bh-fade { opacity: 0; }

/* ---- help / controls panel (centered; the close button opts into clicks) ---- */
.bh-help {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 360px; max-width: 92vw; max-height: 80vh; overflow-y: auto;
  padding: 14px 18px;
  background: var(--bg-panel); border: 1px solid var(--border-bright);
  border-radius: 10px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
  pointer-events: auto;
}
.bh-help-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.bh-help-title { flex: 1; font-size: 16px; font-weight: 800; color: var(--text); }
.bh-help-close {
  width: 24px; height: 24px; border-radius: 5px; cursor: pointer;
  background: var(--bg-panel-raised); border: 1px solid var(--border); color: var(--text);
  font: inherit; font-size: 15px;
}
.bh-help-close:hover { border-color: var(--accent); }
.bh-help-rows { display: flex; flex-direction: column; gap: 4px; }
.bh-help-row {
  display: flex; align-items: center; gap: 10px;
  padding: 3px 4px; font-size: 13px; color: var(--text);
}
.bh-help-keys {
  flex: none; min-width: 92px;
  display: flex; flex-wrap: wrap; gap: 4px;
}
.bh-help-label { flex: 1; color: var(--text-dim); }
.bh-key {
  display: inline-block; padding: 1px 7px; border-radius: 4px;
  background: var(--bg-deep); border: 1px solid var(--border);
  color: var(--accent); font-size: 12px; font-weight: 800;
  font-variant-numeric: tabular-nums; line-height: 1.4;
}
.bh-help-foot {
  margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border);
  color: var(--text-dim); font-size: 12px;
}
`;

function injectStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = BH_ONBOARD_CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// DOM wiring (browser only — never invoked by the pure tests)
// ---------------------------------------------------------------------------

/** Resolve the enemy HQ name once from the static catalog for `myTeam`. */
function catalogEnemyHqName(catalog: Ruleset, myTeam: TeamId | null): string {
  return enemyHqName(
    catalog.map.structures,
    catalog.map.playerStarts,
    (typeId) => catalog.unitTypes[typeId]?.name,
    myTeam,
  );
}

/** A key chip element ('<span class="bh-key">W</span>'). */
function keyChip(parent: Element, code: string): void {
  const chip = el('span', 'bh-key', parent);
  chip.textContent = code;
}

export function initOnboarding(ctx: HudContext): void {
  injectStyles();

  // Mutable state shared by the panels (declared up front so every closure
  // below captures an already-initialized binding).
  const onboarding = new OnboardingState();
  let enemyHqLabel = FALLBACK_HQ_NAME;
  let cachedTeam: TeamId | null | undefined;

  // -- objective banner (persistent; top-left, display-only) -----------------
  const objective = el('div', 'bh-objective bh-panel', ctx.root);
  objective.hidden = true;
  el('span', 'bh-objective-icon', objective).textContent = '\u{1F3AF}'; // 🎯
  el('span', 'bh-objective-label', objective).textContent = 'Objective:';
  const objectiveGoal = el('span', 'bh-objective-goal', objective);
  const objectiveHint = el('span', 'bh-objective-hint', objective);

  // -- opening tip toast (once, on first 'playing') --------------------------
  const tip = el('div', 'bh-onboard-tip', ctx.root);
  tip.hidden = true;
  tip.textContent = OPENING_TIP_TEXT;
  let tipFadeTimer: ReturnType<typeof setTimeout> | null = null;
  let tipHideTimer: ReturnType<typeof setTimeout> | null = null;

  function showTip(): void {
    if (tipFadeTimer !== null) clearTimeout(tipFadeTimer);
    if (tipHideTimer !== null) clearTimeout(tipHideTimer);
    tip.classList.remove('bh-fade');
    tip.hidden = false;
    tipFadeTimer = setTimeout(() => tip.classList.add('bh-fade'), 7000);
    tipHideTimer = setTimeout(() => {
      tip.hidden = true;
    }, 7700);
  }

  // -- first-shop reminder (once, on first shop proximity) -------------------
  const shopReminder = el('div', 'bh-onboard-shopreminder', ctx.root);
  shopReminder.hidden = true;
  shopReminder.innerHTML = `Press <span class="bh-key"></span> to buy here.`;
  const shopReminderKey = shopReminder.querySelector('.bh-key') as HTMLElement;
  let reminderFadeTimer: ReturnType<typeof setTimeout> | null = null;
  let reminderHideTimer: ReturnType<typeof setTimeout> | null = null;

  function showShopReminder(): void {
    if (reminderFadeTimer !== null) clearTimeout(reminderFadeTimer);
    if (reminderHideTimer !== null) clearTimeout(reminderHideTimer);
    shopReminderKey.textContent = keyLabel(bindingFor('shopToggle'));
    shopReminder.classList.remove('bh-fade');
    shopReminder.hidden = false;
    reminderFadeTimer = setTimeout(() => shopReminder.classList.add('bh-fade'), 4500);
    reminderHideTimer = setTimeout(() => {
      shopReminder.hidden = true;
    }, 5100);
  }

  // -- help / controls panel (toggled by the 'help' action) ------------------
  const help = el('div', 'bh-help', ctx.root);
  help.hidden = true;
  const helpHeader = el('div', 'bh-help-header', help);
  el('span', 'bh-help-title', helpHeader).textContent = 'Controls';
  const helpClose = el('button', 'bh-help-close', helpHeader);
  helpClose.type = 'button';
  helpClose.textContent = '×'; // ×
  helpClose.addEventListener('click', () => setHelpOpen(false));
  const helpRowsBox = el('div', 'bh-help-rows', help);
  const helpFoot = el('div', 'bh-help-foot', help);

  let helpBuiltKey = '';
  function rebuildHelp(): void {
    // Rebuild only when a binding actually changed (cheap dirty-check).
    const rows = helpRows((action) => keyLabel(bindingFor(action)));
    const key = rows.map((r) => `${r.keys}=${r.label}`).join('|');
    if (key === helpBuiltKey) return;
    helpBuiltKey = key;
    helpRowsBox.textContent = '';
    for (const row of rows) {
      const rowEl = el('div', 'bh-help-row', helpRowsBox);
      const keysEl = el('span', 'bh-help-keys', rowEl);
      // Space-separated labels (e.g. the W..D item slots) each get a chip;
      // mouse rows ("Right-click") render as a single chip verbatim.
      const parts = row.keys.includes(' ') ? row.keys.split(' ') : [row.keys];
      for (const part of parts) keyChip(keysEl, part);
      el('span', 'bh-help-label', rowEl).textContent = row.label;
    }
    helpFoot.textContent = `Destroy the ${enemyHqLabel} to win.`;
  }

  let helpOpen = false;
  function setHelpOpen(next: boolean): void {
    if (helpOpen === next) return;
    helpOpen = next;
    if (helpOpen) rebuildHelp();
    help.hidden = !helpOpen;
  }

  // Shared 'help' action toggles the panel; 'recenter' re-engages camera follow
  // (the binding exists; the camera fn is exported). No new window listener.
  onAction((action, e) => {
    if (e.type !== 'keydown') return;
    if (action === 'help') setHelpOpen(!helpOpen);
    else if (action === 'recenter') recenterOnPlayer();
  });

  // -- state: resolve enemy HQ + drive once-only cues ------------------------
  const shopHint = `Near a shop? Press ${keyLabel(bindingFor('shopToggle'))} to buy.`;

  function refreshObjective(): void {
    const myTeam = store.match.myTeam;
    if (myTeam !== cachedTeam) {
      cachedTeam = myTeam;
      enemyHqLabel = catalogEnemyHqName(ctx.catalog, myTeam);
      objectiveGoal.textContent = `Destroy the ${enemyHqLabel}`;
      // Keep the help footer in sync if it has already been built.
      helpBuiltKey = '';
    }
    // The objective banner is meaningful only once a match is live.
    objective.hidden = store.match.phase !== 'playing';
  }

  objectiveHint.textContent = `— ${shopHint}`; // — Near a shop? ...

  store.subscribe(() => {
    refreshObjective();
    if (onboarding.onPhase(store.match.phase)) showTip();
  });
  refreshObjective();

  // First shop-proximity reminder rides the frame loop (shop.ts owns/writes
  // store.ui.shopEntityId each frame).
  ctx.onFrame(() => {
    const playing = store.match.phase === 'playing';
    if (onboarding.onShopProximity(store.ui.shopEntityId, playing)) showShopReminder();
  });
}
