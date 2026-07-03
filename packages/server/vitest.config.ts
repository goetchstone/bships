import { defineConfig } from 'vitest/config';

// Same rationale as packages/core/vitest.config.ts: the bot-vs-bot and e2e
// room tests run multi-thousand-tick sims that blow vitest's 5s default on
// the slower shared CI runners while passing locally.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    ...(process.env.CI ? { fileParallelism: false } : {}),
  },
});
