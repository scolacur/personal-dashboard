<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { Sun, Moon } from 'lucide-svelte';
  import SideNav from '$lib/SideNav.svelte';
  import YinYang from '$lib/icons/YinYang.svelte';

  let { children }: { children: Snippet } = $props();

  // True only under `vite dev`; false in the production build the NAS serves.
  // Makes local dev visually unmistakable so it's never confused with prod.
  const isDev = import.meta.env.DEV;

  let theme = $state<'light' | 'dark'>('dark');
  // Mobile-only: the side nav slides in as a drawer. Always false on desktop
  // where the rail is permanently visible (the toggle button is hidden there).
  let drawerOpen = $state(false);

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

  function openDrawer() {
    drawerOpen = true;
  }
  function closeDrawer() {
    drawerOpen = false;
  }
</script>

<div class="shell">
  <aside class="sidebar" class:open={drawerOpen}>
    <SideNav onNavigate={closeDrawer} />
  </aside>

  {#if drawerOpen}
    <button class="scrim" onclick={closeDrawer} aria-label="Close navigation menu"></button>
  {/if}

  <div class="main-col">
    <nav class="top-nav" class:is-dev={isDev}>
      <button class="nav-menu-btn" onclick={openDrawer} aria-label="Open navigation menu">
        <YinYang size={22} />
      </button>
      <a href="/" class="nav-brand">Dashboard</a>
      {#if isDev}
        <span class="env-badge" title="Local development — not production">DEV</span>
      {/if}
      <div class="nav-spacer"></div>
      <button class="theme-toggle" onclick={toggleTheme} aria-label="Toggle light/dark theme">
        {#if theme === 'dark'}<Sun size={16} />{:else}<Moon size={16} />{/if}
      </button>
    </nav>
    <main class="content">
      {@render children()}
    </main>
  </div>
</div>

<style lang="scss" src="./+layout.scss"></style>
