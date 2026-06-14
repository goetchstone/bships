/**
 * Server entry point: starts the ws game server on PORT (default
 * DEFAULT_PORT). All wiring lives in server.ts (`startServer`), which the
 * E2E test reuses with an ephemeral port and test-mode pacing.
 */

import { startServer } from './server.js';

// Last-resort backstops: the per-room tick loop already isolates faults
// (match.ts onTimerFire try/catch), but a stray throw from any other async
// seam (a timer, a socket callback) must never silently crash the whole
// process and disconnect every live match. Log and keep serving; a genuinely
// fatal condition still surfaces in the logs for an operator to act on.
process.on('uncaughtException', (err) => {
  console.error('[bships] uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[bships] unhandledRejection (kept alive):', reason);
});

const port = Number(process.env['PORT'] ?? NaN);

startServer(Number.isFinite(port) ? { port } : {}).catch((err: unknown) => {
  console.error('[bships] failed to start server:', err);
  process.exitCode = 1;
});
