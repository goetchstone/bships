import { defineConfig } from 'vite';

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
  },
});
