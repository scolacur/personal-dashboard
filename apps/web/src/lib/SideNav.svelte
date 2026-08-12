<script lang="ts">
  import { page } from '$app/state';
  import { fly } from 'svelte/transition';
  import { ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-svelte';
  import { pages } from '$lib/pages';
  import { LIBRARY_ROUTE, LIBRARY_TITLE } from '$lib/nav-utils';
  import YinYang from '$lib/icons/YinYang.svelte';

  // Called after a nav link is chosen — the layout uses it to close the
  // mobile drawer. No-op on desktop where the rail is always visible.
  let { onNavigate }: { onNavigate?: () => void } = $props();

  // Panel travel matches the rail width, so a panel slides fully out of view.
  const SLIDE_X = 220;
  const SLIDE_MS = 180;

  function isRouteActive(route: string, pathname: string): boolean {
    if (route === '/') return pathname === '/';
    return pathname === route || pathname.startsWith(route + '/');
  }

  // Which level the nav shows is a pure function of the route (PD-415): a page with children
  // is "drilled into" whenever the current route is that page or one of its subroutes. That
  // makes deep-linking work for free — loading /devops/jobs opens level 2 with Jobs
  // highlighted, no click involved, and the two ways of reaching a route can't disagree.
  //
  // `showRoot` is the single transient override: Back returns to level 1 *without* navigating,
  // and it lasts only until the route changes.
  let showRoot = $state(false);

  const drilled = $derived(
    showRoot
      ? undefined
      : pages.find((p) => p.children?.length && isRouteActive(p.route, page.url.pathname)),
  );

  $effect(() => {
    void page.url.pathname; // re-run on navigation
    showRoot = false;
  });

  function onParentClick(hasChildren: boolean) {
    // Clear the Back override even when the href doesn't change the route — otherwise
    // choosing Dev Ops while already on /devops (i.e. right after Back) would leave the
    // panel closed, since no navigation occurs to reset it.
    if (hasChildren) showRoot = false;
    onNavigate?.();
  }
</script>

<nav class="side-nav" aria-label="Primary">
  <a href="/" class="side-brand" onclick={onNavigate}>
    <span class="side-brand-mark"><YinYang size={24} /></span>
    <span class="side-brand-text">Da Steve Zone</span>
  </a>

  <!-- Both panels are absolutely positioned so they overlay while sliding rather than
       stacking; the container clips whichever is on its way out. -->
  <div class="side-panels">
    {#if drilled === undefined}
      <div
        class="side-panel"
        in:fly={{ x: -SLIDE_X, duration: SLIDE_MS }}
        out:fly={{ x: -SLIDE_X, duration: SLIDE_MS }}
      >
        <ul class="side-links">
          {#each pages as p (p.id)}
            {@const active = isRouteActive(p.route, page.url.pathname)}
            <li>
              <a
                href={p.route}
                class="side-link"
                class:active
                aria-current={active ? 'page' : undefined}
                onclick={() => onParentClick(!!p.children?.length)}
              >
                <span class="side-link-label">{p.title}</span>
                {#if p.children?.length}
                  <!-- Inside the link, so the active highlight spans it (PR #273). -->
                  <span class="side-link-caret" aria-hidden="true"><ChevronRight size={16} /></span>
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      {@const parentActive = page.url.pathname === drilled.route}
      <div
        class="side-panel"
        in:fly={{ x: SLIDE_X, duration: SLIDE_MS }}
        out:fly={{ x: SLIDE_X, duration: SLIDE_MS }}
      >
        <div class="side-back-row" class:active={parentActive}>
          <button
            class="side-back"
            type="button"
            onclick={() => (showRoot = true)}
            aria-label="Back to all sections"
          >
            <ChevronLeft size={16} />
          </button>
          <a
            href={drilled.route}
            class="side-back-title"
            aria-current={parentActive ? 'page' : undefined}
            onclick={onNavigate}
          >
            {drilled.title}
          </a>
        </div>

        <ul class="side-links">
          {#each drilled.children ?? [] as child (child.id)}
            {@const active = isRouteActive(child.route, page.url.pathname)}
            <li>
              <a
                href={child.route}
                class="side-link"
                class:active
                aria-current={active ? 'page' : undefined}
                onclick={onNavigate}
              >
                <span class="side-link-label">{child.title}</span>
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>

  <!-- Bottom bar (PD-334). Pinned below the sliding panels, so it stays put whichever nav level
       is showing. PD-497 adds **New Page** and **Edit** either side of this button; it is built
       as a row of one rather than a lone button so that addition is a sibling, not a rewrite. -->
  <div class="side-bottom">
    <a
      href={LIBRARY_ROUTE}
      class="side-bottom-btn"
      class:active={page.url.pathname === LIBRARY_ROUTE}
      aria-current={page.url.pathname === LIBRARY_ROUTE ? 'page' : undefined}
      onclick={onNavigate}
    >
      <LayoutGrid size={16} aria-hidden="true" />
      <span>{LIBRARY_TITLE}</span>
    </a>
  </div>
</nav>

<style lang="scss" src="./SideNav.scss"></style>
