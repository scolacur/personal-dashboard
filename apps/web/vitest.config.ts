import { defineConfig } from 'vitest/config';

// Isolated from vite.config.ts (no SvelteKit plugin): these are pure-TS unit
// tests for widget logic, so we don't need the app's dev/build plugin chain.
//
// The suffix is `.spec.ts`, not `.test.ts`. A `.test.ts` file here is silently
// never run — that is how utils.test.ts sat dead in the tree.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // Count every source file, not just the ones a test happens to import —
      // otherwise untested modules are invisible and the number reads high.
      all: true,
      // `.svelte` is deliberately absent: with no svelte plugin in this config
      // nothing transforms a component, so it cannot be instrumented. That is
      // the whole of PD-484 — Measure test coverage properly; until it lands,
      // this number describes the `.ts` modules only, not the UI.
      include: ['src/**/*.ts'],
      exclude: ['**/*.spec.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
});
