/**
 * Player profile view builder for the stats overlay (owned by client-stats).
 * Shows rating, win/loss record, favorite ship, and recent match history for
 * a given publicId. Fetched from the stats service.
 */

import type { StatsApi } from './api.js';
import { matchSummaryLine, ratingDeltaLabel, relativeTime, winRate } from './format.js';

/** Build and append a player profile view into `container`. Returns a teardown. */
export function buildProfileView(
  container: HTMLElement,
  publicId: string,
  api: StatsApi,
  onBack: () => void,
): () => void {
  container.textContent = '';

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'bs-btn bs-btn-small';
  backBtn.textContent = '← Back';
  backBtn.addEventListener('click', onBack);
  container.appendChild(backBtn);

  const statusLine = document.createElement('div');
  statusLine.className = 'bs-stats-status';
  statusLine.textContent = 'Loading…';
  container.appendChild(statusLine);

  const content = document.createElement('div');
  content.hidden = true;
  container.appendChild(content);

  let cancelled = false;

  api
    .getPlayer(publicId)
    .then((p) => {
      if (cancelled) return;
      statusLine.hidden = true;
      content.textContent = '';

      const header = document.createElement('div');
      header.className = 'bs-stats-profile-header';

      const nameEl = document.createElement('h2');
      nameEl.className = 'bs-stats-title';
      nameEl.textContent = p.name + (p.claimed ? ' ✓' : '');
      header.appendChild(nameEl);
      content.appendChild(header);

      const statsGrid = document.createElement('div');
      statsGrid.className = 'bs-stats-grid';

      function statCell(label: string, value: string): HTMLElement {
        const cell = document.createElement('div');
        cell.className = 'bs-stats-cell';
        const labelEl = document.createElement('div');
        labelEl.className = 'bs-dim';
        labelEl.textContent = label;
        const valueEl = document.createElement('div');
        valueEl.className = 'bs-stats-val';
        valueEl.textContent = value;
        cell.appendChild(labelEl);
        cell.appendChild(valueEl);
        return cell;
      }

      statsGrid.appendChild(statCell('Rating', String(p.rating)));
      statsGrid.appendChild(statCell('Record', `${p.wins}W / ${p.losses}L`));
      statsGrid.appendChild(statCell('Win Rate', winRate(p.wins, p.losses)));
      statsGrid.appendChild(statCell('Matches', String(p.matchesPlayed)));
      if (p.favoriteShipTypeId !== null) {
        statsGrid.appendChild(statCell('Favorite Ship', p.favoriteShipTypeId));
      }
      content.appendChild(statsGrid);

      if (p.recentMatches.length > 0) {
        const histTitle = document.createElement('div');
        histTitle.className = 'bs-stats-section-title';
        histTitle.textContent = 'Recent Matches';
        content.appendChild(histTitle);

        const histList = document.createElement('div');
        histList.className = 'bs-stats-history';
        const nowMs = Date.now();
        for (const m of p.recentMatches) {
          const row = document.createElement('div');
          row.className = 'bs-stats-history-row' + (m.won ? ' bs-stats-win' : ' bs-stats-loss');

          const summary = document.createElement('span');
          summary.textContent = matchSummaryLine(m);

          const delta = document.createElement('span');
          delta.className = m.ratingDelta >= 0 ? 'bs-stats-delta-pos' : 'bs-stats-delta-neg';
          delta.textContent = ratingDeltaLabel(m.ratingDelta);

          const time = document.createElement('span');
          time.className = 'bs-dim';
          time.textContent = relativeTime(m.endedAt, nowMs);

          row.appendChild(summary);
          row.appendChild(delta);
          row.appendChild(time);
          histList.appendChild(row);
        }
        content.appendChild(histList);
      } else {
        const noHistory = document.createElement('div');
        noHistory.className = 'bs-dim';
        noHistory.textContent = 'No recorded matches yet.';
        content.appendChild(noHistory);
      }

      content.hidden = false;
    })
    .catch((err: unknown) => {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : 'Failed to load profile.';
      statusLine.textContent = msg;
    });

  return () => {
    cancelled = true;
  };
}
