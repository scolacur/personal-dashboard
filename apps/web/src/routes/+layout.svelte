<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { Sun, Moon } from 'lucide-svelte';

  let { children }: { children: Snippet } = $props();

  // True only under `vite dev`; false in the production build the NAS serves.
  // Makes local dev visually unmistakable so it's never confused with prod.
  const isDev = import.meta.env.DEV;

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

<nav class="top-nav" class:is-dev={isDev}>
  <a href="/" class="nav-brand">Dashboard</a>
  {#if isDev}
    <span class="env-badge" title="Local development — not production">DEV</span>
  {/if}
  <div class="nav-links">
    <a href="/task-monitor">Task Monitor</a>
  </div>
  <button class="theme-toggle" onclick={toggleTheme} aria-label="Toggle light/dark theme">
    {#if theme === 'dark'}<Sun size={16} />{:else}<Moon size={16} />{/if}
  </button>
</nav>
<main class="content">
  {@render children()}
</main>

<style lang="scss" src="./+layout.scss"></style>
