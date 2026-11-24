<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { resolveNavPath } from '@dashboard/shared';
  import WidgetGrid from '$lib/WidgetGrid.svelte';
  import { navPages } from '$lib/nav-pages.svelte';

  // Every user-managed page renders here (PD-969 — pages become data). The slug path is resolved
  // by its last segment, so a page that has since been moved or nested still opens from its old
  // URL; it is then redirected to its current path.
  const resolved = $derived(
    navPages.loaded
      ? resolveNavPath(navPages.list, (page.params.path ?? '').split('/'))
      : undefined,
  );

  $effect(() => {
    if (resolved && !resolved.canonical) void goto(resolved.path, { replaceState: true });
  });
</script>

{#if resolved}
  {#key resolved.page.id}
    <WidgetGrid pageId={resolved.page.id} />
  {/key}
{:else if resolved === null}
  <p class="nav-page-missing">This page doesn't exist. It may have been deleted.</p>
{/if}

<style lang="scss" src="./+page.scss"></style>
