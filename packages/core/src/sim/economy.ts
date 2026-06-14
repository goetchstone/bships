/**
 * Economy system: shops, inventory & stack rules, income, contracts/lumber.
 *
 * Responsibilities:
 * - Purchases (SEMANTICS §8): buyItem/buyShip validate shop interact radius
 *   (ShopSpec.interactRadius from the ship's position to the shop
 *   structure), enemy-side gating (StructurePlacement.shopSide vs buyer
 *   team -> reject pre-charge), gold, lumber gating (ContractRules
 *   .lumberCosts — a threshold, never consumed: the original script only
 *   checks udg_PlayerLumber, it never decrements it), stock + restock
 *   timers. Classic sell-back: rejected (constants.sellbackRate === 0).
 * - Inventory: owns PlayerState.inventory and ItemInstance lifecycles
 *   (charges, perishable trade goods destroyed on drop), groundItems,
 *   maxHp recompute on hull/equipment change (clamp hp; the ONLY hp write
 *   this module performs, explicitly granted by the module contract).
 * - Stack & class rules (script-rules.json §2): enforceItemRules runs after
 *   EVERY inventory mutation. Violations: remove item + refund FULL gold
 *   price (ihtp == igol) + emit 'refund'. The just-acquired slot (passed by
 *   buy/pickup/quest-add) is evaluated LAST so it loses ties even when it
 *   landed in a lower slot index — the original triggers always refund
 *   GetManipulatedItem(), the item that just arrived.
 * - useItem: validates slot/charges/readyAtTick/cooldownGroups, then routes:
 *   stormBolt weapons -> combat.castStormBolt (consumes only on true);
 *   instantHeal -> combat.applyHeal; xpTome -> progression.grantXp;
 *   rejuvenation -> a 'hot' status accrued by combat's regen pass;
 *   invisibility/ward/flare/blink/reveal/summon ->
 *   specials.applyEquipmentActive (consumes only on true). On success: set
 *   per-item + group cooldowns, decrement charges, emit 'itemUsed', call
 *   specials.breakInvisibilityOnAction (skipped for the invisibility item
 *   itself so the fresh smoke survives its own activation).
 * - Income (map-layout income block): every intervalTicks pay
 *   byHumanCount[teamHumanCount] to ALL non-AI slots of each team
 *   regardless of occupancy + toTeamAi to the AI slot — gated on the NORTH
 *   HQ (role 'hq', team 'north') being alive for BOTH teams (preserved bug,
 *   income.requiresNorthHqAlive; when false each team gates on its OWN HQ).
 *   Empire gold share at timers.nextEmpireShareTick: every non-AI ally
 *   receives floor(aiGold / teamHumanCount), then AI gold = 0 (verbatim
 *   Trig_Empire_Gold — the remainder is destroyed with the reset). Gold
 *   dump every goldDumpPeriodTicks for opted-in players. Street Merchant
 *   roll at streetMerchant.rollAtTick (skipped if createMatch pre-set the
 *   spawn tick), spawn at spawnAtTick in both map.streetMerchantRegions.
 * - Contracts & trade routes: presence-based region scans (the original
 *   uses enter-rect events; idempotence comes from the carried-goods gate).
 *   A route's pickup requires the CONTRACT item carried, an eligible hull
 *   (carrierMaxItems: H00D < 3 items, H005 < 4) and a free slot; delivery
 *   at the OWN team's reward zone with contract + goods removes the goods
 *   and pays rewardGold + progression.grantXp + rewardLumber (the ONLY
 *   udg_PlayerLumber sources besides the Captain Reward — purchases never
 *   credit lumber; lumberCosts are pure thresholds). Captain Reward:
 *   piecesRequired x pieceItemId + tokenItemId inside the own-team reward
 *   zone pays out and consumes the pieces (token kept, verbatim).
 *   Suicide-bomb REGION logic lives in specials; quest tokens are ordinary
 *   inventory items.
 *
 * Tick order: runs 5th (after combat, before progression).
 * Internal step order (fixed for determinism): income -> empire share ->
 * gold dump -> street merchant -> shop restocks -> contracts.
 */

import { dist } from '../math.js';
import { applyHeal, castStormBolt } from './combat.js';
import { grantXp } from './progression.js';
import { applyEquipmentActive, breakInvisibilityOnAction } from './specials.js';
import {
  allocEntityId,
  pointInRegion,
  rollInt,
  sortedNumericKeys,
  type BuyItemCommand,
  type BuyShipCommand,
  type DropItemCommand,
  type EconomyCommandU,
  type EquipmentActive,
  type ItemInstance,
  type PickupItemCommand,
  type PlayerState,
  type Ruleset,
  type SellItemCommand,
  type SetGoldDumpCommand,
  type ShipEntity,
  type ShopSpec,
  type SimState,
  type StackRule,
  type StructureEntity,
  type TeamId,
  type UseItemCommand,
} from './types.js';

/** Fixed team iteration order (matches createMatch insertion order). */
const TEAM_ORDER: readonly TeamId[] = ['south', 'north'];

/**
 * WC3 item-interaction reach beyond the unit's collision circle (the engine
 * walks a unit to ~150 of an item before picking it up / dropping at a far
 * point). PROVISIONAL stock value — the sim validates instead of pathing.
 */
const ITEM_INTERACT_RANGE = 150;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function reject(
  state: SimState,
  cmd: { type: string; player: number },
  reason: string,
): void {
  state.events.push({
    type: 'commandRejected',
    tick: state.tick,
    player: cmd.player,
    commandType: cmd.type,
    reason,
  });
}

/** The player's living ship entity, or null while dead / awaiting respawn. */
function livingShip(state: SimState, player: PlayerState): ShipEntity | null {
  if (player.shipId === null) return null;
  const entity = state.entities[player.shipId];
  if (!entity || entity.kind !== 'ship' || entity.dead) return null;
  return entity;
}

/**
 * Full gold price of an item (ihtp == igol across the map data — refunds
 * always pay the shop price). Unpriced items (quest tokens, tomes) are 0.
 */
function itemGoldPrice(ruleset: Ruleset, itemId: string): number {
  return ruleset.equipment[itemId]?.gold ?? ruleset.weapons[itemId]?.gold ?? 0;
}

function itemCooldownGroup(ruleset: Ruleset, itemId: string): string | null {
  return (
    ruleset.equipment[itemId]?.cooldownGroup ?? ruleset.weapons[itemId]?.cooldownGroup ?? null
  );
}

/** Initial charge count when an item enters an inventory from a shop. */
function defaultCharges(ruleset: Ruleset, itemId: string): number | null {
  return ruleset.equipment[itemId]?.charges ?? null;
}

/** Usable inventory slot count for the player's CURRENT hull. */
function inventorySlotCount(ruleset: Ruleset, player: PlayerState, ship: ShipEntity | null): number {
  const typeId = ship ? ship.typeId : player.shipTypeId;
  return ruleset.ships[typeId]?.inventorySlots ?? player.inventory.length;
}

/** Lowest empty slot index below `slots`, or -1 when full. */
function firstFreeSlot(player: PlayerState, slots: number): number {
  const limit = Math.min(slots, player.inventory.length);
  for (let i = 0; i < limit; i++) {
    if (player.inventory[i] === null) return i;
  }
  return -1;
}

function countItems(player: PlayerState, itemId: string): number {
  let n = 0;
  for (const item of player.inventory) {
    if (item !== null && item.itemId === itemId) n += 1;
  }
  return n;
}

function removeOneItem(player: PlayerState, itemId: string): boolean {
  for (let i = 0; i < player.inventory.length; i++) {
    const item = player.inventory[i];
    if (item != null && item.itemId === itemId) {
      player.inventory[i] = null;
      return true;
    }
  }
  return false;
}

interface ShopLookup {
  shop: StructureEntity;
  spec: ShopSpec;
}

function lookupShop(state: SimState, ruleset: Ruleset, shopId: number): ShopLookup | null {
  const shop = state.entities[shopId];
  if (!shop || shop.kind !== 'structure' || shop.dead) return null;
  const spec = ruleset.shops[shop.typeId];
  if (!spec) return null;
  return { shop, spec };
}

/**
 * Which team's zone a shop sits in (Items_Not_Buyable gating). Runtime-
 * spawned shops (Street Merchant) have no placement -> open to both sides.
 */
function shopSide(ruleset: Ruleset, shop: StructureEntity): TeamId | null {
  if (shop.instanceKey === '') return null;
  for (const placement of ruleset.map.structures) {
    if (placement.instanceKey === shop.instanceKey) return placement.shopSide;
  }
  return null;
}

/** Common buy validation: living ship in interact range of an allied-side shop. */
function validateShopAccess(
  state: SimState,
  ruleset: Ruleset,
  cmd: { type: string; player: number; shopId: number },
): { player: PlayerState; ship: ShipEntity; shop: StructureEntity; spec: ShopSpec } | null {
  const player = state.players[cmd.player];
  if (!player) {
    reject(state, cmd, 'unknownPlayer');
    return null;
  }
  const ship = livingShip(state, player);
  if (!ship) {
    reject(state, cmd, 'noShip');
    return null;
  }
  const found = lookupShop(state, ruleset, cmd.shopId);
  if (!found) {
    reject(state, cmd, 'notAShop');
    return null;
  }
  if (dist(ship.x, ship.y, found.shop.x, found.shop.y) > found.spec.interactRadius) {
    reject(state, cmd, 'outOfRange');
    return null;
  }
  const side = shopSide(ruleset, found.shop);
  if (side !== null && side !== player.team) {
    reject(state, cmd, 'enemyShop');
    return null;
  }
  return { player, ship, shop: found.shop, spec: found.spec };
}

/** Non-AI player slots of a team, ascending (the five "human" lobby slots). */
function teamNonAiSlots(state: SimState, team: TeamId): number[] {
  const aiSlot = state.teams[team].aiPlayerSlot;
  const slots: number[] = [];
  for (const slot of sortedNumericKeys(state.players)) {
    const player = state.players[slot];
    if (player && player.team === team && slot !== aiSlot) slots.push(slot);
  }
  return slots;
}

/**
 * Income-table key: occupied human slots on the team, clamped to >= 1
 * (MAP_CONTROL_USER count of the original triggers).
 */
function teamHumanCount(state: SimState, team: TeamId): number {
  let n = 0;
  for (const slot of teamNonAiSlots(state, team)) {
    const player = state.players[slot];
    if (player && player.control === 'user') n += 1;
  }
  return Math.max(1, n);
}

function hqAlive(state: SimState, team: TeamId): boolean {
  for (const id of sortedNumericKeys(state.entities)) {
    const entity = state.entities[id];
    if (
      entity &&
      entity.kind === 'structure' &&
      entity.role === 'hq' &&
      entity.team === team &&
      !entity.dead
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ship stat recompute (shared with progression's passive hero skills)
// ---------------------------------------------------------------------------

/**
 * Recompute the player's ship maxHp from its CURRENT typeId (so dive-swapped
 * sub forms resolve correctly): ShipSpec.maxHp + equipment maxHpBonus +
 * learned hullHp hero-skill ranks. Clamps hp down to the new max (the one
 * sanctioned hp write in this module). Regen has no stored field — combat
 * sums ship spec + equipment + skill regen live each tick — so this is the
 * complete derived-stat recompute. Exported for progression (passive skill
 * rank-ups call it after mutating heroSkillLevels).
 */
export function recomputeShipStats(state: SimState, ruleset: Ruleset, playerSlot: number): void {
  const player = state.players[playerSlot];
  if (!player) return;
  const ship = livingShip(state, player);
  if (!ship) return;
  const spec = ruleset.ships[ship.typeId];
  if (!spec) return;
  let maxHp = spec.maxHp;
  for (const item of player.inventory) {
    if (item === null) continue;
    const passives = ruleset.equipment[item.itemId]?.passives;
    if (passives) maxHp += passives.maxHpBonus;
  }
  for (const abilityId of spec.abilityIds) {
    const ability = ruleset.abilities[abilityId];
    if (!ability || ability.mechanic !== 'hullHp') continue;
    const rank = player.heroSkillLevels[abilityId] ?? 0;
    if (rank <= 0) continue;
    const index = Math.min(rank, ability.magnitudePerRank.length) - 1;
    maxHp += ability.magnitudePerRank[index] ?? 0;
  }
  ship.maxHp = maxHp;
  if (ship.hp > maxHp) ship.hp = maxHp;
}

// ---------------------------------------------------------------------------
// Stack / class rules
// ---------------------------------------------------------------------------

/**
 * SubAcquiredItems is a BLACKLIST (war3map.j 9353-9404): submarines are
 * refunded exactly the nine listed items (repair woods, repair crews,
 * Kraken) and may keep anything else — a sub cannot self-repair but can
 * carry ordinary weapons.
 */
function itemBannedOnSub(ruleset: Ruleset, itemId: string): boolean {
  return ruleset.subRules.bannedItemIds.includes(itemId);
}

function conflictsWithActive(
  rule: StackRule,
  activeRuleIds: string[],
  rulesById: Record<string, StackRule>,
): boolean {
  for (const activeId of activeRuleIds) {
    if (activeId === rule.id) continue;
    if (rule.exclusiveWithRuleIds.includes(activeId)) return true;
    const active = rulesById[activeId];
    if (active && active.exclusiveWithRuleIds.includes(rule.id)) return true;
  }
  return false;
}

/** A rule applies in Classic (onlyInModes null) or when its mode is active. */
function ruleActive(state: SimState, rule: StackRule): boolean {
  if (rule.onlyInModes === null) return true;
  return rule.onlyInModes.some((mode) => state.enabledModes.includes(mode));
}

/**
 * True when `shipTypeId` is unavailable for purchase under any active game mode
 * (the SetPlayerUnitAvailableBJ(..., false, ...) lists in the vote-resolution
 * trigger). NormalPlay / no mode disables nothing. Matches createMatch's
 * first-enabled-real-mode resolution by checking every enabled mode's
 * disabledShipTypes — a hull disabled by ANY active mode is rejected.
 */
function shipTypeDisabledByMode(state: SimState, ruleset: Ruleset, shipTypeId: string): boolean {
  for (const name of state.enabledModes) {
    const mode = ruleset.gameModes[name];
    if (mode && mode.disabledShipTypes.includes(shipTypeId)) return true;
  }
  return false;
}

/**
 * Enforce stack caps / class restrictions / sub blacklist on one player's
 * inventory, refunding violations at FULL gold price (ihtp == igol) with a
 * 'refund' event. Items in slots at or beyond the current hull's
 * inventorySlots are violations too. Scans slots ascending and keeps
 * earlier items, EXCEPT the just-acquired slot (`newestSlot`, passed by
 * buy/pickup/quest-add) which is evaluated last — the original triggers
 * always refund GetManipulatedItem(), the item that just arrived, even when
 * it landed in a lower slot index. Rules with onlyInModes apply only while
 * one of their modes is in state.enabledModes (Classic: none). Ends with
 * the maxHp recompute, so callers only need this one call after any
 * inventory mutation.
 */
export function enforceItemRules(
  state: SimState,
  ruleset: Ruleset,
  playerSlot: number,
  newestSlot: number | null = null,
): void {
  const player = state.players[playerSlot];
  if (!player) return;
  const ship = livingShip(state, player);
  const shipTypeId = ship ? ship.typeId : player.shipTypeId;
  const shipSpec = ruleset.ships[shipTypeId];
  const slots = shipSpec?.inventorySlots ?? player.inventory.length;
  const isSub = shipSpec?.isSub ?? false;

  const rulesById: Record<string, StackRule> = {};
  for (const rule of ruleset.stackRules) rulesById[rule.id] = rule;

  const counts: Record<string, number> = {};
  const activeRuleIds: string[] = [];
  let torpedoes = 0;
  const removals: { slot: number; itemId: string; reason: string }[] = [];

  const scanOrder: number[] = [];
  for (let i = 0; i < player.inventory.length; i++) {
    if (i !== newestSlot) scanOrder.push(i);
  }
  if (newestSlot !== null && newestSlot >= 0 && newestSlot < player.inventory.length) {
    scanOrder.push(newestSlot);
  }

  for (const i of scanOrder) {
    const item = player.inventory[i];
    if (!item) continue;
    const itemId = item.itemId;
    let reason: string | null = null;

    if (i >= slots) {
      reason = 'noInventorySlot';
    } else if (isSub && itemBannedOnSub(ruleset, itemId)) {
      reason = 'subBanned';
    } else if (!isSub && ruleset.subRules.torpedoItemIds.includes(itemId)) {
      reason = 'torpedoSubOnly';
    } else if (isSub && ruleset.subRules.torpedoItemIds.includes(itemId)) {
      torpedoes += 1;
      if (torpedoes > ruleset.subRules.maxTorpedoBaysPerSub) reason = 'torpedoCap';
    }

    if (reason === null) {
      for (const rule of ruleset.stackRules) {
        if (!ruleActive(state, rule)) continue;
        if (!rule.itemIds.includes(itemId)) continue;
        if (rule.bannedOnShipTypes.includes(shipTypeId)) {
          reason = `banned:${rule.id}`;
          break;
        }
        if (conflictsWithActive(rule, activeRuleIds, rulesById)) {
          reason = `exclusive:${rule.id}`;
          break;
        }
        if ((counts[rule.id] ?? 0) + 1 > rule.maxPerShip) {
          reason = `stackCap:${rule.id}`;
          break;
        }
      }
    }

    if (reason !== null) {
      removals.push({ slot: i, itemId, reason });
      continue;
    }
    for (const rule of ruleset.stackRules) {
      if (!ruleActive(state, rule)) continue;
      if (!rule.itemIds.includes(itemId)) continue;
      counts[rule.id] = (counts[rule.id] ?? 0) + 1;
      if (!activeRuleIds.includes(rule.id)) activeRuleIds.push(rule.id);
    }
  }

  for (const removal of removals) {
    player.inventory[removal.slot] = null;
    const gold = itemGoldPrice(ruleset, removal.itemId);
    player.gold += gold;
    state.events.push({
      type: 'refund',
      tick: state.tick,
      player: playerSlot,
      itemId: removal.itemId,
      gold,
      reason: removal.reason,
    });
  }

  recomputeShipStats(state, ruleset, playerSlot);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function buyItem(state: SimState, ruleset: Ruleset, cmd: BuyItemCommand): void {
  const access = validateShopAccess(state, ruleset, cmd);
  if (!access) return;
  const { player, ship, shop, spec } = access;

  const entry = spec.items.find((item) => item.itemId === cmd.itemId);
  if (!entry) {
    reject(state, cmd, 'notSoldHere');
    return;
  }
  const lumberNeeded = Math.max(entry.lumberCost, ruleset.contracts.lumberCosts[cmd.itemId] ?? 0);
  if (player.lumber < lumberNeeded) {
    reject(state, cmd, 'notEnoughLumber');
    return;
  }
  if (player.gold < entry.gold) {
    reject(state, cmd, 'notEnoughGold');
    return;
  }
  const slot = firstFreeSlot(player, inventorySlotCount(ruleset, player, ship));
  if (slot < 0) {
    reject(state, cmd, 'inventoryFull');
    return;
  }
  if (entry.stockMax !== null) {
    if (entry.stockMax <= 0) {
      reject(state, cmd, 'outOfStock');
      return;
    }
    if (shop.shopStock === null) shop.shopStock = {};
    let record = shop.shopStock[cmd.itemId];
    if (!record) {
      record = { stock: entry.stockMax, nextRestockTick: 0 };
      shop.shopStock[cmd.itemId] = record;
    }
    if (record.stock <= 0) {
      reject(state, cmd, 'outOfStock');
      return;
    }
    // Buying from full stock arms the restock timer.
    if (record.stock === entry.stockMax && entry.restockTicks !== null) {
      record.nextRestockTick = state.tick + entry.restockTicks;
    }
    record.stock -= 1;
  }

  player.gold -= entry.gold;
  // No lumber mutation: contract items are pure udg_PlayerLumber THRESHOLDS.
  // The original's "lumber refund" only returns the WC3 engine's ilum charge
  // (net zero); purchases never credit trigger lumber (war3map.j 8225-8403).
  player.inventory[slot] = {
    itemId: cmd.itemId,
    charges: defaultCharges(ruleset, cmd.itemId),
    readyAtTick: 0,
  };
  state.events.push({
    type: 'purchase',
    tick: state.tick,
    player: cmd.player,
    itemId: cmd.itemId,
    shipTypeId: null,
    gold: entry.gold,
  });
  enforceItemRules(state, ruleset, cmd.player, slot);
}

function buyShip(state: SimState, ruleset: Ruleset, cmd: BuyShipCommand): void {
  const access = validateShopAccess(state, ruleset, cmd);
  if (!access) return;
  const { player, ship, spec } = access;

  const entry = spec.ships.find((s) => s.shipTypeId === cmd.shipTypeId);
  if (!entry) {
    reject(state, cmd, 'notSoldHere');
    return;
  }
  if (!ruleset.ships[cmd.shipTypeId]) {
    reject(state, cmd, 'unknownShipType');
    return;
  }
  // Game-mode hull availability (SetPlayerUnitAvailableBJ(..., false, ...) in
  // the vote-resolution trigger): a hull disabled by the active mode cannot be
  // purchased. NormalPlay (the solo-vs-AI default) disables nothing.
  if (shipTypeDisabledByMode(state, ruleset, cmd.shipTypeId)) {
    reject(state, cmd, 'shipDisabledInMode');
    return;
  }
  const lumberNeeded = Math.max(
    entry.lumberCost,
    ruleset.contracts.lumberCosts[cmd.shipTypeId] ?? 0,
  );
  if (player.lumber < lumberNeeded) {
    reject(state, cmd, 'notEnoughLumber');
    return;
  }
  if (player.gold < entry.gold) {
    reject(state, cmd, 'notEnoughGold');
    return;
  }

  player.gold -= entry.gold;
  // Change_Ship swaps the hull IN PLACE on the same entity id — all six
  // inventory slots live on PlayerState and transfer automatically;
  // enforceItemRules then refunds anything the new hull may not carry.
  player.shipTypeId = cmd.shipTypeId;
  ship.typeId = cmd.shipTypeId;
  ship.submerged = false;
  ship.casting = null;
  // The permanent dive ghost belongs to the submerged form only — strip it
  // so a dive -> buyShip chain cannot yield a permanently invisible hull
  // (mirrors castDive's surfacing filter).
  ship.statuses = ship.statuses.filter(
    (s) => !(s.kind === 'invisible' && s.expiresAtTick === null),
  );
  state.events.push({
    type: 'purchase',
    tick: state.tick,
    player: cmd.player,
    itemId: null,
    shipTypeId: cmd.shipTypeId,
    gold: entry.gold,
  });
  enforceItemRules(state, ruleset, cmd.player);
  ship.hp = ship.maxHp;
}

function sellItem(state: SimState, ruleset: Ruleset, cmd: SellItemCommand): void {
  if (ruleset.constants.sellbackRate === 0) {
    // Classic: no shop carries Asid — items can never be sold back.
    reject(state, cmd, 'noSellback');
    return;
  }
  const player = state.players[cmd.player];
  if (!player) {
    reject(state, cmd, 'unknownPlayer');
    return;
  }
  const ship = livingShip(state, player);
  if (!ship) {
    reject(state, cmd, 'noShip');
    return;
  }
  const item = player.inventory[cmd.slot];
  if (cmd.slot < 0 || cmd.slot >= player.inventory.length || !item) {
    reject(state, cmd, 'emptySlot');
    return;
  }
  const gold = Math.floor(itemGoldPrice(ruleset, item.itemId) * ruleset.constants.sellbackRate);
  player.inventory[cmd.slot] = null;
  player.gold += gold;
  state.events.push({
    type: 'refund',
    tick: state.tick,
    player: cmd.player,
    itemId: item.itemId,
    gold,
    reason: 'sellback',
  });
  enforceItemRules(state, ruleset, cmd.player);
}

function activeCooldownTicks(active: EquipmentActive): number {
  switch (active.kind) {
    case 'instantHeal':
    case 'blink':
    case 'invisibility':
    case 'summonWard':
    case 'flare':
      return active.cooldownTicks;
    default:
      return 0;
  }
}

function useItem(state: SimState, ruleset: Ruleset, cmd: UseItemCommand): void {
  const player = state.players[cmd.player];
  if (!player) {
    reject(state, cmd, 'unknownPlayer');
    return;
  }
  const ship = livingShip(state, player);
  if (!ship) {
    reject(state, cmd, 'noShip');
    return;
  }
  if (ship.pausedUntilTick > state.tick) {
    reject(state, cmd, 'paused');
    return;
  }
  if (ship.casting !== null) {
    reject(state, cmd, 'casting');
    return;
  }
  const item = cmd.slot >= 0 && cmd.slot < player.inventory.length ? player.inventory[cmd.slot] : null;
  if (!item) {
    reject(state, cmd, 'emptySlot');
    return;
  }
  if (item.readyAtTick > state.tick) {
    reject(state, cmd, 'itemOnCooldown');
    return;
  }
  const group = itemCooldownGroup(ruleset, item.itemId);
  if (group !== null && (player.cooldownGroups[group] ?? 0) > state.tick) {
    reject(state, cmd, 'groupOnCooldown');
    return;
  }
  if (item.charges !== null && item.charges <= 0) {
    reject(state, cmd, 'noCharges');
    return;
  }

  // Repair-Buildings-Mission reward (questSystems.repairMission): USING the
  // Goblin Mechanic token (or its refined Goblin Engineer while carrying the
  // book) pays out and consumes the token. War3map.j fires this on
  // EVENT_PLAYER_UNIT_USE_ITEM after a 1 s settle; the sim applies it on the
  // use command (the +1-tick settle is cosmetic for an instant gold/xp grant).
  const rm = ruleset.questSystems.repairMission;
  if (item.itemId === rm.tokenItemId || item.itemId === rm.refinedVariant.refinedTokenId) {
    const refined = item.itemId === rm.refinedVariant.refinedTokenId;
    // The refined reward requires the membership book still carried; the base
    // token has no extra requirement (war3map.j Trig_Repair_Mission_part2_*).
    if (refined && countItems(player, rm.refinedVariant.membershipItemId) === 0) {
      reject(state, cmd, 'missingBook');
      return;
    }
    player.inventory[cmd.slot] = null; // consume the token
    const reward = refined ? rm.refinedVariant.reward : rm.reward;
    payQuestReward(state, ruleset, cmd.player, player, reward, 'repairMission', 'repairMission');
    state.events.push({ type: 'itemUsed', tick: state.tick, player: cmd.player, itemId: item.itemId });
    breakInvisibilityOnAction(state, ship.id);
    enforceItemRules(state, ruleset, cmd.player);
    return;
  }

  let cooldownTicks: number;
  const weapon = ruleset.weapons[item.itemId];
  const equipment = ruleset.equipment[item.itemId];
  if (weapon && weapon.mechanic === 'stormBolt') {
    if (cmd.targetId === undefined) {
      reject(state, cmd, 'needsTarget');
      return;
    }
    // castStormBolt emits its own rejection on false; nothing is consumed.
    if (!castStormBolt(state, ruleset, ship.id, item.itemId, cmd.targetId)) return;
    cooldownTicks = weapon.cooldownTicks;
  } else if (weapon) {
    // Phoenix-Fire cannons are passive; warheads launch via fireMissile.
    reject(state, cmd, 'notActivatable');
    return;
  } else if (equipment && equipment.active) {
    const active = equipment.active;
    switch (active.kind) {
      case 'instantHeal':
        applyHeal(state, ship.id, active.amount);
        break;
      case 'xpTome':
        grantXp(state, ruleset, cmd.player, active.xp, 'tome');
        break;
      case 'flavor':
        break;
      case 'rejuvenation': {
        // HoT setup is a status; combat's regen pass accrues it (combat
        // applyHeal doc). Targets a friendly combatant in cast range
        // (default: own ship).
        const target = cmd.targetId !== undefined ? state.entities[cmd.targetId] : ship;
        if (
          !target ||
          target.dead ||
          target.kind === 'ward' ||
          target.team !== player.team ||
          dist(ship.x, ship.y, target.x, target.y) > active.rangeUnits
        ) {
          reject(state, cmd, 'invalidTarget');
          return;
        }
        const healPerTick = active.totalHeal / active.durationTicks;
        const expiresAtTick = state.tick + active.durationTicks;
        const existing = target.statuses.find((s) => s.kind === 'hot' && s.buffId === active.buffId);
        if (existing && existing.kind === 'hot') {
          existing.healPerTick = healPerTick;
          existing.expiresAtTick = expiresAtTick;
        } else {
          target.statuses.push({ kind: 'hot', buffId: active.buffId, healPerTick, expiresAtTick });
        }
        break;
      }
      default:
        // Ward/flare/blink/invisibility/reveal/summon effects are owned by
        // specials. applyEquipmentActive returns false on validation/data
        // failure — nothing may be consumed then (validate-then-mutate).
        if (!applyEquipmentActive(state, ruleset, cmd.player, active, cmd.x, cmd.y, cmd.targetId)) {
          reject(state, cmd, 'invalidTarget');
          return;
        }
        break;
    }
    cooldownTicks = activeCooldownTicks(active);
  } else {
    reject(state, cmd, 'notActivatable');
    return;
  }

  if (cooldownTicks > 0) {
    item.readyAtTick = state.tick + cooldownTicks;
    if (group !== null) player.cooldownGroups[group] = state.tick + cooldownTicks;
  }
  if (item.charges !== null) {
    item.charges -= 1;
    if (item.charges <= 0) player.inventory[cmd.slot] = null;
  }
  state.events.push({ type: 'itemUsed', tick: state.tick, player: cmd.player, itemId: item.itemId });
  // Item use is an action and breaks smoke — except the invisibility item
  // itself, whose freshly granted smoke must survive its own activation
  // (SEMANTICS §9; specials.applyEquipmentActive contract).
  if (!(equipment && equipment.active && equipment.active.kind === 'invisibility')) {
    breakInvisibilityOnAction(state, ship.id);
  }
  enforceItemRules(state, ruleset, cmd.player);
}

function dropItem(state: SimState, ruleset: Ruleset, cmd: DropItemCommand): void {
  const player = state.players[cmd.player];
  if (!player) {
    reject(state, cmd, 'unknownPlayer');
    return;
  }
  const ship = livingShip(state, player);
  if (!ship) {
    reject(state, cmd, 'noShip');
    return;
  }
  const item = cmd.slot >= 0 && cmd.slot < player.inventory.length ? player.inventory[cmd.slot] : null;
  if (!item) {
    reject(state, cmd, 'emptySlot');
    return;
  }
  // No teleport logistics: the drop point must be within reach (the WC3
  // engine walks the unit there; the sim validates instead).
  const reach = (ruleset.ships[ship.typeId]?.collisionRadius ?? 0) + ITEM_INTERACT_RANGE;
  if (dist(ship.x, ship.y, cmd.x, cmd.y) > reach) {
    reject(state, cmd, 'outOfRange');
    return;
  }
  player.inventory[cmd.slot] = null;
  // Perishable trade goods are destroyed when dropped (Goblin Mechanic etc.).
  if (!ruleset.equipment[item.itemId]?.perishable) {
    const id = allocEntityId(state);
    state.groundItems[id] = {
      id,
      itemId: item.itemId,
      x: cmd.x,
      y: cmd.y,
      charges: item.charges,
      // Cooldowns survive the ground trip (no drop/re-pick laundering).
      readyAtTick: item.readyAtTick,
    };
  }
  enforceItemRules(state, ruleset, cmd.player);
}

function pickupItem(state: SimState, ruleset: Ruleset, cmd: PickupItemCommand): void {
  const player = state.players[cmd.player];
  if (!player) {
    reject(state, cmd, 'unknownPlayer');
    return;
  }
  const ship = livingShip(state, player);
  if (!ship) {
    reject(state, cmd, 'noShip');
    return;
  }
  const ground = state.groundItems[cmd.groundItemId];
  if (!ground) {
    reject(state, cmd, 'noSuchItem');
    return;
  }
  // The ship must physically reach the item (no map-wide vacuuming).
  const reach = (ruleset.ships[ship.typeId]?.collisionRadius ?? 0) + ITEM_INTERACT_RANGE;
  if (dist(ship.x, ship.y, ground.x, ground.y) > reach) {
    reject(state, cmd, 'outOfRange');
    return;
  }
  const slot = firstFreeSlot(player, inventorySlotCount(ruleset, player, ship));
  if (slot < 0) {
    reject(state, cmd, 'inventoryFull');
    return;
  }
  player.inventory[slot] = {
    itemId: ground.itemId,
    charges: ground.charges,
    readyAtTick: ground.readyAtTick,
  };
  delete state.groundItems[cmd.groundItemId];
  enforceItemRules(state, ruleset, cmd.player, slot);
}

function setGoldDump(state: SimState, cmd: SetGoldDumpCommand): void {
  const player = state.players[cmd.player];
  if (!player) {
    reject(state, cmd, 'unknownPlayer');
    return;
  }
  player.goldDumpEnabled = cmd.enabled;
}

/**
 * Execute a player economy input (buyItem, sellItem, useItem, dropItem,
 * pickupItem, buyShip, setGoldDump). Invalid commands emit
 * 'commandRejected' and change nothing.
 */
export function applyEconomyCommand(state: SimState, ruleset: Ruleset, cmd: EconomyCommandU): void {
  switch (cmd.type) {
    case 'buyItem':
      buyItem(state, ruleset, cmd);
      return;
    case 'buyShip':
      buyShip(state, ruleset, cmd);
      return;
    case 'sellItem':
      sellItem(state, ruleset, cmd);
      return;
    case 'useItem':
      useItem(state, ruleset, cmd);
      return;
    case 'dropItem':
      dropItem(state, ruleset, cmd);
      return;
    case 'pickupItem':
      pickupItem(state, ruleset, cmd);
      return;
    case 'setGoldDump':
      setGoldDump(state, cmd);
      return;
  }
}

// ---------------------------------------------------------------------------
// Periodic economy (stepEconomy)
// ---------------------------------------------------------------------------

function stepIncome(state: SimState, ruleset: Ruleset): void {
  if (state.tick < state.timers.nextIncomeTick) return;
  state.timers.nextIncomeTick = state.tick + ruleset.income.intervalTicks;
  for (const team of TEAM_ORDER) {
    const gateTeam = ruleset.income.requiresNorthHqAlive ? 'north' : team;
    if (!hqAlive(state, gateTeam)) continue;
    const row = ruleset.income.byHumanCount[teamHumanCount(state, team)];
    if (!row) continue;
    for (const slot of teamNonAiSlots(state, team)) {
      const player = state.players[slot];
      if (player) player.gold += row.perHumanSlot;
    }
    const ai = state.players[state.teams[team].aiPlayerSlot];
    if (ai) ai.gold += row.toTeamAi;
  }
}

function stepEmpireShare(state: SimState): void {
  if (state.tick < state.timers.nextEmpireShareTick) return;
  state.timers.nextEmpireShareTick = state.tick + state.timers.empireSharePeriodTicks;
  for (const team of TEAM_ORDER) {
    const ai = state.players[state.teams[team].aiPlayerSlot];
    if (!ai || ai.gold <= 0) continue;
    const share = Math.floor(ai.gold / teamHumanCount(state, team));
    for (const slot of teamNonAiSlots(state, team)) {
      const player = state.players[slot];
      if (player) player.gold += share;
    }
    // Verbatim Trig_Empire_Gold: the AI's gold is zeroed after the split —
    // the integer-division remainder is destroyed, not carried.
    ai.gold = 0;
  }
}

function stepGoldDump(state: SimState, ruleset: Ruleset): void {
  if (state.tick < state.timers.nextGoldDumpTick) return;
  state.timers.nextGoldDumpTick = state.tick + ruleset.income.goldDumpPeriodTicks;
  for (const slot of sortedNumericKeys(state.players)) {
    const player = state.players[slot];
    if (!player || !player.goldDumpEnabled || player.gold <= 0) continue;
    const aiSlot = state.teams[player.team].aiPlayerSlot;
    if (slot === aiSlot) continue;
    const ai = state.players[aiSlot];
    if (!ai) continue;
    ai.gold += player.gold;
    player.gold = 0;
  }
}

/**
 * Initial per-item stock table for a shop structure of the given type
 * (items with unlimited stock are omitted). Exported for createMatch to
 * seed map-placed shops. Returns null for non-shop types.
 */
export function buildShopStock(
  ruleset: Ruleset,
  structureTypeId: string,
): Record<string, { stock: number; nextRestockTick: number }> | null {
  const spec = ruleset.shops[structureTypeId];
  if (!spec) return null;
  const stock: Record<string, { stock: number; nextRestockTick: number }> = {};
  for (const entry of spec.items) {
    if (entry.stockMax === null) continue;
    stock[entry.itemId] = { stock: entry.stockMax, nextRestockTick: 0 };
  }
  return stock;
}

function spawnStreetMerchant(state: SimState, ruleset: Ruleset, x: number, y: number): void {
  const typeId = ruleset.income.streetMerchant.merchantTypeId;
  const unitType = ruleset.unitTypes[typeId];
  const id = allocEntityId(state);
  const merchant: StructureEntity = {
    id,
    typeId,
    kind: 'structure',
    x,
    y,
    facingRad: 0,
    dead: false,
    owner: null,
    team: null,
    instanceKey: '',
    role: 'shop',
    hp: unitType?.maxHp ?? 1,
    maxHp: unitType?.maxHp ?? 1,
    statuses: [],
    attackReadyAtTick: 0,
    shopStock: buildShopStock(ruleset, typeId),
  };
  state.entities[id] = merchant;
}

function stepStreetMerchant(state: SimState, ruleset: Ruleset): void {
  const merchant = ruleset.income.streetMerchant;
  // Skip the roll if createMatch already scheduled a spawn (pre-rolled).
  if (state.tick === merchant.rollAtTick && state.timers.streetMerchantSpawnTick === null) {
    const roll = rollInt(state, merchant.rollMin, merchant.rollMax);
    if (roll > merchant.threshold) {
      state.timers.streetMerchantSpawnTick = merchant.spawnAtTick;
    }
  }
  const due = state.timers.streetMerchantSpawnTick;
  if (due === null || state.tick < due) return;
  state.timers.streetMerchantSpawnTick = null;
  for (const team of TEAM_ORDER) {
    const region = ruleset.map.regions[ruleset.map.streetMerchantRegions[team]];
    if (!region) continue;
    spawnStreetMerchant(state, ruleset, region.centerX, region.centerY);
  }
}

function stepRestocks(state: SimState, ruleset: Ruleset): void {
  for (const id of sortedNumericKeys(state.entities)) {
    const entity = state.entities[id];
    if (!entity || entity.kind !== 'structure' || entity.dead || entity.shopStock === null) {
      continue;
    }
    const spec = ruleset.shops[entity.typeId];
    if (!spec) continue;
    for (const entry of spec.items) {
      if (entry.stockMax === null || entry.restockTicks === null) continue;
      const record = entity.shopStock[entry.itemId];
      if (!record || record.stock >= entry.stockMax) continue;
      if (state.tick < record.nextRestockTick) continue;
      record.stock += 1;
      record.nextRestockTick = state.tick + entry.restockTicks;
    }
  }
}

function addQuestItem(
  state: SimState,
  ruleset: Ruleset,
  playerSlot: number,
  itemId: string,
  questId: string,
  stage: string,
): void {
  const player = state.players[playerSlot];
  if (!player) return;
  const ship = livingShip(state, player);
  const slot = firstFreeSlot(player, inventorySlotCount(ruleset, player, ship));
  if (slot < 0) return;
  const instance: ItemInstance = {
    itemId,
    charges: defaultCharges(ruleset, itemId),
    readyAtTick: 0,
  };
  player.inventory[slot] = instance;
  state.events.push({ type: 'questProgress', tick: state.tick, player: playerSlot, questId, stage });
  enforceItemRules(state, ruleset, playerSlot, slot);
}

/** Carried item count (JASS UnitInventoryCount). */
function carriedItemCount(player: PlayerState): number {
  let n = 0;
  for (const item of player.inventory) {
    if (item !== null) n += 1;
  }
  return n;
}

/** First slot holding `itemId`, or -1. */
function itemSlot(player: PlayerState, itemId: string): number {
  for (let i = 0; i < player.inventory.length; i++) {
    const item = player.inventory[i];
    if (item != null && item.itemId === itemId) return i;
  }
  return -1;
}

/**
 * Swap one carried `fromItemId` for `toItemId` in place (UnitAddItemBy-
 * IdSwapped semantics — the new good lands in the freed slot). Returns the
 * slot, or -1 if `fromItemId` is not carried.
 */
function swapItemInPlace(player: PlayerState, fromItemId: string, toItemId: string): number {
  const slot = itemSlot(player, fromItemId);
  if (slot < 0) return -1;
  player.inventory[slot] = { itemId: toItemId, charges: null, readyAtTick: 0 };
  return slot;
}

function pointInNamedRegion(ruleset: Ruleset, name: string, x: number, y: number): boolean {
  const region = ruleset.map.regions[name];
  return region !== undefined && pointInRegion(region, x, y);
}

/**
 * Pay a quest reward to one pilot: gold + lumber on the player, XP via
 * progression.grantXp (same share semantics as trade routes), and a
 * 'questProgress' event. Gold/lumber credit the PILOT only (the script's
 * AdjustPlayerStateBJ on GetOwningPlayer(GetTriggerUnit())), not the team.
 */
function payQuestReward(
  state: SimState,
  ruleset: Ruleset,
  playerSlot: number,
  player: PlayerState,
  reward: { rewardGold: number; rewardXp: number; rewardLumber: number },
  questId: string,
  reason: string,
): void {
  player.gold += reward.rewardGold;
  player.lumber += reward.rewardLumber;
  grantXp(state, ruleset, playerSlot, reward.rewardXp, reason);
  state.events.push({
    type: 'questProgress',
    tick: state.tick,
    player: playerSlot,
    questId,
    stage: 'delivered',
  });
}

// ---------------------------------------------------------------------------
// Quest systems: refinery, repair mission, treasure hunt (questSystems)
// ---------------------------------------------------------------------------

/**
 * REFINERY CHAIN (questSystems.refinery). Two presence-based stages, run for
 * one carrier (mirrors the trade-route scan; idempotence comes from the
 * carried-item gates):
 * - Refine swap at refineRegion: a carrier (H00D/H005) holding the membership
 *   book + a RAW good swaps the raw good for its REFINED good in place. Also
 *   refines the Repair-Mission token (I01J->I031) and the Treasure
 *   (I02G->I030, the Golden Statue — Trig_Golden_Treasure_Pick_Up) here.
 * - Cash-in at the OWN reward zone: contract + refined good + book carried ->
 *   refined good removed (contract + book kept), reward paid (1.5x raw gold).
 *   The refined-treasure cash-in lives in runTreasureHunt (it also consumes
 *   the contract).
 * No randomness — pure region + carried-item checks.
 *
 * Idempotence divergence (intentional, low impact): each swap also gates on
 * `countItems(refinedGoodId) === 0`. The script's Trig_*_Pick_Up conditions
 * (e.g. Trig_Beer_Pick_Up_Conditions, war3map.j 13591-13606) check ONLY the
 * raw good + the book — a ship carrying both a raw I00J and an already-refined
 * I02V would, in the enter-rect script, refine the raw into a SECOND I02V.
 * The sim is a per-tick presence scan, not an enter event, so this guard is
 * required to stop a ship parked in the Refinery from re-firing every tick;
 * it only diverges in the rare case of carrying both a raw and a refined copy
 * of the same good, and never double-pays a reward.
 */
function runRefinery(state: SimState, ruleset: Ruleset, slot: number, player: PlayerState, ship: ShipEntity): void {
  const refinery = ruleset.questSystems.refinery;
  const maxItems = refinery.carrierMaxItems[ship.typeId];
  if (maxItems === undefined) return; // not a refinery-eligible hull
  const hasBook = countItems(player, refinery.membershipItemId) > 0;

  // --- Step 1: refine swap at the central Refinery rect --------------------
  if (hasBook && pointInNamedRegion(ruleset, refinery.refineRegion, ship.x, ship.y)) {
    for (const swap of refinery.refineSwaps) {
      // One swap per matching raw good carried; the refined good replaces it
      // in place (no inventory-count gate — the slot count is unchanged).
      if (countItems(player, swap.rawGoodId) > 0 && countItems(player, swap.refinedGoodId) === 0) {
        const at = swapItemInPlace(player, swap.rawGoodId, swap.refinedGoodId);
        if (at >= 0) {
          state.events.push({
            type: 'questProgress',
            tick: state.tick,
            player: slot,
            questId: `refine:${swap.refinedGoodId}`,
            stage: 'refined',
          });
          enforceItemRules(state, ruleset, slot, at);
        }
      }
    }
    // Repair-Mission token refine (I01J -> I031), same rect + book gate.
    const rm = ruleset.questSystems.repairMission;
    if (
      countItems(player, rm.tokenItemId) > 0 &&
      countItems(player, rm.refinedVariant.refinedTokenId) === 0
    ) {
      const at = swapItemInPlace(player, rm.tokenItemId, rm.refinedVariant.refinedTokenId);
      if (at >= 0) {
        state.events.push({
          type: 'questProgress',
          tick: state.tick,
          player: slot,
          questId: 'repairMission',
          stage: 'refined',
        });
        enforceItemRules(state, ruleset, slot, at);
      }
    }
    // Superbomb token mints (Trig_Superbomb_Pick_Up1 I01F->I032,
    // Trig_Superbomb_Pick_Up I01G->I02Z): H005-only, gated on the book (I02Q)
    // + the raw token; the raw token is replaced in place and the enemy team
    // is warned. These are the ONLY in-game source of the superbomb tokens
    // I032/I02Z, completing the suicideQuests 'superbomb' arm/detonate chain.
    for (const sb of refinery.superbombSwaps) {
      if (ship.typeId !== sb.carrierShipType) continue;
      if (countItems(player, sb.rawTokenId) > 0 && countItems(player, sb.swappedTokenId) === 0) {
        const at = swapItemInPlace(player, sb.rawTokenId, sb.swappedTokenId);
        if (at >= 0) {
          state.events.push({
            type: 'questProgress',
            tick: state.tick,
            player: slot,
            questId: `superbomb:${sb.swappedTokenId}`,
            stage: 'pickedUp',
          });
          // The enemy minimap ping/warning (Trig_Superbomb_Pick_Up* both
          // PingMinimapLocForForceEx the enemy team) — modeled as the warn stage.
          state.events.push({
            type: 'questProgress',
            tick: state.tick,
            player: slot,
            questId: `superbomb:${sb.swappedTokenId}`,
            stage: 'enemyWarned',
          });
          enforceItemRules(state, ruleset, slot, at);
        }
      }
    }
    // Treasure refine (I02G -> I030, the Golden Statue), same rect + book gate
    // (Trig_Golden_Treasure_Pick_Up). H005-only (the trade-good refines accept
    // H00D too, but the Golden-Treasure trigger checks 'H005'). Cashes out via
    // runTreasureHunt for the larger refined reward.
    const th = ruleset.questSystems.treasureHunts;
    const trv = th.refinedVariant;
    if (
      ship.typeId === th.carrierShipType &&
      countItems(player, th.treasureItemId) > 0 &&
      countItems(player, trv.refinedTreasureId) === 0
    ) {
      const at = swapItemInPlace(player, th.treasureItemId, trv.refinedTreasureId);
      if (at >= 0) {
        state.events.push({
          type: 'questProgress',
          tick: state.tick,
          player: slot,
          questId: 'treasureHunt',
          stage: 'refined',
        });
        enforceItemRules(state, ruleset, slot, at);
      }
    }
  }

  // --- Step 2: cash-in at the OWN team's reward zone -----------------------
  if (!hasBook) return;
  if (!pointInNamedRegion(ruleset, refinery.rewardRegionByTeam[player.team], ship.x, ship.y)) return;
  for (const route of refinery.rewardRoutes) {
    if (route.team !== null && route.team !== player.team) continue;
    if (
      countItems(player, route.contractItemId) > 0 &&
      countItems(player, route.refinedGoodId) > 0
    ) {
      // Remove the refined good only (contract + book kept), pay the reward.
      removeOneItem(player, route.refinedGoodId);
      payQuestReward(
        state,
        ruleset,
        slot,
        player,
        { rewardGold: route.rewardGold, rewardXp: route.rewardXp, rewardLumber: route.rewardLumber },
        `refinery:${route.refinedGoodId}`,
        `refinery:${route.refinedGoodId}`,
      );
      enforceItemRules(state, ruleset, slot);
    }
  }
}

/**
 * REPAIR BUILDINGS MISSION token grant (questSystems.repairMission). At the
 * tokenRegion (gg_rct_GoblinBombShop), a carrier holding the contract and NOT
 * the token, with a free slot (UnitInventoryCount < hull max), gains the
 * token; the contract is kept. The USE-ITEM reward is handled in useItem.
 */
function runRepairMissionToken(
  state: SimState,
  ruleset: Ruleset,
  slot: number,
  player: PlayerState,
  ship: ShipEntity,
): void {
  const rm = ruleset.questSystems.repairMission;
  const maxItems = rm.carrierMaxItems[ship.typeId];
  if (maxItems === undefined) return;
  if (!pointInNamedRegion(ruleset, rm.tokenRegion, ship.x, ship.y)) return;
  if (countItems(player, rm.contractItemId) === 0) return;
  if (countItems(player, rm.tokenItemId) > 0) return;
  if (carriedItemCount(player) >= maxItems) return;
  addQuestItem(state, ruleset, slot, rm.tokenItemId, 'repairMission', 'token');
}

/**
 * TREASURE HUNT find/return (questSystems.treasureHunts). Treasure RNG:
 * - Seed both teams (south then north) ONCE at seedTick from the match Rng.
 * - On find, reroll that team's number inline (in the ascending-slot scan
 *   order) from the match Rng — so the GetRandomInt draw sequence is the
 *   canonical replay contract.
 * Find: a registered H005 ally carrying the team contract, NOT the treasure,
 *   with a free slot, entering the rect matching its team's current number ->
 *   treasure added + reroll. Return: at the OWN reward zone with contract +
 *   treasure -> BOTH removed (the contract IS consumed here), reward paid.
 * Refined return: at the OWN reward zone with contract + Golden Statue (I030,
 *   refined from the Treasure at the Refinery in runRefinery) + the Book of
 *   Formulas -> the statue + contract removed (book kept), the 1.5x reward
 *   paid (Trig_{South,North}TreasureReward_Copy). The base and refined paths
 *   are mutually exclusive: a returning carrier holds either the Treasure or
 *   the Statue, never both (the refine is a swap-in-place).
 */
function runTreasureHunt(
  state: SimState,
  ruleset: Ruleset,
  slot: number,
  player: PlayerState,
  ship: ShipEntity,
): void {
  const th = ruleset.questSystems.treasureHunts;
  if (ship.typeId !== th.carrierShipType) return;
  const contractId = th.contractByTeam[player.team];
  const hasContract = countItems(player, contractId) > 0;
  const hasTreasure = countItems(player, th.treasureItemId) > 0;

  // --- Find ----------------------------------------------------------------
  const current = state.treasureByTeam[player.team];
  if (
    current !== null &&
    hasContract &&
    !hasTreasure &&
    carriedItemCount(player) < th.pickupMaxCarriedItems
  ) {
    const regionName = th.locationRegionsByNumber[player.team][String(current)];
    if (regionName !== undefined && pointInNamedRegion(ruleset, regionName, ship.x, ship.y)) {
      addQuestItem(state, ruleset, slot, th.treasureItemId, 'treasureHunt', 'found');
      // Reroll this team's number from the match Rng (inline draw order).
      state.treasureByTeam[player.team] = rollInt(state, 1, th.locationCount);
    }
  }

  // --- Return --------------------------------------------------------------
  if (!hasContract) return;
  if (!pointInNamedRegion(ruleset, th.rewardRegionByTeam[player.team], ship.x, ship.y)) return;
  // Base path: raw Treasure -> 14000g. Contract consumed.
  if (countItems(player, th.treasureItemId) > 0) {
    removeOneItem(player, th.treasureItemId);
    removeOneItem(player, contractId); // the contract IS consumed on return
    payQuestReward(state, ruleset, slot, player, th.reward, 'treasureHunt', 'treasureHunt');
    enforceItemRules(state, ruleset, slot);
    return;
  }
  // Refined path: Golden Statue + Book of Formulas -> 21000g. The statue +
  // contract are removed; the book is kept (Trig_*TreasureReward_Copy).
  const trv = th.refinedVariant;
  if (
    countItems(player, trv.refinedTreasureId) > 0 &&
    countItems(player, trv.membershipItemId) > 0
  ) {
    removeOneItem(player, trv.refinedTreasureId);
    removeOneItem(player, contractId);
    payQuestReward(state, ruleset, slot, player, trv.reward, 'treasureHunt', 'treasureHunt:refined');
    enforceItemRules(state, ruleset, slot);
  }
}

/**
 * Seed the per-team treasure numbers once at TreasureHuntSpec.seedTick, in a
 * fixed draw order (south then north) so the match replays bit-identically.
 * Idempotent: the null sentinel guards re-seeding.
 */
function seedTreasure(state: SimState, ruleset: Ruleset): void {
  const th = ruleset.questSystems.treasureHunts;
  if (state.tick !== th.seedTick) return;
  if (state.treasureByTeam.south === null) {
    state.treasureByTeam.south = rollInt(state, 1, th.locationCount);
  }
  if (state.treasureByTeam.north === null) {
    state.treasureByTeam.north = rollInt(state, 1, th.locationCount);
  }
}

/**
 * Run the three secondary quest chains for every living-ship player, in
 * ascending slot order (the canonical iteration). The treasure RNG draw
 * order — seed (south then north) at seedTick, then rerolls inline in this
 * scan — is the replay contract.
 */
function stepQuestSystems(state: SimState, ruleset: Ruleset): void {
  seedTreasure(state, ruleset);
  for (const slot of sortedNumericKeys(state.players)) {
    const player = state.players[slot];
    if (!player) continue;
    const ship = livingShip(state, player);
    if (!ship) continue;
    runRefinery(state, ruleset, slot, player, ship);
    runRepairMissionToken(state, ruleset, slot, player, ship);
    runTreasureHunt(state, ruleset, slot, player, ship);
  }
}

function stepContracts(state: SimState, ruleset: Ruleset): void {
  for (const slot of sortedNumericKeys(state.players)) {
    const player = state.players[slot];
    if (!player) continue;
    const ship = livingShip(state, player);
    if (!ship) continue;
    const ownDeliverRegions: string[] = [];
    // Multi-delivery lumber quirk (war3map.j 12090-12152 / 12229-12291): each
    // matching reward block OVERWRITES udg_RewardLumber and the final block
    // credits the LAST-set value once. So gold+XP accumulate per delivered
    // route this visit, but lumber is credited for only the highest-blockOrder
    // delivered route. We defer the lumber credit and apply it after the loop.
    let lumberCreditBlockOrder = -1;
    let lumberCredit = 0;

    for (const route of ruleset.contracts.tradeRoutes) {
      const deliverName = route.deliverRegionByTeam[player.team];
      if (!ownDeliverRegions.includes(deliverName)) ownDeliverRegions.push(deliverName);
      // Team-gated routes (pigs/boxes south, potions/books north, captives).
      if (route.team !== null && route.team !== player.team) continue;
      // Carrier gate: H00D/H005 only (Trade Boat / Trade Ship).
      const maxItems = route.carrierMaxItems[ship.typeId];
      if (maxItems === undefined) continue;
      const questId = `trade:${route.goodsItemId}`;
      // Pickup: contract carried, goods absent, UnitInventoryCount < max.
      if (
        countItems(player, route.goodsItemId) === 0 &&
        countItems(player, route.contractItemId) > 0 &&
        carriedItemCount(player) < maxItems
      ) {
        const pickup = ruleset.map.regions[route.pickupRegion];
        if (pickup && pointInRegion(pickup, ship.x, ship.y)) {
          addQuestItem(state, ruleset, slot, route.goodsItemId, questId, 'pickup');
        }
      }
      // Delivery at the OWN team's reward zone: goods removed, contract
      // kept, gold/XP/lumber paid (war3map.j South/North_Rewards).
      if (
        countItems(player, route.goodsItemId) > 0 &&
        countItems(player, route.contractItemId) > 0
      ) {
        const deliver = ruleset.map.regions[deliverName];
        if (deliver && pointInRegion(deliver, ship.x, ship.y)) {
          removeOneItem(player, route.goodsItemId);
          player.gold += route.rewardGold;
          // Lumber is NOT summed per route: only the last (highest-blockOrder)
          // delivered route's lumber is credited (the udg_RewardLumber
          // overwrite quirk). Defer; apply once after the route loop.
          if (route.rewardBlockOrder >= lumberCreditBlockOrder) {
            lumberCreditBlockOrder = route.rewardBlockOrder;
            lumberCredit = route.rewardLumber;
          }
          grantXp(state, ruleset, slot, route.rewardXp, `contract:${route.goodsItemId}`);
          state.events.push({
            type: 'questProgress',
            tick: state.tick,
            player: slot,
            questId,
            stage: 'delivered',
          });
          enforceItemRules(state, ruleset, slot);
        }
      }
    }
    // Apply the single deferred lumber credit (the last delivered block's value).
    if (lumberCreditBlockOrder >= 0) player.lumber += lumberCredit;

    // Captain Reward: EXACTLY piecesRequired wood pieces (udg_LumberPieces == 5,
    // strict equality, war3map.j 12312) + the contract token (I01R), turned in
    // by The Captain (H00J) at the OWN team's reward zone
    // (South/North_Captain_Rewards). The contract token is kept, verbatim.
    // Gated on the H00J ship type (Trig_*_Captain_Rewards_Conditions): since no
    // playable hull is H00J and the Chop-Wood subsystem that mints I01N is not
    // modeled, this turn-in is correctly unreachable — exactly as in the
    // original without the (out-of-scope) sell-ship-to-Captain subsystem.
    const captain = ruleset.contracts.captainReward;
    if (
      ship.typeId === captain.shipTypeId &&
      countItems(player, captain.tokenItemId) > 0 &&
      countItems(player, captain.pieceItemId) === captain.piecesRequired
    ) {
      let inRewardZone = false;
      for (const regionName of ownDeliverRegions) {
        const region = ruleset.map.regions[regionName];
        if (region && pointInRegion(region, ship.x, ship.y)) {
          inRewardZone = true;
          break;
        }
      }
      if (inRewardZone) {
        for (let i = 0; i < captain.piecesRequired; i++) {
          removeOneItem(player, captain.pieceItemId);
        }
        player.gold += captain.rewardGold;
        player.lumber += captain.rewardLumber;
        grantXp(state, ruleset, slot, captain.rewardXp, 'contract:captainReward');
        state.events.push({
          type: 'questProgress',
          tick: state.tick,
          player: slot,
          questId: 'captainReward',
          stage: 'delivered',
        });
        enforceItemRules(state, ruleset, slot);
      }
    }
  }
}

/**
 * One economy tick: income, empire share, gold dump, merchant, restocks,
 * contracts, quest systems. stepQuestSystems runs AFTER stepContracts so the
 * raw trade routes resolve before the refinery (which reads the same carried
 * contract/goods state) — and the treasure-RNG draw order is anchored to this
 * fixed position in the tick.
 */
export function stepEconomy(state: SimState, ruleset: Ruleset): void {
  stepIncome(state, ruleset);
  stepEmpireShare(state);
  stepGoldDump(state, ruleset);
  stepStreetMerchant(state, ruleset);
  stepRestocks(state, ruleset);
  stepContracts(state, ruleset);
  stepQuestSystems(state, ruleset);
}
