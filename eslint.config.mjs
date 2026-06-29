// Flat ESLint config for the whole monorepo (apps/server, apps/web, packages/shared).
// Non-type-aware on purpose — fast, no project-references wiring. Deepen to type-aware
// rules later if a real ceiling shows up. eslint-config-prettier turns off stylistic
// rules so ESLint and Prettier never fight; formatting is owned by `npm run format`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      '**/node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Parse <script lang="ts"> inside .svelte files with the TS parser.
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      // Static adapter with no `base` configured + LAN-only SPA: plain internal
      // hrefs are correct here, and resolve() would fight svelte-check's typed routes
      // for zero routing benefit. Re-enable if a base path is ever introduced.
      'svelte/no-navigation-without-resolve': 'off',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
