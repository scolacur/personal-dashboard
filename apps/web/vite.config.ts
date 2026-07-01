import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// In dev only, resolve @dashboard/shared to its TypeScript source so edits hot-reload
// without rebuilding packages/shared and busting Vite's dep cache. The production build
// (and svelte-check/tsc) still consume the compiled dist/, same as the server — so
// `npm run build -w packages/shared` before `npm run verify` is still required.
const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [sveltekit()],
  resolve: command === 'serve' ? { alias: { '@dashboard/shared': sharedSrc } } : undefined,
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
}));
