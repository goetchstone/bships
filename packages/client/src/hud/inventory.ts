/**
 * Inventory + spellbook bar: six item slots (W E R A S D), the hull's ability
 * quick-keys (one slot per castable ability the hull carries — a Crusader shows
 * several, a Sailor fewer; bound to the F Q T C X Z cluster), the level-up
 * picker (a '+' badge on learnable abilities when skill points are unspent),
 * and the stop / attack-move order buttons. Slot contents rebuild on store
 * changes; cooldown sweeps update every frame against the interpolation clock's
 * current tick (readyAtTick fields are absolute sim ticks).
 */

import { dropItem, learnSkill, sendCommand } from '../net/commands.js';
import { emitChange, pushChat, store } from '../net/store.js';
import { ABILITY_ACTIONS, bindingFor, onAction, onRawKey } from '../input/keymap.js';
import type { HudAction } from '../input/keymap.js';
import type { HudContext } from './context.js';
import { el } from './context.js';
import { hudSample } from './sample.js';
import {
  CooldownTracker,
  abilityCooldownInfo,
  abilityIcon,
  canLearnSkill,
  cooldownSecondsText,
  itemCooldownTicks,
  itemDisplay,
  itemTargetingMode,
  keyLabel,
  ownShipPosition,
  rejectionMessage,
  shipAbilitySlots,
  shipLearnableSkills,
  shipPassiveLearnableSkills,
  targetingCueText,
} from './hudmath.js';
import type { AbilitySlot, LearnableSkill } from './hudmath.js';

const SLOT_ACTIONS: readonly HudAction[] = ['slot0', 'slot1', 'slot2', 'slot3', 'slot4', 'slot5'];

interface SlotDom {
  button: HTMLButtonElement;
  key: HTMLElement;
  icon: HTMLElement;
  charges: HTMLElement;
  cd: HTMLElement;
  cdText: HTMLElement;
}

interface AbilitySlotDom extends SlotDom {
  /** Current learned rank pips ("II" etc), bottom-left. */
  rank: HTMLElement;
  /** Level-up '+' badge, top-right; clicking ranks the ability up. */
  plus: HTMLButtonElement;
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

function buildAbilitySlot(parent: Element, keyText: string): AbilitySlotDom {
  const base = buildSlot(parent, keyText);
  base.button.classList.add('bh-ability');
  const rank = el('span', 'bh-slot-rank', base.button);
  const plus = el('button', 'bh-slot-plus', base.button);
  plus.type = 'button';
  plus.textContent = '+';
  return { ...base, rank, plus };
}

export function initInventory(ctx: HudContext): void {
  const wrap = el('div', 'bh-inventory', ctx.root);

  // --- six item slots -------------------------------------------------------
  const slotsBox = el('div', 'bh-slots', wrap);
  const slots: SlotDom[] = [];
  for (let i = 0; i < 6; i++) {
    const dom = buildSlot(slotsBox, keyLabel(bindingFor(SLOT_ACTIONS[i] ?? 'slot0')));
    dom.button.addEventListener('click', () => useSlot(i));
    // RIGHT-CLICK drops the item (BSP has no sell-back; you DROP gear). Suppress
    // the browser context menu so the drop is the only effect.
    dom.button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      dropSlot(i);
    });
    slots.push(dom);
  }

  // --- ship ability quick-keys (one per castable hull ability) --------------
  // Pre-build ABILITY_ACTIONS.length slots; updateContents shows only as many
  // as the current hull carries and binds each to its ability + hotkey.
  const abilityBox = el('div', 'bh-abilities', wrap);
  const abilitySlots: AbilitySlotDom[] = [];
  for (let i = 0; i < ABILITY_ACTIONS.length; i++) {
    const action = ABILITY_ACTIONS[i] ?? 'ability0';
    const dom = buildAbilitySlot(abilityBox, keyLabel(bindingFor(action)));
    dom.button.addEventListener('click', () => castAbilitySlot(i));
    dom.plus.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also cast
      rankAbilitySlot(i);
    });
    abilitySlots.push(dom);
  }

  // Unspent-skill-points indicator: a small "● N skill points" pill that sits
  // with the spellbook and glows while points are unspent, so the player knows
  // there is something to spend on the pulsing "+" badges. Hidden at 0 points.
  const skillPoints = el('div', 'bh-skillpoints', abilityBox);
  skillPoints.hidden = true;
  skillPoints.title = 'Unspent skill points — click a + on an ability to rank it up.';
  const skillPointsDot = el('span', 'bh-skillpoints-dot', skillPoints);
  skillPointsDot.textContent = '●'; // ●
  const skillPointsText = el('span', 'bh-skillpoints-text', skillPoints);

  // --- passive-skill learn strip (above the inventory bar) ------------------
  // The hull's PASSIVE learnable skills (Enforced Hull, Onboard Mechanics Crew,
  // Ship Sails, auras...) carry skill rules but never get a castable quick-key,
  // so the cast bar's level-up picker can't reach them. This strip is their
  // home: one chip per passive skill with the same glowing "+1pt" badge, so
  // EVERY learnable skill on every hull has exactly one place to spend a point.
  // Sits as its own shelf above the inventory; hidden when the hull has none
  // (subs / Leviathan). Built once; populated by updateContents.
  const skillStrip = el('div', 'bh-skillstrip', ctx.root);
  skillStrip.hidden = true;
  el('span', 'bh-skillstrip-label', skillStrip).textContent = 'SKILLS';
  const skillChipsBox = el('div', 'bh-skillchips', skillStrip);
  interface SkillChipDom {
    chip: HTMLElement;
    icon: HTMLElement;
    rank: HTMLElement;
    plus: HTMLButtonElement;
  }
  const skillChips: SkillChipDom[] = [];
  const MAX_SKILL_CHIPS = 6;
  for (let i = 0; i < MAX_SKILL_CHIPS; i++) {
    const chip = el('div', 'bh-slot bh-ability bh-skillchip', skillChipsBox);
    const icon = el('span', 'bh-slot-icon', chip);
    const rank = el('span', 'bh-slot-rank', chip);
    const plus = el('button', 'bh-slot-plus', chip);
    plus.type = 'button';
    plus.textContent = '+';
    plus.addEventListener('click', (e) => {
      e.stopPropagation();
      rankPassiveSkill(i);
    });
    skillChips.push({ chip, icon, rank, plus });
  }

  // --- order buttons (stop / attack-move) -----------------------------------
  const orders = el('div', 'bh-orders', wrap);
  // Build with textContent (NOT innerHTML) so rebindable key labels can never
  // inject markup — keyLabel(bindingFor(...)) is user-controlled.
  const orderButton = (icon: string, key: string, title: string): HTMLButtonElement => {
    const btn = el('button', 'bh-order', orders);
    btn.type = 'button';
    el('span', 'bh-order-icon', btn).textContent = icon;
    el('span', 'bh-slot-key', btn).textContent = key;
    btn.title = title;
    return btn;
  };
  const stopBtn = orderButton('■', keyLabel(bindingFor('stop')), 'Stop');
  stopBtn.addEventListener('click', orderStop);
  const amBtn = orderButton('⚔', keyLabel(bindingFor('attackMove')), 'Attack-move (then click the map)');
  amBtn.addEventListener('click', armAttackMove);

  // --- "no sell-back" hint --------------------------------------------------
  // BSP has no sell-back: you DROP gear (right-click a slot). Buying a strictly
  // better hull/sail "burns" the old one — full gold refunded (Only_One_*). A
  // teammate can pick up what you drop.
  const hint = el('div', 'bh-invhint', wrap);
  hint.textContent = 'No selling — right-click to drop. Upgrading a hull/sail refunds the old one.';
  hint.title =
    'BSP has no sell-back. Right-click an item to drop it (a teammate can pick it up). ' +
    'Buying a strictly better hull or sail "burns" the old one and refunds its full gold.';

  // --- armed-target cue (BUG 2) ---------------------------------------------
  // While a targeted ability/item is armed (store.ui.pendingTarget) the player
  // gets a centred prompt naming the cast + what to click, mirroring the
  // attack-move armed state. Sits ABOVE the inventory bar; pointer-events:none
  // so it never eats the targeting click. Hidden by default; toggled in the
  // frame loop. Right-click / Esc cancels (wired below + in pointer.ts).
  const targetCue = el('div', 'bh-targetcue', ctx.root);
  targetCue.hidden = true;
  const targetCueText = el('span', 'bh-targetcue-text', targetCue);
  el('span', 'bh-targetcue-hint', targetCue).textContent = 'right-click or Esc to cancel';

  // Learnable hero skills on the current hull, keyed by abilityId — rebuilt in
  // updateContents on every store change so the cast/learn handlers can tell a
  // rank-0 hero skill (lockable) from an always-castable innate (no skill rule).
  let learnById = new Map<string, LearnableSkill>();

  // The hull's PASSIVE learnable skills, in render order — the skill-strip chips
  // index into this so the '+' on chip i ranks the matching skill.
  let passiveSkills: LearnableSkill[] = [];

  // The castable ability for slot i on the CURRENT hull (or null). The level-up
  // picker indexes the SAME slot order, so the '+' on slot i ranks that ability.
  function abilitySlotFor(index: number): AbilitySlot | null {
    const you = store.match.you;
    if (you === null) return null;
    return shipAbilitySlots(ctx.catalog, you.shipTypeId)[index] ?? null;
  }

  /**
   * Surface a one-off helper line in the chat log (reusing the system-line
   * path drainChat already renders) — used for client-side cast blocks the sim
   * would otherwise reject silently (e.g. casting an unlearned hero skill).
   */
  function noticeLine(text: string): void {
    pushChat({ type: 'chat', from: { publicId: '', name: 'system', slot: null }, scope: 'system', text });
    emitChange();
  }

  // --- actions ---------------------------------------------------------------
  function useSlot(slot: number): void {
    const item = store.match.you?.inventory[slot];
    if (item === null || item === undefined) return;
    // Targeted actives (Light Teleporter blink -> point; reveal / rejuvenation
    // -> ally unit) need a target or the sim rejects them ('invalidTarget'),
    // which read as "the item does nothing". Arm a map click instead, mirroring
    // attackMove; pointer.ts resolves the click and sends useItem with x/y or
    // targetId. Self/untargeted actives (instant heal, smoke, xp tome, summon,
    // flavour) send immediately as before.
    const mode = itemTargetingMode(ctx.catalog, item.itemId);
    if (mode === 'point' || mode === 'unit') {
      store.ui.pendingOrder = null; // mutually exclusive with attack-move
      store.ui.pendingTarget = { kind: 'item', targeting: mode, slot };
      emitChange();
      return;
    }
    sendCommand({ type: 'useItem', slot });
  }

  /**
   * Drop the item in `slot` onto the water at the ship's current position — the
   * only way to discard gear in BSP (no sell-back). Needs the live ship
   * position from the latest world sample; the sim drops AT the ship and
   * re-validates reach, so a missing sample just no-ops here.
   */
  function dropSlot(slot: number): void {
    const item = store.match.you?.inventory[slot];
    if (item === null || item === undefined) return;
    const sample = hudSample(performance.now());
    if (sample === null) return;
    const pos = ownShipPosition(sample.entities, store.match.mySlot);
    if (pos === null) return;
    dropItem(slot, pos.x, pos.y);
  }

  /**
   * Cast the ability in quick-key slot `index` on the current hull. Targeted
   * abilities (Fishing Net ensnare -> enemy ship; flare -> map point; Torpedo ->
   * enemy) arm a click; self-cast ones (Dive, Shore Leave, invisibility) fire
   * immediately. A self-cast Shore Leave away from the harbour is rejected by
   * the sim with a reason surfaced in chat — no longer a silent key.
   */
  function castAbilitySlot(index: number): void {
    const slot = abilitySlotFor(index);
    const you = store.match.you;
    if (slot === null || you === null) return;
    // A rank-0 hero skill is rejected by the sim as 'notLearned' and reads as a
    // dead key. Block it locally and surface a NAMED, actionable hint (the sim
    // event only carries commandType, so the chat fallback can't name it). Shore
    // Leave and other innates have no skill rule (learn === null) and cast as
    // before — the sim still re-validates them (e.g. notAtMainHarbour).
    const learn = learnById.get(slot.abilityId) ?? null;
    if (learn !== null && (you.heroSkillLevels[slot.abilityId] ?? 0) <= 0) {
      // Clicking an UNLEARNED hero skill's whole slot LEARNS rank 1 when a point
      // is available (a big, forgiving hit target — the tiny + badge was hard to
      // click). The sim re-validates. Falls back to the named hint when there's
      // no point to spend.
      if (canLearnSkill(learn, 0, you.level, you.unspentSkillPoints, ctx.catalog.xp.skillLevelGated)) {
        learnSkill(slot.abilityId);
        return;
      }
      const name = ctx.catalog.abilities[slot.abilityId]?.name ?? slot.abilityId;
      noticeLine(rejectionMessage('notLearned', name));
      return;
    }
    if (slot.targeting === 'point' || slot.targeting === 'unit') {
      store.ui.pendingOrder = null;
      store.ui.pendingTarget = {
        kind: 'ability',
        targeting: slot.targeting,
        abilityId: slot.abilityId,
      };
      emitChange();
      return;
    }
    sendCommand({ type: 'castAbility', abilityId: slot.abilityId });
  }

  /**
   * Rank up the ability in quick-key slot `index` via learnSkill (level-up
   * picker). Sends only when the sim would accept it; the sim + server
   * re-validate regardless.
   */
  function rankAbilitySlot(index: number): void {
    const slot = abilitySlotFor(index);
    const you = store.match.you;
    if (slot === null || you === null) return;
    learnSkill(slot.abilityId);
  }

  /**
   * Rank up the PASSIVE skill in skill-strip chip `index` (hull HP, sails,
   * repair crew, auras). These have no quick-key, so the strip's '+' is the only
   * way to spend a point on them. The sim + server re-validate the learnSkill.
   */
  function rankPassiveSkill(index: number): void {
    const skill = passiveSkills[index];
    if (skill === undefined || store.match.you === null) return;
    learnSkill(skill.abilityId);
  }

  function orderStop(): void {
    sendCommand({ type: 'stop' });
  }

  function armAttackMove(): void {
    // Mutually exclusive with an armed targeted cast (store.ts contract).
    store.ui.pendingTarget = null;
    store.ui.pendingOrder = 'attackMove';
    emitChange();
  }

  /** Disarm any pending targeted cast / attack-move (right-click or Esc). */
  function cancelPendingTarget(): boolean {
    if (store.ui.pendingTarget === null && store.ui.pendingOrder === null) return false;
    store.ui.pendingTarget = null;
    store.ui.pendingOrder = null;
    emitChange();
    return true;
  }

  onAction((action, e) => {
    if (e.type !== 'keydown') return;
    const slotIndex = SLOT_ACTIONS.indexOf(action);
    if (slotIndex >= 0) {
      useSlot(slotIndex);
      return;
    }
    const abilityIndex = ABILITY_ACTIONS.indexOf(action);
    if (abilityIndex >= 0) castAbilitySlot(abilityIndex);
    else if (action === 'stop') orderStop();
    else if (action === 'attackMove') armAttackMove();
  });

  // Esc cancels an armed targeted cast / attack-move. Escape is not a bound
  // HudAction, so listen on the raw-key channel (consumed only when something
  // was actually disarmed, so a stray Esc still falls through to other panels).
  onRawKey((e) => {
    if (e.type === 'keydown' && e.code === 'Escape') return cancelPendingTarget();
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
        // Hint the drop affordance (BSP has no sell-back — you DROP gear).
        dom.button.title = `${disp.name}\nRight-click to drop (no sell-back in BSP)`;
      }
    }

    // Spellbook: one slot per castable ability on the current hull; hide the
    // rest. Each slot shows icon + current rank, and a '+' badge when the
    // ability can be ranked up right now. A rank-0 hero skill renders LOCKED
    // (dimmed icon + a lock hint) so it's obvious it must be learned first.
    const castable = you === null ? [] : shipAbilitySlots(ctx.catalog, you.shipTypeId);
    const learnable = you === null ? [] : shipLearnableSkills(ctx.catalog, you.shipTypeId);
    learnById = new Map(learnable.map((s) => [s.abilityId, s]));
    for (let i = 0; i < abilitySlots.length; i++) {
      const dom = abilitySlots[i];
      if (dom === undefined) continue;
      dom.key.textContent = keyLabel(bindingFor(ABILITY_ACTIONS[i] ?? 'ability0'));
      const slot = castable[i] ?? null;
      if (you === null || slot === null) {
        dom.button.classList.add('bh-hidden');
        dom.button.classList.remove('bh-unlearned');
        dom.icon.textContent = '';
        dom.rank.textContent = '';
        dom.plus.classList.remove('bh-show', 'bh-can-learn');
        dom.button.title = '';
        continue;
      }
      dom.button.classList.remove('bh-hidden');
      const ability = ctx.catalog.abilities[slot.abilityId];
      const name = ability?.name ?? slot.abilityId;
      dom.icon.textContent = abilityIcon(ctx.catalog, slot.abilityId);
      const rank = you.heroSkillLevels[slot.abilityId] ?? 0;
      const learn = learnById.get(slot.abilityId) ?? null;
      const maxRanks = learn?.ranks ?? 0;
      // A hero skill (has a skill rule) at rank 0 is UNLEARNED — it cannot be
      // cast (the sim rejects 'notLearned'). Show it locked/dimmed. Innates with
      // no skill rule (Shore Leave) are always castable, never locked.
      const unlearned = learn !== null && rank <= 0;
      dom.button.classList.toggle('bh-unlearned', unlearned);
      // Hero skills show "rank/max"; non-skill innates (Shore Leave) have no rank.
      dom.rank.textContent = maxRanks > 0 ? `${rank}/${maxRanks}` : '';
      const canRank =
        learn !== null &&
        canLearnSkill(learn, rank, you.level, you.unspentSkillPoints, ctx.catalog.xp.skillLevelGated);
      dom.plus.classList.toggle('bh-show', canRank);
      // While a point can be spent, label the badge with the cost and make it
      // glow (bh-can-learn) so the affordance is unmissable.
      dom.plus.classList.toggle('bh-can-learn', canRank);
      dom.plus.textContent = canRank ? '+1pt' : '+';
      dom.plus.title = `Spend a skill point on ${name} (rank ${rank + 1})`;
      const targetHint =
        slot.targeting === 'unit'
          ? '\nTarget an enemy ship'
          : slot.targeting === 'point'
            ? '\nTarget a map point'
            : '';
      const rankHint = maxRanks > 0 ? `\nRank ${rank}/${maxRanks}` : '';
      const lockHint = unlearned
        ? canRank
          ? '\nLOCKED — click the + (1 skill point) to learn'
          : '\nLOCKED — learn it once you have a skill point'
        : '';
      dom.button.title = `${name}${rankHint}${targetHint}${lockHint}`;
    }

    // Unspent-skill-points indicator: only meaningful while points are unspent.
    const points = you?.unspentSkillPoints ?? 0;
    skillPoints.hidden = points <= 0;
    skillPointsText.textContent = `${points} skill point${points === 1 ? '' : 's'}`;

    // Passive-skill learn strip: one chip per passive learnable skill on the
    // hull (hull HP, sails, repair crew, auras). Each shows the live rank and a
    // glowing "+1pt" badge when a point can be spent — the only way to rank
    // these (they carry no quick-key). Hidden when the hull has none.
    passiveSkills = you === null ? [] : shipPassiveLearnableSkills(ctx.catalog, you.shipTypeId);
    skillStrip.hidden = passiveSkills.length === 0;
    for (let i = 0; i < skillChips.length; i++) {
      const dom = skillChips[i];
      if (dom === undefined) continue;
      const skill = passiveSkills[i] ?? null;
      if (you === null || skill === null) {
        dom.chip.classList.add('bh-hidden');
        dom.plus.classList.remove('bh-show', 'bh-can-learn');
        continue;
      }
      dom.chip.classList.remove('bh-hidden');
      const ability = ctx.catalog.abilities[skill.abilityId];
      const name = ability?.name ?? skill.abilityId;
      dom.icon.textContent = abilityIcon(ctx.catalog, skill.abilityId);
      const rank = you.heroSkillLevels[skill.abilityId] ?? 0;
      dom.rank.textContent = `${rank}/${skill.ranks}`;
      const canRank = canLearnSkill(
        skill, rank, you.level, you.unspentSkillPoints, ctx.catalog.xp.skillLevelGated,
      );
      dom.plus.classList.toggle('bh-show', canRank);
      dom.plus.classList.toggle('bh-can-learn', canRank);
      dom.plus.textContent = canRank ? '+1pt' : '+';
      dom.chip.classList.toggle('bh-unlearned', rank <= 0);
      const need = skill.minHeroLevel + rank * skill.levelsPerRank;
      const why =
        rank >= skill.ranks
          ? ' — maxed'
          : canRank
            ? ' — click + to rank up (1 skill point)'
            : points <= 0
              ? ' — need a skill point (level up)'
              : ` — needs hero level ${need}`;
      dom.chip.title = `${name}: rank ${rank}/${skill.ranks}${why}`;
    }

    // Armed-target cue + armed-slot/attack-move highlight. STATE-driven (runs on
    // every store change via this subscriber) so they appear the INSTANT a cast
    // is armed and never depend on the rAF loop — which a backgrounded/throttled
    // tab can stall. Cooldown sweeps stay per-frame in onFrame.
    amBtn.classList.toggle('bh-armed', store.ui.pendingOrder === 'attackMove');
    const pending = store.ui.pendingTarget;
    for (let i = 0; i < 6; i++) {
      slots[i]?.button.classList.toggle(
        'bh-armed',
        pending !== null && pending.kind === 'item' && pending.slot === i,
      );
    }
    for (let i = 0; i < abilitySlots.length; i++) {
      const aslot = castable[i] ?? null;
      abilitySlots[i]?.button.classList.toggle(
        'bh-armed',
        pending !== null &&
          pending.kind === 'ability' &&
          aslot !== null &&
          pending.abilityId === aslot.abilityId,
      );
    }
    if (pending === null) {
      targetCue.hidden = true;
    } else {
      const itemName =
        pending.kind === 'item' && pending.slot !== undefined
          ? (() => {
              const id = you?.inventory[pending.slot ?? -1]?.itemId;
              return id !== undefined ? itemDisplay(ctx.catalog, id).name : null;
            })()
          : null;
      targetCueText.textContent = targetingCueText(ctx.catalog, pending, itemName);
      targetCue.hidden = false;
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
    // Per-ability cooldown sweeps (keyed by abilityId / linked weapon group).
    const castable = you === null ? [] : shipAbilitySlots(ctx.catalog, you.shipTypeId);
    for (let i = 0; i < abilitySlots.length; i++) {
      const dom = abilitySlots[i];
      if (dom === undefined) continue;
      const slot = castable[i] ?? null;
      if (you === null || slot === null || nowTick === null) {
        applySweep(dom, 0, 0);
        continue;
      }
      const info = abilityCooldownInfo(ctx.catalog, you.cooldownGroups, slot.abilityId);
      const fraction = tracker.fraction(
        `ability:${slot.abilityId}`,
        info.readyAtTick,
        nowTick,
        info.durationTicks,
      );
      applySweep(dom, fraction, info.readyAtTick - nowTick);
    }
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
