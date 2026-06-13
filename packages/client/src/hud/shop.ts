/**
 * Shop panel — proximity-derived. Each frame the HUD checks whether the own
 * ship sits within ShopSpec.interactRadius of a shop structure in the newest
 * sample; in range it shows a "press B" affordance, B opens the full panel
 * (item/ship grid with prices, lumber gates and live stock from
 * SnapshotEntity.shopStock). Digit1-9 buy rows while open; auto-closes when
 * out of range. Owns store.ui.shopEntityId.
 */

import type { SnapshotEntity } from '@bships/core';
import { sendCommand } from '../net/commands.js';
import { store } from '../net/store.js';
import { bindingFor, onAction, onRawKey } from '../input/keymap.js';
import type { HudContext } from './context.js';
import { el } from './context.js';
import { hudSample } from './sample.js';
import { itemDisplay, keyLabel, nearestShopInRange } from './hudmath.js';

interface ShopRow {
  kind: 'ship' | 'item';
  id: string;
  name: string;
  emoji: string;
  gold: number;
  lumber: number;
  /** null = unlimited stock (never shown). */
  stockMax: number | null;
  button: HTMLButtonElement;
  stockEl: HTMLElement;
}

export function initShop(ctx: HudContext): void {
  // -- affordance pill -------------------------------------------------------
  const pill = el('div', 'bh-shop-pill', ctx.root);
  pill.hidden = true;

  // -- panel -----------------------------------------------------------------
  const panel = el('div', 'bh-shop bh-panel', ctx.root);
  panel.hidden = true;
  const header = el('div', 'bh-shop-header', panel);
  const title = el('span', 'bh-shop-title', header);
  const goldNow = el('span', 'bh-shop-gold', header);
  const closeBtn = el('button', 'bh-close', header);
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => setOpen(false));
  const body = el('div', 'bh-shop-body', panel);

  let inRangeShop: { id: number; typeId: string } | null = null;
  let open = false;
  let rows: ShopRow[] = [];
  let refreshKey = '';
  let pillHtml = '';

  function setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    panel.hidden = !open;
    if (open) rebuildRows();
  }

  onAction((action, e) => {
    if (e.type !== 'keydown' || action !== 'shopToggle') return;
    if (open) setOpen(false);
    else if (inRangeShop !== null) setOpen(true);
  });

  onRawKey((e) => {
    if (!open || e.type !== 'keydown') return;
    if (e.code === 'Escape') {
      setOpen(false);
      return true;
    }
    if (e.code.startsWith('Digit')) {
      const index = Number(e.code.slice(5)) - 1;
      const row = rows[index];
      if (row !== undefined) {
        buy(row);
        e.preventDefault();
        return true;
      }
    }
    return;
  });

  function buy(row: ShopRow): void {
    if (inRangeShop === null) return;
    if (row.kind === 'ship') {
      sendCommand({ type: 'buyShip', shopId: inRangeShop.id, shipTypeId: row.id });
    } else {
      sendCommand({ type: 'buyItem', shopId: inRangeShop.id, itemId: row.id });
    }
  }

  function shopName(typeId: string): string {
    return ctx.catalog.unitTypes[typeId]?.name ?? 'Shop';
  }

  function rebuildRows(): void {
    if (inRangeShop === null) return;
    const spec = ctx.catalog.shops[inRangeShop.typeId];
    if (spec === undefined) return;
    title.textContent = shopName(inRangeShop.typeId);
    body.textContent = '';
    rows = [];

    const addRow = (parent: Element, row: Omit<ShopRow, 'button' | 'stockEl'>): void => {
      const hotkeyIndex = rows.length;
      const button = el('button', 'bh-shop-row', parent);
      button.type = 'button';
      const hotkey = el('span', 'bh-slot-key', button);
      hotkey.textContent = hotkeyIndex < 9 ? String(hotkeyIndex + 1) : '';
      const icon = el('span', 'bh-shop-icon', button);
      icon.textContent = row.emoji;
      const name = el('span', 'bh-shop-name', button);
      name.textContent = row.name;
      const stockEl = el('span', 'bh-shop-stock', button);
      const cost = el('span', 'bh-shop-cost', button);
      cost.innerHTML =
        `<span class="bh-gold-text">${row.gold}g</span>` +
        (row.lumber > 0 ? ` <span class="bh-lumber-text">${row.lumber}\u{1FAB5}</span>` : '');
      const full: ShopRow = { ...row, button, stockEl };
      button.addEventListener('click', () => buy(full));
      rows.push(full);
    };

    if (spec.ships.length > 0) {
      el('div', 'bh-shop-section', body).textContent = 'Ships';
      const box = el('div', 'bh-shop-rows', body);
      for (const entry of spec.ships) {
        addRow(box, {
          kind: 'ship',
          id: entry.shipTypeId,
          name: ctx.catalog.ships[entry.shipTypeId]?.name ?? entry.shipTypeId,
          emoji: '\u{1F6A2}',
          gold: entry.gold,
          lumber: entry.lumberCost,
          stockMax: null,
        });
      }
    }
    if (spec.items.length > 0) {
      el('div', 'bh-shop-section', body).textContent = 'Items';
      const box = el('div', 'bh-shop-rows', body);
      for (const entry of spec.items) {
        const disp = itemDisplay(ctx.catalog, entry.itemId);
        addRow(box, {
          kind: 'item',
          id: entry.itemId,
          name: disp.name,
          emoji: disp.emoji,
          gold: entry.gold,
          lumber: entry.lumberCost,
          stockMax: entry.stockMax,
        });
      }
    }
    refreshKey = '';
  }

  /** Cheap dirty-check refresh of stock + affordability while open. */
  function refreshRows(shopEntity: SnapshotEntity | null): void {
    const you = store.match.you;
    const stock = shopEntity?.shopStock ?? {};
    const key = `${you?.gold ?? 0}|${you?.lumber ?? 0}|${JSON.stringify(stock)}`;
    if (key === refreshKey) return;
    refreshKey = key;
    for (const row of rows) {
      const left = row.kind === 'item' && row.stockMax !== null ? (stock[row.id] ?? 0) : null;
      if (left !== null) {
        row.stockEl.textContent = left > 0 ? `x${left}` : 'SOLD OUT';
        row.stockEl.classList.toggle('bh-soldout', left === 0);
      } else {
        row.stockEl.textContent = '';
      }
      const tooPoor =
        you === null || you.gold < row.gold || (row.lumber > 0 && you.lumber < row.lumber);
      row.button.disabled = tooPoor || left === 0;
    }
    goldNow.textContent = you === null ? '' : `${Math.floor(you.gold)}g`;
  }

  // -- per-frame proximity ---------------------------------------------------
  ctx.onFrame((nowMs) => {
    const sample = hudSample(nowMs);
    const mySlot = store.match.mySlot;
    let nearest: { id: number; typeId: string } | null = null;
    let shopEntity: SnapshotEntity | null = null;
    if (sample !== null && mySlot !== null) {
      const ship = sample.entities.find((en) => en.kind === 'ship' && en.ownerSlot === mySlot);
      if (ship !== undefined) {
        const structures = sample.entities.filter((en) => en.kind === 'structure');
        nearest = nearestShopInRange(ship, structures, ctx.catalog.shops);
      }
      if (nearest !== null) {
        const id = nearest.id;
        shopEntity = sample.entities.find((en) => en.id === id) ?? null;
      }
    }

    const changed = (nearest?.id ?? null) !== (inRangeShop?.id ?? null);
    inRangeShop = nearest;
    if (store.ui.shopEntityId !== (nearest?.id ?? null)) {
      store.ui.shopEntityId = nearest?.id ?? null;
    }

    if (nearest === null) {
      pill.hidden = true;
      if (open) setOpen(false); // auto-close out of range
      return;
    }
    if (changed && open) rebuildRows();
    pill.hidden = open;
    if (!open) {
      const text = `Press <span class="bh-slot-key">${keyLabel(bindingFor('shopToggle'))}</span> — ${shopName(nearest.typeId)}`;
      if (text !== pillHtml) {
        pillHtml = text;
        pill.innerHTML = text;
      }
    } else {
      refreshRows(shopEntity);
    }
  });
}
