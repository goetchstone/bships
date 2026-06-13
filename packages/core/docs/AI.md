# AI players — contract sheet

Computer-controlled captains that play real Classic matches as **opponents**
(enemy team) and **teammates** (your team). An AI player is just a server-driven
`control: 'computer'` player whose emitted `Command`s flow through the SAME
`applyCommands` path a human's commands take — so it cannot cheat the rules.

An AI match replays bit-identically from `(seed, AI configs)` by **re-running
the deterministic brain** (which reproduces both its command stream and its
`AiMemory` from the seed). The logged command stream is the brain's *output*,
not a substitute: replaying only the command log into a fresh `createMatch`
without re-running the brain does NOT reproduce an AI match's `hashState`,
because `aiMemory` lives in `SimState` (digested by `hashState`) and is advanced
only by the brain. Pure command-log replay reproduces a **human** match, whose
state carries no brain-derived memory. See `ai-match.test.ts` (re-run-brain
determinism) and the `ai.ts` "REPLAY CONTRACT" comment.

This is also why it is needed structurally: the start gate requires a player on
**both** teams (`rooms.ts` `handleStartMatch`), so filling a team with AI lets a
single human play solo vs AI.

Read first: `packages/core/src/sim/types.ts` (`Command` union, entity records,
`AiConfig`/`AiMemory`/`AiDifficulty`, `SimState.aiMemory`),
`packages/core/src/sim/ai.ts` (the skeleton + binding doc comments),
`packages/server/src/match.ts` (tick loop / command drain),
`packages/server/src/rooms.ts` (lobby/slot model), `docs/BALANCE.md`,
`data/json/map-layout.json`.

---

## 1. Where AI memory lives (decision)

**Inside `SimState`**, as `state.aiMemory: Record<number, AiMemory>` keyed by
player slot (2-11). Present only for AI-controlled slots; empty `{}` when the
match has no AI.

Rationale (the determinism mandate):

- `hashState` digests **all of `SimState` except `events`** (see `sim.ts`
  `hashState`), so AI memory is automatically part of the replay/desync hash —
  no extra plumbing.
- Reconnect/serialize/replay all already round-trip `SimState`, so AI memory
  rides along for free. A server-side side table would have to be separately
  reconstructed to keep `hashState` honest; storing it in state avoids that
  entire class of bug.

`AiConfig` (just `difficulty`) is supplied per slot at `createMatch` via the new
optional `PlayerConfig.ai` field; `createMatch` calls `initAiMemory(slot, seed,
config.ai)` for each AI slot (ascending slot order) and writes
`state.aiMemory[slot]`. **`initAiMemory` does NOT touch `state.rngState`** — the
brain's PRNG stream is derived from `(seed, slot)` separately, so adding AI
players never shifts the sim-mechanic RNG draw order (the replay contract).

---

## 2. Brain API (`packages/core/src/sim/ai.ts`)

```ts
// Pure decision function. Reads full SimState, mutates the slot's AiMemory in
// place, returns the Commands that slot issues this think (each .player === slot).
export function computeAiCommands(
  state: SimState,
  ruleset: Ruleset,
  slot: number,
  memory: AiMemory,
): Command[];

// Initial per-slot memory (called by createMatch). Pure; no state.rngState use.
export function initAiMemory(slot: number, seed: number, config: AiConfig): AiMemory;

// Deterministic per-slot seed from (matchSeed, slot). Integer hashing only.
export function deriveAiSeed(seed: number, slot: number): number;

// Brain-private PRNG helpers — the ONLY randomness the brain may use.
export function seedAiRng(memory: AiMemory): Rng;       // load memory.aiRngState
export function commitAiRng(memory: AiMemory, rng: Rng): void; // persist (once/think)

// Difficulty knobs (single source of truth; this table mirrors §5).
export interface AiTuning { thinkIntervalTicks; retreatHpFraction;
  economyEfficiency; microQuality; reserveGold; }
export const AI_TUNING: Readonly<Record<AiDifficulty, AiTuning>>;
export function thinkIntervalTicks(difficulty: AiDifficulty): number;
```

`AiMemory` (serializable POJO in `SimState`): `slot`, `difficulty`,
`initialSeed`, `aiRngState` (brain's private mulberry32 state), `nextThinkTick`
(cadence gate), `laneId`, `stance` (`'push'|'retreat'|'regroup'`),
`lastOrder[XY]`, `lastProgress[XY]`, `lastProgressTick`, `stuckCount`. All
tick-valued fields are **absolute** sim ticks.

---

## 3. Determinism rules (binding — every line must hold)

- **Randomness**: ONLY via `seedAiRng`/`commitAiRng` threading
  `AiMemory.aiRngState`. NEVER `Math.random`, NEVER `Date`/wall-clock, NEVER
  `state.rngState` (that channel's draw order is the sim-mechanic replay
  contract — see `MODULES.md` "RNG draw order"). Commit the advanced PRNG state
  back into `memory` exactly once per think, on every code path.
- **Angle math**: ONLY `dSin`/`dCos`/`dAtan2` from `../math.js` (`dist`,
  `Math.sqrt/abs/floor/min/max` fine). NEVER `Math.sin/cos/atan2`.
- **Iteration**: over `state.entities` / `state.players` in ascending numeric id
  order (`sortedNumericKeys`); build random-pick candidate lists in
  ascending-id order BEFORE drawing.
- **No `state.events` reads** to drive logic (derived output only).
- **Public actions only**: the brain reads full state (server-side) but emits
  only Commands a human could legally issue, and must not encode hidden info
  into them (e.g. don't `attackTarget` an entity the AI's team can't see —
  respect `entity.vision[team]` + sight the way a human would).
- **No new state-mutation channels**: the brain returns Commands; it does NOT
  write entity hp/gold/positions. The only state it mutates is its own
  `AiMemory` entry.

Replay test the implementer must add: a match seeded with AI on both teams,
driven only by the AI runner, must `hashState`-equal a fresh `createMatch` +
re-application of the captured command stream (same as the existing
integration determinism test, now with AI slots).

---

## 4. Think cadence model

Humans act every tick; bots think every `thinkIntervalTicks(difficulty)` ticks.

- The server AI runner calls `computeAiCommands(state, ruleset, slot, memory)`
  for an AI slot **when `state.tick >= memory.nextThinkTick`**, BEFORE
  `applyCommands` for that tick, and enqueues the returned commands so they are
  applied on that same tick (ascending-slot, FIFO-within-slot order, exactly
  like human commands).
- The **brain** advances `memory.nextThinkTick = state.tick +
  thinkIntervalTicks(memory.difficulty)` itself, so cadence is part of
  deterministic state. The runner only gates on `nextThinkTick` — it must not
  invent its own schedule.
- Returning `[]` from a think is valid (nothing to do). Multiple AI slots in one
  tick are processed in **ascending slot order** so the merged command batch is
  deterministic.

---

## 5. Difficulty tuning table (mirror of `AI_TUNING` in `ai.ts`)

| Difficulty | thinkIntervalTicks | retreatHpFraction | economyEfficiency | microQuality | reserveGold |
|---|---:|---:|---:|---:|---:|
| easy   | 20 (~1.0 s) | 0.15 | 0.50 | 0.30 | 0   |
| normal | 10 (~0.5 s) | 0.30 | 0.80 | 0.65 | 100 |
| hard   | 5 (~0.25 s) | 0.40 | 1.00 | 0.95 | 150 |

- `thinkIntervalTicks` — ticks between thinks (lower = sharper reactions).
- `retreatHpFraction` — retreat toward base/repair when `hp/maxHp` drops below
  this (0 disables; easy bot is reckless).
- `economyEfficiency` — 0..1 chance per think the bot makes its ideal buy vs
  dawdling.
- `microQuality` — 0..1 chance per think the bot issues an optimal
  targeting/positioning order vs a coarse attack-move.
- `reserveGold` — gold the bot keeps on hand (spends only the excess).

ai-brain may refine the exact numbers during playtesting but MUST keep them in
`AI_TUNING` and re-sync this table.

---

## 6. Behavior spec (what the brain must do)

BattleShips is a 2-lane creep-pushing naval MOBA; the win condition is
destroying the enemy HQ (`role 'hq'`). South HQ sits at the far -y end, North HQ
at the far +y end (`map-layout.json`). Per think, in order:

1. **Cadence + liveness**: gate on `nextThinkTick` (defensive); advance it. If
   the player is dead/respawning (`player.shipId === null`), emit nothing.
2. **Economy** (gated by `economyEfficiency`): spend `gold - reserveGold` on the
   next BALANCE-tier item from the correct team's in-range shop. Opening:
   a Basic Cannon (`I001`). Then upgrade weapon → hull (`I009`→`I016`→`I00A`) →
   sail (`I007`+) → repair as gold allows (`docs/BALANCE.md` §1–3, §6 tiers).
   Buy via `buyItem{shopId, itemId}`; the shop must be within its
   `interactRadius` of the ship, so move into range first if needed. Weapon shops
   sit by each team's HQ (south: `n001`/`n007`/`n002` near y≈-6500..-7040; north:
   the y≈+5800..+6272 mirror).
3. **Survival**: if `hp/maxHp < retreatHpFraction`, set `stance: 'retreat'`,
   move toward own base / repair bay, and `useItem` a carried repair wood /
   active heal if available. Hysteresis: only return to `'push'` after healing
   above a higher band (e.g. 0.7) so it doesn't flip-flop each think.
4. **Lane + push**: pick/keep a lane (`memory.laneId`); coordinate loosely with
   teammate bots — don't all stack one lane (e.g. pick the lane with the fewest
   allied ships, or split by slot parity). `attackMove` toward the enemy HQ so
   carried Phoenix-Fire weapons auto-fire at creeps/ships en route; push to the
   HQ.
5. **Targeting** (gated by `microQuality`): prefer an enemy **ship** in weapon
   range → else enemy **creeps** → else keep advancing toward the enemy HQ.
   Respect team vision. High micro = explicit `attackTarget`; low micro = coarse
   `attackMove` only.
6. **Stuck breaking**: compare current ship pos vs `lastProgress[XY]`; if it
   hasn't moved meaningfully since `lastProgressTick`, bump `stuckCount` and
   re-issue a fresh waypoint (re-route) once it crosses a small threshold.

Teammate bots use the same brain; loose coordination comes from reading allied
ship positions/lanes, not from shared mutable state.

---

## 7. Lobby + server flow

### Protocol (added in `packages/core/src/protocol.ts`, version unchanged)

- `addAi{ slot, difficulty }` — host only, lobby only: seat an AI in an OPEN
  pickable slot (in `LOBBY_SLOTS`, unoccupied by human or AI).
- `removeAi{ slot }` — host only, lobby only: reopen an AI-occupied slot.
- `RoomPlayer.ai: AiDifficulty | null` — human members report `null`; AI-filled
  slots are emitted as synthetic `RoomPlayer`s with `ai = difficulty`,
  `ready: true`, `connected: true`, `isHost: false`, and a display name like
  `"AI (normal)"`. They count as their team's player for the both-teams
  start gate.

### Server (server-ai module)

- `rooms.ts`: validate + handle `addAi`/`removeAi` (host + lobby + slot checks),
  track AI slots per room (slot → difficulty), include them in `roomStateMessage`
  as synthetic `RoomPlayer`s, count them in the both-teams start gate, and pass
  them into the match as seats with an AI config. Optional: "fill empty slots
  with AI" + a quick "vs AI" path.
- `match.ts`: build `createMatch` `PlayerConfig`s with `control: 'computer'` +
  `ai: { difficulty }` for AI slots; each tick, BEFORE draining human commands,
  run the AI runner for every AI slot whose `nextThinkTick` is due and enqueue
  its commands into the same per-tick batch.
- New file `src/ai-runner.ts` (server-ai owns it): the thin loop that, given the
  live `SimState`, iterates AI slots in ascending order, calls
  `computeAiCommands`, and returns the merged commands for the tick. No game
  logic lives here — it only invokes the core brain and forwards commands.

AI commands never leak vision: they run server-side from full state but emit
only public actions; the per-team snapshot filtering is unchanged. Reconnect /
spectator are unaffected (AI memory is in `SimState`).

### Client (client-ai-lobby module)

Lobby UI: per open slot, an "Add AI" control with a difficulty picker and a
"Remove" on AI-occupied slots; a "Fill with AI" button and a quick "Play vs AI"
button; render AI occupancy (`RoomPlayer.ai`) distinctly. Senders for
`addAi`/`removeAi` in `net/commands.ts`. Pure UI-logic only — the server
re-validates everything.
