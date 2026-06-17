/**
 * Keyboard bindings — the single source of truth for HUD hotkeys.
 *
 * The ONLY window-level keydown/keyup listeners in the client live here
 * (client-render uses canvas pointer events only; chat attaches element-level
 * listeners to its own input, which is allowed). Dispatch rules:
 * - All dispatch is suppressed while a text input is focused (chat).
 * - Tab is always preventDefault-ed (no browser focus cycling mid-match).
 * - Bound actions fire on BOTH keydown and keyup (the same subscriber
 *   signature; check `e.type`) so hold-style actions (scoreboard) work.
 *   Auto-repeat keydowns are swallowed.
 * - Rebind-ready: overrides persist in localStorage under 'bships.keybinds';
 *   `setBinding` updates them at runtime.
 *
 * NO numpad codes anywhere — defaults are the left-hand cluster per
 * docs/DESIGN.md.
 */

export type HudAction =
  | 'slot0'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'slot5'
  | 'ability0'
  | 'ability1'
  | 'ability2'
  | 'ability3'
  | 'ability4'
  | 'ability5'
  | 'stop'
  | 'attackMove'
  | 'scoreboard'
  | 'chat'
  | 'shopToggle'
  | 'help'
  | 'recenter';

/** Stable action order — also the precedence order when codes collide. */
export const HUD_ACTIONS: readonly HudAction[] = [
  'slot0',
  'slot1',
  'slot2',
  'slot3',
  'slot4',
  'slot5',
  'ability0',
  'ability1',
  'ability2',
  'ability3',
  'ability4',
  'ability5',
  'stop',
  'attackMove',
  'scoreboard',
  'chat',
  'shopToggle',
  'help',
  'recenter',
];

/**
 * The hull spellbook hotkeys, in slot order. A hull renders ONE quick-key per
 * ability it carries (a Sailor ~5, a Crusader 6), so these must outnumber the
 * largest hull's ability set. Kept as a left-hand grouped cluster distinct from
 * the W/E/R/A/S/D item slots: F (the legacy ship-ability key, kept first for
 * muscle memory) then Q T C X Z. Consumed by hud/inventory.ts.
 */
export const ABILITY_ACTIONS: readonly HudAction[] = [
  'ability0',
  'ability1',
  'ability2',
  'ability3',
  'ability4',
  'ability5',
];

/**
 * Default bindings, keyed by `KeyboardEvent.code`.
 *
 * `help` toggles the onboarding controls/help panel (hud/onboarding.ts);
 * `recenter` re-engages the camera follow on the player ship (camera.ts
 * `recenterOnPlayer`). Both are rebind-ready like every other action.
 */
export const DEFAULT_BINDINGS: Record<HudAction, string> = {
  slot0: 'KeyW',
  slot1: 'KeyE',
  slot2: 'KeyR',
  slot3: 'KeyA',
  slot4: 'KeyS',
  slot5: 'KeyD',
  // Hull spellbook: F kept as the primary ability key (legacy muscle memory),
  // then the rest of the left-hand cluster Q T C X Z. None collide with the
  // item slots / movement / stop / attack-move / shop keys.
  ability0: 'KeyF',
  ability1: 'KeyQ',
  ability2: 'KeyT',
  ability3: 'KeyC',
  ability4: 'KeyX',
  ability5: 'KeyZ',
  stop: 'KeyV',
  attackMove: 'KeyG',
  scoreboard: 'Tab',
  chat: 'Enter',
  shopToggle: 'KeyB',
  help: 'F1',
  recenter: 'Space',
};

const STORAGE_KEY = 'bships.keybinds';

type ActionListener = (action: HudAction, e: KeyboardEvent) => void;

/**
 * Raw-key subscriber (additive API beyond the frozen exports): runs before
 * action dispatch; returning `true` consumes the event. Used by the shop
 * panel for its Digit1-9 buy hotkeys while open.
 */
type RawKeyListener = (e: KeyboardEvent) => boolean | void;

let overrides: Partial<Record<HudAction, string>> = loadOverrides();
const actionListeners = new Set<ActionListener>();
const rawListeners = new Set<RawKeyListener>();
let installed = false;

function isHudAction(value: string): value is HudAction {
  return (HUD_ACTIONS as readonly string[]).includes(value);
}

function loadOverrides(): Partial<Record<HudAction, string>> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Partial<Record<HudAction, string>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isHudAction(key) && typeof value === 'string' && value.length > 0) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistOverrides(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Storage full/blocked — overrides still apply for this session.
  }
}

/** The effective `KeyboardEvent.code` for an action (override aware). */
export function bindingFor(action: HudAction): string {
  return overrides[action] ?? DEFAULT_BINDINGS[action];
}

/** Rebind an action; persisted to localStorage. */
export function setBinding(action: HudAction, code: string): void {
  if (code === DEFAULT_BINDINGS[action]) {
    delete overrides[action];
  } else {
    overrides[action] = code;
  }
  persistOverrides();
}

/**
 * Reverse lookup: action bound to a code, or null. When two actions share a
 * code (mid-rebind), the first in HUD_ACTIONS order wins.
 */
export function actionForCode(code: string): HudAction | null {
  for (const action of HUD_ACTIONS) {
    if (bindingFor(action) === code) return action;
  }
  return null;
}

function isTextInputFocused(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * The single key handler. Exported so pure-logic tests can drive dispatch
 * with synthetic events (no DOM required) — production code must not call
 * it directly.
 */
export function handleKeyEvent(e: KeyboardEvent): void {
  if (isTextInputFocused()) return;
  // Keys whose browser default would steal focus / scroll / open help mid-match
  // are always suppressed, bound or not.
  if (e.code === 'Tab' || e.code === 'F1' || e.code === 'Space') e.preventDefault();
  for (const fn of [...rawListeners]) {
    if (fn(e) === true) return;
  }
  const action = actionForCode(e.code);
  if (action === null) return;
  if (e.type === 'keydown') {
    if (e.repeat) return;
    e.preventDefault();
  }
  for (const fn of [...actionListeners]) fn(action, e);
}

function ensureInstalled(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', handleKeyEvent);
  window.addEventListener('keyup', handleKeyEvent);
}

/**
 * Subscribe to bound-action key events (keydown AND keyup — check `e.type`).
 * Returns the unsubscribe function. Installs the window listeners on first
 * use.
 */
export function onAction(fn: ActionListener): () => void {
  ensureInstalled();
  actionListeners.add(fn);
  return () => {
    actionListeners.delete(fn);
  };
}

/**
 * Subscribe to every non-suppressed key event before action dispatch;
 * return `true` to consume. Shop digit hotkeys use this.
 */
export function onRawKey(fn: RawKeyListener): () => void {
  ensureInstalled();
  rawListeners.add(fn);
  return () => {
    rawListeners.delete(fn);
  };
}

/** Test seam: clear overrides and subscribers (module state is global). */
export function resetKeymapForTests(): void {
  overrides = {};
  actionListeners.clear();
  rawListeners.clear();
}
