/**
 * Minimap: ~220 px canvas bottom-left. Linear transform from
 * getCatalog().map.bounds — y flipped, NO foreshortening (the camera's 2.5D
 * squash is a render-only effect). Structures draw as role glyphs, newest-
 * frame units as team dots, the camera's viewportWorldRect as a rectangle;
 * click/drag pans via getCamera().panTo.
 */

import type { SnapshotEntity } from '@bships/core';
import { getCamera } from '../render/camera.js';
import { store } from '../net/store.js';
import type { HudContext } from './context.js';
import { cssVar, el } from './context.js';
import { hudSample } from './sample.js';
import { createMinimapTransform } from './hudmath.js';

export function initMinimap(ctx: HudContext): void {
  const transform = createMinimapTransform(ctx.catalog.map.bounds, 220);

  const wrap = el('div', 'bh-minimap', ctx.root);
  const canvas = el('canvas', undefined, wrap);
  canvas.width = transform.width;
  canvas.height = transform.height;
  const g = canvas.getContext('2d');
  if (g === null) return;

  const colors = {
    water: cssVar('--bg-deep', '#07111c'),
    border: cssVar('--border', '#2a4a66'),
    south: cssVar('--team-south', '#ff5c5c'),
    north: cssVar('--team-north', '#5c8aff'),
    neutral: cssVar('--text-dim', '#7d96ab'),
    self: cssVar('--text', '#d8e6f2'),
    view: cssVar('--accent', '#36a3ff'),
  };

  function teamColor(team: string | null): string {
    if (team === 'south') return colors.south;
    if (team === 'north') return colors.north;
    return colors.neutral;
  }

  function drawStructure(en: SnapshotEntity): void {
    if (g === null) return;
    const { x, y } = transform.toMini(en.x, en.y);
    g.fillStyle = teamColor(en.team);
    switch (en.role) {
      case 'hq': {
        // diamond
        g.beginPath();
        g.moveTo(x, y - 5);
        g.lineTo(x + 5, y);
        g.lineTo(x, y + 5);
        g.lineTo(x - 5, y);
        g.closePath();
        g.fill();
        break;
      }
      case 'tower': {
        g.beginPath();
        g.moveTo(x, y - 4);
        g.lineTo(x + 3.5, y + 3);
        g.lineTo(x - 3.5, y + 3);
        g.closePath();
        g.fill();
        break;
      }
      case 'shop': {
        g.beginPath();
        g.arc(x, y, 3, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = colors.self;
        g.lineWidth = 1;
        g.stroke();
        break;
      }
      case 'repair': {
        g.fillRect(x - 3, y - 1, 6, 2);
        g.fillRect(x - 1, y - 3, 2, 6);
        break;
      }
      case 'missileRamp': {
        g.fillRect(x - 4, y - 1.5, 8, 3);
        break;
      }
      case 'spawnBuilding': {
        g.fillRect(x - 3, y - 3, 6, 6);
        break;
      }
      default: {
        g.fillRect(x - 2, y - 2, 4, 4);
        break;
      }
    }
  }

  function draw(nowMs: number): void {
    if (g === null) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = colors.water;
    g.fillRect(0, 0, canvas.width, canvas.height);

    const sample = hudSample(nowMs);
    if (sample !== null) {
      const mySlot = store.match.mySlot;
      // Structures first (under unit dots).
      for (const en of sample.entities) {
        if (en.kind === 'structure') drawStructure(en);
      }
      for (const en of sample.entities) {
        if (en.kind === 'structure') continue;
        const { x, y } = transform.toMini(en.x, en.y);
        const isSelf = en.kind === 'ship' && en.ownerSlot !== null && en.ownerSlot === mySlot;
        const r = en.kind === 'ship' ? 2.5 : en.kind === 'ward' ? 1.5 : 2;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fillStyle = teamColor(en.team);
        g.fill();
        if (isSelf) {
          g.strokeStyle = colors.self;
          g.lineWidth = 1.5;
          g.stroke();
        }
      }
    }

    // Camera viewport rectangle.
    const rect = getCamera().viewportWorldRect();
    const a = transform.toMini(rect.minX, rect.maxY);
    const b = transform.toMini(rect.maxX, rect.minY);
    g.strokeStyle = colors.view;
    g.lineWidth = 1;
    g.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);

    // Map border.
    g.strokeStyle = colors.border;
    g.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
  }

  ctx.onFrame(draw);

  // -- click / drag to pan ---------------------------------------------------
  let dragging = false;

  function panToEvent(e: PointerEvent): void {
    const box = canvas.getBoundingClientRect();
    const mx = ((e.clientX - box.left) / box.width) * canvas.width;
    const my = ((e.clientY - box.top) / box.height) * canvas.height;
    const world = transform.toWorld(mx, my);
    getCamera().panTo(world.x, world.y);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    panToEvent(e);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) panToEvent(e);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointercancel', () => {
    dragging = false;
  });
}
