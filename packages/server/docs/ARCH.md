# Game server — module contracts

Authoritative Node WebSocket server (`packages/server`). Two implementers,
disjoint files; nobody edits the other's. The wire protocol is FROZEN in
`@bships/core` (`packages/core/src/protocol.ts`) — changes need architect
sign-off. Read `protocol.ts` top-of-file docs first: vision filtering and the
keyframe+delta cadence are specified there.

Scaffolded and complete (do not rewrite):

- `src/data.ts` — `loadRawDataFiles()`, `getClassicRuleset()` (compile-once,
  shared, treated as deeply immutable).
- `src/server.ts` — `startServer(options)`: the ws bootstrap (port binding,
  socket->manager adaptation, graceful `close()`). `src/index.ts` is the
  thin CLI entry; `test/e2e.test.ts` reuses `startServer` with `port: 0`
  and test-mode pacing (`tickIntervalMs: 0` burst, `countdownSeconds: 0`).

## Hard rules (both modules)

- The sim runs ONLY here. Clients send `Command`s and receive vision-filtered
  snapshots. Never send a client an enemy unit its team cannot see, or
  another player's private state.
- Sim state depends only on (ruleset, seed, per-tick command batches). Wall
  clock decides WHEN ticks run, never WHAT they compute. No `Math.random` in
  anything feeding the sim — seed comes from `crypto` at room start.
- Per-tick command batches are applied in deterministic order: ascending
  player slot, FIFO within a slot (matches `applyCommands`' "sorted by
  player" contract in `sim.ts`).
- Every inbound message crosses `parseClientMessage` (server-rooms) before
  any handler sees it. Trust nothing from the wire.
- Style: 2-space, named exports, ESM with `.js` import suffixes; deps: `ws`
  only.

## Module: server-rooms

- **Owns**: `src/index.ts` (replace placeholder handler), `src/identity.ts`,
  `src/validate.ts`, `src/rooms.ts`, `test/rooms.test.ts`
- **Exports** (consumed by tests; index.ts wires it all):
  - `validate.ts`: `parseClientMessage(raw: unknown): ClientMessage | null` —
    structural validation of EVERY message type incl. the full `Command`
    union (field types, lengths via `MAX_*` constants, `TOKEN_PATTERN`,
    finite numbers). Returns null on garbage; caller answers
    `error{badMessage}`.
  - `identity.ts`: token -> session registry. `publicId` = short random id
    (NOT derived from the token; never leak tokens). One live socket per
    token: a new `hello` with a token that has a live socket closes the old
    one (newest wins).
  - `rooms.ts`: `createRoomManager(ruleset)` — room registry + per-connection
    state machine.
- **Behavior**:
  - Connection lifecycle: first message MUST be `hello` (anything else:
    `error{notAuthed}`, close). Version mismatch: `error{versionMismatch}`,
    close. Then `welcome` (+ resume routing below).
  - Lobby: `createRoom` (creator = host), `joinRoom`, `listRooms`,
    `leaveRoom`, `pickSlot` (must be in `LOBBY_SLOTS`, unoccupied),
    `setReady`, `chat` (lobby scope relays to room; system notices use
    `scope:'system'`). Broadcast `roomState` on every change. Host leaving
    promotes the oldest member; empty rooms are deleted (lobby phase only).
  - Start: host sends `startMatch`; require >=1 seated player per team is
    NOT required (solo testing allowed) but every seated player must be
    ready (`error{playersNotReady}`). Phase 'starting', broadcast
    `matchStarting` each second from `MATCH_COUNTDOWN_SECONDS` down to 0,
    then draw `seed` (crypto random uint32), build seats from picked slots,
    `createMatchRuntime(...)`, `runtime.start()`, phase 'playing'.
  - In match: route `command` messages to `runtime.enqueueCommand(slot,
    msg.command)`; `chat` relays respecting scope ('team' = same-team slots
    only); `leaveRoom` marks the seat disconnected (no mid-match unseating).
  - Reconnect: `hello` token matching a seat in a room -> `welcome.resumed`,
    re-attach: lobby phase -> send `roomState`; playing -> notify
    `runtime.setConnected(slot, true)` (runtime sends the full keyframe).
    Disconnect (socket close / heartbeat timeout) -> `setConnected(slot,
    false)`, mark in roomState.
  - Heartbeat: send `ping{t: Date.now()}` every `HEARTBEAT_INTERVAL_MS`;
    drop sockets silent for `HEARTBEAT_TIMEOUT_MS`. (Wall clock is fine
    here — it never feeds the sim.)
  - Rate limiting (per connection): token bucket — 60 messages burst,
    refill 30/s; `command` messages additionally capped at 40/s. Over
    budget: `error{rateLimited}` and drop the message (close after ~5
    consecutive violations). Oversized frames (> 16 KiB) -> close.
- **Provides to server-match**: `sendToSlot` closures that serialize one
  `ServerMessage` to the seat's live socket (no-op while disconnected).

## Module: server-match

- **Owns**: `src/match.ts`, `src/visibility.ts`, `src/snapshot.ts`,
  `test/match.test.ts`, `test/visibility.test.ts`
- **Exports** — the seam between the modules, frozen:

  ```ts
  // src/match.ts
  export interface MatchSeat { slot: number; name: string; }
  export interface MatchRuntimeDeps {
    ruleset: Ruleset;                // getClassicRuleset(), shared
    seed: number;                    // rooms draws it at start
    seats: MatchSeat[];              // human slots only (2-6 / 7-11)
    sendToSlot(slot: number, msg: ServerMessage): void;
    onEnded(result: { winnerTeam: TeamId | null; stats: PublicPlayerStat[] }): void;
    tickIntervalMs?: number;         // TEST MODE ONLY: ms/tick, 0 = burst
  }
  export interface MatchRuntime {
    readonly status: 'running' | 'ended';
    start(): void;
    stop(): void;                    // room teardown; clears timers
    enqueueCommand(slot: number, command: Command): void;
    setConnected(slot: number, connected: boolean): void;
    readonly replay: MatchReplayLog; // (seed, tick -> commands[]) artifacts
    getState(): SimState;            // diagnostics/tests only; never mutate
  }
  export function createMatchRuntime(deps: MatchRuntimeDeps): MatchRuntime;
  ```

  Signed off (integrator): `replay` and `getState()` are part of the
  interface — the determinism/replay tests and the E2E suite depend on them.
  `getState()` must never feed data back into message payloads except
  through the snapshot/visibility pipeline. `tickIntervalMs` exists for the
  E2E suite (burst mode); production paths never set it — wall clock still
  only decides WHEN ticks run, never WHAT they compute.

- **Behavior**:
  - Setup: `createMatch(ruleset, seed, seats.map(s => ({ slot: s.slot,
    control: 'user' })))`. AI empire slots 0/1 and unseated human slots need
    nothing — `createMatch` already creates them as computer players with no
    ships, and they receive no commands ever.
  - Tick loop, drift-corrected: a `setTimeout` chain against an anchor
    `startMs`; on fire, step while `state.tick <
    floor((now - startMs) / (1000 / TICK_RATE))`, capped at 5 catch-up
    steps per fire (log when capped). Each tick: drain the command queue
    for this tick (sorted slot-asc, FIFO within slot), validate
    `command.player === slot` (mismatch: drop +
    `error{invalidCommand}` to sender), `applyCommands`, `stepTick`,
    tally kills/deaths from death events (ship victims with non-null
    players), then build + send per-team payloads.
  - **Vision filter** (`visibility.ts`) — THE security boundary. The sim's
    `entity.vision` flags cover ONLY invisibility-vs-detection
    (`recomputeVisibility` doc: "Fog-of-war is not modeled"). Sight-radius
    fog is computed HERE per team each tick:
    - Sight sources of team T: every live entity of team T (sightRadius
      from ShipSpec / UnitTypeSpec / WardEntity.sightRadius) plus T's
      active `state.detectionZones`.
    - Structures: ALWAYS included for both teams (placement is public map
      knowledge; live HP is an accepted v1 divergence — note it in code).
    - Own-team units/wards/summons: always included.
    - Enemy units (ship/creep/summon): included iff `entity.vision[T]`
      (invisibility check, sim-owned) AND within some T sight source's
      radius (fog check, this module).
    - Enemy wards: included iff (!ward.invisible OR covered by a T detector
      — mirror specials' detector collection) AND inside T sight range.
    - Projectiles: included iff `team === T` OR inside T sight range.
    - Ground items: not in snapshots v1 (documented gap; pickups still work
      blind via quest regions — revisit with the protocol owner).
  - Snapshot build (`snapshot.ts`): per team, build the filtered
    entity/projectile/event payload ONCE, then wrap per seat with that
    seat's `you` (PlayerState verbatim) and `players` when due. Keyframe
    (`snapshot`) on start, on `setConnected(true)`, and every
    `KEYFRAME_INTERVAL_TICKS`; `snapshotDelta` otherwise. Delta = diff
    against the per-team payload of the previous tick: `upserts` (changed
    or entered vision — compare cheap fields x/y/facing/hp/maxHp/statuses/
    shopStock), `removed` (died or left vision), full projectile list,
    events. Round x/y to 0.1. `you` included when the seat's PlayerState
    JSON changed; `players` when any public stat changed.
  - Event filtering per team T: player-private events (purchase, refund,
    itemUsed, xpGained, levelUp, bounty, questProgress, proximityWarning)
    go ONLY to that player's own seat — they ride in that seat's message,
    not the team payload. Team-scoped: researchStarted/researchComplete
    (matching team), respawn (own team). Global: waveSpawned,
    matchEnded. Spatial
    (death, hit, missileLaunched): only if the affected entity is in T's
    filtered set this tick (deaths: also if victim/killer is a T player).
  - Match end: `stepTick` flips `state.status.phase` to 'ended' (HQ death).
    Send final delta, then `matchEnded{winnerTeam, stats}` to all seats,
    stop the loop, call `onEnded`.
  - Determinism artifacts (cheap, valuable): keep `(seed, tick ->
    commands[])` in memory; expose on the runtime for tests to assert
    `hashState` replay equality against a fresh `createMatch` +
    re-application.

## Message flow summary

```
client hello ──> identity ──> welcome ──┬─ lobby msgs ──> rooms.ts
                                        └─ command/chat (playing) ──> runtime
runtime ── sendToSlot ──> per-seat socket   (snapshot / delta / matchEnded)
```
