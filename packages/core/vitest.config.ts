import { defineConfig } from 'vitest/config';

// The heavy sim probes (3000-tick integration matches, AI replay determinism,
// creep/tower grind windows) take 2-16s on a fast dev machine and 3-4x that on
// the shared CI runners — vitest's 5s default timeout fails them there while
// they pass locally. One generous package-wide cap (a hung test still fails,
// just slower) instead of scattered per-test overrides; CI also caps workers
// so parallel heavy probes don't saturate the runner's cores.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    ...(process.env.CI ? { minWorkers: 1, maxWorkers: 2 } : {}),
  },
});
