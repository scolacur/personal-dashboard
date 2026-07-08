<script lang="ts">
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import { slide } from 'svelte/transition';
  import { ChevronRight } from 'lucide-svelte';
  import { pages } from '$lib/pages';
  import { SvelteSet } from 'svelte/reactivity';
  import YinYang from '$lib/icons/YinYang.svelte';

  // Called after a nav link is chosen — the layout uses it to close the
  // mobile drawer. No-op on desktop where the rail is always visible.
  let { onNavigate }: { onNavigate?: () => void } = $props();

  function isRouteActive(route: string, pathname: string): boolean {
    if (route === '/') return pathname === '/';
    return pathname === route || pathname.startsWith(route + '/');
  }

  // Accordion state: which parents have their sub-items revealed. Sections start collapsed
  // ("not normally visible") except the one you're currently inside.
  const open = new SvelteSet(
    browser
      ? pages.filter((p) => p.children && isRouteActive(p.route, $page.url.pathname)).map((p) => p.id)
      : [],
  );

  // The hash of the section currently selected on the parent page (Jobs/Tickets). Tracked
  // locally because we scroll via replaceState, which the page store doesn't observe.
  let selectedHash = $state(browser ? window.location.hash : '');
  $effect(() => {
    void $page.url.pathname; // re-run on route change
    selectedHash = browser ? window.location.hash : '';
  });

  function childActive(route: string): boolean {
    const i = route.indexOf('#');
    if (i === -1) return isRouteActive(route, $page.url.pathname);
    return $page.url.pathname === route.slice(0, i) && selectedHash === route.slice(i);
  }

  // Clicking a parent that has children navigates AND reveals its accordion (never collapses —
  // use the chevron to collapse).
  function onParentClick(id: string, hasChildren: boolean) {
    onNavigate?.();
    if (hasChildren) open.add(id);
  }

  function toggle(e: MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    if (open.has(id)) open.delete(id);
    else open.add(id);
  }

  // Hash children scroll to a section on the parent page; smooth-scroll when already there.
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
</script>

<nav class="side-nav" aria-label="Primary">
  <a href="/" class="side-brand" onclick={onNavigate}>
    <span class="side-brand-mark"><YinYang size={24} /></span>
    <span class="side-brand-text">Da Steve Zone</span>
  </a>
  <ul class="side-links">
    {#each pages as p (p.id)}
      <li>
        <div class="side-link-row">
          <a
            href={p.route}
            class="side-link"
            class:active={isRouteActive(p.route, $page.url.pathname)}
            aria-current={isRouteActive(p.route, $page.url.pathname) ? 'page' : undefined}
            onclick={() => onParentClick(p.id, !!p.children)}
          >
            <span class="side-link-label">{p.title}</span>
          </a>
          {#if p.children}
            <button
              class="side-caret"
              type="button"
              aria-label={open.has(p.id) ? `Collapse ${p.title}` : `Expand ${p.title}`}
              aria-expanded={open.has(p.id)}
              onclick={(e) => toggle(e, p.id)}
            >
              <span class="side-caret-icon" class:open={open.has(p.id)}><ChevronRight size={16} /></span>
            </button>
          {/if}
        </div>

        {#if p.children && open.has(p.id)}
          <ul class="side-sublinks" transition:slide={{ duration: 150 }}>
            {#each p.children as child (child.id)}
              <li>
                <a
                  href={child.route}
                  class="side-sublink"
                  class:active={childActive(child.route)}
                  aria-current={childActive(child.route) ? 'page' : undefined}
                  onclick={(e) => onChildClick(e, child.route)}
                >
                  {child.title}
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ul>
</nav>

<style lang="scss" src="./SideNav.scss"></style>
