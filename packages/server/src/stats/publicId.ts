/**
 * Stable, non-reversible stats public id derived from the secret identity
 * token (owned by server-integration).
 *
 * The WebSocket identity registry's RoomPlayer.publicId is a throwaway 'p'+hex
 * handle, fresh every server restart — useless as a cross-restart/cross-device
 * stats key. The stats service instead keys players by THIS id, which is a
 * deterministic, one-way function of the token:
 *
 *   deriveStatsPublicId(token) = 's' + sha256(token).hex.slice(0, 16)
 *
 * Matches STATS_PUBLIC_ID_PATTERN ('^s[0-9a-f]{16}$'). sha256 makes it
 * non-reversible, so the public id can be displayed/stored by the stats
 * service without ever exposing the secret token. Pure + trivially unit-tested.
 */

import { createHash } from 'node:crypto';

/** Derive the stable stats public id for an identity token. */
export function deriveStatsPublicId(token: string): string {
  return 's' + createHash('sha256').update(token).digest('hex').slice(0, 16);
}
