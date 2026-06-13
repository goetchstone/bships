# Browser client — module contracts

PixiJS v8 + Vite client (`packages/client`). Three implementers, disjoint
files. The wire protocol is FROZEN in `@bships/core`
(`packages/core/src/protocol.ts`). The sim NEVER runs here: the client
renders interpolated snapshots and sends `Command`s — zero client-side game
logic, no prediction.

Scaffolded and complete (do not rewrite):

- `index.html` — DOM roots + theme CSS variables (see "DOM ownership").
- `src/catalog.ts` — `getCatalog(): Ruleset`, the Classic ruleset compiled
  client-side from the bundled data/json as a READ-ONLY display catalog
  (names, prices, shop lists, ship specs, map bounds/regions). Display only;
  the server stays authoritative for all outcomes.
- `vite.config.ts`, `tsconfig.json`, `package.json`.

## DOM ownership

- `#screens` — client-net (lobby/menu screens; hidden during match).
- `#stage` — client-render (Pixi canvas mount; all canvas pointer events).
- `#hud` — client-hud (overlay; `pointer-events:none` root, interactive
  children opt back in). Keyboard events (window-level) belong to
  client-hud's keymap; client-render must not add key listeners.

Theme: use the CSS variables from index.html (`--bg-panel`, `--team-south`
red, `--team-north` blue, `--gold`, ...). Team colors must match between
HUD (CSS) and renderer (hex literals mirroring the same values).

## Coordinate conventions (binding)

- World space = sim space: +x east, +y north, units as in the data; `facing`
  radians, 0 = east, counter-clockwise positive.
- Screen space: Pixi y-down. Camera transform (camera.ts owns the only
  world<->screen code in the app):
  - `screenX = (worldX - cam.x) * cam.zoom + viewport.w / 2`
  - `screenY = (cam.y - worldY) * cam.zoom * FORESHORTEN + viewport.h / 2`
  - `FORESHORTEN = 0.82` (2.5D vertical squash), zoom clamped `[0.5, 2.0]`.
- Y-sort: `sortableChildren` with `zIndex = -worldY` (north = behind).
- Sprite rotation for facing: `rotation = -facing` (y-flip negates angles).

## Interpolation contract (client-net provides, client-render consumes)

- net stamps every snapshot/delta arrival and maintains a server-clock
  estimate: `serverTickAt(nowMs)` ≈ latest tick + elapsed since receipt,
  EWMA-smoothed; render time = `serverTickAt(now) -
  RECOMMENDED_INTERP_DELAY_MS / (1000 / TICK_RATE)` ticks (i.e. ~120 ms
  behind newest).
- net keeps a ring buffer of the last 64 APPLIED frames (keyframe or
  keyframe+deltas resolved into full frames):
  `{ tick, entities: Map<number, SnapshotEntity>, projectiles: SnapshotProjectile[] }`.
- `sampleWorld(nowMs): WorldSample` (src/net/interpolation.ts) returns, for
  the two frames bracketing render time: every entity present in BOTH
  lerped (x, y; facing via shortest-arc), entities only in the newer frame
  at their newest position (just appeared), entities only in the older
  frame omitted (gone — render fades on its own via events), plus lerped
  projectiles and `tickFloat`. Render calls this once per rAF and NEVER
  reads frames directly.

## Module: client-net

- **Owns**: `src/main.ts` (boot wiring), `src/net/identity.ts`,
  `src/net/socket.ts`, `src/net/store.ts`, `src/net/interpolation.ts`,
  `src/net/commands.ts`, `src/lobby/lobby.ts`, `src/lobby/lobby.css` (or
  inline styles), `test/net.test.ts`
- **Exports**:
  - `identity.ts`: `getIdentity(): { token, name }` — token = 32 hex chars
    from `crypto.getRandomValues`, persisted in localStorage
    (`bships.token`, `bships.name`); name prompt/edit in lobby UI.
  - `socket.ts`: `connect(url)` — WebSocket with auto-reconnect
    (exponential backoff 0.5 s..8 s, infinite), sends `hello` on every
    (re)open, answers `ping` with `pong`, dispatches every `ServerMessage`
    into the store. Default url `ws://localhost:${DEFAULT_PORT}` (override
    `?server=` query param).
  - `store.ts`: THE shared state singleton (plain object + subscribe):

    ```ts
    interface Store {
      connection: { status: 'connecting' | 'open' | 'closed'; rttMs: number };
      identity: { token: string; name: string; publicId: string | null };
      lobby: { rooms: RoomSummary[]; room: RoomStateMessage | null };
      match: {
        phase: 'idle' | 'starting' | 'playing' | 'ended';
        countdown: number;
        mySlot: number | null;
        myTeam: TeamId | null;
        you: SnapshotYou | null;          // latest, not interpolated
        players: PublicPlayerStat[];
        latestTick: number;
        winnerTeam: TeamId | null;
        chat: ServerChatMessage[];         // capped at 100
      };
      ui: {
        selectedEntityId: number | null;   // render writes, hud reads
        pendingOrder: 'attackMove' | null; // hud writes, render consumes
        shopEntityId: number | null;       // hud derives + owns
      };
      subscribe(fn: () => void): () => void;  // coarse change signal
    }
    export const store: Store;
    ```

    Event fan-out: `onEvent(fn: (e: SimEvent) => void): unsubscribe` —
    every snapshot/delta's events are fanned out once, in order (render
    subscribes for death flashes/projectile impacts; hud for kill feed,
    level-ups, errors-as-toasts).
  - `interpolation.ts`: `sampleWorld(nowMs)` per the contract above.
  - `commands.ts`: `sendCommand(cmd: Omit<Command, 'player'> & { player?: number })`
    — fills `player: store.match.mySlot`, wraps in `CommandMessage`, drops
    with a console.warn if not in a playing match. Plus lobby senders:
    `createRoom(name)`, `joinRoom(id)`, `listRooms()`, `pickSlot(n)`,
    `setReady(b)`, `startMatch()`, `sendChat(scope, text)`, `leaveRoom()`.
- **Behavior**: lobby screens in `#screens` (plain DOM): connect status ->
  name entry -> room browser (list + create + join) -> room lobby (slot
  picker laid out as the two teams' five slots using `LOBBY_SLOTS`, ready
  toggle, host start button, lobby chat) -> countdown. On
  `matchStarting{0}`/first snapshot: hide `#screens`, show `#hud`, call
  `initRenderer(...)` then `initHud(...)` (dynamic import is fine). On
  `matchEnded`: keep render alive, hud shows the banner; "back to lobby"
  re-shows `#screens`. Keyframe gap handling per protocol.ts (drop deltas
  whose baseTick mismatches; wait for keyframe).

## Module: client-render

- **Owns**: `src/render/renderer.ts`, `src/render/camera.ts`,
  `src/render/water.ts`, `src/render/entities.ts`,
  `src/render/projectiles.ts`, `src/render/effects.ts`,
  `src/render/fog.ts`, `src/render/pointer.ts`, `test/render.test.ts`
- **Exports**:
  - `renderer.ts`: `initRenderer(opts: { mount: HTMLElement }): Promise<void>`
    — creates the Pixi Application, starts the rAF loop: each frame
    `sampleWorld(performance.now())` -> update display objects.
  - `camera.ts`: `getCamera(): Camera` —

    ```ts
    interface Camera {
      x: number; y: number; zoom: number;          // world-space center
      worldToScreen(x: number, y: number): { x: number; y: number };
      screenToWorld(sx: number, sy: number): { x: number; y: number };
      panTo(worldX: number, worldY: number): void; // smooth lerp
      viewportWorldRect(): { minX: number; minY: number; maxX: number; maxY: number };
    }
    ```

    HUD imports `getCamera()` read-mostly (minimap rect + click-to-pan).
    Mouse-wheel zoom-to-cursor (the world point under the cursor stays
    fixed), clamp [0.5, 2.0]; edge scroll (pointer within 12 px of window
    edge); middle-drag pan; camera position clamped to
    `getCatalog().map.bounds` with margin. All camera motion smoothed
    (exp lerp ~10/s).
- **Behavior**:
  - Water background: deep-navy base + subtle grid/wave bands in world
    space (cheap, tiling Graphics), map border visible.
  - Structures: distinct procedural silhouettes by `role` (hq: large
    bastion + flag; tower: slim turret; harbor/spawnBuilding: dock + crane;
    shop: tent/awning + sign; repair: dry-dock; missileRamp: rail), team
    color trim (`--team-*` hex values), neutral = parchment gray.
  - Ships: team-colored hull polygon with a clear BOW (facing); class
    silhouette from `getCatalog().ships[typeId]` tiers (size scales with
    gold tier; subs slim + dive-shaded when `submerged`), creeps smaller
    desaturated hulls, summons ghost-tinted, wards = buoys. HP bar above
    every combatant (green>yellow>red, width = maxHp-scaled, hidden at
    full HP except selected), name label for player ships
    (`store.match.players` by ownerSlot), selection ring on
    `store.ui.selectedEntityId`, status tints from `statuses` (burning
    flicker, slowed blue, stunned stars, invisible 50% alpha — own team
    only by construction).
  - Projectiles: small tracers by `mechanic` (phoenixFire: dot+trail,
    stormBolt: bolt, kaboomMissile: large missile + smoke), lerped.
  - Effects (`effects.ts`): subscribe `onEvent` — death = expanding ring +
    flash sized by maxHp, hit = small impact tick, levelUp = pillar on own
    ship, respawn = splash.
  - Fog (`fog.ts`): cosmetic only — the server already filters. Dim
    (multiply ~0.55) world areas outside any friendly entity's sightRadius
    circle (sample the current frame's friendly entities; coarse 64 px
    render-texture is fine). No information is revealed or hidden by it.
  - Pointer (`pointer.ts`, canvas events only): left-click = select own
    ship / any entity (writes `store.ui.selectedEntityId`); right-click =
    `sendCommand({ type:'move', x, y })` via `screenToWorld`, or
    `attackTarget` when the click hits an enemy combatant's hull bounds;
    if `store.ui.pendingOrder === 'attackMove'`, left-click issues
    `attackMove` and clears it. Y-FORESHORTEN applies to hit-testing too —
    always go through camera transforms.

## Module: client-hud

- **Owns**: `src/input/keymap.ts`, `src/hud/hud.ts`, `src/hud/topbar.ts`,
  `src/hud/inventory.ts`, `src/hud/shop.ts`, `src/hud/minimap.ts`,
  `src/hud/scoreboard.ts`, `src/hud/chat.ts`, `src/hud/banner.ts`,
  `src/hud/hud.css` (or inline), `test/hud.test.ts`
- **Exports**: `initHud(opts: { root: HTMLElement }): void` (root =
  `#hud`); `keymap.ts`: the single source of truth for bindings —

  ```ts
  type HudAction =
    | 'slot0' | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5'
    | 'shipAbility' | 'stop' | 'attackMove' | 'scoreboard' | 'chat'
    | 'shopToggle';
  export const DEFAULT_BINDINGS: Record<HudAction, string>; // KeyboardEvent.code
  export function bindingFor(action: HudAction): string;    // user override aware
  export function setBinding(action: HudAction, code: string): void; // localStorage
  export function onAction(fn: (a: HudAction, e: KeyboardEvent) => void): () => void;
  ```

  Defaults: slots 0-5 = `KeyW KeyE KeyR KeyA KeyS KeyD`, shipAbility =
  `KeyF`, stop = `KeyV`, attackMove = `KeyG`, scoreboard = `Tab` (hold),
  chat = `Enter`, shopToggle = `KeyB`. NO numpad anywhere. One window-level
  keydown/keyup listener lives here; ignore keys while chat input is
  focused; preventDefault on Tab.
- **Behavior** (all data from `store` + `getCatalog()`; all sim actions via
  `sendCommand`; camera via `getCamera()`):
  - Top bar: gold (`--gold`), lumber, level + XP-to-next (catalog
    `xp.xpToLevel`), K/D from `store.match.players[mySlot]`, connection/RTT
    dot.
  - Inventory: 6 slots labeled W E R A S D from `bindingFor`, item
    name/emoji placeholder + charges, cooldown sweep = conic-gradient
    overlay driven by `readyAtTick` vs the interpolation clock's current
    tick; click or hotkey -> `useItem{slot}` (target-requiring items enter
    a click-target mode via `store.ui.pendingOrder`-style local state —
    v1: send untargeted and rely on server rejection events for UX). `F`
    button beside slots -> `castAbility` with the catalog ability of the
    current ship (`ships[you.shipTypeId].abilityIds`), cooldown from
    `you.cooldownGroups`.
  - Stop/attack-move: stop -> `sendCommand({type:'stop'})`; attackMove
    sets `store.ui.pendingOrder = 'attackMove'` (render consumes the next
    click).
  - Shop panel: derive proximity each store change — own ship within
    `interactRadius` of a shop entity in the current frame (use
    `sampleWorld` newest frame entities of kind structure + catalog
    `shops[typeId]`); auto-open small "press B" affordance, full panel
    lists `ShopSpec.items/ships` with names (catalog equipment/weapons/
    ships), prices, stock (`shopStock`), lumber gates; buy ->
    `buyItem`/`buyShip`. Closes when out of range.
  - Minimap (canvas, ~220 px, bottom-left): world->minimap = linear from
    `map.bounds` (y flipped, NO foreshortening); draw structures (role
    glyphs), visible units as team-color dots (newest frame), camera
    `viewportWorldRect` rectangle; click/drag -> `getCamera().panTo`.
  - Scoreboard (hold Tab): both teams' `PublicPlayerStat` rows — name,
    ship, level, K/D, connected.
  - Chat: log bottom-left above minimap (from `store.match.chat` + system
    events via `onEvent`: kills feed "A sunk B"), Enter opens input
    (all/team toggle), Esc closes.
  - Banner: `matchStarting` countdown numerals; `matchEnded` ->
    VICTORY/DEFEAT by `winnerTeam === myTeam` + stats table + back-to-lobby
    button (calls the client-net exposed `returnToLobby()` — net exports it
    from `lobby.ts`).

## Boot order (main.ts, owned by client-net)

```
getIdentity -> connect(ws) -> lobby screens (#screens)
on first snapshot: hide #screens, initRenderer({mount: #stage}),
initHud({root: #hud}), show #hud
```
