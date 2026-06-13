/**
 * render-fog tests: the PURE cache signature that gates the per-frame
 * scene-rebuild + render-to-texture pass. The fog texture only changes when the
 * camera transform or the friendly (own-team) vision set changes; while the
 * signature holds, the RT pass is skipped. No pixi / no renderer here — only
 * `fogSignature` is exercised (the drawing is human-QA'd via the live match).
 */

import { describe, expect, it } from 'vitest';
import type { SnapshotEntity, TeamId } from '@bships/core';

import { fogSignature } from '../src/render/fog.js';
import type { WorldSample } from '../src/net/interpolation.js';

const cam = { x: 100, y: -50, zoom: 1 };

function entity(id: number, team: TeamId | null, x: number, y: number): SnapshotEntity {
  return {
    id,
    kind: 'ship',
    typeId: 'H000',
    x,
    y,
    facing: 0,
    hp: 100,
    maxHp: 100,
    team,
    ownerSlot: null,
    statuses: [],
  };
}

function sample(entities: SnapshotEntity[]): WorldSample {
  return { tickFloat: 0, entities, projectiles: [] };
}

describe('fogSignature', () => {
  it('collapses to "clear" with no sample or no team (multiply identity)', () => {
    expect(fogSignature(null, 'south', cam)).toBe('clear');
    expect(fogSignature(sample([]), null, cam)).toBe('clear');
  });

  it('is stable when the camera and friendly vision set are unchanged', () => {
    const s = sample([entity(1, 'south', 0, 0), entity(2, 'north', 500, 500)]);
    expect(fogSignature(s, 'south', cam)).toBe(fogSignature(s, 'south', { ...cam }));
  });

  it('ignores enemy entities (they do not grant the player vision)', () => {
    const withEnemy = sample([entity(1, 'south', 0, 0), entity(2, 'north', 500, 500)]);
    const withoutEnemy = sample([entity(1, 'south', 0, 0)]);
    expect(fogSignature(withEnemy, 'south', cam)).toBe(fogSignature(withoutEnemy, 'south', cam));
  });

  it('changes when a friendly entity moves past a texel', () => {
    const a = sample([entity(1, 'south', 0, 0)]);
    const b = sample([entity(1, 'south', 64, 0)]); // 8 texels at COARSE=8
    expect(fogSignature(a, 'south', cam)).not.toBe(fogSignature(b, 'south', cam));
  });

  it('absorbs sub-texel friendly jitter so the RT pass is reused while static', () => {
    const a = sample([entity(1, 'south', 0, 0)]);
    const b = sample([entity(1, 'south', 1, 1)]); // < 1 texel (COARSE=8) -> rounds equal
    expect(fogSignature(a, 'south', cam)).toBe(fogSignature(b, 'south', cam));
  });

  it('changes when the camera pans or zooms (the whole projection shifts)', () => {
    const s = sample([entity(1, 'south', 0, 0)]);
    expect(fogSignature(s, 'south', cam)).not.toBe(fogSignature(s, 'south', { ...cam, x: cam.x + 30 }));
    expect(fogSignature(s, 'south', cam)).not.toBe(fogSignature(s, 'south', { ...cam, zoom: 1.5 }));
  });

  it('changes when a friendly entity appears or disappears', () => {
    const one = sample([entity(1, 'south', 0, 0)]);
    const two = sample([entity(1, 'south', 0, 0), entity(3, 'south', 200, 200)]);
    expect(fogSignature(one, 'south', cam)).not.toBe(fogSignature(two, 'south', cam));
  });
});
