<!-- Dashboard shell: top nav + theme toggle wrapping all pages -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';

  let { children }: { children: Snippet } = $props();

  let theme = $state<'light' | 'dark'>('dark');

  onMount(() => {
    const t = document.documentElement.getAttribute('data-theme');
    theme = t === 'light' ? 'light' : 'dark';
  });

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('theme', theme);
    } catch {
      // ignore — storage may be unavailable
    }
  }
</script>

<nav class="top-nav">
  <a href="/" class="nav-brand">Dashboard</a>
  <button class="theme-toggle" onclick={toggleTheme} aria-label="Toggle light/dark theme">
    {theme === 'dark' ? '☀' : '☾'}
  </button>
</nav>
<main class="content">
  {@render children()}
</main>

<style lang="scss" src="./+layout.scss"></style>
