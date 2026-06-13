/**
 * Pure presentation helpers for the stats UI (owned by client-stats). NO DOM,
 * NO fetch — just formatting on wire DTOs, so test/stats.test.ts can cover
 * them without a browser. The screens (leaderboard.ts / profile.ts) import
 * these for display.
 */

import type { LeaderboardEntry, ProfileMatchSummary } from '@bships/core';

/** Win rate as a rounded percentage string, e.g. '57%'; '—' with no matches. */
export function winRate(wins: number, losses: number): string {
  const total = wins + losses;
  if (total === 0) return '—'; // em dash
  return `${Math.round((wins / total) * 100)}%`;
}

/** Signed Elo delta for display: '+12', '-8', '\xb10'. */
export function ratingDeltaLabel(delta: number): string {
  if (delta === 0) return '\xb10'; // ±0
  return delta > 0 ? `+${delta}` : String(delta);
}

/** Rank label from a zero-based leaderboard index: '#1', '#2', ... */
export function rankLabel(index: number): string {
  return `#${index + 1}`;
}

/** Compact relative time from an epoch-ms timestamp, e.g. '3m ago', '2d ago'. */
export function relativeTime(thenMs: number, nowMs: number): string {
  const diffMs = nowMs - thenMs;
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** One-line summary of a recent match for the profile list. */
export function matchSummaryLine(m: ProfileMatchSummary): string {
  const outcome = m.won ? 'W' : 'L';
  const delta = ratingDeltaLabel(m.ratingDelta);
  return `${outcome} · ${m.shipTypeId} · ${m.kills}/${m.deaths} · ${delta}`;
}

/** Sort/clamp a leaderboard for display (defensive — service already orders). */
export function displayLeaderboard(entries: LeaderboardEntry[], limit: number): LeaderboardEntry[] {
  return [...entries]
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit);
}
