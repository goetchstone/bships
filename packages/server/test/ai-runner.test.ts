/**
 * server-ai AI runner tests. The runner is the thin loop that turns the AI
 * memory inside SimState into a tick's AI commands; all decision logic is in
 * the core brain. To test the runner's contract (cadence gating, ascending-slot
 * merge, deterministic forwarding) independently of the brain's body, the core
 * `computeAiCommands` is mocked with a controllable fake that records its calls
 * and returns scripted commands. The real ruleset is irrelevant here — only the
 * runner's slot iteration + cadence gate are under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiMemory, Command, Ruleset, SimState } from '@bships/core';

// Mock ONLY computeAiCommands; keep every other core export real.
const brain = vi.fn<
  (state: SimState, ruleset: Ruleset, slot: number, memory: AiMemory) => Command[]
>();
vi.mock('@bships/core', async (importActual) => {
  const actual = await importActual<typeof import('@bships/core')>();
  return { ...actual, computeAiCommands: (...args: Parameters<typeof brain>) => brain(...args) };
});

// Import the runner AFTER the mock is registered (vi.mock is hoisted, so a
// static import is fine, but we keep it explicit).
const { runAiTick, aiSlotsAscending } = await import('../src/ai-runner.js');

const FAKE_RULESET = {} as Ruleset;

function makeMemory(slot: number, nextThinkTick: number): AiMemory {
  return {
    slot,
    difficulty: 'normal',
    initialSeed: slot,
    aiRngState: slot,
    nextThinkTick,
    laneId: null,
    stance: 'push',
    retreatSinceTick: 0,
    lastOrderX: null,
    lastOrderY: null,
    lastProgressX: null,
    lastProgressY: null,
    lastProgressTick: 0,
    stuckCount: 0,
  };
}

/** Minimal SimState carrying only what the runner reads (tick + aiMemory). */
function makeState(tick: number, aiMemory: Record<number, AiMemory>): SimState {
  return { tick, aiMemory } as unknown as SimState;
}

beforeEach(() => {
  brain.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('aiSlotsAscending', () => {
  it('returns the AI slots in ascending numeric order regardless of key order', () => {
    const state = makeState(0, {
      9: makeMemory(9, 0),
      2: makeMemory(2, 0),
      11: makeMemory(11, 0),
    });
    expect(aiSlotsAscending(state)).toEqual([2, 9, 11]);
  });

  it('returns [] for a match with no AI slots', () => {
    expect(aiSlotsAscending(makeState(0, {}))).toEqual([]);
  });
});

describe('runAiTick cadence gating', () => {
  it('thinks only for slots whose nextThinkTick <= state.tick', () => {
    const state = makeState(10, {
      2: makeMemory(2, 10), // due (==)
      3: makeMemory(3, 5), // due (past)
      4: makeMemory(4, 11), // not due (future)
    });
    brain.mockReturnValue([]);
    runAiTick(state, FAKE_RULESET);

    const thoughtSlots = brain.mock.calls.map((c) => c[2]);
    expect(thoughtSlots).toEqual([2, 3]); // ascending, slot 4 skipped
  });

  it('returns [] and calls nothing when no slot is due', () => {
    const state = makeState(3, { 2: makeMemory(2, 10), 7: makeMemory(7, 4) });
    brain.mockReturnValue([{ type: 'stop', player: 2 }]);
    expect(runAiTick(state, FAKE_RULESET)).toEqual([]);
    expect(brain).not.toHaveBeenCalled();
  });

  it('returns [] for a match with no AI slots without touching the brain', () => {
    expect(runAiTick(makeState(0, {}), FAKE_RULESET)).toEqual([]);
    expect(brain).not.toHaveBeenCalled();
  });
});

describe('runAiTick merge order', () => {
  it('iterates due slots ascending and concatenates their commands FIFO', () => {
    const state = makeState(0, {
      7: makeMemory(7, 0),
      2: makeMemory(2, 0),
    });
    brain.mockImplementation((_s, _r, slot) =>
      slot === 2
        ? [
            { type: 'attackMove', player: 2, x: 1, y: 2 },
            { type: 'buyItem', player: 2, shopId: 5, itemId: 'I001' },
          ]
        : [{ type: 'stop', player: 7 }],
    );

    expect(runAiTick(state, FAKE_RULESET)).toEqual([
      { type: 'attackMove', player: 2, x: 1, y: 2 },
      { type: 'buyItem', player: 2, shopId: 5, itemId: 'I001' },
      { type: 'stop', player: 7 },
    ]);
    // Brain was invoked in ascending slot order.
    expect(brain.mock.calls.map((c) => c[2])).toEqual([2, 7]);
  });

  it('passes the live memory object through so the brain can mutate it in place', () => {
    const mem2 = makeMemory(2, 0);
    const state = makeState(0, { 2: mem2 });
    brain.mockImplementation((_s, _r, _slot, memory) => {
      memory.nextThinkTick = 10; // brain advances its own cadence
      return [];
    });
    runAiTick(state, FAKE_RULESET);
    expect(brain.mock.calls[0]?.[3]).toBe(mem2); // same reference
    expect(mem2.nextThinkTick).toBe(10); // mutation is observed by the runner
  });

  it('forwards the brain output verbatim (no reordering within a slot)', () => {
    const state = makeState(0, { 5: makeMemory(5, 0) });
    const scripted: Command[] = [
      { type: 'move', player: 5, x: 0, y: 0 },
      { type: 'holdPosition', player: 5 },
      { type: 'setGoldDump', player: 5, enabled: true },
    ];
    brain.mockReturnValue(scripted);
    expect(runAiTick(state, FAKE_RULESET)).toEqual(scripted);
  });
});

describe('runAiTick determinism', () => {
  it('produces identical output across repeated runs for the same state snapshot', () => {
    // Two structurally-identical states with different key insertion orders
    // must yield the same merged command sequence.
    const a = makeState(0, { 11: makeMemory(11, 0), 2: makeMemory(2, 0), 7: makeMemory(7, 0) });
    const b = makeState(0, { 2: makeMemory(2, 0), 7: makeMemory(7, 0), 11: makeMemory(11, 0) });
    brain.mockImplementation((_s, _r, slot) => [{ type: 'stop', player: slot }]);

    const outA = runAiTick(a, FAKE_RULESET);
    brain.mockClear();
    const outB = runAiTick(b, FAKE_RULESET);
    expect(outA).toEqual(outB);
    expect(outA).toEqual([
      { type: 'stop', player: 2 },
      { type: 'stop', player: 7 },
      { type: 'stop', player: 11 },
    ]);
  });
});
