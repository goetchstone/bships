/**
 * Server entry point: starts the ws game server on PORT (default
 * DEFAULT_PORT). All wiring lives in server.ts (`startServer`), which the
 * E2E test reuses with an ephemeral port and test-mode pacing.
 */

import { startServer } from './server.js';

const port = Number(process.env['PORT'] ?? NaN);

startServer(Number.isFinite(port) ? { port } : {}).catch((err: unknown) => {
  console.error('[bships] failed to start server:', err);
  process.exitCode = 1;
});
