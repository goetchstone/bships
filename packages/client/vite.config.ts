import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
    // Allow importing data/json/*.json from the repo root (catalog.ts).
    fs: { allow: ['../..'] },
  },
  build: {
    target: 'es2022',
    // The bundled data catalog (~1.6 MB raw JSON) trips the default warning.
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      // Two entry HTMLs: the game (index) and the standalone render gallery
      // (the human art-QA surface), reachable at /gallery.html in dev + build.
      input: {
        index: resolve(root, 'index.html'),
        gallery: resolve(root, 'gallery.html'),
      },
    },
  },
});
