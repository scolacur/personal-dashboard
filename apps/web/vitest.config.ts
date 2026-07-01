import { defineConfig } from 'vitest/config';

// Isolated from vite.config.ts (no SvelteKit plugin): these are pure-TS unit
// tests for widget logic, so we don't need the app's dev/build plugin chain.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
