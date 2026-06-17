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
      // Armed targeted ability/item (hud set store.ui.pendingTarget): resolve
      // the click to a world point or a unit and send the SAME useItem/
      // castAbility command WITH the target. Clears the pending state on send
      // (and on a missed unit-click so the player isn't stuck armed).
      const pending = store.ui.pendingTarget;
      if (pending !== null) {
        if (pending.targeting === 'point') {
          const w = cam.screenToWorld(sx, sy);
          if (pending.kind === 'item' && pending.slot !== undefined) {
            sendCommand({ type: 'useItem', slot: pending.slot, x: w.x, y: w.y });
          } else if (pending.kind === 'ability' && pending.abilityId !== undefined) {
            sendCommand({ type: 'castAbility', abilityId: pending.abilityId, x: w.x, y: w.y });
          }
        } else {
          const hit = hitTestEntities(sample.entities, sx, sy, cam, getCatalog());
          if (hit !== null) {
            if (pending.kind === 'item' && pending.slot !== undefined) {
              sendCommand({ type: 'useItem', slot: pending.slot, targetId: hit.id });
            } else if (pending.kind === 'ability' && pending.abilityId !== undefined) {
              sendCommand({ type: 'castAbility', abilityId: pending.abilityId, targetId: hit.id });
            }
          }
        }
        store.ui.pendingTarget = null;
        emitChange();
        return;
      }
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

    // Right-click while an ability/item is armed (or attack-move is pending):
    // CANCEL the armed cast instead of issuing an order — the standard RTS
    // "right-click to back out of targeting" gesture (Esc does the same in the
    // hud). Without this, a player trying to abort would fire a move/attack.
    if (store.ui.pendingTarget !== null || store.ui.pendingOrder !== null) {
      store.ui.pendingTarget = null;
      store.ui.pendingOrder = null;
      emitChange();
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

  // Crosshair cursor while a targeted cast / attack-move is armed, so the
  // canvas itself signals "click to pick a target" (the hud also shows a
  // centred cue + highlights the armed slot). Driven by the store signal.
  const unsubCursor = store.subscribe(() => {
    const armed = store.ui.pendingTarget !== null || store.ui.pendingOrder !== null;
    canvas.style.cursor = armed ? 'crosshair' : '';
  });

  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('pointerdown', onPointerDown);

  return () => {
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.style.cursor = '';
    unsubEvents();
    unsubCursor();
  };
}
