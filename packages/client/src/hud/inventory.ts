/**
 * Inventory bar: six item slots (W E R A S D), the ship-ability button (F)
 * and the stop / attack-move order buttons. Slot contents rebuild on store
 * changes; cooldown sweeps update every frame against the interpolation
 * clock's current tick (readyAtTick fields are absolute sim ticks).
 */

import { sendCommand } from '../net/commands.js';
import { store } from '../net/store.js';
import { bindingFor, onAction } from '../input/keymap.js';
import type { HudAction } from '../input/keymap.js';
import type { HudContext } from './context.js';
import { el } from './context.js';
import { hudSample } from './sample.js';
import {
  CooldownTracker,
  abilityCooldownInfo,
  cooldownSecondsText,
  itemCooldownTicks,
  itemDisplay,
  keyLabel,
  shipActiveAbilityId,
} from './hudmath.js';

const SLOT_ACTIONS: readonly HudAction[] = ['slot0', 'slot1', 'slot2', 'slot3', 'slot4', 'slot5'];

interface SlotDom {
  button: HTMLButtonElement;
  key: HTMLElement;
  icon: HTMLElement;
  charges: HTMLElement;
  cd: HTMLElement;
  cdText: HTMLElement;
}

function buildSlot(parent: Element, keyText: string): SlotDom {
  const button = el('button', 'bh-slot', parent);
  button.type = 'button';
  const icon = el('span', 'bh-slot-icon', button);
  const key = el('span', 'bh-slot-key', button);
  key.textContent = keyText;
  const charges = el('span', 'bh-slot-charges', button);
  const cd = el('span', 'bh-slot-cd', button);
  const cdText = el('span', 'bh-slot-cdtext', button);
  return { button, key, icon, charges, cd, cdText };
}

export function initInventory(ctx: HudContext): void {
  const wrap = el('div', 'bh-inventory', ctx.root);

  // --- six item slots -------------------------------------------------------
  const slotsBox = el('div', 'bh-slots', wrap);
  const slots: SlotDom[] = [];
  for (let i = 0; i < 6; i++) {
    const dom = buildSlot(slotsBox, keyLabel(bindingFor(SLOT_ACTIONS[i] ?? 'slot0')));
    dom.button.addEventListener('click', () => useSlot(i));
    slots.push(dom);
  }

  // --- ship ability (F) -----------------------------------------------------
  const ability = buildSlot(slotsBox, keyLabel(bindingFor('shipAbility')));
  ability.button.classList.add('bh-ability');
  ability.button.addEventListener('click', castShipAbility);

  // --- order buttons (stop / attack-move) -----------------------------------
  const orders = el('div', 'bh-orders', wrap);
  const stopBtn = el('button', 'bh-order', orders);
  stopBtn.type = 'button';
  stopBtn.innerHTML = `<span class="bh-order-icon">■</span><span class="bh-slot-key">${keyLabel(bindingFor('stop'))}</span>`;
  stopBtn.title = 'Stop';
  stopBtn.addEventListener('click', orderStop);
  const amBtn = el('button', 'bh-order', orders);
  amBtn.type = 'button';
  amBtn.innerHTML = `<span class="bh-order-icon">⚔</span><span class="bh-slot-key">${keyLabel(bindingFor('attackMove'))}</span>`;
  amBtn.title = 'Attack-move (then click the map)';
  amBtn.addEventListener('click', armAttackMove);

  // --- actions ---------------------------------------------------------------
  function useSlot(slot: number): void {
    const item = store.match.you?.inventory[slot];
    if (item === null || item === undefined) return;
    // v1: untargeted use; the server rejects target-requiring items with a
    // commandRejected event surfaced in the chat log.
    sendCommand({ type: 'useItem', slot });
  }

  function castShipAbility(): void {
    const you = store.match.you;
    if (you === null) return;
    const abilityId = shipActiveAbilityId(ctx.catalog, you.shipTypeId);
    if (abilityId === null) return;
    sendCommand({ type: 'castAbility', abilityId });
  }

  function orderStop(): void {
    sendCommand({ type: 'stop' });
  }

  function armAttackMove(): void {
    store.ui.pendingOrder = 'attackMove';
  }

  onAction((action, e) => {
    if (e.type !== 'keydown') return;
    const slotIndex = SLOT_ACTIONS.indexOf(action);
    if (slotIndex >= 0) useSlot(slotIndex);
    else if (action === 'shipAbility') castShipAbility();
    else if (action === 'stop') orderStop();
    else if (action === 'attackMove') armAttackMove();
  });

  // --- store-driven content -------------------------------------------------
  function updateContents(): void {
    const you = store.match.you;
    for (let i = 0; i < 6; i++) {
      const dom = slots[i];
      if (dom === undefined) continue;
      dom.key.textContent = keyLabel(bindingFor(SLOT_ACTIONS[i] ?? 'slot0'));
      const item = you?.inventory[i] ?? null;
      if (item === null) {
        dom.button.classList.add('bh-empty');
        dom.icon.textContent = '';
        dom.charges.textContent = '';
        dom.button.title = 'Empty slot';
      } else {
        dom.button.classList.remove('bh-empty');
        const disp = itemDisplay(ctx.catalog, item.itemId);
        dom.icon.textContent = disp.emoji;
        dom.charges.textContent = item.charges === null ? '' : String(item.charges);
        dom.button.title = disp.name;
      }
    }
    ability.key.textContent = keyLabel(bindingFor('shipAbility'));
    if (you === null) {
      ability.button.classList.add('bh-empty');
      ability.icon.textContent = '';
      ability.button.title = 'Ship ability';
    } else {
      const abilityId = shipActiveAbilityId(ctx.catalog, you.shipTypeId);
      if (abilityId === null) {
        ability.button.classList.add('bh-empty');
        ability.icon.textContent = '';
        ability.button.title = 'No ship ability';
      } else {
        ability.button.classList.remove('bh-empty');
        ability.icon.textContent = '\u{1F300}';
        ability.button.title = ctx.catalog.abilities[abilityId]?.name ?? abilityId;
      }
    }
  }

  updateContents();
  store.subscribe(updateContents);

  // --- per-frame cooldown sweeps --------------------------------------------
  const tracker = new CooldownTracker();

  function applySweep(dom: SlotDom, fraction: number, remainingTicks: number): void {
    if (fraction <= 0) {
      dom.cd.style.background = 'none';
      dom.cdText.textContent = '';
      return;
    }
    const deg = (fraction * 360).toFixed(1);
    dom.cd.style.background = `conic-gradient(rgba(4, 10, 18, 0.78) ${deg}deg, transparent ${deg}deg)`;
    dom.cdText.textContent = cooldownSecondsText(remainingTicks, ctx.catalog.tickRate);
  }

  ctx.onFrame((nowMs) => {
    const you = store.match.you;
    const nowTick = currentTick(nowMs);
    for (let i = 0; i < 6; i++) {
      const dom = slots[i];
      if (dom === undefined) continue;
      const item = you?.inventory[i] ?? null;
      if (item === null || nowTick === null) {
        applySweep(dom, 0, 0);
        continue;
      }
      const groupReady = readyFromGroup(item.itemId);
      const readyAt = Math.max(item.readyAtTick, groupReady);
      const duration = itemCooldownTicks(ctx.catalog, item.itemId);
      const fraction = tracker.fraction(`item${i}:${item.itemId}`, readyAt, nowTick, duration);
      applySweep(dom, fraction, readyAt - nowTick);
    }
    if (you !== null && nowTick !== null) {
      const abilityId = shipActiveAbilityId(ctx.catalog, you.shipTypeId);
      if (abilityId !== null) {
        const info = abilityCooldownInfo(ctx.catalog, you.cooldownGroups, abilityId);
        const fraction = tracker.fraction(
          `ability:${abilityId}`,
          info.readyAtTick,
          nowTick,
          info.durationTicks,
        );
        applySweep(ability, fraction, info.readyAtTick - nowTick);
      } else {
        applySweep(ability, 0, 0);
      }
    } else {
      applySweep(ability, 0, 0);
    }
    amBtn.classList.toggle('bh-armed', store.ui.pendingOrder === 'attackMove');
  });

  function readyFromGroup(itemId: string): number {
    const groups = store.match.you?.cooldownGroups;
    if (groups === undefined) return 0;
    const group =
      ctx.catalog.equipment[itemId]?.cooldownGroup ??
      ctx.catalog.weapons[itemId]?.cooldownGroup ??
      null;
    if (group === null) return 0;
    return groups[group] ?? 0;
  }
}

/** Current interpolated sim tick; falls back to the newest snapshot tick. */
function currentTick(nowMs: number): number | null {
  const sample = hudSample(nowMs);
  if (sample !== null) return sample.tickFloat;
  const latest = store.match.latestTick;
  return latest > 0 ? latest : null;
}
