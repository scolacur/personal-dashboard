import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import sveltePreprocess from 'svelte-preprocess';

/** @type {import('@sveltejs/kit').Config} */
export default {
  // vitePreprocess handles inline <script lang="ts"> / <style lang="scss">.
  // svelte-preprocess adds external-file support via `<style src="./x.scss">`,
  // which vitePreprocess silently ignores. Convention (see PROJECT.md §5):
  // component styles live in a sibling .scss file, not inline.
  preprocess: [vitePreprocess(), sveltePreprocess()],
  kit: {
    adapter: adapter({
      fallback: 'index.html',
    }),
    // Consume @dashboard/shared from SOURCE, not its built dist/. One alias here
    // wires both Vite and the generated tsconfig, so dev, prod build, and
    // svelte-check all resolve the same .ts files. Vite bundles the source in
    // both dev and prod — consistent, and it removes the "rebuild shared/dist
    // after editing" gotcha for the web app entirely (see DECISIONS D-024).
    alias: {
      '@dashboard/shared': '../../packages/shared/src/index.ts',
    },
  },
};
