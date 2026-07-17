<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { Sun, Moon } from 'lucide-svelte';
  import { page } from '$app/state';
  import SideNav from '$lib/SideNav.svelte';
  import NotificationBell from '$lib/NotificationBell.svelte';
  import YinYang from '$lib/icons/YinYang.svelte';
  import { resolvePageTitle } from '$lib/nav-utils';
  import { widgets, widgetsForPage } from '$lib/widgets';
  import { pages } from '$lib/pages';
  import { arrangeMode } from '$lib/arrange.svelte';
  import FloatingPomodoro from './widgets/pomodoro/FloatingPomodoro.svelte';

  let { children }: { children: Snippet } = $props();

  // True only under `vite dev`; false in the production build the NAS serves.
  // Makes local dev visually unmistakable so it's never confused with prod.
  const isDev = import.meta.env.DEV;

  let theme = $state<'light' | 'dark'>('dark');
  // Mobile-only: the side nav slides in as a drawer. Always false on desktop
  // where the rail is permanently visible (the toggle button is hidden there).
  let drawerOpen = $state(false);

  const currentPageTitle = $derived(resolvePageTitle(page.url.pathname));

  // The pomodoro floats over the whole app, but on the ticket-detail page it overlaps the
  // Refine chat window on mobile — hide it there. Match on route id (exact) not pathname.
  const showPomodoro = $derived(page.route.id !== '/task-monitor/tickets/[ticketId]');

  // Arrange button: shown only on widget-bearing pages at >=768px (enforced in CSS).
  // task-monitor is a Kanban, not a widget grid — excluded.
  const canArrange = $derived.by(() => {
    const pathname = page.url.pathname;
    if (pathname.startsWith('/task-monitor')) return false;
    if (pathname === '/') return widgets.length > 0;
    const p = pages.find(
      (pg) =>
        pg.route !== '/' && (pathname === pg.route || pathname.startsWith(pg.route + '/')),
    );
    return p ? widgetsForPage(p.id).length > 0 : false;
  });

  // Exit arrange mode whenever the page changes.
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    page.url.pathname;
    arrangeMode.exit();
  });

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
      <a href="/" class="nav-brand">{currentPageTitle}</a>
      {#if isDev}
        <span class="env-badge" title="Local development — not production">DEV</span>
      {/if}
      <div class="nav-spacer"></div>
      <NotificationBell />
      {#if canArrange}
        <button
          class="arrange-btn"
          class:active={arrangeMode.active}
          onclick={arrangeMode.toggle}
          aria-label={arrangeMode.active ? 'Exit arrange mode' : 'Arrange widgets'}
        >Arrange</button>
      {/if}
      <button class="theme-toggle" onclick={toggleTheme} aria-label="Toggle light/dark theme">
        {#if theme === 'dark'}<Sun size={16} />{:else}<Moon size={16} />{/if}
      </button>
    </nav>
    <main class="content">
      {@render children()}
    </main>
  </div>
</div>

{#if showPomodoro}
  <FloatingPomodoro />
{/if}

<style lang="scss" src="./+layout.scss"></style>
