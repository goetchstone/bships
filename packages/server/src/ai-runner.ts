/**
 * Server-side AI runner (server-ai): the thin deterministic loop that turns
 * the AI memory living inside `SimState` into this tick's AI commands.
 *
 * NO game logic lives here. The runner only:
 *  - iterates the AI slots present in `state.aiMemory` in ASCENDING slot order
 *    (so the merged command batch is deterministic regardless of object key
 *    insertion order), and
 *  - for each slot whose `memory.nextThinkTick <= state.tick`, invokes the core
 *    brain `computeAiCommands(state, ruleset, slot, memory)` and forwards the
 *    Commands it returns.
 *
 * All decision-making (lane choice, economy, targeting, cadence advancement,
 * PRNG) is owned by the pure core brain in `packages/core/src/sim/ai.ts`. The
 * brain mutates its own `AiMemory` entry in place (including advancing
 * `nextThinkTick`); the runner never second-guesses the cadence — it only
 * gates on `nextThinkTick` exactly as the brain documents.
 *
 * Determinism: this module reads only `state.tick` and `state.aiMemory` keys
 * and forwards the brain's output verbatim. It introduces no time/random/trig
 * built-ins and no extra `state.rngState` draws. The merged result is sorted
 * ascending-slot/FIFO-within-slot so match.ts can splice it into the per-tick
 * command batch and keep the replay log (`commandsByTick`) bit-identical.
 *
 * Trust boundary: the runner only forwards commands whose `.player` equals the
 * AI slot they were computed for — mirroring the human path's `enqueueCommand`
 * guard (match.ts), so the architecture mandate's "AI cannot cheat the rules"
 * holds even if a future brain regression emitted a command addressed to
 * another player's slot. The current brain always sets `player: slot`, so this
 * is a defensive filter, not a live fix.
 */

import { computeAiCommands } from '@bships/core';
import type { Command, Ruleset, SimState } from '@bships/core';

/**
 * Compute every due AI slot's commands for the current tick.
 *
 * Returns a flat `Command[]` already grouped by ascending slot, with each
 * slot's commands in the order the brain emitted them (FIFO within slot).
 * Slots whose `nextThinkTick` is still in the future contribute nothing this
 * tick. The brain mutates `state.aiMemory[slot]` in place as a side effect
 * (cadence/stance/stuck tracking), which is part of `SimState` and thus the
 * replay/desync hash.
 */
export function runAiTick(state: SimState, ruleset: Ruleset): Command[] {
  const slots = aiSlotsAscending(state);
  if (slots.length === 0) return [];

  const merged: Command[] = [];
  for (const slot of slots) {
    const memory = state.aiMemory[slot];
    if (memory === undefined) continue; // defensive: key vanished mid-iteration
    if (state.tick < memory.nextThinkTick) continue; // not due this tick
    const commands = computeAiCommands(state, ruleset, slot, memory);
    for (const command of commands) {
      // Trust boundary: never forward a command addressed to another slot (the
      // brain always sets player: slot; this guards a regression that didn't).
      if (command.player !== slot) continue;
      merged.push(command);
    }
  }
  return merged;
}

/**
 * The AI-controlled player slots present in `state.aiMemory`, in ascending
 * numeric order. Object keys are coerced to numbers (JSON round-trips them as
 * strings) and sorted so iteration order is independent of insertion order.
 */
export function aiSlotsAscending(state: SimState): number[] {
  return Object.keys(state.aiMemory)
    .map((key) => Number(key))
    .sort((a, b) => a - b);
}
