/**
 * Center banners: matchStarting countdown numerals, level-up toasts, and the
 * matchEnded VICTORY/DEFEAT panel with final stats + back-to-lobby button
 * (client-net's returnToLobby()).
 */

import type { PublicPlayerStat, TeamId } from '@bships/core';
import { returnToLobby } from '../lobby/lobby.js';
import { onEvent, store } from '../net/store.js';
import type { HudContext } from './context.js';
import { el } from './context.js';

const TEAM_LABEL: Record<TeamId, string> = { south: 'South Empire', north: 'North Empire' };

export function initBanner(ctx: HudContext): void {
  const countdown = el('div', 'bh-countdown', ctx.root);
  countdown.hidden = true;

  const toast = el('div', 'bh-toast', ctx.root);
  toast.hidden = true;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  const endPanel = el('div', 'bh-end bh-panel', ctx.root);
  endPanel.hidden = true;
  let endBuiltFor: TeamId | null | 'none' = 'none';

  function shipName(typeId: string): string {
    return ctx.catalog.ships[typeId]?.name ?? typeId;
  }

  function buildEndPanel(winner: TeamId | null): void {
    endPanel.textContent = '';
    const mine = store.match.myTeam;
    const title = el('div', 'bh-end-title', endPanel);
    if (winner === null) {
      title.textContent = 'DRAW';
      title.classList.add('bh-draw');
    } else if (winner === mine) {
      title.textContent = 'VICTORY';
      title.classList.add('bh-victory');
    } else {
      title.textContent = 'DEFEAT';
      title.classList.add('bh-defeat');
    }
    if (winner !== null) {
      el('div', 'bh-end-sub', endPanel).textContent = `${TEAM_LABEL[winner]} wins`;
    }

    const table = el('table', 'bh-score-table', endPanel);
    const thead = el('thead', undefined, table);
    thead.innerHTML =
      '<tr><th class="bh-l">Player</th><th class="bh-l">Ship</th><th>Lv</th><th>K</th><th>D</th></tr>';
    const tbody = el('tbody', undefined, table);
    const players: PublicPlayerStat[] = [...store.match.players].sort(
      (a, b) => a.team.localeCompare(b.team) || b.kills - a.kills || a.slot - b.slot,
    );
    for (const p of players) {
      const tr = el('tr', `bh-team-${p.team}`, tbody);
      if (p.slot === store.match.mySlot) tr.classList.add('bh-me');
      el('td', 'bh-l', tr).textContent = p.name;
      el('td', 'bh-l', tr).textContent = shipName(p.shipTypeId);
      el('td', undefined, tr).textContent = String(p.level);
      el('td', undefined, tr).textContent = String(p.kills);
      el('td', undefined, tr).textContent = String(p.deaths);
    }

    const back = el('button', 'bh-back-btn', endPanel);
    back.type = 'button';
    back.textContent = 'Back to lobby';
    back.addEventListener('click', () => {
      endPanel.hidden = true;
      endBuiltFor = 'none';
      returnToLobby();
    });
  }

  function update(): void {
    const { phase, countdown: secs, winnerTeam } = store.match;
    if (phase === 'starting') {
      countdown.hidden = false;
      countdown.textContent = secs > 0 ? String(secs) : 'GO!';
    } else {
      countdown.hidden = true;
    }
    if (phase === 'ended') {
      if (endPanel.hidden || endBuiltFor !== winnerTeam) {
        endBuiltFor = winnerTeam;
        buildEndPanel(winnerTeam);
        endPanel.hidden = false;
      }
    } else {
      endPanel.hidden = true;
      endBuiltFor = 'none';
    }
  }

  update();
  store.subscribe(update);

  onEvent((ev) => {
    if (ev.type === 'levelUp' && ev.player === store.match.mySlot) {
      toast.textContent = `LEVEL ${ev.level}`;
      toast.hidden = false;
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.hidden = true;
      }, 2000);
    }
  });
}
