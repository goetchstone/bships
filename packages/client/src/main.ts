/**
 * Client entry point (owned by client-net). Boot order per docs/ARCH.md:
 *
 *   getIdentity -> connect(ws) -> lobby screens (#screens)
 *   on first snapshot: hide #screens, await initRenderer({mount: #stage}),
 *   initHud({root: #hud}), unhide #hud
 *
 * client-render / client-hud are loaded lazily via import.meta.glob so this
 * module builds and runs before those modules exist (the globs simply match
 * nothing); once their files land they are bundled as lazy chunks with zero
 * changes here. After `matchEnded` the renderer stays alive; returnToLobby()
 * flips match.phase back to 'idle', which re-shows #screens and hides #hud.
 */

import { installCrashTrap, setCrashContextProvider } from './debug/crashtrap.js';
import { initLobby } from './lobby/lobby.js';
import { getIdentity } from './net/identity.js';
import { connect } from './net/socket.js';
import { store } from './net/store.js';

interface RendererModule {
  initRenderer(opts: { mount: HTMLElement }): Promise<void> | void;
}

interface HudModule {
  initHud(opts: { root: HTMLElement }): void;
}

const rendererGlob = import.meta.glob('./render/renderer.ts');
const hudGlob = import.meta.glob('./hud/hud.ts');

function requireRoot(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id} root`);
  return node;
}

// 0. Crash trap, before anything else can throw (STATUS.md task #15).
installCrashTrap();
setCrashContextProvider(() => ({
  phase: store.match.phase,
  mySlot: store.match.mySlot,
  latestTick: store.match.latestTick,
  selectedEntityId: store.ui.selectedEntityId,
}));

const screens = requireRoot('screens');
const stage = requireRoot('stage');
const hud = requireRoot('hud');

// 1. Identity (mints + persists the token on first run).
const identity = getIdentity();
store.identity.token = identity.token;
store.identity.name = identity.name;

// 2. Socket (auto-reconnect; hello on every open).
connect();

// 3. Lobby screens.
initLobby(screens);

// 4. Match UI lifecycle, driven by store.match.phase.
let matchUiReady = false;
let matchUiLoading = false;

async function startMatchUi(): Promise<void> {
  matchUiLoading = true;
  try {
    const loadRenderer = rendererGlob['./render/renderer.ts'];
    const loadHud = hudGlob['./hud/hud.ts'];
    if (loadRenderer !== undefined) {
      const renderer = (await loadRenderer()) as RendererModule;
      await renderer.initRenderer({ mount: stage });
    } else {
      console.warn('[boot] client-render module not present — stage left empty');
    }
    if (loadHud !== undefined) {
      const hudModule = (await loadHud()) as HudModule;
      hudModule.initHud({ root: hud });
    } else {
      console.warn('[boot] client-hud module not present — hud left empty');
    }
    matchUiReady = true;
    hud.hidden = false;
  } catch (err) {
    console.error('[boot] failed to start match UI', err);
  } finally {
    matchUiLoading = false;
  }
}

function syncRoots(): void {
  const phase = store.match.phase;
  if (phase === 'playing' || phase === 'ended') {
    screens.hidden = true;
    if (!matchUiReady && !matchUiLoading && phase === 'playing') {
      void startMatchUi();
    } else if (matchUiReady) {
      hud.hidden = false;
    }
  } else if (phase === 'idle') {
    screens.hidden = false;
    if (matchUiReady) hud.hidden = true;
  }
  // 'starting': lobby shows the countdown inside #screens — nothing to do.
}

store.subscribe(syncRoots);
syncRoots();
