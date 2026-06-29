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
  },
};
