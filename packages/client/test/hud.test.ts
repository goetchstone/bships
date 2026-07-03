/**
 * client-hud tests — pure logic only (no DOM, no headless browser):
 * keymap dispatch/rebinding and the hudmath helpers (XP progress, cooldown
 * sweeps, minimap transform, shop proximity, kill feed), plus light
 * integration checks against the real compiled catalog.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ABILITY_ACTIONS,
  DEFAULT_BINDINGS,
  HUD_ACTIONS,
  actionForCode,
  bindingFor,
  handleKeyEvent,
  onAction,
  onRawKey,
  resetKeymapForTests,
  setBinding,
} from '../src/input/keymap.js';
import type { HudAction } from '../src/input/keymap.js';
import {
  CooldownTracker,
  abilityCooldownInfo,
  abilityIcon,
  abilityTargetingMode,
  canLearnSkill,
  cooldownSecondsText,
  createMinimapTransform,
  itemCooldownTicks,
  itemDisplay,
  itemTargetingMode,
  keyLabel,
  killFeedLine,
  nearestShopInRange,
  ownShipPosition,
  rejectionMessage,
  shipAbilitySlots,
  shipActiveAbilityId,
  shipLearnableSkills,
  shipPassiveLearnableSkills,
  sortScoreboardRows,
  sweepFraction,
  targetingCueText,
  xpProgress,
} from '../src/hud/hudmath.js';
import type { PendingTargetLike } from '../src/hud/hudmath.js';
import type { PublicPlayerStat, SimEvent, TeamId } from '@bships/core';
import { getCatalog } from '../src/catalog.js';
import { HUD_CSS } from '../src/hud/hud.js';
import { BH_ONBOARD_CSS } from '../src/hud/onboarding.js';
import { declares, ruleBody, valueOf } from '../src/hud/csslint.js';
import {
  OPENING_TIP_TEXT,
  OnboardingState,
  enemyHqName,
  helpRows,
} from '../src/hud/onboarding.js';

function fakeKey(type: 'keydown' | 'keyup', code: string, repeat = false): KeyboardEvent {
  return {
    type,
    code,
    repeat,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe('keymap', () => {
  beforeEach(() => {
    resetKeymapForTests();
  });

  it('default bindings match the design contract (and avoid the numpad)', () => {
    expect(DEFAULT_BINDINGS).toEqual({
      slot0: 'KeyW',
      slot1: 'KeyE',
      slot2: 'KeyR',
      slot3: 'KeyA',
      slot4: 'KeyS',
      slot5: 'KeyD',
      // Hull spellbook quick-keys: F kept primary, then the left-hand cluster.
      ability0: 'KeyF',
      ability1: 'KeyQ',
      ability2: 'KeyT',
      ability3: 'KeyC',
      ability4: 'KeyX',
      ability5: 'KeyZ',
      stop: 'KeyV',
      attackMove: 'KeyG',
      scoreboard: 'Tab',
      chat: 'Enter',
      shopToggle: 'KeyB',
      help: 'F1',
      recenter: 'Space',
    });
    for (const code of Object.values(DEFAULT_BINDINGS)) {
      expect(code).not.toMatch(/^Numpad/);
    }
    expect(HUD_ACTIONS).toHaveLength(Object.keys(DEFAULT_BINDINGS).length);
  });

  it('bindingFor honors setBinding overrides and reverts to defaults', () => {
    expect(bindingFor('stop')).toBe('KeyV');
    setBinding('stop', 'KeyM'); // KeyM is otherwise unbound
    expect(bindingFor('stop')).toBe('KeyM');
    expect(actionForCode('KeyM')).toBe('stop');
    expect(actionForCode('KeyV')).toBeNull();
    setBinding('stop', 'KeyV'); // back to default clears the override
    expect(bindingFor('stop')).toBe('KeyV');
  });

  it('dispatches bound actions on keydown and keyup, swallowing auto-repeat', () => {
    const got: { action: HudAction; type: string }[] = [];
    onAction((action, e) => got.push({ action, type: e.type }));

    handleKeyEvent(fakeKey('keydown', 'KeyW'));
    handleKeyEvent(fakeKey('keydown', 'KeyW', true)); // auto-repeat ignored
    handleKeyEvent(fakeKey('keyup', 'KeyW'));
    handleKeyEvent(fakeKey('keydown', 'KeyM')); // unbound

    expect(got).toEqual([
      { action: 'slot0', type: 'keydown' },
      { action: 'slot0', type: 'keyup' },
    ]);
  });

  it('preventDefaults Tab on both keydown and keyup', () => {
    const down = fakeKey('keydown', 'Tab');
    const up = fakeKey('keyup', 'Tab');
    handleKeyEvent(down);
    handleKeyEvent(up);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(up.preventDefault).toHaveBeenCalled();
  });

  it('raw key listeners run first and can consume the event', () => {
    const actions: HudAction[] = [];
    onAction((a) => actions.push(a));
    onRawKey((e) => e.code === 'KeyB');

    handleKeyEvent(fakeKey('keydown', 'KeyB')); // consumed by raw listener
    handleKeyEvent(fakeKey('keydown', 'KeyF')); // passes through (ability slot 0)

    expect(actions).toEqual(['ability0']);
  });
});

describe('hudmath: keyLabel', () => {
  it('shortens KeyboardEvent codes to HUD labels', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit7')).toBe('7');
    expect(keyLabel('Tab')).toBe('TAB');
    expect(keyLabel('Enter')).toBe('ENT');
    expect(keyLabel('Escape')).toBe('ESC');
  });
});

describe('hudmath: xpProgress', () => {
  // Cumulative XP needed to REACH the level at each index.
  const xpToLevel = [0, 0, 200, 500, 900];

  it('reports progress into the current level', () => {
    expect(xpProgress(120, 1, xpToLevel, 12)).toEqual({ into: 120, needed: 200 });
    expect(xpProgress(350, 2, xpToLevel, 12)).toEqual({ into: 150, needed: 300 });
  });

  it('clamps progress to the level span', () => {
    expect(xpProgress(99999, 2, xpToLevel, 12)).toEqual({ into: 300, needed: 300 });
    expect(xpProgress(-5, 1, xpToLevel, 12)).toEqual({ into: 0, needed: 200 });
  });

  it('returns needed=null at the level cap and beyond the table', () => {
    expect(xpProgress(900, 4, xpToLevel, 12).needed).toBeNull(); // table end
    expect(xpProgress(500, 3, xpToLevel, 3).needed).toBeNull(); // heroLevelCap
  });
});

describe('hudmath: cooldown sweeps', () => {
  it('sweepFraction maps remaining ticks onto [0,1]', () => {
    expect(sweepFraction(100, 100, 40)).toBe(0);
    expect(sweepFraction(100, 120, 40)).toBe(0);
    expect(sweepFraction(100, 80, 40)).toBeCloseTo(0.5);
    expect(sweepFraction(100, 60, 40)).toBe(1);
    expect(sweepFraction(100, 95, null)).toBe(1); // unknown duration: full
  });

  it('CooldownTracker uses the catalog duration when provided', () => {
    const t = new CooldownTracker();
    expect(t.fraction('a', 200, 120, 100)).toBeCloseTo(0.8);
    expect(t.fraction('a', 200, 150, 100)).toBeCloseTo(0.5);
    expect(t.fraction('a', 200, 200, 100)).toBe(0);
  });

  it('CooldownTracker animates unknown durations from first observation', () => {
    const t = new CooldownTracker();
    expect(t.fraction('b', 300, 100, null)).toBe(1); // observed mid-cooldown
    expect(t.fraction('b', 300, 200, null)).toBeCloseTo(0.5);
    expect(t.fraction('b', 300, 300, null)).toBe(0);
    // A NEW cooldown on the same key re-anchors.
    expect(t.fraction('b', 500, 400, null)).toBe(1);
  });

  it('formats remaining seconds legibly', () => {
    expect(cooldownSecondsText(300, 20)).toBe('15');
    expect(cooldownSecondsText(45, 20)).toBe('2.3');
    expect(cooldownSecondsText(0, 20)).toBe('0.0');
  });
});

describe('hudmath: minimap transform', () => {
  it('flips y and preserves aspect (no foreshortening)', () => {
    const t = createMinimapTransform({ minX: -1000, minY: -2000, maxX: 3000, maxY: 2000 }, 220);
    expect(t.width).toBe(220);
    expect(t.height).toBe(220);
    // North-west world corner -> top-left pixel.
    expect(t.toMini(-1000, 2000)).toEqual({ x: 0, y: 0 });
    // South-east world corner -> bottom-right pixel.
    expect(t.toMini(3000, -2000)).toEqual({ x: 220, y: 220 });
  });

  it('handles non-square bounds with a uniform scale', () => {
    const t = createMinimapTransform({ minX: 0, minY: 0, maxX: 4000, maxY: 2000 }, 220);
    expect(t.width).toBe(220);
    expect(t.height).toBe(110);
  });

  it('round-trips world coordinates', () => {
    const t = createMinimapTransform({ minX: -512, minY: -512, maxX: 512, maxY: 512 }, 220);
    const mini = t.toMini(123.5, -77.25);
    const world = t.toWorld(mini.x, mini.y);
    expect(world.x).toBeCloseTo(123.5, 5);
    expect(world.y).toBeCloseTo(-77.25, 5);
  });
});

describe('hudmath: shop proximity', () => {
  const shops = { harbor: { interactRadius: 400 }, tinker: { interactRadius: 200 } };

  it('returns null when nothing is in range', () => {
    const hit = nearestShopInRange(
      { x: 0, y: 0 },
      [{ id: 7, typeId: 'harbor', x: 1000, y: 0 }],
      shops,
    );
    expect(hit).toBeNull();
  });

  it('ignores structures without a ShopSpec and picks the nearest in range', () => {
    const hit = nearestShopInRange(
      { x: 0, y: 0 },
      [
        { id: 1, typeId: 'tower', x: 10, y: 0 }, // not a shop
        { id: 2, typeId: 'harbor', x: 350, y: 0 }, // in range
        { id: 3, typeId: 'harbor', x: 300, y: 0 }, // in range, nearer
        { id: 4, typeId: 'tinker', x: 250, y: 0 }, // out of its smaller radius
      ],
      shops,
    );
    expect(hit?.id).toBe(3);
  });

  it('respects per-shop interact radii (boundary inclusive)', () => {
    const hit = nearestShopInRange(
      { x: 0, y: 0 },
      [{ id: 5, typeId: 'tinker', x: 200, y: 0 }],
      shops,
    );
    expect(hit?.id).toBe(5);
  });
});

describe('hudmath: ownShipPosition (drop targeting)', () => {
  const entities = [
    { kind: 'structure', ownerSlot: null, x: 1, y: 1 },
    { kind: 'ship', ownerSlot: 7, x: 10, y: 20 }, // teammate / enemy
    { kind: 'ship', ownerSlot: 2, x: 30, y: -40 }, // mine
  ];

  it('finds the viewer own ship by slot', () => {
    expect(ownShipPosition(entities, 2)).toEqual({ x: 30, y: -40 });
  });

  it('returns null when there is no slot or no matching ship', () => {
    expect(ownShipPosition(entities, null)).toBeNull();
    expect(ownShipPosition(entities, 5)).toBeNull(); // slot present, no ship
    expect(ownShipPosition([], 2)).toBeNull(); // dead / not spawned
  });

  it('ignores non-ship entities even when the owner matches', () => {
    const onlyStruct = [{ kind: 'structure', ownerSlot: 2, x: 9, y: 9 }];
    expect(ownShipPosition(onlyStruct, 2)).toBeNull();
  });
});

describe('hudmath: kill feed', () => {
  const nameOf = (slot: number): string => (slot === 3 ? 'Alice' : slot === 8 ? 'Bob' : `P${slot}`);
  const death = (victim: number | null, killer: number | null): SimEvent => ({
    type: 'death',
    tick: 1,
    entityId: 42,
    entityTypeId: 'H001',
    victimPlayer: victim,
    killerPlayer: killer,
    x: 0,
    y: 0,
  });

  it('formats player kills and unattributed sinkings', () => {
    expect(killFeedLine(death(3, 8), nameOf)).toBe('Bob sunk Alice');
    expect(killFeedLine(death(3, null), nameOf)).toBe('Alice was sunk');
  });

  it('ignores non-player deaths and non-death events', () => {
    expect(killFeedLine(death(null, 8), nameOf)).toBeNull();
    const ev: SimEvent = { type: 'levelUp', tick: 1, player: 3, level: 4 };
    expect(killFeedLine(ev, nameOf)).toBeNull();
  });
});

describe('hudmath: sortScoreboardRows', () => {
  const stat = (
    slot: number,
    team: TeamId,
    kills: number,
    goldEarned = 0,
  ): PublicPlayerStat => ({
    slot,
    name: `P${slot}`,
    team,
    shipTypeId: 'H001',
    level: 1,
    kills,
    deaths: 0,
    goldEarned,
    connected: true,
  });

  it('filters to the requested team and sorts kills descending', () => {
    const players = [stat(2, 'south', 1), stat(7, 'north', 5), stat(3, 'south', 4)];
    expect(sortScoreboardRows(players, 'south').map((p) => p.slot)).toEqual([3, 2]);
    expect(sortScoreboardRows(players, 'north').map((p) => p.slot)).toEqual([7]);
  });

  it('breaks kill ties by ascending slot (stable ordering)', () => {
    const players = [stat(6, 'south', 2), stat(2, 'south', 2), stat(4, 'south', 2)];
    expect(sortScoreboardRows(players, 'south').map((p) => p.slot)).toEqual([2, 4, 6]);
  });

  it('carries goldEarned through untouched (a per-player cumulative tally)', () => {
    const players = [stat(2, 'south', 0, 1500), stat(3, 'south', 1, 800)];
    const rows = sortScoreboardRows(players, 'south');
    expect(rows.map((p) => p.goldEarned)).toEqual([800, 1500]); // kills desc: slot 3 first
  });
});

describe('catalog integration (display data)', () => {
  const catalog = getCatalog();

  it('resolves names and emoji for every shop entry', () => {
    for (const shop of Object.values(catalog.shops)) {
      for (const entry of shop.items) {
        const disp = itemDisplay(catalog, entry.itemId);
        expect(disp.name.length).toBeGreaterThan(0);
        expect(disp.emoji.length).toBeGreaterThan(0);
      }
      for (const entry of shop.ships) {
        expect(catalog.ships[entry.shipTypeId]?.name.length).toBeGreaterThan(0);
      }
    }
  });

  it('resolves the F-key ship ability without throwing for every hull', () => {
    let actives = 0;
    for (const typeId of Object.keys(catalog.ships)) {
      const abilityId = shipActiveAbilityId(catalog, typeId);
      if (abilityId !== null) {
        actives++;
        expect(catalog.abilities[abilityId]).toBeDefined();
        const info = abilityCooldownInfo(catalog, {}, abilityId);
        expect(info.readyAtTick).toBe(0);
      }
    }
    expect(actives).toBeGreaterThan(0); // at least the subs' Dive
  });

  it('surfaces Shore Leave on F for the starter Battle Ship (H000)', () => {
    // The reported "I don't see any ship abilities" bug: the starter hull's F
    // slot must resolve to its innate active (Shore Leave A01D), not null.
    const abilityId = shipActiveAbilityId(catalog, 'H000');
    expect(abilityId).toBe('A01D');
    expect(catalog.abilities[abilityId!]?.name).toBe('Shore Leave');
    expect(catalog.abilities[abilityId!]?.mechanic).toBe('shoreLeave');
  });

  it('finds item cooldowns for weapon items', () => {
    const weaponIds = Object.keys(catalog.weapons);
    expect(weaponIds.length).toBeGreaterThan(0);
    for (const id of weaponIds.slice(0, 5)) {
      expect(itemCooldownTicks(catalog, id)).toBeGreaterThan(0);
    }
    expect(itemCooldownTicks(catalog, 'definitely-not-an-item')).toBeNull();
  });

  it('starting ship exists and the minimap transform covers the map bounds', () => {
    expect(catalog.ships[catalog.map.startingShipTypeId]).toBeDefined();
    const t = createMinimapTransform(catalog.map.bounds, 220);
    expect(Math.max(t.width, t.height)).toBe(220);
    expect(Math.min(t.width, t.height)).toBeGreaterThan(0);
  });
});

describe('ability casting: F-key binding + targeting (the "abilities never fire" bug)', () => {
  const catalog = getCatalog();

  // applyCastAbility (specials.ts) routes mechanic 'special' straight to a
  // 'unimplemented' rejection, so F must never resolve to one — that was a
  // guaranteed silent no-op for Merchant Boat / some Cruisers / Flagship /
  // Leviathian. Every hull's F ability must instead map to a mechanic the sim
  // actually handles.
  const SIM_HANDLED_MECHANICS = new Set([
    'shoreLeave',
    'flareDetection',
    'ensnare',
    'invisibility',
    'dive',
    'stormBoltWeapon',
    'phoenixFireWeapon',
  ]);

  it('every hull binds F to a sim-handled ability (never an unimplemented "special")', () => {
    for (const typeId of Object.keys(catalog.ships)) {
      const abilityId = shipActiveAbilityId(catalog, typeId);
      if (abilityId === null) continue; // a hull with no castable active is fine
      const mechanic = catalog.abilities[abilityId]?.mechanic;
      expect(mechanic, `hull ${typeId} F-ability ${abilityId}`).toBeDefined();
      expect(
        SIM_HANDLED_MECHANICS.has(mechanic!),
        `hull ${typeId} F-ability ${abilityId} has mechanic '${mechanic}' which the sim rejects`,
      ).toBe(true);
    }
  });

  it('the starter Battle Ship (H000) still surfaces Shore Leave on F', () => {
    const abilityId = shipActiveAbilityId(catalog, 'H000');
    expect(abilityId).toBe('A01D');
    expect(catalog.abilities[abilityId!]?.mechanic).toBe('shoreLeave');
  });

  it('abilityTargetingMode arms the right click per mechanic', () => {
    // The client must supply the target the sim demands; otherwise the cast is
    // rejected ('missingTarget'/'invalidTarget') and "the ability does nothing".
    const flare = Object.values(catalog.abilities).find((a) => a.mechanic === 'flareDetection');
    const ensnare = Object.values(catalog.abilities).find((a) => a.mechanic === 'ensnare');
    const torpedo = Object.values(catalog.abilities).find((a) => a.mechanic === 'stormBoltWeapon');
    const shore = Object.values(catalog.abilities).find((a) => a.mechanic === 'shoreLeave');
    expect(flare && abilityTargetingMode(catalog, flare.abilityId)).toBe('point');
    expect(ensnare && abilityTargetingMode(catalog, ensnare.abilityId)).toBe('unit');
    // stormBoltWeapon (sub Torpedo) fires at an enemy unit -> needs a unit click.
    expect(torpedo && abilityTargetingMode(catalog, torpedo.abilityId)).toBe('unit');
    // Shore Leave is self-cast at the harbour -> no click armed.
    expect(shore && abilityTargetingMode(catalog, shore.abilityId)).toBe('none');
    expect(abilityTargetingMode(catalog, 'not-an-ability')).toBe('none');
  });

  it('itemTargetingMode arms point for blink, unit for reveal/rejuvenation, none otherwise', () => {
    // Light Teleporter (blink) needs an x/y or the sim returns 'invalidTarget'.
    expect(itemTargetingMode(catalog, 'I01L')).toBe('point');
    // Informant (reveal) and the mechanic crews (rejuvenation) need an ally/enemy.
    expect(itemTargetingMode(catalog, 'wshs')).toBe('unit');
    expect(itemTargetingMode(catalog, 'I01J')).toBe('unit');
    // Self/untargeted actives send immediately (no arming).
    expect(itemTargetingMode(catalog, 'I00C')).toBe('none'); // repair wood (instantHeal)
    expect(itemTargetingMode(catalog, 'I01K')).toBe('none'); // smoke (invisibility)
    expect(itemTargetingMode(catalog, 'not-an-item')).toBe('none');
  });
});

describe('spellbook: shipAbilitySlots renders one quick-key per castable ability', () => {
  const catalog = getCatalog();

  // G2: an N-ability hull shows N quick-keys. The HUD loop in inventory.ts
  // builds exactly shipAbilitySlots(...).length visible slots, so testing the
  // pure driver proves the render count without a DOM.
  it('the Crusader (H001) shows MORE castable quick-keys than the Sailor (H000)', () => {
    const sailor = shipAbilitySlots(catalog, 'H000');
    const crusader = shipAbilitySlots(catalog, 'H001');
    // Sailor casts Shore Leave + Captain's Cannon (Hull/Sails/Mechanics are
    // passive — ranked in the picker, never a quick-key).
    expect(sailor.map((s) => s.abilityId).sort()).toEqual(['A01D', 'A01Y']);
    // Crusader casts Fishing Net + Shore Leave + Hide + Capsize (the active
    // 'special' now surfaces; Sails + True Sight are passive).
    expect(crusader.map((s) => s.abilityId).sort()).toEqual(['A00Y', 'A01A', 'A01D', 'A047']);
    expect(crusader.length).toBeGreaterThan(sailor.length); // more abilities, more keys
  });

  it('never assigns more quick-keys than the keymap has ability hotkeys', () => {
    for (const typeId of Object.keys(catalog.ships)) {
      expect(shipAbilitySlots(catalog, typeId).length).toBeLessThanOrEqual(ABILITY_ACTIONS.length);
    }
  });

  // G4: each slot carries the targeting the sim demands, so the cast routes the
  // right command (self-fire vs an armed target click).
  it('carries the correct targeting per ability (self / point / unit)', () => {
    const crusader = shipAbilitySlots(catalog, 'H001');
    const byId = new Map(crusader.map((s) => [s.abilityId, s.targeting]));
    expect(byId.get('A00Y')).toBe('unit'); // Fishing Net ensnares an enemy ship
    expect(byId.get('A047')).toBe('none'); // Hide is self-cast
    expect(byId.get('A01D')).toBe('none'); // Shore Leave is self-cast at harbour
    // The submarine's Torpedo + Echo-Location need a unit / point respectively.
    const sub = new Map(shipAbilitySlots(catalog, 'H00V').map((s) => [s.abilityId, s.targeting]));
    expect(sub.get('A04X')).toBe('unit'); // Torpedo -> enemy unit
    expect(sub.get('A04D')).toBe('point'); // Echo-Location -> map point
    expect(sub.get('A04C')).toBe('none'); // Dive -> self
  });

  it('surfaces ACTIVE specials (Capsize) but excludes passive auras + passives', () => {
    const crusader = shipAbilitySlots(catalog, 'H001').map((s) => s.abilityId);
    expect(crusader).toContain('A01A'); // Capsize — active 'special', now castable
    expect(catalog.abilities['A01A']?.mechanic).toBe('special');
    expect(abilityTargetingMode(catalog, 'A01A')).toBe('unit'); // suicidal nuke targets a ship
    expect(crusader).not.toContain('A03W'); // Ship Sails (passive)
    expect(crusader).not.toContain('Adtg'); // True Sight (passive)

    // Passive 'special' auras never claim a quick-key (Cruiser H006 carries
    // Slow Aura A02D); the active Cruiser specials do.
    const cruiser = shipAbilitySlots(catalog, 'H006').map((s) => s.abilityId);
    expect(cruiser).not.toContain('A02D'); // Slow Aura (passive aura)
    expect(cruiser).toContain('A037'); // EMP (active)
  });

  it('gives every castable slot a non-empty icon and a defined ability', () => {
    let total = 0;
    for (const typeId of Object.keys(catalog.ships)) {
      for (const slot of shipAbilitySlots(catalog, typeId)) {
        total++;
        expect(catalog.abilities[slot.abilityId]).toBeDefined();
        expect(abilityIcon(catalog, slot.abilityId).length).toBeGreaterThan(0);
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  // BUG 1 regression: the OLD filter hid EVERY mechanic 'special' ability, so a
  // hull with active specials lost those quick-keys. The fix surfaces the
  // castable ones, so the slot count must go UP vs that old behavior.
  it('shows MORE quick-keys than the old special-excluded filter (BUG 1)', () => {
    // The pre-fix rule: a 'special' ability never got a quick-key.
    const oldSlots = (typeId: string): string[] => {
      const ship = catalog.ships[typeId];
      if (ship === undefined) return [];
      return ship.abilityIds.filter((id) => {
        const a = catalog.abilities[id];
        return a !== undefined && a.mechanic !== 'special' && shipAbilitySlots(catalog, typeId).some((s) => s.abilityId === id);
      });
    };
    // Crusader (Capsize active special) and Cruiser (EMP active special) both
    // gain at least one castable special the old filter would have hidden.
    for (const typeId of ['H001', 'H006']) {
      const now = shipAbilitySlots(catalog, typeId).map((s) => s.abilityId);
      const before = oldSlots(typeId);
      expect(now.length).toBeGreaterThan(before.length);
      // Every newly-surfaced id is an active (non-passive, non-null) special.
      for (const id of now.filter((x) => !before.includes(x))) {
        const a = catalog.abilities[id];
        expect(a?.mechanic).toBe('special');
        expect(a?.special).not.toBeNull();
        expect(a?.special?.passive).not.toBe(true);
      }
    }
  });
});

describe('targeting cue + arming (BUG 2): pending-target prompt and cancel', () => {
  const catalog = getCatalog();

  it('targetingCueText names the ability and what to click (unit vs point)', () => {
    // Fishing Net (A00Y) is a unit-target ensnare; the cue says "enemy ship".
    const netName = catalog.abilities['A00Y']?.name ?? 'Fishing Net';
    const unitCue = targetingCueText(catalog, {
      kind: 'ability',
      targeting: 'unit',
      abilityId: 'A00Y',
    });
    expect(unitCue).toContain(netName);
    expect(unitCue).toContain('enemy ship');

    // Echo-Location (A04D) is point-cast; the cue says "click a location".
    const flareName = catalog.abilities['A04D']?.name ?? 'Echo-Location';
    const pointCue = targetingCueText(catalog, {
      kind: 'ability',
      targeting: 'point',
      abilityId: 'A04D',
    });
    expect(pointCue).toContain(flareName);
    expect(pointCue).toContain('location');
  });

  it('uses the caller-supplied item name for an item cast (and falls back)', () => {
    const cue = targetingCueText(
      catalog,
      { kind: 'item', targeting: 'unit', slot: 2 },
      'Light Teleporter',
    );
    expect(cue).toContain('Light Teleporter');
    expect(cue).toContain('enemy ship');
    // No name supplied -> a generic but non-empty label, never blank/undefined.
    const generic = targetingCueText(catalog, { kind: 'item', targeting: 'point', slot: 0 });
    expect(generic).toContain('location');
    expect(generic).not.toContain('undefined');
  });

  it('the armed-slot highlight is derivable from a pendingTarget (matches the hud loop)', () => {
    // The hud frame loop highlights ability slot i when the pendingTarget's
    // abilityId equals shipAbilitySlots()[i]. Prove that derivation here.
    const armed: PendingTargetLike = { kind: 'ability', targeting: 'unit', abilityId: 'A00Y' };
    const slots = shipAbilitySlots(catalog, 'H001');
    const armedIndex = slots.findIndex((s) => s.abilityId === armed.abilityId);
    expect(armedIndex).toBeGreaterThanOrEqual(0); // Fishing Net is a Crusader quick-key
    expect(slots[armedIndex]?.targeting).toBe('unit'); // and it arms a unit click
  });
});

describe('level-up picker: shipLearnableSkills + canLearnSkill (the learnSkill gate)', () => {
  const catalog = getCatalog();

  // G3: the picker lists every hull hero skill (passive or active) and gates a
  // rank-up exactly like the sim (progression.applyLearnSkill), so a '+' click
  // only ever sends a learnSkill the sim will accept.
  it('lists the Crusader hull hero skills (incl. passives) in ability order', () => {
    const ids = shipLearnableSkills(catalog, 'H001').map((s) => s.abilityId);
    // Fishing Net, Capsize, Ship Sails, Hide — every ability with a HeroSkillRule
    // (Shore Leave + True Sight are innate, no rule, so they are NOT listed).
    expect(ids).toEqual(['A00Y', 'A01A', 'A03W', 'A047']);
    expect(ids).not.toContain('A01D');
    expect(ids).not.toContain('Adtg');
  });

  it('lists the Sailor hero skills (hull / mechanics / cannon / sails)', () => {
    const ids = shipLearnableSkills(catalog, 'H000').map((s) => s.abilityId);
    expect(ids).toEqual(['A007', 'A009', 'A01Y', 'A03W']);
  });

  it('canLearnSkill mirrors the sim gate: unspent point + level + below max rank', () => {
    // Ship Sails on the Sailor: ranks 6, minHeroLevel 1, levelsPerRank 2.
    const sails = shipLearnableSkills(catalog, 'H000').find((s) => s.abilityId === 'A03W')!;
    expect(sails.ranks).toBe(6);
    // No unspent point -> never.
    expect(canLearnSkill(sails, 0, 1, 0)).toBe(false);
    // Rank 0 -> 1 needs level >= minHeroLevel (1).
    expect(canLearnSkill(sails, 0, 1, 1)).toBe(true);
    // Rank 1 -> 2 needs level >= 1 + 1*2 = 3.
    expect(canLearnSkill(sails, 1, 2, 1)).toBe(false);
    expect(canLearnSkill(sails, 1, 3, 1)).toBe(true);
    // At max rank -> never, even with points/level.
    expect(canLearnSkill(sails, 6, 99, 9)).toBe(false);
  });

  it('respects a high minHeroLevel gate (Fishing Net needs level 5)', () => {
    const net = shipLearnableSkills(catalog, 'H001').find((s) => s.abilityId === 'A00Y')!;
    expect(net.minHeroLevel).toBe(5);
    expect(canLearnSkill(net, 0, 4, 1)).toBe(false); // too low
    expect(canLearnSkill(net, 0, 5, 1)).toBe(true); // clears the gate
  });

  // --- "I can't learn it / bigger ships show no skills" bug ----------------
  // Root cause: the cast bar's '+' only ever appeared on CASTABLE abilities, so
  // the PASSIVE hero skills (hull HP, sails, repair crew, auras) — which carry
  // skill rules but no quick-key — had no badge anywhere and could never be
  // ranked. shipPassiveLearnableSkills feeds the dedicated "Skills" strip that
  // fixes this. These tests lock the invariant that no learnable skill is
  // orphaned and that every hull has somewhere to spend a starting point.
  it('the passive strip surfaces the Sailor hull/mechanics/sails (not its cannon)', () => {
    const passive = shipPassiveLearnableSkills(catalog, 'H000').map((s) => s.abilityId);
    // Enforced Hull, Onboard Mechanics Crew, Ship Sails — the passives.
    expect(passive).toEqual(['A007', 'A009', 'A03W']);
    // The Captain's Cannon (A01Y) is castable, so it keeps its badge in the cast
    // bar and is NOT duplicated into the strip.
    expect(passive).not.toContain('A01Y');
    expect(passive).not.toContain('A01D'); // Shore Leave: innate, not learnable
  });

  it('EVERY learnable skill on EVERY hull is reachable (cast-bar OR strip) — no orphans', () => {
    for (const typeId of Object.keys(catalog.ships)) {
      const castIds = new Set(shipAbilitySlots(catalog, typeId).map((s) => s.abilityId));
      const passiveIds = new Set(shipPassiveLearnableSkills(catalog, typeId).map((s) => s.abilityId));
      for (const skill of shipLearnableSkills(catalog, typeId)) {
        const reachable = castIds.has(skill.abilityId) || passiveIds.has(skill.abilityId);
        expect(reachable, `${typeId} skill ${skill.abilityId} has no +badge`).toBe(true);
      }
    }
  });

  it('a hull whose castable skills are all level-gated still shows spendable passives at L1', () => {
    // H00A Royal Ship: its only castable hero skill (A01B) needs hero level 8,
    // so before the fix it showed ZERO '+' badges at level 1 ("no skills"). The
    // passive strip (Mechanics, Super Hull, Nautical, Sails) is spendable at L1.
    const passive = shipPassiveLearnableSkills(catalog, 'H00A');
    expect(passive.length).toBeGreaterThan(0);
    const spendableNow = passive.filter((s) => canLearnSkill(s, 0, 1, 1));
    expect(spendableNow.length).toBeGreaterThan(0);
  });
});

describe('ship names: distinct properName per hull (so the player knows which is which)', () => {
  const catalog = getCatalog();

  it('gives each hull its distinct WC3 proper name, not the shared class name', () => {
    const proper = (id: string): string =>
      (catalog.ships[id] as { properName?: string }).properName ?? '';
    // The class name (unam) collides across hulls; the proper name (upro) does not.
    expect(catalog.ships['H000']?.name).toBe('Battle Ship');
    expect(proper('H000')).toBe('Sailor');
    expect(proper('H001')).toBe('Crusader');
    expect(proper('H003')).toBe('Interceptor');
    // The four "Cruiser"-class hulls are distinguishable by proper name.
    const cruisers = ['H006', 'H007', 'H008', 'H009'].map(proper);
    expect(new Set(cruisers).size).toBe(4);
  });

  it('every hull has a non-empty proper name', () => {
    for (const [id, spec] of Object.entries(catalog.ships)) {
      const proper = (spec as { properName?: string }).properName ?? '';
      expect(proper.length, `${id} has empty properName`).toBeGreaterThan(0);
    }
  });
});

describe('rejectionMessage: friendly text for sim commandRejected reasons', () => {
  it('explains a rank-0 hero skill (notLearned) and names it + the fix', () => {
    const msg = rejectionMessage('notLearned', "Captain's Cannon");
    expect(msg).toContain("Captain's Cannon");
    expect(msg.toLowerCase()).toContain('learn');
    expect(msg).toContain('+'); // points to the learn badge
  });

  it('maps the skill-gate reasons to actionable help', () => {
    expect(rejectionMessage('noSkillPoints', 'Fishing Net').toLowerCase()).toContain('level up');
    expect(rejectionMessage('levelTooLow', 'Fishing Net')).toContain('Fishing Net');
    expect(rejectionMessage('maxRank', 'Fishing Net').toLowerCase()).toContain('max rank');
  });

  it('maps Shore Leave away-from-harbour and the target reasons', () => {
    expect(rejectionMessage('notAtMainHarbour', null).toLowerCase()).toContain('main harbour');
    expect(rejectionMessage('missingTarget', 'Torpedo').toLowerCase()).toContain('target');
    expect(rejectionMessage('needsTarget', 'Torpedo').toLowerCase()).toContain('target');
    expect(rejectionMessage('invalidTarget', 'Torpedo').toLowerCase()).toContain('target');
  });

  it('falls back to a terse line for unknown reasons (named and unnamed)', () => {
    expect(rejectionMessage('somethingElse', 'Acid Bomb')).toBe('Cannot use Acid Bomb: somethingElse');
    expect(rejectionMessage('somethingElse', null)).toBe('Cannot do that: somethingElse');
  });

  it('uses a generic subject when no label is known', () => {
    expect(rejectionMessage('notLearned', null)).toContain('That ability');
  });
});

describe('csslint: rule extraction', () => {
  const css = `
    /* a comment */
    .a, .b { color: red; left: 12px; }
    .c { position: absolute; transform: translateX(-50%); }
  `;

  it('returns the body of a rule by exact selector in a list', () => {
    expect(ruleBody(css, '.a')).toBe('color: red; left: 12px;');
    expect(ruleBody(css, '.b')).toBe('color: red; left: 12px;');
    expect(ruleBody(css, '.c')).toBe('position: absolute; transform: translateX(-50%);');
  });

  it('returns null for an absent selector and is not fooled by substrings', () => {
    expect(ruleBody(css, '.d')).toBeNull();
    expect(ruleBody(css, '.ab')).toBeNull();
  });

  it('declares() matches a property/value pair loosely', () => {
    const body = ruleBody(css, '.c');
    expect(declares(body, 'position', 'absolute')).toBe(true);
    expect(declares(body, 'transform', 'translateX')).toBe(true);
    expect(declares(body, 'left', '0')).toBe(false);
    expect(declares(null, 'position', 'absolute')).toBe(false);
  });

  it('valueOf() returns the raw declared value', () => {
    expect(valueOf(ruleBody(css, '.a'), 'left')).toBe('12px');
    expect(valueOf(ruleBody(css, '.c'), 'transform')).toBe('translateX(-50%)');
    expect(valueOf(ruleBody(css, '.a'), 'top')).toBeNull();
  });
});

describe('HUD layout contract (regression guards for the reported bugs)', () => {
  it('chat docks bottom-LEFT and is never centered', () => {
    const chat = ruleBody(HUD_CSS, '.bh-chat');
    expect(declares(chat, 'position', 'absolute')).toBe(true);
    // Anchored to the left edge, NOT left:50% / centered.
    expect(valueOf(chat, 'left')).toBe('12px');
    expect(declares(chat, 'transform', 'translateX(-50%)')).toBe(false);
    expect(valueOf(chat, 'left')).not.toBe('50%');
    // Bottom-anchored flex column with the input pinned to the bottom.
    expect(declares(chat, 'flex-direction', 'column')).toBe(true);
    expect(declares(chat, 'justify-content', 'flex-end')).toBe(true);
    // Sits above the minimap (a positive bottom offset clearing the panel).
    const bottom = valueOf(chat, 'bottom');
    expect(bottom).not.toBeNull();
    expect(Number.parseInt(bottom ?? '0', 10)).toBeGreaterThan(200);
  });

  it('chat block is display-only; only the input row captures pointer events', () => {
    expect(declares(ruleBody(HUD_CSS, '.bh-chat'), 'pointer-events', 'none')).toBe(true);
    expect(declares(ruleBody(HUD_CSS, '.bh-chat-log'), 'pointer-events', 'none')).toBe(true);
    expect(declares(ruleBody(HUD_CSS, '.bh-chat-input'), 'pointer-events', 'auto')).toBe(true);
  });

  it('hidden-toggled elements with an explicit display keep a [hidden] override', () => {
    // An author `display:` rule beats the UA's [hidden]{display:none}, so any
    // class both toggled via el.hidden and declaring display MUST restate the
    // hidden state. Live-play bug: the chat input row (meant to be summoned by
    // Enter) was always visible AND clickable, and one stray click focused it —
    // silently swallowing every game hotkey into chat until Escape.
    expect(declares(ruleBody(HUD_CSS, '.bh-chat-input[hidden]'), 'display', 'none')).toBe(true);
    expect(declares(ruleBody(BH_ONBOARD_CSS, '.bh-objective[hidden]'), 'display', 'none')).toBe(
      true,
    );
  });

  it('minimap docks to the bottom-left corner with a framed panel', () => {
    const mini = ruleBody(HUD_CSS, '.bh-minimap');
    expect(declares(mini, 'position', 'absolute')).toBe(true);
    expect(valueOf(mini, 'left')).toBe('12px');
    expect(valueOf(mini, 'bottom')).toBe('12px');
    expect(declares(mini, 'border', '1px')).toBe(true);
  });

  it('only the minimap canvas (not the frame) captures pointer events', () => {
    // The wrapper frame must NOT swallow clicks across its padded panel; only
    // the canvas itself is interactive so the corner stays mostly click-through.
    expect(declares(ruleBody(HUD_CSS, '.bh-minimap'), 'pointer-events', 'auto')).toBe(false);
    expect(declares(ruleBody(HUD_CSS, '.bh-minimap canvas'), 'pointer-events', 'auto')).toBe(true);
  });

  it('top bar is display-only (clicks fall through to the canvas)', () => {
    const bar = ruleBody(HUD_CSS, '.bh-topbar');
    expect(declares(bar, 'pointer-events', 'none')).toBe(true);
    // Top-center.
    expect(valueOf(bar, 'top')).toBe('0');
    expect(declares(bar, 'transform', 'translateX(-50%)')).toBe(true);
  });

  it('inventory is interactive, docked bottom-center, hugging the bottom edge', () => {
    const inv = ruleBody(HUD_CSS, '.bh-inventory');
    expect(declares(inv, 'pointer-events', 'auto')).toBe(true);
    expect(declares(inv, 'transform', 'translateX(-50%)')).toBe(true);
    const bottom = valueOf(inv, 'bottom');
    // Within a thin strip of the bottom edge, out of the central play rect.
    expect(Number.parseInt(bottom ?? '999', 10)).toBeLessThanOrEqual(16);
  });

  it('the attack-move armed state is visually distinct', () => {
    expect(declares(ruleBody(HUD_CSS, '.bh-order.bh-armed'), 'border-color', 'var(--danger)')).toBe(
      true,
    );
  });

  it('the armed-target cue (BUG 2) is centred, danger-accented, click-through', () => {
    const cue = ruleBody(HUD_CSS, '.bh-targetcue');
    expect(cue).not.toBeNull();
    expect(declares(cue, 'position', 'absolute')).toBe(true);
    expect(declares(cue, 'transform', 'translateX(-50%)')).toBe(true); // horizontally centred
    // Matches the attack-move armed look (danger border) so both armed states read alike.
    expect(declares(cue, 'border', 'var(--danger)')).toBe(true);
    // pointer-events:none so the targeting click passes through to the canvas.
    expect(declares(cue, 'pointer-events', 'none')).toBe(true);
    // Hidden when nothing is armed.
    expect(declares(ruleBody(HUD_CSS, '.bh-targetcue[hidden]'), 'display', 'none')).toBe(true);
  });

  it('the spellbook quick-keys sit in their own flex group, gold-framed', () => {
    expect(declares(ruleBody(HUD_CSS, '.bh-abilities'), 'display', 'flex')).toBe(true);
    // Ability slots are gold-bordered to read as the hull spellbook.
    expect(declares(ruleBody(HUD_CSS, '.bh-slot.bh-ability'), 'border-color', 'var(--gold)')).toBe(
      true,
    );
    // An ability slot the hull does NOT carry collapses out of the bar.
    expect(declares(ruleBody(HUD_CSS, '.bh-slot.bh-hidden'), 'display', 'none')).toBe(true);
  });

  it('the level-up "+" badge is hidden until shown, then a green clickable pip', () => {
    const plus = ruleBody(HUD_CSS, '.bh-slot-plus');
    expect(declares(plus, 'display', 'none')).toBe(true); // hidden by default
    expect(declares(plus, 'cursor', 'pointer')).toBe(true);
    expect(declares(plus, 'background', 'var(--ready)')).toBe(true);
    // Toggled visible only when the ability can be ranked up right now.
    expect(declares(ruleBody(HUD_CSS, '.bh-slot-plus.bh-show'), 'display', 'flex')).toBe(true);
  });

  it('the learnable "+" badge glows (pulses) only when a point can be spent', () => {
    // Base badge no longer carries the pulse — it is on .bh-can-learn so a shown
    // badge that cannot be afforded does not falsely pulse.
    expect(declares(ruleBody(HUD_CSS, '.bh-slot-plus'), 'animation', 'bh-plus-pulse')).toBe(false);
    const canLearn = ruleBody(HUD_CSS, '.bh-slot-plus.bh-can-learn');
    expect(declares(canLearn, 'animation', 'bh-plus-pulse')).toBe(true);
    expect(declares(canLearn, 'box-shadow', 'var')).toBe(false); // a literal glow, not a token
  });

  it('an UNLEARNED hero skill slot is desaturated/dimmed with a lock stamp', () => {
    // The icon reads as locked (grayscale + dimmed) so a rank-0 skill is not
    // mistaken for a broken key.
    const icon = ruleBody(HUD_CSS, '.bh-slot.bh-ability.bh-unlearned .bh-slot-icon');
    expect(declares(icon, 'filter', 'grayscale')).toBe(true);
    // And a lock glyph is stamped over it.
    const lock = ruleBody(HUD_CSS, '.bh-slot.bh-ability.bh-unlearned::after');
    expect(lock).not.toBeNull();
    expect(declares(lock, 'content', '1F512')).toBe(true);
    expect(declares(lock, 'pointer-events', 'none')).toBe(true); // never eats the click
  });

  it('the unspent-skill-points indicator is a glowing pill, hidden at zero', () => {
    const sp = ruleBody(HUD_CSS, '.bh-skillpoints');
    expect(declares(sp, 'border', 'var(--ready)')).toBe(true);
    expect(declares(sp, 'animation', 'bh-plus-pulse')).toBe(true);
    expect(declares(ruleBody(HUD_CSS, '.bh-skillpoints[hidden]'), 'display', 'none')).toBe(true);
  });

  it('the shop cue clears the inventory bar (never covers a slot hotkey, task #21)', () => {
    const inv = ruleBody(HUD_CSS, '.bh-inventory');
    const cue = ruleBody(HUD_CSS, '.bh-shopcue');
    expect(declares(cue, 'position', 'absolute')).toBe(true);
    // The inventory hugs the bottom edge (bottom <= 16) and is ~110px tall with
    // its hint caption; the cue must sit ABOVE that whole span so its gold pill
    // never overlaps the centred inventory slots' quick-key labels.
    const invBottom = Number.parseInt(valueOf(inv, 'bottom') ?? '0', 10);
    const cueBottom = Number.parseInt(valueOf(cue, 'bottom') ?? '0', 10);
    expect(cueBottom).toBeGreaterThan(invBottom + 110);
    // ...and the press-B pill (its in-range counterpart) sits at the same height.
    const pillBottom = Number.parseInt(valueOf(ruleBody(HUD_CSS, '.bh-shop-pill'), 'bottom') ?? '0', 10);
    expect(pillBottom).toBe(cueBottom);
  });
});

describe('onboarding: enemyHqName (objective from the STATIC map, never the sim)', () => {
  // Two HQ harbors plus a noise structure; owner slots map to teams via
  // playerStarts (mirrors the real catalog: owner 0 = south, owner 1 = north).
  const playerStarts: Record<number, { team: TeamId }> = {
    0: { team: 'south' },
    1: { team: 'north' },
  };
  const structures = [
    { role: 'shop', owner: 0, typeId: 'n002' }, // not an HQ
    { role: 'hq', owner: 0, typeId: 'n000' }, // south HQ
    { role: 'hq', owner: 1, typeId: 'n000' }, // north HQ
  ];
  const nameOf = (typeId: string): string | undefined =>
    typeId === 'n000' ? 'Main Harbor' : undefined;

  it('names the OPPOSING HQ for a south player', () => {
    // South's enemy HQ is the north-owned harbor (owner 1).
    expect(enemyHqName(structures, playerStarts, nameOf, 'south')).toBe('Main Harbor');
  });

  it('names the OPPOSING HQ for a north player', () => {
    expect(enemyHqName(structures, playerStarts, nameOf, 'north')).toBe('Main Harbor');
  });

  it('falls back generically for a teamless (pre-slot / spectator) viewer', () => {
    expect(enemyHqName(structures, playerStarts, nameOf, null)).toBe('enemy Main Harbor');
  });

  it('falls back when no opposing HQ exists or the name is missing', () => {
    const onlyOwn = [{ role: 'hq', owner: 0, typeId: 'n000' }];
    expect(enemyHqName(onlyOwn, playerStarts, nameOf, 'south')).toBe('enemy Main Harbor');
    const nameless = [{ role: 'hq', owner: 1, typeId: 'zzzz' }];
    expect(enemyHqName(nameless, playerStarts, nameOf, 'south')).toBe('enemy Main Harbor');
  });

  it('resolves against the real compiled catalog (south sees the north harbor)', () => {
    const catalog = getCatalog();
    const south = enemyHqName(
      catalog.map.structures,
      catalog.map.playerStarts,
      (id) => catalog.unitTypes[id]?.name,
      'south',
    );
    const north = enemyHqName(
      catalog.map.structures,
      catalog.map.playerStarts,
      (id) => catalog.unitTypes[id]?.name,
      'north',
    );
    expect(south.length).toBeGreaterThan(0);
    expect(south).not.toBe('enemy Main Harbor'); // a real HQ was found
    expect(north).toBe(south); // both bases share the harbor type name
  });
});

describe('onboarding: helpRows (controls track the LIVE keymap)', () => {
  it('builds rows from the keymap and explains the core verbs', () => {
    const rows = helpRows((action) => action.toUpperCase());
    const byLabel = new Map(rows.map((r) => [r.label, r.keys]));
    // Mouse verbs are static; the rest come straight from the action labels.
    expect(byLabel.has('Move / attack a target')).toBe(true);
    expect(byLabel.get('Attack-move (then click)')).toBe('ATTACKMOVE');
    expect(byLabel.get('Buy at a shop (when near one)')).toBe('SHOPTOGGLE');
    // The spellbook row joins every ability-cluster key into one string.
    expect(byLabel.get('Ship abilities (spellbook)')).toBe(
      'ABILITY0 ABILITY1 ABILITY2 ABILITY3 ABILITY4 ABILITY5',
    );
    expect(byLabel.get('Recenter on your ship')).toBe('RECENTER');
    expect(byLabel.get('Toggle this help')).toBe('HELP');
  });

  it('collapses the six inventory slots into one space-separated row', () => {
    const rows = helpRows((action) => action.toUpperCase());
    const items = rows.find((r) => r.label === 'Use inventory items');
    expect(items?.keys.split(' ')).toEqual([
      'SLOT0',
      'SLOT1',
      'SLOT2',
      'SLOT3',
      'SLOT4',
      'SLOT5',
    ]);
  });

  it('reflects rebinds through the injected label resolver', () => {
    setBinding('shopToggle', 'KeyP');
    try {
      const rows = helpRows((action) => keyLabel(bindingFor(action)));
      const buy = rows.find((r) => r.label === 'Buy at a shop (when near one)');
      expect(buy?.keys).toBe('P');
    } finally {
      setBinding('shopToggle', 'KeyB'); // revert to default; don't leak the override
    }
  });
});

describe('onboarding: OnboardingState (once-only tip + shop reminder)', () => {
  it('reveals the opening tip exactly once, on the first edge into playing', () => {
    const s = new OnboardingState();
    expect(s.onPhase('starting')).toBe(false);
    expect(s.onPhase('playing')).toBe(true); // first edge -> show
    expect(s.onPhase('playing')).toBe(false); // still playing -> no repeat
    expect(s.onPhase('ended')).toBe(false);
    expect(s.onPhase('playing')).toBe(false); // never again, even on re-entry
  });

  it('fires the shop reminder once, only while playing and near a shop', () => {
    const s = new OnboardingState();
    expect(s.onShopProximity(42, false)).toBe(false); // not playing yet
    expect(s.onShopProximity(null, true)).toBe(false); // playing but not near
    expect(s.onShopProximity(42, true)).toBe(true); // first proximity -> show
    expect(s.onShopProximity(42, true)).toBe(false); // already shown
    expect(s.onShopProximity(7, true)).toBe(false); // a different shop: still no
  });

  it('exposes a non-empty opening tip mentioning shops and pushing', () => {
    expect(OPENING_TIP_TEXT.length).toBeGreaterThan(0);
    expect(OPENING_TIP_TEXT.toLowerCase()).toContain('shop');
    expect(OPENING_TIP_TEXT.toLowerCase()).toContain('lane');
  });
});
