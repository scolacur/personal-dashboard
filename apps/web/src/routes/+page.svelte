<script lang="ts">
  /**
   * Home shows the widgets you most recently used (PD-751, Home shows recently used widgets).
   *
   * Newest first, capped at `RECENT_WIDGETS_CAP`, only widgets still in the registry. With no
   * usage yet — a fresh install — or if usage cannot be loaded, Home falls back to its curated
   * grid (D-073), so it is never empty for want of history. Interacting with a card *here* is
   * never recorded as a use (see `recent-widgets.ts`): otherwise Home would reinforce itself.
   *
   * The top nav reads `homeView` to hide Arrange while the recent view is showing; only the
   * curated grid has a stored arrangement to edit.
   */
  import { onMount } from 'svelte';
  import WidgetGrid from '$lib/WidgetGrid.svelte';
  import { widgets as registry, type WidgetMeta } from '$lib/widgets';
  import { recentWidgetIds } from '$lib/recent-widgets';
  import { fetchWidgetUsage, homeView } from '$lib/widget-usage.svelte';
  import RecentWidgets from './RecentWidgets.svelte';

  let recent = $state<WidgetMeta[] | null>(null);

  onMount(() => {
    let cancelled = false;
    homeView.set('pending');
    fetchWidgetUsage()
      .then((usage) => {
        if (cancelled) return;
        const byId = new Map(registry.map((w) => [w.id, w]));
        recent = recentWidgetIds(usage, byId.keys()).flatMap((id) => byId.get(id) ?? []);
      })
      .catch(() => {
        if (!cancelled) recent = [];
      })
      .finally(() => {
        if (!cancelled) homeView.set(recent && recent.length > 0 ? 'recent' : 'curated');
      });
    return () => {
      cancelled = true;
      homeView.set('pending');
    };
  });
</script>

{#if recent === null}
  <!-- Usage is one small request; render nothing for that instant rather than flashing the
       curated grid and then swapping it out. -->
{:else if recent.length > 0}
  <RecentWidgets widgets={recent} />
{:else}
  <WidgetGrid pageId="home" />
{/if}

<style lang="scss" src="./+page.scss"></style>
