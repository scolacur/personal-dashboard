<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { resolveNavPath } from '@dashboard/shared';
  import { navPages } from '$lib/nav-pages.svelte';

  // Pre-PD-969 page URLs (`/productivity`, `/inboxes`, …). Those pages are data now and live
  // under `/p/…`; their seeded slugs equal the old segments, so the old URL resolves by slug and
  // redirects. Static routes (`/devops`, `/library`, `/widgets`, …) outrank this param route, so
  // it only ever sees paths nothing else claimed.
  const resolved = $derived(
    navPages.loaded ? resolveNavPath(navPages.list, [page.params.legacy ?? '']) : undefined,
  );

  $effect(() => {
    if (resolved) void goto(resolved.path, { replaceState: true });
  });
</script>

{#if resolved === null}
  <p class="nav-page-missing">Page not found.</p>
{/if}

<style lang="scss" src="./+page.scss"></style>
