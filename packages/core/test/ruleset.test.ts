import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyRulesetPatch, compileClassicRuleset, validateRuleset } from '../src/sim/ruleset.js';
import type { RawDataFiles, Ruleset } from '../src/sim/types.js';

// ---------------------------------------------------------------------------
// Compile the REAL repo data (the sim core is IO-free; tests do the IO).
// ---------------------------------------------------------------------------

function loadJson<T>(name: string): T {
  const url = new URL(`../../../data/json/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

function loadRaw(): RawDataFiles {
  return {
    weapons: loadJson('weapons.json'),
    equipment: loadJson('equipment.json'),
    ships: loadJson('ships.json'),
    upgradeCurves: loadJson('upgrade-curves.json'),
    scriptRules: loadJson('script-rules.json'),
    mapLayout: loadJson('map-layout.json'),
    gameplayConstants: loadJson('gameplay-constants.json'),
    units: loadJson('units.json'),
    abilities: loadJson('abilities.json'),
    items: loadJson('items.json'),
    buffs: loadJson('buffs.json'),
    strings: loadJson('strings.json'),
  };
}

const raw = loadRaw();
const rs: Ruleset = compileClassicRuleset(raw);

describe('compileClassicRuleset — weapons', () => {
  it('compiles Vulcan Cannon: 30 dmg, 0.05 s cooldown clamps to 1 tick', () => {
    const vulcan = rs.weapons['I01Z'];
    expect(vulcan).toBeDefined();
    expect(vulcan?.damage).toBe(30);
    expect(vulcan?.cooldownTicks).toBe(1);
    expect(vulcan?.rangeUnits).toBe(450);
    expect(vulcan?.gold).toBe(19750);
    expect(vulcan?.mechanic).toBe('phoenixFire');
    expect(vulcan?.homing).toBe(true);
    expect(vulcan?.attackType).toBe('spells');
    expect(vulcan?.damageType).toBe('magic');
  });

  it('compiles Basic Cannon: 20 dmg, 1.5 s -> 30 ticks, 700 range', () => {
    const basic = rs.weapons['I001'];
    expect(basic?.damage).toBe(20);
    expect(basic?.cooldownTicks).toBe(30);
    expect(basic?.rangeUnits).toBe(700);
    expect(basic?.gold).toBe(200);
    // amho=0 in object data -> non-homing
    expect(basic?.homing).toBe(false);
    // 900 units/s -> 45 units/tick
    expect(basic?.projectileSpeedPerTick).toBe(45);
    expect(basic?.targets).toEqual({ ships: true, structures: true, heroOnly: false });
  });

  it('parses target filters: sniper hero-only, catapult structures-only, torpedo ships-only', () => {
    expect(rs.weapons['I02F']?.targets).toEqual({ ships: true, structures: false, heroOnly: true });
    expect(rs.weapons['I00P']?.targets).toEqual({ ships: false, structures: true, heroOnly: false });
    expect(rs.weapons['I02N']?.targets).toEqual({ ships: true, structures: false, heroOnly: false });
    // Underwater Launch hits structures only
    expect(rs.weapons['I026']?.targets).toEqual({ ships: false, structures: true, heroOnly: false });
  });

  it('compiles the Acid Bomber DoT from ability data (20/s for 20 s via BNab)', () => {
    const acid = rs.weapons['I027'];
    expect(acid?.dot).toEqual({ dmgPerTick: 1, durationTicks: 400, buffId: 'BNab', nonLethal: true });
    // 20 s buff > 3 s cooldown: the PF retarget gate that makes acid spray.
    expect(acid?.buffId).toBe('BNab');
    expect(acid?.buffDurationTicks).toBe(400);
  });

  it('compiles the Nuclear Strike fallout DoT (100/s for 4 s via B016)', () => {
    const nuke = rs.weapons['I01Y'];
    expect(nuke?.damage).toBe(2000);
    expect(nuke?.dot).toEqual({ dmgPerTick: 5, durationTicks: 80, buffId: 'B016', nonLethal: true });
  });

  it('compiles missile warheads as kaboom: physical, no type mult, map-wide range', () => {
    const small = rs.weapons['I01O'];
    expect(small?.mechanic).toBe('kaboomMissile');
    expect(small?.damage).toBe(50);
    expect(small?.aoeRadius).toBe(200);
    expect(small?.rangeUnits).toBeNull();
    expect(small?.noTypeMult).toBe(true);
    expect(small?.damageType).toBe('physical');
    expect(small?.cooldownTicks).toBe(40); // scripted ~2 s throttle
    expect(rs.weapons['I01P']?.damage).toBe(250);
    expect(rs.weapons['I01Q']?.damage).toBe(500);
  });

  it('compiles Underwater Launch cast time (3.5 s -> 70 ticks) and 750 speed override', () => {
    const uwl = rs.weapons['I026'];
    expect(uwl?.castTimeTicks).toBe(70);
    expect(uwl?.projectileSpeedPerTick).toBe(37.5);
    expect(uwl?.damage).toBe(3000);
    expect(uwl?.cooldownTicks).toBe(900);
  });

  it('synthesizes hero-skill storm bolt weapons (Captain\'s Cannon, sub torpedoes)', () => {
    const cc = rs.weapons['A01Y'];
    expect(cc?.mechanic).toBe('stormBolt');
    expect(cc?.damage).toBe(40);
    expect(cc?.rangeUnits).toBe(900);
    expect(cc?.cooldownTicks).toBe(500); // 25 s
    expect(cc?.projectileSpeedPerTick).toBe(50); // AHtb default 1000/s
    expect(rs.weapons['A04X']?.damage).toBe(150);
    expect(rs.weapons['A04Z']?.damage).toBe(150);
  });

  it('does not include the Goblin Bomber row (hero ability, not an item weapon)', () => {
    expect(rs.weapons['A055']).toBeUndefined();
  });

  it('pins the two ACCEPTED cooldown-quantization divergences (SEMANTICS conventions)', () => {
    // I00H Machinegun 0.12 s -> 2 ticks (0.10 s): +20% DPS (80 vs 66.67).
    expect(rs.weapons['I00H']?.cooldownTicks).toBe(2);
    // I00G Multi-Rocket 0.33 s -> 7 ticks (0.35 s): -5.7% DPS (31.43 vs 33.33).
    expect(rs.weapons['I00G']?.cooldownTicks).toBe(7);
  });
});

describe('compileClassicRuleset — ships', () => {
  it('compiles H000 starter: 200 hp (no str bonus), armor 0, speed 170, 6 slots', () => {
    const h000 = rs.ships['H000'];
    expect(h000).toBeDefined();
    expect(h000?.gold).toBe(200);
    expect(h000?.rawHp).toBe(200);
    // war3mapMisc.txt StrHitPointBonus=0 -> maxHp == rawHp (no +25);
    // AgiDefenseBase/Bonus=0 -> armor == rawArmor (no -1.7).
    expect(h000?.maxHp).toBe(200);
    expect(h000?.rawArmor).toBe(0);
    expect(h000?.armor).toBe(0);
    expect(h000?.moveSpeed).toBe(170);
    expect(h000?.inventorySlots).toBe(6);
    expect(h000?.defenseType).toBe('hero');
    expect(h000?.collisionRadius).toBe(5);
    expect(h000?.sightRadius).toBe(1100);
    expect(h000?.bounty).toEqual({ base: 79, dice: 1, sides: 1 });
    expect(h000?.abilityIds).toContain('A01Y');
    expect(h000?.abilityIds).toContain('A007');
    // Shore Leave (A01D) must survive the uabi grant so the F-key ship ability
    // surfaces — it is the only innate non-passive active on the starter hull.
    expect(h000?.abilityIds).toContain('A01D');
    expect(h000?.abilityIds).not.toContain('AInv');
    expect(h000?.isSub).toBe(false);
  });

  it('flags subs and fort-defense hulls', () => {
    expect(rs.ships['H00V']?.isSub).toBe(true);
    expect(rs.ships['H00W']?.isSub).toBe(true);
    expect(rs.ships['H00V']?.defenseType).toBe('fortified');
    expect(rs.ships['H00A']?.defenseType).toBe('fortified');
    expect(rs.ships['H003']?.defenseType).toBe('hero');
    // Ghost on the submerged sub
    expect(rs.ships['H00W']?.abilityIds).toContain('Agho');
  });

  it('gives H001 its built-in true sight (Adtg 1200)', () => {
    expect(rs.ships['H001']?.detectionRadius).toBe(1200);
    expect(rs.ships['H000']?.detectionRadius).toBeNull();
  });

  it('regen is uhpr only — BSP zeroes the hero strength regen (StrRegenBonus=0)', () => {
    // Most hulls have uhpr 0 -> no passive regen at all.
    expect(rs.ships['H000']?.hpRegenPerTick).toBe(0);
    // H00A overrides uhpr 5 -> 5 / 20 (no +0.05 str bonus).
    expect(rs.ships['H00A']?.hpRegenPerTick).toBeCloseTo(5 / 20, 12);
    for (const id of Object.keys(rs.ships)) {
      expect(rs.ships[id]!.hpRegenPerTick, id).toBeGreaterThanOrEqual(0);
    }
  });

  it('compiles the vestigial native-attack range (ua1r 1000) without damage', () => {
    // The chase stop distance exists; Hpal base damage awaits the SLK
    // extraction (PROVISIONAL — ruleset.ts header), so unitTypes has no
    // ship attack rows and ships deal no native damage.
    expect(rs.ships['H000']?.nativeAttackRangeUnits).toBe(1000);
    expect(rs.unitTypes['H000']).toBeUndefined();
  });

  it('caps every ship turn rate at 0.20 rad/frame -> ~0.333 rad/tick', () => {
    for (const id of Object.keys(rs.ships)) {
      expect(rs.ships[id]?.turnRateRadPerTick).toBeCloseTo(0.2 * (0.05 / 0.03), 10);
    }
  });
});

describe('compileClassicRuleset — upgrades', () => {
  it('compiles R005 Ship Cannons with the +1-then-+8 dice anomaly preserved', () => {
    const r005 = rs.upgrades['R005'];
    expect(r005).toBeDefined();
    expect(r005?.maxLevel).toBe(10);
    expect(r005?.effect.kind).toBe('bonusAttackDice');
    expect(r005?.effect.perLevel).toEqual([1, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
    expect(r005?.goldCostPerLevel).toEqual(Array(10).fill(600));
    expect(r005?.researchTicks).toBe(900); // 45 s
    expect(r005?.appliesToUnitTypes).toEqual(['h00B', 'h00E', 'h00F', 'h00G', 'h00H', 'h00I']);
  });

  it('compiles the tower upgrades R000/R001 against n004 only', () => {
    expect(rs.upgrades['R000']?.effect.kind).toBe('flatMaxHp');
    expect(rs.upgrades['R000']?.effect.perLevel).toEqual(Array(10).fill(500));
    expect(rs.upgrades['R000']?.appliesToUnitTypes).toEqual(['n004']);
    expect(rs.upgrades['R001']?.effect.kind).toBe('flatAttackDamage');
    expect(rs.upgrades['R001']?.effect.perLevel).toEqual([40, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    expect(rs.upgrades['R001']?.researchTicks).toBe(3600); // 180 s
  });

  it('keeps R002 orphaned (no unit references it, NOT researchable) — verbatim data', () => {
    expect(rs.upgrades['R002']?.appliesToUnitTypes).toEqual([]);
    // n00P ures = R005,R003,R004,R001,R000 — R002 is absent.
    expect(rs.upgrades['R002']?.researchable).toBe(false);
    for (const id of ['R000', 'R001', 'R003', 'R004', 'R005']) {
      expect(rs.upgrades[id]?.researchable).toBe(true);
    }
  });

  it('compiles R003 Ship Hull percent points as FRACTIONS of base max HP', () => {
    const r003 = rs.upgrades['R003'];
    expect(r003?.effect.kind).toBe('pctBaseMaxHp');
    // "+25% of base max HP" per level -> 0.25, not 25.
    expect(r003?.effect.perLevel).toEqual(Array(10).fill(0.25));
  });

  it('links damage upgrades onto unit attacks (R005 dice on lane ships, R001 on towers)', () => {
    expect(rs.unitTypes['h00I']?.attack?.upgradeIds).toEqual(['R005']);
    expect(rs.unitTypes['n004']?.attack?.upgradeIds).toEqual(['R001']);
  });
});

describe('compileClassicRuleset — script rules', () => {
  it('compiles the stack caps from script-rules (hull/sail/repair/kraken/nuke/vulcan/sniper/torpedo)', () => {
    const byId = new Map(rs.stackRules.map((r) => [r.id, r]));
    expect(byId.get('onlyOneHull')?.itemIds).toEqual(['I009', 'I016', 'I00A']);
    expect(byId.get('onlyOneHull')?.maxPerShip).toBe(1);
    expect(byId.get('onlyOneHull')?.bannedOnShipTypes).toEqual(['H001']);
    expect(byId.get('onlyOneSail')?.itemIds).toEqual(['I008', 'I01A', 'I01U', 'I01V', 'I01T']);
    // NOT banned on subs — the JASS H00V/H00W branch only suppresses the
    // duplicate-refund message (war3map.j 8897-8961).
    expect(byId.get('onlyOneSail')?.bannedOnShipTypes).toEqual([]);
    // Verbatim quirk: the Light Sail (I007) is absent from Only_One_Sail.
    expect(byId.get('onlyOneSail')?.itemIds).not.toContain('I007');
    expect(byId.get('onlyOneKraken')?.exclusiveWithRuleIds).toEqual(['onlyOneHull', 'onlyOneSail', 'onlyOneRepair']);
    expect(byId.get('onlyOneNuke')?.itemIds).toEqual(['I01Y']);
    expect(byId.get('onlyOneVulcan')?.itemIds).toEqual(['I01Z']);
    expect(byId.get('onlyOneSniper')?.onlyInModes).toEqual(['OnlySailors']);
    expect(byId.get('onlyOneTorpedo')?.itemIds).toEqual(['I026', 'I02N', 'I02O', 'I02P']);
    // Torpedoes banned on every non-sub hull.
    expect(byId.get('onlyOneTorpedo')?.bannedOnShipTypes).not.toContain('H00V');
    expect(byId.get('onlyOneTorpedo')?.bannedOnShipTypes).toContain('H000');
  });

  it('compiles sub rules: H00V/H00W, 1 torpedo bay, repair/Kraken BLACKLIST', () => {
    expect(rs.subRules.surfacedTypeId).toBe('H00V');
    expect(rs.subRules.submergedTypeId).toBe('H00W');
    expect(rs.subRules.maxTorpedoBaysPerSub).toBe(1);
    expect(rs.subRules.torpedoItemIds).toEqual(['I026', 'I02N', 'I02O', 'I02P']);
    // SubAcquiredItems refunds exactly these nine (war3map.j 9353-9404).
    expect(rs.subRules.bannedItemIds).toEqual([
      'I00B', 'I00C', 'I00D', 'I00E', 'I011', 'I017', 'I01H', 'I01W', 'I01X',
    ]);
    expect(rs.subRules.diveAbilityId).toBe('A04C');
    expect(rs.subRules.diveCooldownTicks).toBe(100); // 5 s
  });

  it('compiles the missile system: warhead->dummy links, 2 s throttle, south-only Buggfix', () => {
    expect(rs.missiles.castAbilityId).toBe('A032');
    expect(rs.missiles.lumberItemId).toBe('I01N');
    expect(rs.missiles.throttleTicks).toBe(40);
    expect(rs.missiles.warheads['I01O']).toEqual({ dummyTypeId: 'h00N', weaponId: 'I01O' });
    expect(rs.missiles.warheads['I01P']).toEqual({ dummyTypeId: 'h00O', weaponId: 'I01P' });
    expect(rs.missiles.warheads['I01Q']).toEqual({ dummyTypeId: 'h00P', weaponId: 'I01Q' });
    expect(rs.missiles.targeting).toBe('randomEnemyLeadPlayerStructure');
    expect(rs.missiles.buggfixPeriodTicks).toBe(400); // 20 s
    expect(rs.missiles.buggfixSouthOnly).toBe(true);
  });

  it('compiles both suicide quests with flat HQ damage and verbatim region routing', () => {
    const bombRun = rs.suicideQuests.find((q) => q.id === 'goblinBombRun');
    expect(bombRun?.shipTypeId).toBe('H005');
    expect(bombRun?.hqDamage).toBe(4000);
    expect(bombRun?.rewardGold).toBe(8000);
    expect(bombRun?.rewardXp).toBe(1200);
    expect(bombRun?.pickupMaxCarriedItems).toBe(4); // UnitInventoryCount < 4
    expect(bombRun?.armForbiddenItemIds).toEqual([]);
    expect(bombRun?.armRegionByTeam).toEqual({ south: 'SouthReward', north: 'NorthReward' });
    expect(bombRun?.detonateRegionByTeam).toEqual({ south: 'North_Main', north: 'South_Main' });
    const superbomb = rs.suicideQuests.find((q) => q.id === 'superbomb');
    expect(superbomb?.hqDamage).toBe(6000);
    expect(superbomb?.rewardGold).toBe(12000);
    // startItemId survives arming (I032 is consumed by the swap): the JASS
    // detonation conditions are I01E + I02Z + I02Q (war3map.j 14199-14225).
    expect(superbomb?.startItemId).toBe('I01E');
    expect(superbomb?.unarmedTokenId).toBe('I032');
    expect(superbomb?.armedTokenId).toBe('I02Z');
    expect(superbomb?.requiredItemIds).toEqual(['I01E', 'I02Q', 'I02Z']);
    // Superbomb arms at the OWN team's reward zone (war3map.j 14131-14198),
    // blocked while the goblin armed token I01G is carried.
    expect(superbomb?.armRegionByTeam).toEqual({ south: 'SouthReward', north: 'NorthReward' });
    expect(superbomb?.armForbiddenItemIds).toEqual(['I01G']);
    expect(superbomb?.pickupRegion).toBeNull(); // Refinery I01F+I02Q swap — OPEN
  });

  it('parses the contract lumber economy from the script extract', () => {
    expect(rs.contracts.lumberCosts).toEqual({ I00M: 10, I00Q: 25, I00S: 4, I00W: 10, I01I: 18 });
    expect(rs.contracts.lumberRefunds).toEqual({ I00U: 25, I012: 50, I013: 50, I01E: 80, I02H: 80, I02I: 80 });
    expect(rs.contracts.captainReward).toEqual({
      pieceItemId: 'I01N',
      piecesRequired: 5,
      tokenItemId: 'I01R',
      // Trig_*_Captain_Rewards gate GetUnitTypeId == 'H00J' (The Captain).
      shipTypeId: 'H00J',
      rewardGold: 200,
      rewardXp: 80,
      rewardLumber: 1,
    });
  });

  it('compiles the nine trade routes (the only udg_PlayerLumber income besides the Captain)', () => {
    const routes = rs.contracts.tradeRoutes;
    expect(routes).toHaveLength(9);
    const byGoods = new Map(routes.map((r) => [r.goodsItemId, r]));
    // Ale: open to both teams, 200/80/1 (war3map.j 11222ff, 12179/12040).
    expect(byGoods.get('I00J')).toMatchObject({
      contractItemId: 'I00K',
      pickupRegion: 'AleFactory',
      team: null,
      carrierMaxItems: { H00D: 3, H005: 4 },
      deliverRegionByTeam: { south: 'SouthReward', north: 'NorthReward' },
      rewardGold: 200,
      rewardXp: 80,
      rewardLumber: 1,
    });
    // Pigs south-only at the Pigfarm, 1200/300/5.
    expect(byGoods.get('I02J')).toMatchObject({
      contractItemId: 'I00W',
      pickupRegion: 'Pigfarm',
      team: 'south',
      rewardGold: 1200,
      rewardXp: 300,
      rewardLumber: 5,
    });
    // Captives picked up inside the ENEMY main base, 4500/850/8.
    expect(byGoods.get('I014')).toMatchObject({ contractItemId: 'I013', pickupRegion: 'North_Main', team: 'south' });
    expect(byGoods.get('I015')).toMatchObject({ contractItemId: 'I012', pickupRegion: 'South_Main', team: 'north', rewardGold: 4500 });
    // Ammo route (separate Ammo_*_Rewards triggers), 400/125/2.
    expect(byGoods.get('I00V')).toMatchObject({ contractItemId: 'I02K', pickupRegion: 'GoblinBombShop', team: null, rewardGold: 400 });
  });

  it('compiles the six game-mode vote modes with their concrete effects', () => {
    const m = rs.gameModes;
    // NormalPlay (the solo-vs-AI default): no restriction.
    expect(m['NormalPlay']).toMatchObject({
      label: 'Normal Play',
      disabledShipTypes: [],
      forceShipType: null,
      removedStructureKeys: [],
    });
    // OnlyTraders is announced as "Only Submarines" (TRIGSTR_3361): forces H00V
    // and removes the trade masters.
    expect(m['OnlyTraders']).toMatchObject({
      label: 'Only Submarines',
      forceShipType: 'H00V',
      removedStructureKeys: ['n00E_0021', 'n00F_0015'],
    });
    expect(m['OnlyTraders']?.disabledShipTypes).toContain('H003');
    expect(m['OnlyTraders']?.disabledShipTypes).toContain('H00D');
    // NoBP "No Superships" (TRIGSTR_3350): removes only the supership seller.
    expect(m['NoBP']).toMatchObject({
      label: 'No Superships',
      forceShipType: null,
      removedStructureKeys: ['n005_0019'],
    });
    // OnlySailors is Tournament Mode (TRIGSTR_3365), NOT a sailors-only mode.
    expect(m['OnlySailors']?.label).toBe('Tournament Mode');
    expect(m['OnlySailors']?.disabledShipTypes).toContain('H00D');
    // NoTraders disables the trader hulls and removes the trade masters.
    expect(m['NoTraders']).toMatchObject({
      label: 'No Traders',
      disabledShipTypes: ['H00D', 'H005'],
      removedStructureKeys: ['n00E_0021', 'n00F_0015'],
    });
  });
});

describe('compileClassicRuleset — equipment', () => {
  it('compiles Stone Hull passives (+100 HP, 10% reduction, -5% speed, +3 armor)', () => {
    const stone = rs.equipment['I009'];
    expect(stone?.category).toBe('hull');
    expect(stone?.passives).toEqual({
      maxHpBonus: 100,
      damageReductionPct: 0.1,
      armorBonus: 3,
      moveSpeedPct: -0.05,
      hpRegenPerTick: 0,
    });
  });

  it('compiles the sail line move-speed fractions', () => {
    expect(rs.equipment['I007']?.passives?.moveSpeedPct).toBe(0.1);
    expect(rs.equipment['I01V']?.passives?.moveSpeedPct).toBe(1.0);
    expect(rs.equipment['I01T']?.passives?.moveSpeedPct).toBe(2.0);
  });

  it('compiles Kraken shell as the hybrid hull (+20 HP/s, +30% speed, no HP bonus)', () => {
    const kraken = rs.equipment['I01X'];
    expect(kraken?.passives).toEqual({
      maxHpBonus: 0,
      damageReductionPct: 0.2,
      armorBonus: 6,
      moveSpeedPct: 0.3,
      hpRegenPerTick: 1,
    });
  });

  it('compiles repair crews as passive regen and repair woods as instant heals', () => {
    expect(rs.equipment['I017']?.passives?.hpRegenPerTick).toBe(0.1); // 2 HP/s (Arel default)
    expect(rs.equipment['I01W']?.passives?.hpRegenPerTick).toBe(3.5); // 70 HP/s
    expect(rs.equipment['I00C']?.active).toEqual({ kind: 'instantHeal', amount: 300, cooldownTicks: 900 });
    expect(rs.equipment['I01H']?.active).toEqual({ kind: 'instantHeal', amount: 99999, cooldownTicks: 2400 });
  });

  it('compiles utility actives: smoke, blink, spies, flare, rejuvenation, charm', () => {
    expect(rs.equipment['I01K']?.active).toEqual({
      kind: 'invisibility',
      durationTicks: 200,
      cooldownTicks: 1400,
      buffId: 'B00I',
    });
    expect(rs.equipment['I01L']?.active).toEqual({ kind: 'blink', maxDistance: 1200, cooldownTicks: 1000 });
    expect(rs.equipment['I020']?.active).toEqual({
      kind: 'summonWard',
      wardTypeId: 'nvil',
      durationTicks: 10800,
      cooldownTicks: 0,
    });
    expect(rs.equipment['I020']?.charges).toBe(4);
    expect(rs.equipment['fgun']?.active).toEqual({
      kind: 'flare',
      radius: 1200,
      durationTicks: 300,
      cooldownTicks: 1200,
      detectsInvisible: true,
    });
    expect(rs.equipment['I00T']?.active).toEqual({
      kind: 'rejuvenation',
      totalHeal: 20000,
      durationTicks: 400,
      rangeUnits: 100,
      buffId: 'B00G',
    });
    expect(rs.equipment['fgdg']?.active).toEqual({ kind: 'summonUnit', unitTypeId: 'nba2', durationTicks: 24000 });
    expect(rs.equipment['texp']?.active).toEqual({ kind: 'xpTome', xp: 200 });
    expect(rs.equipment['tgxp']?.active).toEqual({ kind: 'xpTome', xp: 500 });
    expect(rs.equipment['tst2']?.active).toEqual({ kind: 'flavor' });
  });

  it('flags perishable trade goods and item cooldown groups', () => {
    expect(rs.equipment['I01J']?.perishable).toBe(true);
    expect(rs.equipment['I017']?.perishable).toBe(false);
    expect(rs.equipment['I021']?.cooldownGroup).toBe('Aeye');
    expect(rs.equipment['I00T']?.cooldownGroup).toBe('AOeq');
  });

  it('synthesizes quest/contract goods so every shop and quest item resolves', () => {
    expect(rs.equipment['I01N']?.category).toBe('consumable'); // Piece of Lumber
    expect(rs.equipment['I01G']?.category).toBe('consumable'); // armed barrel
    expect(rs.equipment['I02Z']?.category).toBe('consumable'); // armed superbomb
    expect(rs.equipment['I00Q']?.category).toBe('consumable'); // Trading Boxes Contract
    expect(rs.equipment['I00Q']?.name).toBe('Trading Boxes Contract'); // color codes stripped
  });
});

describe('compileClassicRuleset — unit types', () => {
  it('compiles lane creeps with native attack dice; all twins pay bounty (owner override)', () => {
    const rowboat = rs.unitTypes['h00I'];
    expect(rowboat?.maxHp).toBe(100);
    expect(rowboat?.level).toBe(2);
    expect(rowboat?.bounty).toEqual({ base: 5, dice: 2, sides: 10 });
    expect(rowboat?.attack).toMatchObject({
      damageBase: 3,
      damageDice: 2,
      damageSides: 3,
      cooldownTicks: 34, // 1.7 s
      rangeUnits: 550,
    });
    expect(rowboat?.moveSpeed).toBe(250);
    // Owner-directed: ALL lane creeps pay bounty. The post-harbor mirror twin
    // h00E ships ubba/ubdi/ubsi = 0 in the map (anti-farm); BOUNTY_TWIN_COUNTERPART
    // makes it inherit its paying counterpart h00I's bounty. Same combat stats,
    // level 1.
    const mirror = rs.unitTypes['h00E'];
    expect(mirror?.bounty).toEqual({ base: 5, dice: 2, sides: 10 });
    expect(mirror?.level).toBe(1);
    expect(mirror?.attack?.damageBase).toBe(3);
    expect(rs.unitTypes['h00H']?.level).toBe(6);
    expect(rs.unitTypes['h00H']?.bounty).toEqual({ base: 25, dice: 2, sides: 50 });
  });

  it('compiles towers and HQs as structures with attacks', () => {
    const tower = rs.unitTypes['n004'];
    expect(tower?.isStructure).toBe(true);
    expect(tower?.maxHp).toBe(6500);
    expect(tower?.attack).toMatchObject({ damageBase: 20, damageDice: 10, damageSides: 2, rangeUnits: 1000 });
    expect(tower?.attack?.cooldownTicks).toBe(30); // 1.5 s
    expect(tower?.hpRegenPerTick).toBeCloseTo(0.35, 10); // 7 HP/s
    const hq = rs.unitTypes['n000'];
    expect(hq?.maxHp).toBe(20000);
    expect(hq?.attack?.damageBase).toBe(49);
    expect(hq?.bounty).toEqual({ base: 0, dice: 0, sides: 0 });
    expect(rs.unitTypes['n003']?.bounty).toEqual({ base: 499, dice: 1, sides: 1 });
    expect(rs.unitTypes['n00D']?.bounty).toEqual({ base: 999, dice: 1, sides: 1 });
  });

  it('compiles wards and missile dummies (invisibility, invulnerability, detection)', () => {
    const spy = rs.unitTypes['nvil'];
    expect(spy?.invulnerable).toBe(true);
    expect(spy?.permanentlyInvisible).toBe(false); // "Spies are visable"
    expect(spy?.detectionRadius).toBe(1600);
    const detector = rs.unitTypes['ohwd'];
    expect(detector?.invulnerable).toBe(true);
    expect(detector?.permanentlyInvisible).toBe(true);
    expect(detector?.detectionRadius).toBeNull(); // NOT a detector
    expect(detector?.sightRadius).toBe(1);
    const dummy = rs.unitTypes['h00N'];
    expect(dummy?.invulnerable).toBe(true);
    expect(dummy?.moveSpeed).toBe(200);
    expect(rs.unitTypes['h00O']?.moveSpeed).toBe(300);
    expect(rs.unitTypes['h00P']?.moveSpeed).toBe(400);
  });

  it('includes the Upgrade Center (n00P) even though map-layout omits its placement (OPEN)', () => {
    expect(rs.unitTypes['n00P']).toBeDefined();
    expect(rs.unitTypes['n00P']?.maxHp).toBe(500);
  });
});

describe('compileClassicRuleset — shops', () => {
  it('compiles the Weapons Merchant item list with data prices', () => {
    const shop = rs.shops['n001'];
    expect(shop).toBeDefined();
    const basic = shop?.items.find((i) => i.itemId === 'I001');
    expect(basic?.gold).toBe(200);
    expect(basic?.lumberCost).toBe(0);
    expect(shop?.items.map((i) => i.itemId)).toContain('I02F');
  });

  it('compiles Main Harbor: A057 interact radius 400 and the ship roster', () => {
    const harbor = rs.shops['n000'];
    expect(harbor?.interactRadius).toBe(400);
    const shipIds = harbor?.ships.map((s) => s.shipTypeId) ?? [];
    for (const id of ['H000', 'H003', 'H005', 'H00Y']) expect(shipIds).toContain(id);
    expect(harbor?.ships.find((s) => s.shipTypeId === 'H005')?.gold).toBe(4525);
    // Pirate merchant sells the capital ships.
    expect(rs.shops['n005']?.ships.map((s) => s.shipTypeId)).toEqual(['H00V', 'H00L', 'H00K', 'H00A', 'H00C']);
  });

  it('gates contract purchases on lumber at the Trade Masters', () => {
    const will = rs.shops['n00E'];
    expect(will?.items.find((i) => i.itemId === 'I00Q')?.lumberCost).toBe(25);
    expect(will?.items.find((i) => i.itemId === 'I00S')?.lumberCost).toBe(4);
    const bill = rs.shops['n00F'];
    expect(bill?.items.find((i) => i.itemId === 'I00M')?.lumberCost).toBe(10);
  });

  it('compiles the lumber threshold per the need/refund groups, not raw ilum', () => {
    // The NEED group (I00S/I00W/I00M/I01I/I00Q) gates on udg_PlayerLumber at
    // its ilum value (a pure, never-consumed threshold). The REFUND group
    // (I00U/I013/I012/I01E/I02I/I02H) merely gets its engine ilum charge back
    // and imposes NO threshold — so although their ilum is large (e.g. 80),
    // the compiled lumberCost is 0. This is the contractLumberThreshold=0
    // semantics the treasure-hunt extraction confirmed (script-rules.json
    // mechanism: "I00U/I013/I012/I01E/I02I/I02H refund 25/50/50/80/80/80").
    const thresholds: Record<string, number> = {
      // refund group -> no threshold
      I01E: 0,
      I00U: 0,
      I012: 0,
      I013: 0,
      I02H: 0,
      I02I: 0,
      // need group -> ilum gate
      I02K: 4,
      I01I: 18,
      I00Q: 25,
    };
    for (const [itemId, lumber] of Object.entries(thresholds)) {
      const entries = Object.values(rs.shops)
        .flatMap((shop) => shop.items)
        .filter((entry) => entry.itemId === itemId);
      expect(entries.length, `${itemId} sold somewhere`).toBeGreaterThan(0);
      for (const entry of entries) expect(entry.lumberCost, itemId).toBe(lumber);
    }
  });

  it('compiles stock/restock for the timed items (GrandMaster 1200 s, Charm 300 s)', () => {
    const lumberMill = rs.shops['n00A'];
    const gm = lumberMill?.items.find((i) => i.itemId === 'I00T');
    expect(gm?.stockMax).toBe(1);
    expect(gm?.restockTicks).toBe(24000);
    const basic = rs.shops['n001']?.items.find((i) => i.itemId === 'I001');
    expect(basic?.stockMax).toBeNull();
    expect(basic?.restockTicks).toBeNull();
  });

  it('sells warheads at the Missile Silo', () => {
    expect(rs.shops['n00Q']?.items.map((i) => i.itemId)).toEqual(['I01O', 'I01P', 'I01Q']);
  });
});

describe('compileClassicRuleset — xp/respawn/income/constants', () => {
  it('builds the default XP curves', () => {
    expect(rs.xp.xpToLevel[1]).toBe(0);
    expect(rs.xp.xpToLevel[2]).toBe(200);
    expect(rs.xp.xpToLevel[3]).toBe(500);
    expect(rs.xp.xpToLevel[4]).toBe(900);
    // war3mapMisc.txt GrantNormalXP=15 is the table SEED (not a multiplier of
    // the engine-default 25/40/60 table); same recurrence xp(L)=xp(L-1)+5L+5.
    expect(rs.xp.killXpByVictimLevel.slice(0, 11)).toEqual([
      0, 15, 30, 50, 75, 105, 140, 180, 225, 275, 330,
    ]);
    // war3mapMisc.txt GrantHeroXP is the full victim-hero-level table (20
    // entries, index 0 unused).
    expect(rs.xp.heroKillXpByVictimLevel).toEqual([
      0, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240,
    ]);
    // Table reaches heroLevelCap, so the per-level-above step is only the
    // table's own terminal step (240 - 230), never actually applied in play.
    expect(rs.xp.heroKillXpPerLevelAbove).toBe(10);
    // war3mapMisc.txt BuildingKillsGiveExp=1: structure kills grant kill XP.
    expect(rs.xp.buildingKillsGiveXp).toBe(true);
    // war3mapMisc.txt: HeroExpRange=1500, MaxHeroLevel=20 (was guessed 1200/12).
    expect(rs.xp.shareRadius).toBe(1500);
    expect(rs.xp.summonFactor).toBe(0.5);
    expect(rs.xp.heroLevelCap).toBe(20);
    expect(rs.xp.xpToLevel).toHaveLength(21); // index 0..20
    // Owner-directed: Classic spends skill points freely (no per-rank level gate).
    expect(rs.xp.skillLevelGated).toBe(false);
  });

  it('parses the respawn formula 2L + 5 + rand(0,3) with 5 s invulnerability', () => {
    expect(rs.respawn).toEqual({
      perLevelSeconds: 2,
      baseSeconds: 5,
      randMaxSeconds: 3,
      invulnerableTicks: 100,
    });
  });

  it('compiles income with the preserved north-HQ gate and per-human-count table', () => {
    expect(rs.income.intervalTicks).toBe(20);
    expect(rs.income.requiresNorthHqAlive).toBe(true);
    expect(rs.income.byHumanCount[1]).toEqual({ perHumanSlot: 5, toTeamAi: 5 });
    expect(rs.income.byHumanCount[3]).toEqual({ perHumanSlot: 3, toTeamAi: 1 });
    expect(rs.income.byHumanCount[5]).toEqual({ perHumanSlot: 2, toTeamAi: 0 });
    expect(rs.income.empireShareMinTicks).toBe(1200);
    expect(rs.income.empireShareMaxTicks).toBe(2400);
    expect(rs.income.goldDumpPeriodTicks).toBe(300);
    expect(rs.income.streetMerchant).toEqual({
      rollAtTick: 100,
      spawnAtTick: 140,
      rollMin: 1,
      rollMax: 12,
      threshold: 9,
      merchantTypeId: 'n00R',
    });
  });

  it('bakes the Classic constants (war3mapMisc overrides) and the TFT spells row', () => {
    expect(rs.constants.startingGold).toBe(200);
    // war3mapMisc.txt: MinUnitSpeed=10, MaxUnitSpeed=522 (not the editor 150/400).
    expect(rs.constants.minMoveSpeed).toBe(10);
    expect(rs.constants.maxMoveSpeed).toBe(522);
    expect(rs.constants.heroStrHpBonus).toBe(0);
    expect(rs.constants.heroAgiArmorPerPoint).toBe(0);
    expect(rs.constants.heroArmorBaseOffset).toBe(0);
    expect(rs.constants.heroStrRegenPerSecond).toBe(0);
    expect(rs.constants.sellbackRate).toBe(0);
    expect(rs.constants.friendlyFire).toBe(false);
    expect(rs.constants.missileExplodeOnDeathDoubling).toBe(false);
    expect(rs.constants.pfDotNonLethal).toBe(true);
    // DamageBonusSpells override: x1.00 vs hero (not 0.70), x0.05 vs divine.
    expect(rs.attackTypeVsDefense.spells.hero).toBe(1.0);
    expect(rs.attackTypeVsDefense.spells.fortified).toBe(1.0);
    expect(rs.attackTypeVsDefense.spells.divine).toBe(0.05);
    expect(rs.attackTypeVsDefense.siege.fortified).toBe(1.5);
    expect(rs.attackTypeVsDefense.pierce.hero).toBe(0.5);
    expect(rs.attackTypeVsDefense.normal.fortified).toBe(0.7);
  });
});

describe('compileClassicRuleset — map', () => {
  it('compiles bounds, regions, lanes and waves', () => {
    expect(rs.map.bounds).toEqual({ minX: -5536, minY: -8192, maxX: 5312, maxY: 6656 });
    expect(rs.map.regions['Refinery']).toBeDefined();
    expect(rs.map.lanes).toHaveLength(4);
    const sw = rs.map.lanes.find((l) => l.id === 'south-west');
    expect(sw?.ownHarborKey).toBe('n003_0024');
    expect(sw?.bountyGateEnemyHarborKey).toBe('n003_0016');
    expect(sw?.waypoints[1]?.issuedOnEnteringRegions).toEqual(['Harbour1_North', 'Harbour2_North']);
    const rowboat = rs.map.waves.find((w) => w.name === 'rowboat');
    expect(rowboat).toMatchObject({
      periodTicks: 700,
      count: 6,
      preSpawnDelayTicks: 0,
      bountyTypeId: 'h00I',
      zeroBountyTypeId: 'h00E',
    });
    expect(rs.map.waves.find((w) => w.name === 'cruiser')?.preSpawnDelayTicks).toBe(140);
  });

  it('places structures with stable instance keys, skipping showcase ships and critters', () => {
    const keys = rs.map.structures.map((s) => s.instanceKey);
    expect(keys).toContain('n000_0020'); // south HQ
    expect(keys).toContain('n000_0018'); // north HQ
    expect(keys).toContain('n003_0024');
    // showcase H009 (removedAtMapStart) and critters never compile in
    expect(rs.map.structures.find((s) => s.typeId === 'H009')).toBeUndefined();
    expect(rs.map.structures.find((s) => s.typeId === 'npig')).toBeUndefined();
    const southHq = rs.map.structures.find((s) => s.instanceKey === 'n000_0020');
    expect(southHq?.owner).toBe(0);
    expect(southHq?.role).toBe('hq');
    // unkeyed towers get generated instance keys (12 per side in the layout)
    const towers = rs.map.structures.filter((s) => s.typeId === 'n004');
    expect(towers).toHaveLength(24);
    expect(new Set(towers.map((t) => t.instanceKey)).size).toBe(24);
  });

  it('sides the in-base shops and leaves the neutral island shops open', () => {
    const sideOf = (key: string): string | null =>
      rs.map.structures.find((s) => s.instanceKey === key)?.shopSide ?? null;
    expect(sideOf('n001_0022')).toBe('south');
    expect(sideOf('n001_0013')).toBe('north');
    expect(sideOf('n00E_0021')).toBe('south');
    expect(sideOf('n00F_0015')).toBe('north');
    // Pirate merchant + mid/island shops are open to both teams.
    expect(sideOf('n005_0019')).toBeNull();
    expect(sideOf('n00B_0009')).toBeNull();
  });

  it('seeds player starts with the H000 + Basic Cannon loadout', () => {
    expect(rs.map.startingShipTypeId).toBe('H000');
    expect(rs.map.playerStarts[2]?.startItems).toEqual(['I001']);
    expect(rs.map.playerStarts[2]?.team).toBe('south');
    expect(rs.map.playerStarts[7]?.team).toBe('north');
    expect(rs.map.playerStarts[0]?.startItems).toEqual([]); // AI empire
    expect(rs.map.respawnRegionByTeam).toEqual({ south: 'SouthRespawn', north: 'NorthRespawn' });
    expect(rs.map.streetMerchantRegions).toEqual({ south: 'StreetMerchant1', north: 'StreetMerchant' });
  });
});

describe('compileClassicRuleset — abilities', () => {
  it('compiles Captain\'s Cannon as a 6-rank hero storm bolt skill (40..200)', () => {
    const cc = rs.abilities['A01Y'];
    expect(cc?.kind).toBe('heroSkill');
    expect(cc?.mechanic).toBe('stormBoltWeapon');
    expect(cc?.magnitudePerRank).toEqual([40, 72, 104, 136, 168, 200]);
    expect(cc?.skill).toEqual({ abilityId: 'A01Y', ranks: 6, levelsPerRank: 2, minHeroLevel: 1 });
    expect(cc?.weaponId).toBe('A01Y');
    expect(cc?.cooldownTicks).toBe(500);
    expect(cc?.rangeUnits).toBe(900);
  });

  it('compiles Hide with per-rank durations 6..16 s', () => {
    const hide = rs.abilities['A047'];
    expect(hide?.mechanic).toBe('invisibility');
    expect(hide?.durationTicksPerRank).toEqual([120, 160, 200, 240, 280, 320]);
    expect(hide?.cooldownTicks).toBe(500);
  });

  it('compiles the passive skill curves (sails data; hull/mechanics slope-extended)', () => {
    expect(rs.abilities['A03W']?.mechanic).toBe('sailSpeed');
    expect(rs.abilities['A03W']?.magnitudePerRank).toEqual([0.05, 0.14, 0.23, 0.32, 0.41, 0.5]);
    // PROVISIONAL: levels 7-10 slope extension (see ruleset.ts header).
    expect(rs.abilities['A007']?.magnitudePerRank).toEqual([30, 60, 90, 120, 150, 180]);
    expect(rs.abilities['A009']?.magnitudePerRank).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rs.abilities['A00G']?.magnitudePerRank).toEqual([2]); // Arel base default
  });

  it('compiles dive, echo-location and the stock Adtg/Agho entries', () => {
    expect(rs.abilities['A04C']?.mechanic).toBe('dive');
    expect(rs.abilities['A04C']?.cooldownTicks).toBe(100);
    expect(rs.abilities['A04D']?.mechanic).toBe('flareDetection');
    expect(rs.abilities['A04D']?.magnitudePerRank).toEqual([1500]);
    expect(rs.abilities['Adtg']?.mechanic).toBe('trueSightPassive');
    expect(rs.abilities['Agho']?.mechanic).toBe('invisibility');
    expect(rs.abilities['Agho']?.durationTicksPerRank).toBeNull();
    // Goblin Bomber: level-8 unlock preserved.
    expect(rs.abilities['A055']?.skill?.minHeroLevel).toBe(8);
    expect(rs.abilities['A055']?.mechanic).toBe('special');
  });

  it('routes exotic kits to specials via specialKey', () => {
    expect(rs.abilities['A01A']?.mechanic).toBe('special'); // Capsize
    expect(rs.abilities['A01A']?.specialKey).toBe('Auco');
    expect(rs.abilities['A02D']?.mechanic).toBe('special'); // Slow Aura (negative AOae)
    expect(rs.abilities['A037']?.specialKey).toBe('AHtc'); // EMP
  });

  it('decodes special abilities into SpecialParams (kinds + per-rank magnitudes)', () => {
    // Capsize (Auco A01A): suicidal nuke, primary Dda2 + splash Dda4 by rank.
    const cap = rs.abilities['A01A']?.special;
    expect(cap?.kind).toBe('capsize');
    expect(cap?.suicidal).toBe(true);
    expect(cap?.damagePerRank).toEqual([250, 500, 750, 1000, 1250, 1500]);
    expect(cap?.splashPerRank).toEqual([100, 160, 220, 280, 340, 400]);

    // EMP (AHtc A037): self-AoE damage Htc1 + 40% sail slow for 10 s.
    const emp = rs.abilities['A037']?.special;
    expect(emp?.kind).toBe('empBlast');
    expect(emp?.areaRadius).toBe(700);
    expect(emp?.damagePerRank).toEqual([500]);
    expect(emp?.moveSpeedPctPerRank).toEqual([-0.4]);
    expect(emp?.effectDurTicksPerRank).toEqual([200]);

    // Slow Aura (AOae A02D): passive enemy sail-speed slow (Oae1).
    const slow = rs.abilities['A02D']?.special;
    expect(slow?.kind).toBe('slowAura');
    expect(slow?.passive).toBe(true);
    expect(slow?.areaRadius).toBe(1500);
    expect(slow?.moveSpeedPctPerRank).toEqual([-0.05, -0.1, -0.15, -0.2, -0.25, -0.3]);

    // Pirate Crew (AUls A00J): timed summon swarm (Ulsu u000, Uls1 counts).
    const swarm = rs.abilities['A00J']?.special;
    expect(swarm?.kind).toBe('summonSwarm');
    expect(swarm?.summonTypeIdPerRank?.[0]).toBe('u000');
    expect(swarm?.summonCountPerRank).toEqual([4, 6, 8, 10, 12, 14]);

    // Barrier (AHds A01V): innate timed invulnerability (adur 5..10 s).
    expect(rs.abilities['A01V']?.special?.kind).toBe('barrier');
    expect(rs.abilities['A01V']?.special?.effectDurTicksPerRank).toEqual([100, 120, 140, 160, 180, 200]);

    // Shared base, different behavior keyed by id: Send Spy vs Goblin Bomber.
    expect(rs.abilities['A02Z']?.special?.kind).toBe('sendSpy');
    expect(rs.abilities['A055']?.special?.kind).toBe('goblinMine');
    // Eat Hero / Digest Hero both decode to 'devour'.
    expect(rs.abilities['A04R']?.special?.kind).toBe('devour');
    expect(rs.abilities['A04N']?.special?.kind).toBe('devour');
    // Non-special abilities carry no special params.
    expect(rs.abilities['A00Y']?.special).toBeNull(); // Fishing Net (ensnare)
    expect(rs.abilities['A04C']?.special).toBeNull(); // Dive
  });

  it('compiles the Fishing Net (A00Y, ANen) as a ranged ensnare hold', () => {
    const net = rs.abilities['A00Y'];
    expect(net?.mechanic).toBe('ensnare'); // not a stubbed 'special'
    expect(net?.specialKey).toBeNull();
    expect(net?.rangeUnits).toBe(800); // aran
    expect(net?.durationTicksPerRank).toEqual([160]); // ahdu 8 s @ 20 tps
    expect(net?.cooldownTicks).toBe(700); // acdn 35 s @ 20 tps
  });

  it('compiles Shore Leave (A01D) as an innate shoreLeave active, not a stub', () => {
    const sl = rs.abilities['A01D'];
    // A01D shares the generic Afzy base with A032/A03V — must be keyed by id,
    // and must NOT fall through to the unimplemented 'special' stub.
    expect(sl?.name).toBe('Shore Leave');
    expect(sl?.kind).toBe('innate'); // not a hero skill -> always present on hull
    expect(sl?.mechanic).toBe('shoreLeave');
    // acdn 0 -> no cooldown; the gate is the Main-Harbour region (specials.ts).
    expect(sl?.cooldownTicks).toBeNull();
  });
});

describe('ruleset integrity and determinism', () => {
  it('validateRuleset finds no dangling references in Classic', () => {
    expect(validateRuleset(rs)).toEqual([]);
  });

  it('compiling twice yields structurally identical rulesets (stable key order)', () => {
    const again = compileClassicRuleset(loadRaw());
    expect(JSON.stringify(again)).toBe(JSON.stringify(rs));
  });

  it('the compiled ruleset is plain serializable data (except the static water mask + nav fields)', () => {
    // ARCHITECT DECISION (docs/TERRAIN.md): the land/water mask lives on the
    // immutable Ruleset — NOT in SimState — so it is never serialized per-match
    // nor covered by hashState. Its `cells` payload is therefore a packed
    // Uint8Array (fast static query) rather than a JSON array, the one
    // intentional non-JSON node in a Ruleset. The per-team lane-navigation
    // fields (map.navByTeam / map.navHomeByTeam) are derived from that same
    // static mask and share the rationale: each is a packed Int32Array on the
    // immutable Ruleset, never serialized per-match nor hashed (see types.ts
    // NavField). Assert serializability of everything ELSE, and pin the
    // typed-array representation of the mask + every nav field.
    expect(rs.map.waterMask.cells).toBeInstanceOf(Uint8Array);
    // `depth` shares the mask's rationale exactly: a packed render-only
    // seabed band per cell (0=land,1=deep,2=shallow,3=pink) on the immutable
    // Ruleset, never serialized per-match nor hashed. The SIM ignores it.
    expect(rs.map.waterMask.depth).toBeInstanceOf(Uint8Array);
    expect(rs.map.waterMask.depth.length).toBe(rs.map.waterMask.cells.length);
    for (const team of ['south', 'north'] as const) {
      expect(rs.map.navByTeam[team].dist).toBeInstanceOf(Int32Array);
      expect(rs.map.navHomeByTeam[team].dist).toBeInstanceOf(Int32Array);
    }
    const { waterMask, navByTeam, navHomeByTeam, navToRegion, ...mapRest } = rs.map;
    const { cells, depth, ...maskRest } = waterMask;
    void cells;
    void depth;
    // Strip the typed `dist` from each nav field; keep the JSON-able metadata.
    const stripNav = (nav: (typeof navByTeam)['south']): object => {
      const { dist, ...rest } = nav;
      void dist;
      return rest;
    };
    const stripRegionNav = (fields: typeof navToRegion): Record<string, object> => {
      const out: Record<string, object> = {};
      for (const name of Object.keys(fields)) out[name] = stripNav(fields[name]!);
      return out;
    };
    const jsonable = {
      ...rs,
      map: {
        ...mapRest,
        waterMask: maskRest,
        navByTeam: { south: stripNav(navByTeam.south), north: stripNav(navByTeam.north) },
        navHomeByTeam: {
          south: stripNav(navHomeByTeam.south),
          north: stripNav(navHomeByTeam.north),
        },
        navToRegion: stripRegionNav(navToRegion),
      },
    };
    expect(JSON.parse(JSON.stringify(jsonable))).toEqual(jsonable);
  });

  it('throws on missing critical fields instead of defaulting', () => {
    const broken = structuredClone(raw) as RawDataFiles & {
      weapons: { weapons: { rawcode: string; damage: number | null }[] };
    };
    const vulcan = broken.weapons.weapons.find((w) => w.rawcode === 'I01Z');
    expect(vulcan).toBeDefined();
    if (vulcan !== undefined) vulcan.damage = null;
    expect(() => compileClassicRuleset(broken)).toThrow(/I01Z damage/);
  });

  it('throws when script-rule rawcodes drift from the extracted text', () => {
    const broken = structuredClone(raw);
    broken.scriptRules.mechanism = broken.scriptRules.mechanism.replace('Only_One_Vulcan', 'Only_One_Vulkan');
    expect(() => compileClassicRuleset(broken)).toThrow(/Only_One_Vulcan/);
  });
});

describe('applyRulesetPatch', () => {
  it('deep-merges objects, replaces arrays wholesale, and never mutates the base', () => {
    const patched = applyRulesetPatch(rs, {
      name: 'balanced-test',
      description: 'test patch',
      changes: {
        constants: { startingGold: 500 },
        xp: { xpToLevel: [0, 0, 100] },
      },
    });
    expect(patched.name).toBe('balanced-test');
    expect(patched.constants.startingGold).toBe(500);
    // untouched siblings survive the merge
    expect(patched.constants.maxMoveSpeed).toBe(522);
    expect(patched.weapons['I01Z']?.damage).toBe(30);
    // arrays replaced wholesale
    expect(patched.xp.xpToLevel).toEqual([0, 0, 100]);
    expect(patched.xp.shareRadius).toBe(1500);
    // base untouched
    expect(rs.name).toBe('classic-1.187');
    expect(rs.constants.startingGold).toBe(200);
    expect(rs.xp.xpToLevel[2]).toBe(200);
  });

  it('patched ship stats override single fields without clobbering the record', () => {
    const patched = applyRulesetPatch(rs, {
      name: 'fast-starters',
      description: 'test',
      changes: { ships: { H000: { moveSpeed: 250 } } },
    });
    expect(patched.ships['H000']?.moveSpeed).toBe(250);
    expect(patched.ships['H000']?.maxHp).toBe(200);
    expect(patched.ships['H003']?.moveSpeed).toBe(230);
  });
});
