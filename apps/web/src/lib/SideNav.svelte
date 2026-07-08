<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import { pages } from '$lib/pages';
  import type { NavChild } from '$lib/pages';
  import YinYang from '$lib/icons/YinYang.svelte';
  import { openFindingCount, refreshOpenFindingCount } from '$lib/audit-store';

  // Called after a nav link is chosen — the layout uses it to close the
  // mobile drawer. No-op on desktop where the rail is always visible.
  let { onNavigate }: { onNavigate?: () => void } = $props();

  // The hash of the section currently "selected" on the parent page (Jobs/Tickets). Tracked
  // locally because we scroll via replaceState rather than a full navigation, which the page
  // store doesn't observe. Re-synced from the URL whenever the route path changes.
  let selectedHash = $state(browser ? window.location.hash : '');
  $effect(() => {
    void $page.url.pathname; // re-run on route change
    selectedHash = browser ? window.location.hash : '';
  });

  function isRouteActive(route: string, pathname: string): boolean {
    if (route === '/') return pathname === '/';
    return pathname === route || pathname.startsWith(route + '/');
  }

  // Active when: a plain route matches the path, OR a hash link's base matches the path and
  // its hash is the selected one (so Jobs/Tickets highlight when chosen, not just Ticket Audit).
  function childActive(route: string): boolean {
    const i = route.indexOf('#');
    if (i === -1) return isRouteActive(route, $page.url.pathname);
    return $page.url.pathname === route.slice(0, i) && selectedHash === route.slice(i);
  }

  const liveCounts = $derived<Record<string, number>>({ 'ticket-audit': $openFindingCount });
  function badgeFor(child: NavChild): number {
    return (child.badge ? liveCounts[child.id] : undefined) ?? child.count ?? 0;
  }

  // Hash children scroll to a section on the parent page. When already on that page, scroll
  // smoothly and record the selection; otherwise let SvelteKit navigate to `/base#hash`.
  function onChildClick(e: MouseEvent, route: string) {
    onNavigate?.();
    const hashIdx = route.indexOf('#');
    if (hashIdx === -1) return;
    const base = route.slice(0, hashIdx);
    const id = route.slice(hashIdx + 1);
    if ($page.url.pathname === base) {
      const el = document.getElementById(id);
      if (el) {
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(history.state, '', route);
        selectedHash = '#' + id;
      }
    }
  }

  onMount(() => {
    refreshOpenFindingCount();
    const onFocus = () => refreshOpenFindingCount();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(refreshOpenFindingCount, 60000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  });
</script>

{#snippet childItem(child: NavChild)}
  <li>
    {#if child.children}
      <span class="side-subgroup">{child.title}</span>
      <ul class="side-sublinks nested">
        {#each child.children as gc (gc.id)}
          {@render childItem(gc)}
        {/each}
      </ul>
    {:else if child.route}
      {@const badge = badgeFor(child)}
      <a
        href={child.route}
        class="side-sublink"
        class:active={childActive(child.route)}
        aria-current={childActive(child.route) ? 'page' : undefined}
        onclick={(e) => onChildClick(e, child.route!)}
      >
        <span class="side-link-label">{child.title}</span>
        {#if badge > 0}
          <span class="side-link-badge" aria-label="{badge} open">{badge > 99 ? '99+' : badge}</span>
        {/if}
      </a>
    {/if}
  </li>
{/snippet}

<nav class="side-nav" aria-label="Primary">
  <a href="/" class="side-brand" onclick={onNavigate}>
    <span class="side-brand-mark"><YinYang size={24} /></span>
    <span class="side-brand-text">Da Steve Zone</span>
  </a>
  <ul class="side-links">
    {#each pages as p (p.id)}
      <li>
        <a
          href={p.route}
          class="side-link"
          class:active={isRouteActive(p.route, $page.url.pathname)}
          aria-current={isRouteActive(p.route, $page.url.pathname) ? 'page' : undefined}
          onclick={onNavigate}
        >
          <span class="side-link-label">{p.title}</span>
        </a>

        {#if p.children}
          <ul class="side-sublinks">
            {#each p.children as child (child.id)}
              {@render childItem(child)}
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ul>
</nav>

<style lang="scss" src="./SideNav.scss"></style>
