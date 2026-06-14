/**
 * client-hud tests — pure logic only (no DOM, no headless browser):
 * keymap dispatch/rebinding and the hudmath helpers (XP progress, cooldown
 * sweeps, minimap transform, shop proximity, kill feed), plus light
 * integration checks against the real compiled catalog.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
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
  cooldownSecondsText,
  createMinimapTransform,
  itemCooldownTicks,
  itemDisplay,
  keyLabel,
  killFeedLine,
  nearestShopInRange,
  ownShipPosition,
  shipActiveAbilityId,
  sweepFraction,
  xpProgress,
} from '../src/hud/hudmath.js';
import type { SimEvent, TeamId } from '@bships/core';
import { getCatalog } from '../src/catalog.js';
import { HUD_CSS } from '../src/hud/hud.js';
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
      shipAbility: 'KeyF',
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
    setBinding('stop', 'KeyX');
    expect(bindingFor('stop')).toBe('KeyX');
    expect(actionForCode('KeyX')).toBe('stop');
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
    handleKeyEvent(fakeKey('keydown', 'KeyZ')); // unbound

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
    handleKeyEvent(fakeKey('keydown', 'KeyF')); // passes through

    expect(actions).toEqual(['shipAbility']);
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
    expect(byLabel.get('Ship ability')).toBe('SHIPABILITY');
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
