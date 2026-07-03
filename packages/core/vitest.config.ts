import { defineConfig } from 'vitest/config';

// The heavy sim probes (3000-tick integration matches, AI replay determinism,
// creep/tower grind windows) take 2-16s on a fast dev machine and 3-4x that on
// the shared CI runners — vitest's 5s default timeout fails them there while
// they pass locally. One generous package-wide cap (a hung test still fails,
// just slower) instead of scattered per-test overrides. On CI the files also
// run serially, and the vitest-infra "[vitest-worker]: Timeout calling
// onTaskUpdate" artifact is ignored: the probes are synchronous CPU loops
// that starve the worker's event loop past birpc's fixed 60s ack window on
// slow runners, failing runs whose 547 tests all PASSED (observed twice,
// with and without worker parallelism). Test failures still fail CI; real
// unhandled errors still surface in (unflagged) local runs.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    ...(process.env.CI
      ? { fileParallelism: false, dangerouslyIgnoreUnhandledErrors: true }
      : {}),
  },
});
