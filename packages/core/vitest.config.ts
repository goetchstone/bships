import { defineConfig } from 'vitest/config';

// The heavy sim probes (3000-tick integration matches, AI replay determinism,
// creep/tower grind windows) take 2-16s on a fast dev machine and 3-4x that on
// the shared CI runners — vitest's 5s default timeout fails them there while
// they pass locally. One generous package-wide cap (a hung test still fails,
// just slower) instead of scattered per-test overrides. On CI the files also
// run serially: the probes are synchronous CPU-bound loops, and parallel
// workers pegging the runner's cores stall vitest's worker IPC past its fixed
// 60s ("Timeout calling onTaskUpdate" fails an otherwise-green run).
export default defineConfig({
  test: {
    testTimeout: 120_000,
    ...(process.env.CI ? { fileParallelism: false } : {}),
  },
});
