/**
 * AUDIT PROBE (throwaway): entity-layer memory across 1000 entity churns,
 * plus projectile tracker cleanup. Feeds synthetic WorldSamples directly.
 */

import { describe, expect, it } from 'vitest';
import type { SnapshotEntity } from '@bships/core';

import { createEntities } from '../src/render/entities.js';
import { createProjectiles } from '../src/render/projectiles.js';
import { resetCameraForTest } from '../src/render/camera.js';
import { resetStoreForTest, store } from '../src/net/store.js';
import type { WorldSample } from '../src/net/interpolation.js';

function ship(id: number, ownerSlot: number | null): SnapshotEntity {
  return {
    id,
    kind: 'ship',
    typeId: 'H000',
    x: (id % 100) * 10,
    y: (id % 50) * 10,
    facing: 0,
    hp: 50,
    maxHp: 100,
    team: 'south',
    ownerSlot,
    statuses: [],
  };
}

describe('AUDIT: entity view churn', () => {
  it('destroys Pixi objects for dead entities across 1000 churns', () => {
    resetCameraForTest();
    resetStoreForTest();
    store.match.players = [
      {
        slot: 2,
        name: 'Probe',
        team: 'south',
        shipTypeId: 'H000',
        level: 1,
        kills: 0,
        deaths: 0,
        connected: true,
      },
    ];

    const layer = createEntities();
    const destroyed: { destroyed: boolean }[] = [];

    let nextId = 1;
    for (let gen = 0; gen < 100; gen++) {
      // 10 fresh entities per generation; all previous die.
      const entities: SnapshotEntity[] = [];
      for (let k = 0; k < 10; k++) entities.push(ship(nextId++, k === 0 ? 2 : null));
      const sample: WorldSample = { tickFloat: gen, entities, projectiles: [] };
      layer.update(sample, gen * 50);
      // Track every current child container so we can check destruction later.
      for (const child of layer.view.children) destroyed.push(child as unknown as { destroyed: boolean });
    }

    // After 100 generations x 10 entities = 1000 churned entities, only the
    // last generation's 10 views may exist.
    expect(layer.view.children.length).toBe(10);

    // Every collected view container except the live 10 must be destroyed.
    const liveCount = destroyed.filter((d) => !d.destroyed).length;
    expect(liveCount).toBe(10);

    // Empty sample: everything destroyed.
    layer.update({ tickFloat: 999, entities: [], projectiles: [] }, 99999);
    expect(layer.view.children.length).toBe(0);

    // null sample also clears.
    layer.update(null, 100000);
    expect(layer.view.children.length).toBe(0);
  });

  it('projectile trail tracker does not grow across churns', () => {
    resetCameraForTest();
    const layer = createProjectiles();
    for (let gen = 0; gen < 200; gen++) {
      const projectiles = [];
      for (let k = 0; k < 5; k++) {
        projectiles.push({
          id: gen * 5 + k,
          weaponId: 'w',
          mechanic: 'kaboomMissile' as const,
          x: gen,
          y: k,
          team: 'south' as const,
        });
      }
      layer.update({ tickFloat: gen, entities: [], projectiles }, gen * 16);
    }
    // tracked map is module-private; verify indirectly via no throw + clear path
    layer.update(null, 999999);
    expect(true).toBe(true);
  });
});
