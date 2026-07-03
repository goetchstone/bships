/**
 * Scoreboard: hold-Tab overlay listing both teams' PublicPlayerStat rows
 * (name, ship, level, K/D, gold earned, connected). Shown on scoreboard
 * keydown, hidden on keyup.
 */

import type { TeamId } from '@bships/core';
import { store } from '../net/store.js';
import { onAction } from '../input/keymap.js';
import type { HudContext } from './context.js';
import { el } from './context.js';
import { sortScoreboardRows } from './hudmath.js';

const TEAMS: readonly TeamId[] = ['south', 'north'];
const TEAM_LABEL: Record<TeamId, string> = { south: 'South Empire', north: 'North Empire' };

export function initScoreboard(ctx: HudContext): void {
  const panel = el('div', 'bh-scoreboard bh-panel', ctx.root);
  panel.hidden = true;

  function shipName(typeId: string): string {
    return ctx.catalog.ships[typeId]?.properName ?? typeId;
  }

  function rebuild(): void {
    panel.textContent = '';
    for (const team of TEAMS) {
      const head = el('div', `bh-score-team bh-team-${team}`, panel);
      head.textContent = TEAM_LABEL[team];
      const table = el('table', 'bh-score-table', panel);
      const thead = el('thead', undefined, table);
      thead.innerHTML =
        '<tr><th class="bh-l">Player</th><th class="bh-l">Ship</th><th>Lv</th><th>K</th><th>D</th><th>Gold</th></tr>';
      const tbody = el('tbody', undefined, table);
      const players = sortScoreboardRows(store.match.players, team);
      for (const p of players) {
        const tr = el('tr', p.connected ? undefined : 'bh-dc', tbody);
        if (p.slot === store.match.mySlot) tr.classList.add('bh-me');
        const name = el('td', 'bh-l', tr);
        name.textContent = p.connected ? p.name : `${p.name} (dc)`;
        const ship = el('td', 'bh-l', tr);
        ship.textContent = shipName(p.shipTypeId);
        el('td', undefined, tr).textContent = String(p.level);
        el('td', undefined, tr).textContent = String(p.kills);
        el('td', undefined, tr).textContent = String(p.deaths);
        el('td', undefined, tr).textContent = String(p.goldEarned);
      }
      if (players.length === 0) {
        const tr = el('tr', 'bh-dc', tbody);
        const td = el('td', 'bh-l', tr);
        td.colSpan = 6;
        td.textContent = '(no players)';
      }
    }
  }

  onAction((action, e) => {
    if (action !== 'scoreboard') return;
    if (e.type === 'keydown') {
      rebuild();
      panel.hidden = false;
    } else if (e.type === 'keyup') {
      panel.hidden = true;
    }
  });

  store.subscribe(() => {
    if (!panel.hidden) rebuild();
  });
}
