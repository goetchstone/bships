/**
 * Canvas pointer input (docs/ARCH.md "Module: client-render", pointer):
 *   - left-click: select any entity under the cursor (writes
 *     store.ui.selectedEntityId; empty water deselects) — UNLESS
 *     store.ui.pendingOrder === 'attackMove', in which case the click issues
 *     attackMove at the world point and clears the pending order.
 *   - right-click: attackTarget when the click hits an enemy combatant's
 *     hull, otherwise move to the world point.
 *   - middle button belongs to the camera (drag pan) — ignored here.
 *
 * Hit-testing goes THROUGH the camera transforms (incl. foreshortening) via
 * viz.hitTestEntities against the current interpolated sample. Canvas-only
 * events; keyboard belongs to client-hud's keymap. Never touches
 * #screens/#hud DOM.
 */

import { getCatalog } from '../catalog.js';
import { sendCommand } from '../net/commands.js';
import { sampleWorld } from '../net/interpolation.js';
import { emitChange, onEvent, store } from '../net/store.js';
import { getCamera } from './camera.js';
import { hitTestEntities, isEnemyCombatant } from './viz.js';

export function attachPointer(canvas: HTMLCanvasElement): () => void {
  const localPos = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onContextMenu = (e: Event): void => e.preventDefault();

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.button !== 2) return; // middle = camera drag
    const sample = sampleWorld(performance.now());
    if (sample === null) return;
    const cam = getCamera();
    const { x: sx, y: sy } = localPos(e);

    if (e.button === 0) {
      if (store.ui.pendingOrder === 'attackMove') {
        const w = cam.screenToWorld(sx, sy);
        sendCommand({ type: 'attackMove', x: w.x, y: w.y });
        store.ui.pendingOrder = null;
        emitChange();
        return;
      }
      const hit = hitTestEntities(sample.entities, sx, sy, cam, getCatalog());
      const id = hit?.id ?? null;
      if (store.ui.selectedEntityId !== id) {
        store.ui.selectedEntityId = id;
        emitChange();
      }
      return;
    }

    // Right-click: attack an enemy combatant, otherwise move.
    const hit = hitTestEntities(sample.entities, sx, sy, cam, getCatalog());
    if (hit !== null && isEnemyCombatant(hit, store.match.myTeam)) {
      sendCommand({ type: 'attackTarget', targetId: hit.id });
    } else {
      const w = cam.screenToWorld(sx, sy);
      sendCommand({ type: 'move', x: w.x, y: w.y });
    }
  };

  // Keep selection honest: clear it when the selected entity dies.
  const unsubEvents = onEvent((event) => {
    if (event.type === 'death' && event.entityId === store.ui.selectedEntityId) {
      store.ui.selectedEntityId = null;
      emitChange();
    }
  });

  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('pointerdown', onPointerDown);

  return () => {
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('pointerdown', onPointerDown);
    unsubEvents();
  };
}
