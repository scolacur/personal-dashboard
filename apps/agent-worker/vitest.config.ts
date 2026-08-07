import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // Count every source file, not just the ones a test happens to import —
      // otherwise untested modules are invisible and the number reads high.
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['**/*.spec.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
});
