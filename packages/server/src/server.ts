/**
 * Reusable ws bootstrap: adapts ws sockets/frames to the room manager's
 * transport-agnostic API. `index.ts` calls this for the real process; the
 * E2E test calls it with an ephemeral port (0) and test-mode pacing options.
 *
 * Determinism note: `tickIntervalMs`/`countdownSeconds` only change WHEN
 * ticks/starts happen on the wall clock — sim results stay a pure function
 * of (ruleset, seed, per-tick command batches).
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import { DEFAULT_PORT, PROTOCOL_VERSION } from '@bships/core';
import { getClassicRuleset } from './data.js';
import { createMatchRuntime } from './match.js';
import { createRoomManager, MAX_FRAME_BYTES } from './rooms.js';
import type { RoomManager } from './rooms.js';

export interface ServerOptions {
  /** TCP port; 0 picks an ephemeral port (tests). Default DEFAULT_PORT. */
  port?: number;
  /** Test mode only: ms per sim tick (0 = burst). Default realtime. */
  tickIntervalMs?: number;
  /** Lobby countdown override (tests); default MATCH_COUNTDOWN_SECONDS. */
  countdownSeconds?: number;
  /** Suppress startup logging (tests). */
  quiet?: boolean;
}

export interface RunningServer {
  /** The actually bound port (resolved when `port: 0` was requested). */
  port: number;
  manager: RoomManager;
  /** Close every client socket, tear down all rooms, stop listening. */
  close(): Promise<void>;
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.length;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const port = options.port ?? DEFAULT_PORT;
  const quiet = options.quiet === true;
  const ruleset = getClassicRuleset();

  if (!quiet) {
    console.log(
      `[bships] Classic ruleset compiled: ${Object.keys(ruleset.ships).length} ships, ` +
        `${Object.keys(ruleset.weapons).length} weapons, ` +
        `${ruleset.map.structures.length} structures`,
    );
  }

  const manager = createRoomManager(ruleset, {
    createRuntime: createMatchRuntime,
    ...(options.tickIntervalMs !== undefined ? { tickIntervalMs: options.tickIntervalMs } : {}),
    ...(options.countdownSeconds !== undefined
      ? { countdownSeconds: options.countdownSeconds }
      : {}),
  });

  // maxPayload is a hard memory backstop; the manager enforces the actual
  // MAX_FRAME_BYTES policy (close 1009) itself.
  const wss = new WebSocketServer({ port, maxPayload: MAX_FRAME_BYTES * 4 });

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', (err) => reject(err));
  });

  const address = wss.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  if (!quiet) {
    console.log(`[bships] ws server listening on :${boundPort} (protocol v${PROTOCOL_VERSION})`);
  }

  wss.on('connection', (socket) => {
    const conn = manager.handleConnection({
      send: (text) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
      close: (code, reason) => socket.close(code, reason),
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      conn.onMessage(rawDataToString(data), {
        binary: isBinary,
        byteLength: rawDataByteLength(data),
      });
    });
    socket.on('close', () => conn.onClose());
    socket.on('error', (err) => {
      if (!quiet) console.warn(`[bships] socket error: ${err.message}`);
      socket.close();
    });
  });

  return {
    port: boundPort,
    manager,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        manager.shutdown();
        wss.close(() => resolve());
      }),
  };
}
