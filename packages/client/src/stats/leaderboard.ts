/**
 * Leaderboard view builder for the stats overlay (owned by client-stats).
 * Renders a ranked table of players by Elo rating with win-rate, fetched from
 * the stats service via createStatsApi. Pure DOM — no game-loop dependencies.
 */

import type { LeaderboardEntry } from '@bships/core';
import type { StatsApi } from './api.js';
import { displayLeaderboard, rankLabel, winRate } from './format.js';

/** Build and append the leaderboard view into `container`. Returns a teardown. */
export function buildLeaderboardView(
  container: HTMLElement,
  api: StatsApi,
  onProfile: (publicId: string) => void,
): () => void {
  container.textContent = '';

  const title = document.createElement('h2');
  title.className = 'bs-stats-title';
  title.textContent = 'Leaderboard';
  container.appendChild(title);

  const statusLine = document.createElement('div');
  statusLine.className = 'bs-stats-status';
  statusLine.textContent = 'Loading…';
  container.appendChild(statusLine);

  const table = document.createElement('table');
  table.className = 'bs-stats-table';
  table.hidden = true;
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>#</th><th class="bs-l">Name</th><th>Rating</th><th>W/L</th><th>Win%</th></tr>';
  const tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  container.appendChild(table);

  let cancelled = false;

  function renderRows(entries: LeaderboardEntry[]): void {
    tbody.textContent = '';
    const rows = displayLeaderboard(entries, 100);
    rows.forEach((entry, i) => {
      const tr = document.createElement('tr');
      tr.className = 'bs-stats-row';
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');

      const rankTd = document.createElement('td');
      rankTd.className = 'bs-dim';
      rankTd.textContent = rankLabel(i);

      const nameTd = document.createElement('td');
      nameTd.className = 'bs-l';
      nameTd.textContent = entry.name + (entry.claimed ? ' ✓' : '');

      const ratingTd = document.createElement('td');
      ratingTd.textContent = String(entry.rating);

      const wlTd = document.createElement('td');
      wlTd.className = 'bs-dim';
      wlTd.textContent = `${entry.wins}/${entry.losses}`;

      const wrTd = document.createElement('td');
      wrTd.textContent = winRate(entry.wins, entry.losses);

      tr.appendChild(rankTd);
      tr.appendChild(nameTd);
      tr.appendChild(ratingTd);
      tr.appendChild(wlTd);
      tr.appendChild(wrTd);

      tr.addEventListener('click', () => onProfile(entry.publicId));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onProfile(entry.publicId);
        }
      });

      tbody.appendChild(tr);
    });
  }

  api
    .getLeaderboard(100)
    .then((res) => {
      if (cancelled) return;
      statusLine.hidden = true;
      if (res.entries.length === 0) {
        statusLine.textContent = 'No players yet.';
        statusLine.hidden = false;
        return;
      }
      renderRows(res.entries);
      table.hidden = false;
    })
    .catch((err: unknown) => {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : 'Failed to load leaderboard.';
      statusLine.textContent = msg;
    });

  return () => {
    cancelled = true;
  };
}
