/**
 * Client <-> server wire protocol. Defined ONCE here; both @bships/server and
 * @bships/client import these types via the workspace dependency.
 *
 * Transport: WebSocket, one JSON-encoded message per frame (UTF-8 text).
 * Every message is a tagged POJO (`type` discriminant). The protocol version
 * is negotiated once in hello/welcome — a mismatch is answered with
 * error{code:'versionMismatch'} and the connection is closed.
 *
 * VISION FILTERING (hard rule): snapshots are built PER TEAM on the server.
 * A client never receives an enemy unit (ship/creep/summon/ward) that its
 * team cannot currently see (entity.vision[team] false / undetected ward),
 * and never receives another player's private state (gold, lumber, xp,
 * inventory, cooldowns). Structures are the one documented exception: their
 * placement is public map knowledge, so all structures are always included
 * (live HP included — an accepted v1 simplification vs WC3 fog memory).
 *
 * SNAPSHOT CADENCE — keyframe + delta (decision record):
 * A full snapshot of ~150 entities is ~25-30 KB of JSON; at 20 Hz that is
 * ~500 KB/s per client before compression, which is too heavy. But most of
 * those entities are static structures and most ticks change only the
 * ~20-50 moving units in vision. So the server sends:
 *   - `snapshot` (keyframe): the complete vision-filtered world. Sent on
 *     match start, on (re)connect, and every KEYFRAME_INTERVAL_TICKS ticks.
 *   - `snapshotDelta`: every other tick. Contains full records for entities
 *     that changed OR entered vision (`upserts`), ids that died OR left
 *     vision (`removed`), the FULL projectile list (projectiles are few and
 *     move every tick — diffing them is pointless), per-team-filtered
 *     events, and `you`/`players` only when changed.
 * Deltas chain: `baseTick` names the tick the delta applies to. WebSocket is
 * ordered+reliable, so a gap can only follow a reconnect — which already
 * forces a keyframe. A client that still sees baseTick !== lastAppliedTick
 * must drop deltas until the next keyframe (worst case one second).
 * Typical delta: 30 moving entities ≈ 4-6 KB -> ~100 KB/s raw, well under
 * 15 KB/s with ws permessage-deflate. Revisit (binary encoding) only if
 * profiling demands it.
 */

import type { Command, PlayerState, SimEvent, StructureEntity, TeamId } from './sim/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;

/** Default WebSocket port for the game server (override with PORT env). */
export const DEFAULT_PORT = 8787;

/** Full keyframe snapshot every N ticks (1 s at 20 ticks/s). */
export const KEYFRAME_INTERVAL_TICKS = 20;

/** Render-time delay behind newest snapshot the client should target. */
export const RECOMMENDED_INTERP_DELAY_MS = 120;

/** Server sends ping at this interval; client echoes pong. */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** Server drops a connection after this long without any client message. */
export const HEARTBEAT_TIMEOUT_MS = 20000;

/** Lobby countdown after the host presses start. */
export const MATCH_COUNTDOWN_SECONDS = 3;

/** Identity token: 32 lowercase hex chars, client-generated, localStorage. */
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export const MAX_NAME_LENGTH = 24;
export const MAX_ROOM_NAME_LENGTH = 40;
export const MAX_CHAT_LENGTH = 240;

/**
 * Pickable lobby slots per team (sim player slots; 0/1 are the AI empire
 * players and are never pickable). Matches map-layout.json playerStarts.
 */
export const LOBBY_SLOTS: Readonly<Record<TeamId, readonly number[]>> = {
  south: [2, 3, 4, 5, 6],
  north: [7, 8, 9, 10, 11],
};

export const MAX_PLAYERS_PER_ROOM = 10;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export type RoomPhase = 'lobby' | 'starting' | 'playing' | 'ended';

/** Lobby room as listed in the room browser. */
export interface RoomSummary {
  roomId: string;
  name: string;
  phase: RoomPhase;
  playerCount: number;
  maxPlayers: number;
}

/**
 * A player as seen by other lobby members. `publicId` is a server-assigned
 * short id (NEVER the secret token) stable for the server's lifetime.
 */
export interface RoomPlayer {
  publicId: string;
  name: string;
  /** Picked sim slot, or null while undecided. */
  slot: number | null;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
}

/**
 * Public per-player scoreboard line, included in keyframes (and in deltas
 * when changed). Kills/deaths are tallied by the server from death events
 * (ship victims with non-null players).
 */
export interface PublicPlayerStat {
  slot: number;
  name: string;
  team: TeamId;
  shipTypeId: string;
  level: number;
  kills: number;
  deaths: number;
  connected: boolean;
}

/**
 * Status kinds a renderer needs. Server maps sim Status.kind:
 * dot->'burning', hot->'healing', speedAura->'hasted'; weaponBuff is
 * dropped; 'invisible' is only ever sent to the OWN team (an undetected
 * enemy is excluded entirely; a detected one carries 'revealed').
 */
export type SnapshotStatusKind =
  | 'invisible'
  | 'revealed'
  | 'stunned'
  | 'silenced'
  | 'ensnared'
  | 'slowed'
  | 'hasted'
  | 'shielded'
  | 'burning'
  | 'healing'
  | 'goblinMine';

/**
 * One vision-filtered entity. Positions are sim world units (+x east,
 * +y north); `facing` is sim facingRad. The snapshot builder rounds x/y to
 * 0.1 units to shrink payloads (display-only precision).
 * Wards report hp/maxHp 1/1.
 */
export interface SnapshotEntity {
  id: number;
  kind: 'ship' | 'creep' | 'structure' | 'ward' | 'summon';
  typeId: string;
  x: number;
  y: number;
  facing: number;
  hp: number;
  maxHp: number;
  team: TeamId | null;
  /** Owning player slot; null for neutral structures. */
  ownerSlot: number | null;
  statuses: SnapshotStatusKind[];
  /** Structures only. */
  role?: StructureEntity['role'];
  /** Ships only: submerged sub form. */
  submerged?: boolean;
  /**
   * Shop structures only: live stock for FINITE-stock items
   * (itemId -> remaining). Unlimited items are omitted.
   */
  shopStock?: Record<string, number>;
}

/** In-flight projectile (vision-filtered like entities). */
export interface SnapshotProjectile {
  id: number;
  weaponId: string;
  mechanic: 'phoenixFire' | 'stormBolt' | 'kaboomMissile' | 'nativeAttack';
  x: number;
  y: number;
  team: TeamId;
}

/**
 * YOUR private state — sent only to the owning client. This is the sim's
 * PlayerState verbatim (gold, lumber, xp, level, skill points/levels,
 * shipTypeId/shipId, full 6-slot inventory with charges + readyAtTick,
 * cooldown groups, missile throttle, respawn timer). Tick fields are
 * absolute sim ticks — the HUD renders cooldown sweeps against the
 * interpolation clock's current tick.
 */
export type SnapshotYou = PlayerState;

export type ErrorCode =
  | 'badMessage'
  | 'versionMismatch'
  | 'notAuthed'
  | 'roomNotFound'
  | 'roomFull'
  | 'alreadyInRoom'
  | 'notInRoom'
  | 'invalidSlot'
  | 'slotTaken'
  | 'notHost'
  | 'playersNotReady'
  | 'matchInProgress'
  | 'notInMatch'
  | 'invalidCommand'
  | 'rateLimited'
  | 'internal';

// ---------------------------------------------------------------------------
// Client -> server messages
// ---------------------------------------------------------------------------

/**
 * First message on every connection. `token` is the client's persistent
 * random identity (TOKEN_PATTERN); `name` the chosen display name. If the
 * token belongs to a player in a live room/match, the server resumes that
 * membership (see WelcomeMessage.resumed).
 */
export interface HelloMessage {
  type: 'hello';
  version: number;
  token: string;
  name: string;
}

export interface CreateRoomMessage {
  type: 'createRoom';
  roomName: string;
}

export interface JoinRoomMessage {
  type: 'joinRoom';
  roomId: string;
}

export interface ListRoomsMessage {
  type: 'listRooms';
}

/** Claim a lobby slot (must be in LOBBY_SLOTS and unoccupied). */
export interface PickSlotMessage {
  type: 'pickSlot';
  slot: number;
}

export interface SetReadyMessage {
  type: 'setReady';
  ready: boolean;
}

/** Host only; requires every seated player ready. */
export interface StartMatchMessage {
  type: 'startMatch';
}

/**
 * One sim command. `command.player` MUST equal the sender's slot — the
 * server rejects mismatches (error 'invalidCommand'). `tick` is the
 * client's estimated sim tick, for diagnostics only: the server always
 * applies the command on the next tick boundary after receipt.
 */
export interface CommandMessage {
  type: 'command';
  tick?: number;
  command: Command;
}

export interface ClientChatMessage {
  type: 'chat';
  scope: 'all' | 'team';
  text: string;
}

export interface LeaveRoomMessage {
  type: 'leaveRoom';
}

/** Echo of ServerPingMessage.t. */
export interface PongMessage {
  type: 'pong';
  t: number;
}

export type ClientMessage =
  | HelloMessage
  | CreateRoomMessage
  | JoinRoomMessage
  | ListRoomsMessage
  | PickSlotMessage
  | SetReadyMessage
  | StartMatchMessage
  | CommandMessage
  | ClientChatMessage
  | LeaveRoomMessage
  | PongMessage;

// ---------------------------------------------------------------------------
// Server -> client messages
// ---------------------------------------------------------------------------

/**
 * Reply to a valid hello. `resumed` is non-null when the token already
 * belongs to a live room: the server re-attaches the connection and follows
 * up with roomState (lobby) or a full keyframe snapshot (playing).
 */
export interface WelcomeMessage {
  type: 'welcome';
  version: number;
  publicId: string;
  /** Possibly trimmed/deduplicated display name the server settled on. */
  name: string;
  resumed: { roomId: string; phase: RoomPhase } | null;
}

export interface RoomListMessage {
  type: 'roomList';
  rooms: RoomSummary[];
}

/** Full lobby state; rebroadcast to the room on every membership change. */
export interface RoomStateMessage {
  type: 'roomState';
  roomId: string;
  name: string;
  phase: RoomPhase;
  players: RoomPlayer[];
}

/**
 * Broadcast once per second during the countdown with decreasing values
 * (..., 2, 1, 0). countdownSeconds 0 means the match is live — the first
 * keyframe snapshot follows immediately.
 */
export interface MatchStartingMessage {
  type: 'matchStarting';
  countdownSeconds: number;
}

/** Full keyframe: the complete vision-filtered world for YOUR team + you. */
export interface SnapshotMessage {
  type: 'snapshot';
  tick: number;
  you: SnapshotYou;
  entities: SnapshotEntity[];
  projectiles: SnapshotProjectile[];
  /** Per-team-filtered sim events for this tick (see server ARCH). */
  events: SimEvent[];
  players: PublicPlayerStat[];
}

/**
 * Per-tick delta against the client's last applied tick (`baseTick`).
 * Apply: upsert every entity in `upserts`, delete every id in `removed`
 * (death OR left vision — the client cannot tell, and must not), replace
 * the projectile list wholesale, append events. `you`/`players` are present
 * only when changed since baseTick.
 */
export interface SnapshotDeltaMessage {
  type: 'snapshotDelta';
  tick: number;
  baseTick: number;
  upserts: SnapshotEntity[];
  removed: number[];
  projectiles: SnapshotProjectile[];
  events: SimEvent[];
  you?: SnapshotYou;
  players?: PublicPlayerStat[];
}

export interface MatchEndedMessage {
  type: 'matchEnded';
  winnerTeam: TeamId | null;
  stats: PublicPlayerStat[];
}

export interface ServerChatMessage {
  type: 'chat';
  from: { publicId: string; name: string; slot: number | null };
  scope: 'all' | 'team' | 'system';
  text: string;
}

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  msg: string;
}

/** Heartbeat + clock sample; client echoes t in pong. */
export interface ServerPingMessage {
  type: 'ping';
  t: number;
}

export type ServerMessage =
  | WelcomeMessage
  | RoomListMessage
  | RoomStateMessage
  | MatchStartingMessage
  | SnapshotMessage
  | SnapshotDeltaMessage
  | MatchEndedMessage
  | ServerChatMessage
  | ErrorMessage
  | ServerPingMessage;
