/**
 * AUDIT 1: 10-minute (12000 sim ticks) burst match at the runtime level.
 * Measures: heap/RSS growth, entity/projectile counts, replay-log growth,
 * bytes "sent", then a snapshot-build benchmark at ~150 live entities.
 */
import { getClassicRuleset } from '../src/data.js';
import { createMatchRuntime } from '../src/match.js';
import { buildTeamPayload, diffTeamPayloads, filterEventsForSeat } from '../src/snapshot.js';
import type { TeamPayload } from '../src/snapshot.js';
import type { CreepEntity, SimState } from '@bships/core';

const ruleset = getClassicRuleset();
const TARGET_TICKS = 12_000; // 10 min at 20 t/s

const seats = [2, 3, 7, 8].map((slot) => ({ slot, name: `P${slot}` }));
let bytesSent = 0;
let messagesSent = 0;

const runtime = createMatchRuntime({
  ruleset,
  seed: 0xa5a5a5,
  seats,
  tickIntervalMs: 0, // burst
  sendToSlot: (_slot, msg) => {
    const text = JSON.stringify(msg);
    bytesSent += text.length;
    messagesSent += 1;
  },
  onEnded: (r) => console.log('[onEnded]', JSON.stringify(r.winnerTeam)),
});

const state = runtime.getState();
const starts = ruleset.map.playerStarts;

interface Sample {
  tick: number;
  heapMB: number;
  rssMB: number;
  entities: number;
  projectiles: number;
  replayTicks: number;
  replayCommands: number;
  bytesMB: number;
  wallMs: number;
}
const samples: Sample[] = [];
const t0 = Date.now();
let lastSampleTick = -1;
let lastCmdTick = -1;

function takeSample(): void {
  if (typeof global.gc === 'function') global.gc();
  const mem = process.memoryUsage();
  let replayCommands = 0;
  for (const cmds of runtime.replay.commandsByTick.values()) replayCommands += cmds.length;
  samples.push({
    tick: state.tick,
    heapMB: +(mem.heapUsed / 1048576).toFixed(1),
    rssMB: +(mem.rss / 1048576).toFixed(1),
    entities: Object.values(state.entities).filter((e) => e && !e.dead).length,
    projectiles: Object.keys(state.projectiles).length,
    replayTicks: runtime.replay.commandsByTick.size,
    replayCommands,
    bytesMB: +(bytesSent / 1048576).toFixed(1),
    wallMs: Date.now() - t0,
  });
}

runtime.start();
takeSample();

const poll = setInterval(() => {
  // Command pressure: every ~10 ticks, every seat issues a move (heavy but
  // realistic-competitive APM ~ 2 cmd/s/player).
  if (state.tick - lastCmdTick >= 10) {
    lastCmdTick = state.tick;
    for (const seat of seats) {
      const st = starts[seat.slot];
      if (!st) continue;
      runtime.enqueueCommand(seat.slot, {
        type: 'move',
        player: seat.slot,
        x: st.x + (state.tick % 700),
        y: st.y + ((state.tick * 13) % 500),
      });
    }
  }
  if (state.tick - lastSampleTick >= 1000) {
    lastSampleTick = state.tick;
    takeSample();
  }
  if (state.tick >= TARGET_TICKS || runtime.status === 'ended') {
    clearInterval(poll);
    runtime.stop();
    report();
  }
}, 5);

function report(): void {
  takeSample();
  console.log('\n=== burst match memory/growth profile (4 human seats) ===');
  console.log('tick | heapMB | rssMB | ents | proj | replayTicks | replayCmds | sentMB | wall(s)');
  for (const s of samples) {
    console.log(
      `${String(s.tick).padStart(5)} | ${s.heapMB} | ${s.rssMB} | ${s.entities} | ${s.projectiles} | ` +
        `${s.replayTicks} | ${s.replayCommands} | ${s.bytesMB} | ${(s.wallMs / 1000).toFixed(1)}`,
    );
  }
  console.log(`messages sent: ${messagesSent}, status: ${runtime.status}, final tick: ${state.tick}`);
  benchmarkSnapshots(state);
}

/** Pad the live state to >= 150 entities with REAL creep types, then time
 * exactly what broadcastTick does per tick (2 teams: build + diff + JSON). */
function benchmarkSnapshots(s: SimState): void {
  const creepTypeId = Object.keys(ruleset.unitTypes).find((id) => {
    const u = ruleset.unitTypes[id];
    return u && u.sightRadius > 0 && !ruleset.map.structures.some((p) => p.typeId === id);
  });
  if (!creepTypeId) throw new Error('no creep type found');
  let live = Object.values(s.entities).filter((e) => e && !e.dead).length;
  let i = 0;
  while (live < 150) {
    const id = s.nextEntityId++;
    const creep: CreepEntity = {
      id,
      kind: 'creep',
      typeId: creepTypeId,
      x: -2000 + (i * 137) % 6000,
      y: -3000 + (i * 211) % 6000,
      facingRad: 0,
      dead: false,
      owner: i % 2 === 0 ? 0 : 1,
      team: i % 2 === 0 ? 'south' : 'north',
      hp: 100,
      maxHp: 200,
      order: { type: 'idle' },
      statuses: [],
      vision: { south: true, north: true },
      attackReadyAtTick: 0,
      laneId: 'bench',
      waypointIndex: 0,
    };
    s.entities[id] = creep;
    live += 1;
    i += 1;
  }
  console.log(`\n=== snapshot build benchmark at ${live} live entities ===`);

  const teams = ['south', 'north'] as const;
  const prev = new Map<string, TeamPayload>();
  for (const team of teams) prev.set(team, buildTeamPayload(s, ruleset, team));

  const ITERS = 400;
  const times: number[] = [];
  for (let iter = 0; iter < ITERS; iter++) {
    // Worst case: every unit moved since last tick (forces full re-diff JSON).
    for (const e of Object.values(s.entities)) {
      if (e && !e.dead && e.kind !== 'structure') { e.x += 0.3; e.y -= 0.3; }
    }
    const start = performance.now();
    for (const team of teams) {
      const payload = buildTeamPayload(s, ruleset, team);
      const diff = diffTeamPayloads(prev.get(team)!, payload);
      prev.set(team, payload);
      // per-seat work: 2 seats per team, JSON event filter + delta stringify
      for (let seat = 0; seat < 2; seat++) {
        const events = filterEventsForSeat(s, [], team, 2, new Set(payload.entities.keys()));
        JSON.stringify({ type: 'snapshotDelta', tick: payload.tick, baseTick: payload.tick - 1, upserts: diff.upserts, removed: diff.removed, projectiles: payload.projectiles, events });
      }
    }
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(
    `per-tick full snapshot pipeline (2 teams x build+diff, 4 seat serializations), all units moving:`,
  );
  console.log(
    `  mean ${mean.toFixed(3)} ms | p50 ${times[Math.floor(ITERS * 0.5)]!.toFixed(3)} ms | ` +
      `p95 ${times[Math.floor(ITERS * 0.95)]!.toFixed(3)} ms | max ${times[ITERS - 1]!.toFixed(3)} ms`,
  );
}
