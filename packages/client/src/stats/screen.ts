/**
 * Stats board UI entry (owned by client-stats). Mounts a full-screen overlay
 * inside #screens with three views — Leaderboard, a Player profile, and the
 * Claim/Login account panel — styled to the dark-naval theme (reuses the
 * `.panel` / `--*` CSS vars + the lobby's `.bs-*` classes; add stats-specific
 * classes via an injected <style id="bships-stats-css"> like the lobby does).
 *
 * THE LOBBY NAV SEAM (single hook): the lobby calls `openStatsScreen(root)` to
 * show the board and the returned handle's `close()` (or the overlay's own
 * Back button) to return to the harbor. The ONLY edit to lobby.ts is a single
 * "Leaderboard" button in `browserPanel()`:
 *
 *     import { openStatsScreen } from '../stats/screen.js';
 *     // inside browserPanel(), next to Refresh:
 *     button('Leaderboard', () => openStatsScreen(rootEl!), 'bs-btn bs-btn-small')
 *
 * The overlay sits ABOVE the lobby content and does not disturb the store-
 * driven lobby render (it manages its own DOM + visibility). Data comes from
 * api.ts; the claim panel uses the identity token (net/identity.ts) + session.ts.
 */

import { createStatsApi } from './api.js';
import { buildLeaderboardView } from './leaderboard.js';
import { buildProfileView } from './profile.js';
import { buildAccountView } from './account.js';

export interface StatsScreenHandle {
  /** Tear down the overlay and return to the lobby. */
  close(): void;
}

export type StatsView = 'leaderboard' | { profile: string } | 'account';

const STATS_CSS_ID = 'bships-stats-css';

function injectStatsStyles(): void {
  if (document.getElementById(STATS_CSS_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STATS_CSS_ID;
  style.textContent = STATS_CSS;
  document.head.appendChild(style);
}

/**
 * Open the stats board overlay inside `root` (the lobby's #screens element).
 * Optionally deep-link to a starting view (default the leaderboard).
 */
export function openStatsScreen(root: HTMLElement, view: StatsView = 'leaderboard'): StatsScreenHandle {
  injectStatsStyles();

  const api = createStatsApi();

  // Full-screen overlay that sits above existing lobby content.
  const overlay = document.createElement('div');
  overlay.className = 'bs-stats-overlay';

  const inner = document.createElement('div');
  inner.className = 'panel bs-stats-panel';
  overlay.appendChild(inner);

  // Nav bar.
  const nav = document.createElement('div');
  nav.className = 'bs-stats-nav';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'bs-btn bs-btn-small';
  backBtn.textContent = '✕ Close';
  backBtn.addEventListener('click', () => handle.close());
  nav.appendChild(backBtn);

  const navLinks = document.createElement('div');
  navLinks.className = 'bs-stats-nav-links';

  function navLink(label: string, targetView: StatsView): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bs-btn bs-btn-small';
    btn.textContent = label;
    btn.addEventListener('click', () => navigate(targetView));
    return btn;
  }

  const leaderboardLink = navLink('Leaderboard', 'leaderboard');
  const accountLink = navLink('Account', 'account');
  navLinks.appendChild(leaderboardLink);
  navLinks.appendChild(accountLink);
  nav.appendChild(navLinks);

  inner.appendChild(nav);

  // Content area (rebuilt on each navigation).
  const content = document.createElement('div');
  content.className = 'bs-stats-content';
  inner.appendChild(content);

  // Active teardown for the current view.
  let currentTeardown: (() => void) | null = null;

  function navigate(v: StatsView): void {
    if (currentTeardown !== null) {
      currentTeardown();
      currentTeardown = null;
    }
    content.textContent = '';

    // Update active nav styling.
    leaderboardLink.classList.toggle('bs-btn-primary', v === 'leaderboard');
    accountLink.classList.toggle('bs-btn-primary', v === 'account');

    if (v === 'leaderboard') {
      currentTeardown = buildLeaderboardView(content, api, (publicId) => {
        navigate({ profile: publicId });
      });
    } else if (v === 'account') {
      currentTeardown = buildAccountView(content, api, () => {
        // Rebuild account view on session change (login/logout).
        navigate('account');
      });
    } else {
      // profile view
      currentTeardown = buildProfileView(content, v.profile, api, () => {
        navigate('leaderboard');
      });
    }
  }

  root.appendChild(overlay);
  navigate(view);

  const handle: StatsScreenHandle = {
    close() {
      if (currentTeardown !== null) {
        currentTeardown();
        currentTeardown = null;
      }
      overlay.remove();
    },
  };

  return handle;
}

const STATS_CSS = `
.bs-stats-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 24px 16px;
  background: rgba(4, 18, 31, 0.88);
  overflow-y: auto;
}
.bs-stats-panel {
  width: 640px;
  max-width: 98vw;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
}
.bs-stats-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 10px;
  margin-bottom: 4px;
}
.bs-stats-nav-links {
  display: flex;
  gap: 6px;
  flex: 1;
}
.bs-stats-title {
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 8px;
  color: var(--text);
}
.bs-stats-section-title {
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-dim);
  margin: 12px 0 6px;
}
.bs-stats-content {
  min-height: 200px;
}
.bs-stats-status {
  color: var(--text-dim);
  font-size: 13px;
}
.bs-stats-error {
  color: var(--danger);
  font-size: 13px;
}
.bs-stats-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}
.bs-stats-table th,
.bs-stats-table td {
  padding: 4px 8px;
  text-align: right;
}
.bs-stats-table th {
  color: var(--text-dim);
  font-weight: 400;
  border-bottom: 1px solid var(--border);
}
.bs-stats-table .bs-l { text-align: left; }
.bs-stats-row {
  cursor: pointer;
  border-radius: 3px;
}
.bs-stats-row:hover td { background: var(--bg-panel-raised); }
.bs-stats-row:focus { outline: 1px solid var(--accent); }
.bs-dim { color: var(--text-dim); }
.bs-stats-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 8px 0;
}
.bs-stats-cell {
  background: var(--bg-panel-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  min-width: 100px;
}
.bs-stats-val {
  font-size: 18px;
  font-weight: 700;
  margin-top: 2px;
}
.bs-stats-profile-header {
  margin-bottom: 4px;
}
.bs-stats-history {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bs-stats-history-row {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 4px 8px;
  border-radius: 3px;
  background: var(--bg-panel-raised);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.bs-stats-win { border-left: 3px solid var(--lumber); }
.bs-stats-loss { border-left: 3px solid var(--danger); }
.bs-stats-delta-pos { color: var(--lumber); font-weight: 700; margin-left: auto; }
.bs-stats-delta-neg { color: var(--danger); font-weight: 700; margin-left: auto; }
.bs-stats-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 340px;
  margin-top: 12px;
}
.bs-stats-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.bs-stats-field .bs-input {
  width: 100%;
}
`;
