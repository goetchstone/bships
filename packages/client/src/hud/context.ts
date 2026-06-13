/**
 * Shared plumbing for the HUD panels: the per-panel init context, tiny DOM
 * helpers and CSS-variable access. Panels never talk to each other directly —
 * they share state through the client-net store and this context only.
 */

import type { Ruleset } from '@bships/core';

export interface HudContext {
  /** The #hud overlay root (pointer-events:none; children opt back in). */
  root: HTMLElement;
  /** Read-only display catalog (names, prices, map bounds...). */
  catalog: Ruleset;
  /** Register a callback driven by hud.ts's single rAF loop. */
  onFrame(fn: (nowMs: number) => void): void;
}

/** Create an element, optionally with class and parent. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: Element,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (parent !== undefined) parent.appendChild(node);
  return node;
}

/** Resolve a CSS custom property from :root, with a fallback for tests. */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}
