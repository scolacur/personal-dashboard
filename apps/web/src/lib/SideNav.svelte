<script lang="ts">
  import { page } from '$app/stores';
  import { pages } from '$lib/pages';
  import YinYang from '$lib/icons/YinYang.svelte';

  // Called after a nav link is chosen — the layout uses it to close the
  // mobile drawer. No-op on desktop where the rail is always visible.
  let { onNavigate }: { onNavigate?: () => void } = $props();

  function isActive(route: string, pathname: string): boolean {
    if (route === '/') return pathname === '/';
    return pathname === route || pathname.startsWith(route + '/');
  }
</script>

<nav class="side-nav" aria-label="Primary">
  <a href="/" class="side-brand" onclick={onNavigate}>
    <span class="side-brand-mark"><YinYang size={24} /></span>
    <span class="side-brand-text">Dashboard</span>
  </a>
  <ul class="side-links">
    {#each pages as p (p.id)}
      <li>
        <a
          href={p.route}
          class="side-link"
          class:active={isActive(p.route, $page.url.pathname)}
          aria-current={isActive(p.route, $page.url.pathname) ? 'page' : undefined}
          onclick={onNavigate}
        >
          {p.title}
        </a>
      </li>
    {/each}
  </ul>
</nav>

<style lang="scss" src="./SideNav.scss"></style>
