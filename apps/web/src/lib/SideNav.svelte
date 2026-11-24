<script lang="ts">
  import { page } from '$app/state';
  import { fly } from 'svelte/transition';
  import { Check, ChevronLeft, ChevronRight, GripVertical, LayoutGrid, Lock, Pencil } from 'lucide-svelte';
  import { flattenNavTree, navChildren, type NavRow } from '@dashboard/shared';
  import { pages } from '$lib/pages';
  import { LIBRARY_ROUTE, LIBRARY_TITLE } from '$lib/nav-utils';
  import { navPages } from '$lib/nav-pages.svelte';
  import { computeDrop, dropAtEnd, isNoopDrop, type NavDrop } from '$lib/nav-drop';
  import YinYang from '$lib/icons/YinYang.svelte';
  import { decisionsCount, refreshDecisionsCount } from '$lib/decisions-store';

  // Called after a nav link is chosen — the layout uses it to close the
  // mobile drawer. No-op on desktop where the rail is always visible.
  let { onNavigate }: { onNavigate?: () => void } = $props();

  // PD-746: the Decisions badge. Polled here because the nav is the one thing mounted on every
  // page; the Decisions page refreshes the same store when it sends an answer.
  $effect(() => {
    void refreshDecisionsCount();
    const timer = setInterval(refreshDecisionsCount, 30_000);
    return () => clearInterval(timer);
  });
  const badgeCount = (badge: 'decisions' | undefined): number => (badge === 'decisions' ? $decisionsCount : 0);

  // ── The pages ─────────────────────────────────────────────────────────────────
  // PD-969 (pages become data): Home and Dev Ops are pinned and code-defined (`pages.ts`); every
  // page between them is a user-managed row from the nav-pages store, in stored order.
  const HOME = pages.find((p) => p.id === 'home')!;
  const DEVOPS = pages.find((p) => p.id === 'devops')!;
  const DEVOPS_LEVEL = 'devops';

  /** One rendered nav row, whatever its source. */
  interface NavItem {
    id: string;
    title: string;
    route: string;
    badge: number;
    hasChildren: boolean;
  }

  const routeById = $derived(new Map(navPages.routes.map((r) => [r.id, r.route])));

  function customItem(id: string): NavItem {
    const p = navPages.byId(id)!;
    return {
      id,
      title: p.title,
      route: routeById.get(id) ?? '/',
      badge: 0,
      hasChildren: navChildren(navPages.list, id).length > 0,
    };
  }

  const devopsBadge = $derived((DEVOPS.children ?? []).reduce((n, c) => n + badgeCount(c.badge), 0));

  /** The rows shown at a level: `null` is the root, otherwise a page id with children. */
  function itemsAt(level: string | null): NavItem[] {
    if (level === DEVOPS_LEVEL) {
      return (DEVOPS.children ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        route: c.route,
        badge: badgeCount(c.badge),
        hasChildren: false,
      }));
    }
    const custom = navChildren(navPages.list, level).map((p) => customItem(p.id));
    if (level !== null) return custom;
    return [
      { id: HOME.id, title: HOME.title, route: HOME.route, badge: 0, hasChildren: false },
      ...custom,
      { id: DEVOPS.id, title: DEVOPS.title, route: DEVOPS.route, badge: devopsBadge, hasChildren: true },
    ];
  }

  function isRouteActive(route: string, pathname: string): boolean {
    if (route === '/') return pathname === '/';
    return pathname === route || pathname.startsWith(route + '/');
  }

  // ── Which level is showing ────────────────────────────────────────────────────
  // A pure function of the route (PD-415), generalised to any depth by PD-969: on a page with
  // children the nav shows those children; on a leaf it shows the leaf's own siblings. Deep links
  // land on the right level with no click involved.
  const activeCustomId = $derived.by(() => {
    const path = page.url.pathname;
    const match = navPages.routes
      .filter((r) => isRouteActive(r.route, path))
      .sort((a, b) => b.route.length - a.route.length)[0];
    return match?.id;
  });

  const routeLevel = $derived.by((): string | null => {
    if (isRouteActive(DEVOPS.route, page.url.pathname)) return DEVOPS_LEVEL;
    if (activeCustomId === undefined) return null;
    if (navChildren(navPages.list, activeCustomId).length > 0) return activeCustomId;
    return navPages.byId(activeCustomId)?.parentId ?? null;
  });

  // Back is the single transient override: it climbs one level *without* navigating, and lasts
  // only until the route changes.
  let override = $state<{ level: string | null } | undefined>(undefined);
  const level = $derived(override ? override.level : routeLevel);

  $effect(() => {
    void page.url.pathname; // re-run on navigation
    override = undefined;
  });

  const levelDepth = (l: string | null): number =>
    l === null ? 0 : l === DEVOPS_LEVEL ? 1 : 1 + depthOf(l);
  function depthOf(id: string): number {
    let d = 0;
    let cur = navPages.byId(id)?.parentId ?? null;
    while (cur !== null && d < 64) {
      d += 1;
      cur = navPages.byId(cur)?.parentId ?? null;
    }
    return d;
  }

  /** Header of a drilled-in level: its own title/route, and where Back goes. */
  const header = $derived.by(() => {
    if (level === null) return undefined;
    if (level === DEVOPS_LEVEL) return { title: DEVOPS.title, route: DEVOPS.route, backTo: null };
    const p = navPages.byId(level);
    if (!p) return undefined;
    return { title: p.title, route: routeById.get(level) ?? '/', backTo: p.parentId };
  });

  // Panels slide right-to-left going deeper, left-to-right coming back.
  const SLIDE_X = 220;
  const SLIDE_MS = 180;
  let slideDir = $state(1);
  let prevDepth = 0;
  $effect.pre(() => {
    const d = levelDepth(level);
    slideDir = d >= prevDepth ? 1 : -1;
    prevDepth = d;
  });

  function onItemClick(item: NavItem) {
    // Clear the Back override even when the href doesn't change the route — otherwise choosing
    // a parent while already on it (i.e. right after Back) would leave its panel closed.
    if (item.hasChildren) override = undefined;
    onNavigate?.();
  }

  // ── Edit mode (PD-969): reorder and nest with Spotify-style drop lines ─────────
  let editing = $state(false);
  const rows = $derived<NavRow[]>(flattenNavTree(navPages.list));

  let dragId = $state<string | null>(null);
  let drop = $state<NavDrop | null>(null);
  // The dragged page plus everything that travels with it (rows are depth-first, so one pass works).
  const draggingSubtree = $derived.by((): string[] => {
    if (dragId === null) return [];
    const ids: string[] = [dragId];
    for (const r of rows) if (r.page.parentId !== null && ids.includes(r.page.parentId)) ids.push(r.page.id);
    return ids;
  });

  function startDrag(e: PointerEvent, id: string) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragId = id;
    drop = null;
  }

  function moveDrag(e: PointerEvent) {
    if (dragId === null) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-drop-row]');
    if (!el) return; // keep the last line while crossing gaps between rows
    const which = el.dataset.dropRow;
    if (which === 'end') {
      drop = dropAtEnd(rows, dragId);
      return;
    }
    if (which === 'start') {
      drop = { parentId: null, index: 0, rowIndex: 0, edge: 'before', depth: 0 };
      return;
    }
    const rect = el.getBoundingClientRect();
    drop = computeDrop(rows, Number(which), (e.clientY - rect.top) / rect.height, dragId);
  }

  function endDrag() {
    if (dragId !== null && drop !== null && !isNoopDrop(rows, dragId, drop)) {
      void navPages.move(dragId, drop.parentId, drop.index);
    }
    dragId = null;
    drop = null;
  }

  function cancelDrag() {
    dragId = null;
    drop = null;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && dragId !== null) cancelDrag();
  }

  const INDENT_PX = 20;
</script>

<svelte:window onkeydown={onKeydown} />

<nav class="side-nav" aria-label="Primary">
  <a href="/" class="side-brand" onclick={onNavigate}>
    <span class="side-brand-mark"><YinYang size={24} /></span>
    <span class="side-brand-text">Da Steve Zone</span>
  </a>

  <!-- Panels are absolutely positioned so they overlay while sliding rather than stacking; the
       container clips whichever is on its way out. -->
  <div class="side-panels">
    {#if editing}
      <div class="side-panel side-edit" aria-label="Reorder pages">
        <ul class="side-links" class:dragging={dragId !== null}>
          <!-- Pinned: never moves. Its row is a drop zone meaning "first in the list". -->
          <li class="side-edit-row pinned" data-drop-row="start">
            <span class="side-edit-pin" aria-hidden="true"><Lock size={14} /></span>
            <span class="side-link-label">{HOME.title}</span>
          </li>

          {#each rows as row, i (row.page.id)}
            {@const showBefore = drop?.rowIndex === i && drop.edge === 'before'}
            {@const showAfter = drop?.rowIndex === i && drop.edge === 'after'}
            <li
              class="side-edit-row"
              class:lifted={draggingSubtree.includes(row.page.id)}
              data-drop-row={i}
              style:padding-left="calc(var(--space-sm) + {row.depth * INDENT_PX}px)"
            >
              {#if showBefore}
                <span class="drop-line before" style:left="{drop!.depth * INDENT_PX}px"></span>
              {/if}
              <span
                class="side-edit-grip"
                role="button"
                tabindex="-1"
                aria-label="Drag {row.page.title}"
                onpointerdown={(e) => startDrag(e, row.page.id)}
                onpointermove={moveDrag}
                onpointerup={endDrag}
                onpointercancel={cancelDrag}
              >
                <GripVertical size={14} />
              </span>
              <span class="side-link-label">{row.page.title}</span>
              {#if showAfter}
                <span class="drop-line after" style:left="{drop!.depth * INDENT_PX}px"></span>
              {/if}
            </li>
          {/each}

          <li class="side-edit-row pinned" data-drop-row="end">
            {#if drop?.rowIndex === rows.length}
              <span class="drop-line before" style:left="0px"></span>
            {/if}
            <span class="side-edit-pin" aria-hidden="true"><Lock size={14} /></span>
            <span class="side-link-label">{DEVOPS.title}</span>
          </li>
        </ul>
        <p class="side-edit-hint">
          Drag to reorder. Drop just below a page to nest it inside; a little lower to place it after.
        </p>
      </div>
    {:else}
      {#key level}
        <div
          class="side-panel"
          in:fly={{ x: slideDir * SLIDE_X, duration: SLIDE_MS }}
          out:fly={{ x: -slideDir * SLIDE_X, duration: SLIDE_MS }}
        >
          {#if header}
            {@const parentActive = page.url.pathname === header.route}
            <div class="side-back-row" class:active={parentActive}>
              <button
                class="side-back"
                type="button"
                onclick={() => (override = { level: header.backTo })}
                aria-label="Back"
              >
                <ChevronLeft size={16} />
              </button>
              <a
                href={header.route}
                class="side-back-title"
                aria-current={parentActive ? 'page' : undefined}
                onclick={onNavigate}
              >
                {header.title}
              </a>
            </div>
          {/if}

          <ul class="side-links">
            {#each itemsAt(level) as item (item.id)}
              {@const active = isRouteActive(item.route, page.url.pathname)}
              <li>
                <a
                  href={item.route}
                  class="side-link"
                  class:active
                  aria-current={active ? 'page' : undefined}
                  onclick={() => onItemClick(item)}
                >
                  <span class="side-link-label">{item.title}</span>
                  {#if item.badge > 0}
                    <span class="side-link-badge" aria-label="{item.badge} waiting on you">{item.badge}</span>
                  {/if}
                  {#if item.hasChildren}
                    <!-- Inside the link, so the active highlight spans it (PR #273). -->
                    <span class="side-link-caret" aria-hidden="true"><ChevronRight size={16} /></span>
                  {/if}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/key}
    {/if}
  </div>

  <!-- Bottom bar (PD-334). Pinned below the sliding panels, so it stays put whichever nav level
       is showing. PD-969 adds **Edit** beside All Widgets; PD-970 will add **New Page**. -->
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
    <button
      type="button"
      class="side-bottom-btn side-edit-toggle"
      class:active={editing}
      aria-pressed={editing}
      onclick={() => {
        editing = !editing;
        cancelDrag();
      }}
    >
      {#if editing}
        <Check size={16} aria-hidden="true" /><span>Done</span>
      {:else}
        <Pencil size={16} aria-hidden="true" /><span>Edit</span>
      {/if}
    </button>
  </div>
</nav>

<style lang="scss" src="./SideNav.scss"></style>
