/**
 * field-overlay tests — pure geometry only (no DOM, no canvas, no pixi),
 * matching the rest of client-render's pure-helper test style. Covers the
 * legibility layer's world-space geometry helpers:
 *   - lanePolyline: spawn followed by waypoints, in order
 *   - contestedRect: union of named centre region(s), null when none
 *   - contestedBandFromLanes: central band derived from lane geometry
 *   - traderRoutePath: pickup centre -> own-team deliver centre
 * plus a pass against the REAL compiled Classic catalog (4 lanes, 9 routes,
 * no named centre region -> the lane-derived band is used).
 */

import { describe, expect, it } from 'vitest';

import {
  contestedBandFromLanes,
  contestedRect,
  laneWaterPath,
  lanePolyline,
  polylineStaysOnWater,
  traceLaneWaterPath,
  traderRoutePath,
} from '../src/render/fieldoverlay.js';
import { getCatalog } from '../src/catalog.js';
import { isWater } from '@bships/core';
import type { LaneSpec, RegionRect, TradeRouteSpec } from '@bships/core';

const region = (
  name: string,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): RegionRect => ({
  name,
  minX,
  minY,
  maxX,
  maxY,
  centerX: (minX + maxX) / 2,
  centerY: (minY + maxY) / 2,
});

const lane = (id: string, team: 'south' | 'north', spawn: [number, number], wps: [number, number][]): LaneSpec => ({
  id,
  creepOwner: 0,
  team,
  spawnX: spawn[0],
  spawnY: spawn[1],
  spawnFacingDeg: 0,
  spawnRegion: 'r',
  ownHarborKey: 'h',
  bountyGateEnemyHarborKey: 'e',
  waypoints: wps.map(([x, y]) => ({ x, y, issuedOnEnteringRegions: null })),
});

describe('fieldoverlay: lanePolyline', () => {
  it('is the spawn point followed by each waypoint, in order', () => {
    const l = lane('south-west', 'south', [-2096, -5696], [[-2320, 5104], [-1152, 6400]]);
    expect(lanePolyline(l)).toEqual([
      { x: -2096, y: -5696 },
      { x: -2320, y: 5104 },
      { x: -1152, y: 6400 },
    ]);
  });

  it('is just the spawn for a lane with no waypoints', () => {
    const l = lane('x', 'north', [10, 20], []);
    expect(lanePolyline(l)).toEqual([{ x: 10, y: 20 }]);
  });
});

describe('fieldoverlay: contestedRect (named centre region)', () => {
  it('returns null when no centre region is named (the Classic case)', () => {
    const regions: Record<string, RegionRect> = {
      South_Main: region('South_Main', -1472, -6944, -320, -6272),
      North_Main: region('North_Main', -1824, 5824, -480, 6496),
    };
    expect(contestedRect(regions)).toBeNull();
  });

  it('returns the named centre region when one exists', () => {
    const regions: Record<string, RegionRect> = {
      Center: region('Center', -500, -500, 500, 500),
    };
    const r = contestedRect(regions);
    expect(r).not.toBeNull();
    expect(r?.centerX).toBe(0);
    expect(r?.centerY).toBe(0);
  });

  it('unions multiple named centre regions', () => {
    const regions: Record<string, RegionRect> = {
      Center: region('Center', -500, -500, 0, 0),
      Mid: region('Mid', 0, 0, 800, 600),
    };
    const r = contestedRect(regions);
    expect(r).not.toBeNull();
    expect(r?.minX).toBe(-500);
    expect(r?.minY).toBe(-500);
    expect(r?.maxX).toBe(800);
    expect(r?.maxY).toBe(600);
  });
});

describe('fieldoverlay: contestedBandFromLanes', () => {
  const bounds = { minX: -5536, minY: -8192, maxX: 5312, maxY: 6656 };

  it('returns null with no lanes (open-sea stub)', () => {
    expect(contestedBandFromLanes([], bounds)).toBeNull();
  });

  it('spans the lane corridor horizontally and a centred band vertically', () => {
    const lanes = [
      lane('sw', 'south', [-2096, -5696], [[-2320, 5104], [-1152, 6400]]),
      lane('se', 'south', [272, -5792], [[176, 5104], [-1152, 6400]]),
    ];
    const band = contestedBandFromLanes(lanes, bounds, 0.34);
    expect(band).not.toBeNull();
    // Horizontal extent = min/max lane vertex X.
    expect(band?.minX).toBe(-2320);
    expect(band?.maxX).toBe(272);
    // Vertical band centred on the map mid-Y.
    const midY = (bounds.minY + bounds.maxY) / 2;
    expect(band?.centerY).toBe(midY);
    const halfH = ((bounds.maxY - bounds.minY) * 0.34) / 2;
    expect(band?.minY).toBeCloseTo(midY - halfH, 6);
    expect(band?.maxY).toBeCloseTo(midY + halfH, 6);
  });
});

describe('fieldoverlay: traderRoutePath', () => {
  const regions: Record<string, RegionRect> = {
    SwedeLumberMill: region('SwedeLumberMill', -5184, -1280, -4288, -512),
    SouthReward: region('SouthReward', -224, -6720, 224, -6400),
    NorthReward: region('NorthReward', -2272, 6176, -1792, 6592),
  };
  const route: TradeRouteSpec = {
    contractItemId: 'c',
    goodsItemId: 'g',
    goodsName: 'Bundle of Raw Wood',
    pickupRegion: 'SwedeLumberMill',
    team: null,
    carrierMaxItems: {},
    deliverRegionByTeam: { south: 'SouthReward', north: 'NorthReward' },
    rewardGold: 0,
    rewardXp: 0,
    rewardLumber: 0,
    rewardBlockOrder: 0,
  };

  it('runs pickup centre -> the SOUTH deliver centre for a south player', () => {
    expect(traderRoutePath(route, regions, 'south')).toEqual([
      { x: regions.SwedeLumberMill!.centerX, y: regions.SwedeLumberMill!.centerY },
      { x: regions.SouthReward!.centerX, y: regions.SouthReward!.centerY },
    ]);
  });

  it('runs to the NORTH deliver centre for a north player', () => {
    const path = traderRoutePath(route, regions, 'north');
    expect(path[1]).toEqual({ x: regions.NorthReward!.centerX, y: regions.NorthReward!.centerY });
  });

  it('returns [] when a referenced region is missing', () => {
    const missing: TradeRouteSpec = { ...route, pickupRegion: 'Nowhere' };
    expect(traderRoutePath(missing, regions, 'south')).toEqual([]);
  });
});

describe('fieldoverlay: against the real compiled Classic catalog', () => {
  const catalog = getCatalog();

  it('ships 4 lanes (2 per team) that each polyline to a multi-point path', () => {
    const lanes = catalog.map.lanes;
    expect(lanes.length).toBe(4);
    expect(lanes.filter((l) => l.team === 'south').length).toBe(2);
    expect(lanes.filter((l) => l.team === 'north').length).toBe(2);
    for (const l of lanes) {
      const poly = lanePolyline(l);
      expect(poly.length).toBeGreaterThanOrEqual(2);
      expect(poly[0]).toEqual({ x: l.spawnX, y: l.spawnY });
    }
  });

  it('has no named centre region, so the contested band comes from the lanes', () => {
    expect(contestedRect(catalog.map.regions)).toBeNull();
    const band = contestedBandFromLanes(catalog.map.lanes, catalog.map.bounds);
    expect(band).not.toBeNull();
    // The band sits inside the map bounds and straddles the mid-Y line.
    expect(band!.minY).toBeGreaterThanOrEqual(catalog.map.bounds.minY);
    expect(band!.maxY).toBeLessThanOrEqual(catalog.map.bounds.maxY);
    expect(band!.minY).toBeLessThan(band!.centerY);
    expect(band!.maxY).toBeGreaterThan(band!.centerY);
  });

  it('resolves every team-eligible trade route to a 2-point path for both teams', () => {
    const routes = catalog.contracts.tradeRoutes;
    expect(routes.length).toBeGreaterThan(0);
    for (const team of ['south', 'north'] as const) {
      for (const r of routes) {
        if (r.team !== null && r.team !== team) continue; // not runnable by this team
        const path = traderRoutePath(r, catalog.map.regions, team);
        expect(path.length).toBe(2);
      }
    }
  });

  it('traces each lane along the navigable WATER channel (not a straight line over land)', () => {
    const map = catalog.map;
    const mask = map.waterMask;
    expect(mask.cells.length).toBeGreaterThan(0); // real terrain compiled

    for (const lane of map.lanes) {
      const path = laneWaterPath(lane, map);

      // Many more points than the raw 3-vertex skeleton: it follows the bends.
      expect(path.length).toBeGreaterThan(lanePolyline(lane).length);
      // Starts at the spawn.
      expect(path[0]).toEqual({ x: lane.spawnX, y: lane.spawnY });

      // EVERY vertex AND every interior point of every segment is on water —
      // the ribbon never cuts across the central land. Dense-sample each chord
      // (cell ~28 units) so a corner-clipping bend would be caught.
      expect(polylineStaysOnWater(path, mask)).toBe(true);
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!;
        const b = path[i]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.ceil(len / 14));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          expect(isWater(mask, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)).toBe(true);
        }
      }

      // Ends AT the enemy HQ — the lane's final waypoint and the nav goal.
      const last = path[path.length - 1]!;
      const field = map.navByTeam[lane.team];
      expect(Math.hypot(last.x - field.goalX, last.y - field.goalY)).toBeLessThan(50);
    }
  });

  it('falls back to the raw skeleton when the map ships no nav field (open-sea stub)', () => {
    const stubLane: LaneSpec = lane('s', 'south', [0, 0], [[100, 100], [200, 200]]);
    const stubField = {
      cols: 0,
      rows: 0,
      cellSizeX: 1,
      cellSizeY: 1,
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      goalX: 200,
      goalY: 200,
      dist: new Int32Array(0),
    };
    expect(traceLaneWaterPath(stubLane, stubField)).toEqual(lanePolyline(stubLane));
  });
});
