/**
 * Vite config — dev server roots at ./viewer/.
 *
 * The viewer (docs/16-viewer.md) is the canonical inspection UI for v1. Vite
 * serves viewer/index.html on `npm run dev` at http://localhost:5173/, and
 * `npm run build` emits a static bundle into dist/.
 *
 * The simulation lives in src/ and the viewer imports it directly via relative
 * paths (../src/...). The tsconfig path aliases (@sim, @procgen, @burnin) are
 * not wired here on purpose — the viewer wants explicit relative imports so
 * sim refactors surface as obvious diffs.
 */

import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./viewer', import.meta.url)),
  publicDir: false,
  server: {
    port: 5173,
    open: false,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@sim': fileURLToPath(new URL('./src/sim', import.meta.url)),
      '@procgen': fileURLToPath(new URL('./src/procgen', import.meta.url)),
    },
  },
});
