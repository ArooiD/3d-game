import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Vite is used for the dev server only (HMR for the renderer UI).
 * Production bundles are produced by scripts/build.mjs via esbuild, which keeps
 * one single build path for game code and avoids duplicating module resolution.
 */
export default defineConfig({
  root: resolve(process.cwd(), 'src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@shared': resolve(process.cwd(), 'src/shared'),
      '@renderer': resolve(process.cwd(), 'src/renderer'),
    },
  },
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    host: 'localhost',
  },
  build: {
    outDir: resolve(process.cwd(), 'dist/renderer'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
