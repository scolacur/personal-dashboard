<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { Sun, Moon } from 'lucide-svelte';
  import { page } from '$app/state';
  import SideNav from '$lib/SideNav.svelte';
  import NotificationBell from '$lib/NotificationBell.svelte';
  import YinYang from '$lib/icons/YinYang.svelte';
  import { arrangeablePageId, isDevOpsRoute, resolvePageTitle } from '$lib/nav-utils';
  import DeployStatus from './DeployStatus.svelte';
  import DispatchKillswitch from './DispatchKillswitch.svelte';
  import MaintenanceHoldIndicator from '$lib/MaintenanceHoldIndicator.svelte';
  import { pageWidgets } from '$lib/page-widgets.svelte';
  import { clearLegacyLayoutKeys } from '$lib/layout';
  import Toast from '$lib/Toast.svelte';
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
  const showPomodoro = $derived(page.route.id !== '/devops/tickets/[ticketId]');

  // Dev Ops section context in the nav: the deploy/commit readout (PD-414, re-homed from the
  // `#site-status` section PD-422 removed), the Robot dispatch killswitch (PD-410), and the
  // maintenance-hold indicator (PD-498). All three are section-wide operational state, so all
  // three ride the same predicate. The hold indicator renders nothing when no hold is pending.
  const showDevOpsNav = $derived(isDevOpsRoute(page.url.pathname));

  // Arrange button: shown only on widget-bearing pages at >=768px (enforced in CSS).
  // The route half of the rule lives in nav-utils so it's unit-tested (nav-utils.spec.ts).
  //
  // Still a synchronous derivation even though membership now lives server-side — that is the
  // whole reason the store boot-loads every page at once rather than fetching per navigation
  // (D-073). Home has no special case any more; it is an ordinary page.
  const canArrange = $derived.by(() => {
    const pageId = arrangeablePageId(page.url.pathname);
    if (pageId === undefined) return false;
    return pageWidgets.forPage(pageId).length > 0;
  });

  // Exit arrange mode whenever the page changes.
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    page.url.pathname;
    arrangeMode.exit();
  });

  onMount(() => {
    // One fetch for every page's membership (D-073), plus a one-time sweep of the per-device
    // layout keys D-053 wrote — nothing reads those any more.
    void pageWidgets.load();
    clearLegacyLayoutKeys();

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
      {#if showDevOpsNav}
        <MaintenanceHoldIndicator />
        <DispatchKillswitch />
        <DeployStatus />
      {/if}
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

<!-- Mounted once for the whole app: anything, including non-component modules like the
     page-membership store, can raise a toast (PD-334). -->
<Toast />

<style lang="scss" src="./+layout.scss"></style>
