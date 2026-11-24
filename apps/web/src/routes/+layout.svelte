<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { Sun, Moon } from 'lucide-svelte';
  import { page } from '$app/state';
  import SideNav from '$lib/SideNav.svelte';
  import NotificationBell from '$lib/NotificationBell.svelte';
  import AppTicketButton from '$lib/AppTicketButton.svelte';
  import PageTicketButton from '$lib/PageTicketButton.svelte';
  import FloatDock from '$lib/FloatDock.svelte';
  import YinYang from '$lib/icons/YinYang.svelte';
  import { arrangeablePageId, isDevOpsRoute, resolvePageTitle } from '$lib/nav-utils';
  import DeployStatus from './DeployStatus.svelte';
  import DispatchKillswitch from './DispatchKillswitch.svelte';
  import { pageWidgets } from '$lib/page-widgets.svelte';
  import { widgets } from '$lib/widgets';
  import { clearLegacyLayoutKeys } from '$lib/layout';
  import Toast from '$lib/Toast.svelte';
  import { arrangeMode } from '$lib/arrange.svelte';
  import { homeView, recordWidgetUse } from '$lib/widget-usage.svelte';
  import { widgetIdForPath } from '$lib/recent-widgets';
  import FloatingPomodoro from './widgets/pomodoro/FloatingPomodoro.svelte';

  let { children }: { children: Snippet } = $props();

  // True only under `vite dev`; false in the production build the NAS serves.
  // Makes local dev visually unmistakable so it's never confused with prod.
  const isDev = import.meta.env.DEV;

  let theme = $state<'light' | 'dark'>('dark');
  // Mobile-only: the side nav slides in as a drawer. Always false on desktop
  // where the rail is permanently visible (the toggle button is hidden there).
  let drawerOpen = $state(false);

  // Widget routes as plain {route, title}, so nav-utils stays free of `.svelte` imports (PD-717).
  const widgetRoutes = widgets.map((w) => ({ route: w.route, title: w.title }));
  const currentPageTitle = $derived(resolvePageTitle(page.url.pathname, widgetRoutes));

  // The ticket-detail page mounts its own FloatDock — "Change something" beside its Refine chat —
  // so the app-wide one (which also carries the Pomodoro) stands down there. The Pomodoro was
  // already hidden on that page: it overlapped the Refine chat. Match on route id, not pathname.
  const showFloatDock = $derived(page.route.id !== '/devops/tickets/[ticketId]');

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
  // (D-073). Home's one special case is below.
  const canArrange = $derived.by(() => {
    const pageId = arrangeablePageId(page.url.pathname);
    if (pageId === undefined) return false;
    // Home is the one exception (PD-751, Home shows recently used widgets): it shows recently
    // used widgets when there is usage, and that view is derived, not arranged. Arrange applies
    // only when Home has fallen back to its curated grid.
    if (pageId === 'home' && homeView.current !== 'curated') return false;
    return pageWidgets.forPage(pageId).length > 0;
  });

  // Visiting a widget's own page counts as using it (PD-751, Home shows recently used widgets).
  // Throttled per widget inside `recordWidgetUse`, so moving around within one widget's
  // sub-pages doesn't send a request per navigation.
  const widgetIdRoutes = widgets.map((w) => ({ id: w.id, route: w.route }));
  $effect(() => {
    const pathname = page.url.pathname;
    const id = widgetIdForPath(pathname, widgetIdRoutes);
    if (id) recordWidgetUse(id, pathname);
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
        <DispatchKillswitch />
        <DeployStatus />
      {/if}
      <AppTicketButton />
      <NotificationBell />
      {#if canArrange}
        <button
          class="arrange-btn"
          class:active={arrangeMode.active}
          onclick={arrangeMode.toggle}
          aria-label={arrangeMode.active ? 'Exit arrange mode' : 'Arrange widgets'}>Arrange</button
        >
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

<!-- Page-scoped suggestions (PD-578 front door) float bottom-right on every page, beside the
     Pomodoro. `.content` carries bottom padding so the dock never hides the end of a page. -->
{#if showFloatDock}
  <FloatDock>
    <PageTicketButton />
    <FloatingPomodoro />
  </FloatDock>
{/if}

<!-- Mounted once for the whole app: anything, including non-component modules like the
     page-membership store, can raise a toast (PD-334). -->
<Toast />

<style lang="scss" src="./+layout.scss"></style>
