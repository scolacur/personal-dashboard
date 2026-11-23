<script lang="ts">
  import type { EpicBurndown } from '@dashboard/shared';
  import VelocityChart from './VelocityChart.svelte';
  import { defaultEpicId, groupEpics, sliceRange, type VelocityRange } from './velocity-view';

  /**
   * Velocity › Epics (PD-897): one Epic's members over time — done stacked under still-open, so the
   * bar is the Epic's live scope and the done share is its progress. Members closed without
   * completing (split, superseded) drop out of scope and are counted in the summary instead.
   * Replayed over TODAY's membership: moves between Epics are not logged, so the chart cannot know
   * who belonged when, and it says so.
   */
  interface Props {
    epics: EpicBurndown[];
    range: VelocityRange;
  }
  let { epics, range }: Props = $props();

  let picked = $state<number | null>(null);
  // A pick from before the project filter changed may not be in the new list; fall back then.
  const selectedId = $derived(
    picked !== null && epics.some((e) => e.id === picked) ? picked : defaultEpicId(epics),
  );
  const epic = $derived(epics.find((e) => e.id === selectedId) ?? null);
  const groups = $derived(groupEpics(epics));
  const weeks = $derived(epic ? sliceRange(epic.weeks, range) : []);

  const series = $derived([
    { key: 'done', label: 'Done', tone: 'done' as const, values: weeks.map((w) => w.done) },
    { key: 'open', label: 'Open', tone: 'neutral' as const, values: weeks.map((w) => w.open) },
  ]);

  const name = (e: EpicBurndown) =>
    `${e.displayId ?? '—'} — ${e.title.replace(/^\[Epic\]\s*/, '')}`;
</script>

<h2 class="velocity-section">Epics</h2>
{#if epics.length === 0}
  <p class="velocity-empty">No Epics with members yet.</p>
{:else}
  <article class="card">
    <header class="card-head epic-head">
      <label class="epic-picker">
        <span class="sr-only">Epic</span>
        <select value={selectedId} onchange={(e) => (picked = Number(e.currentTarget.value))}>
          {#if groups.open.length}
            <optgroup label="Open">
              {#each groups.open as e (e.id)}<option value={e.id}>{name(e)}</option>{/each}
            </optgroup>
          {/if}
          {#if groups.finished.length}
            <optgroup label="Finished">
              {#each groups.finished as e (e.id)}<option value={e.id}>{name(e)}</option>{/each}
            </optgroup>
          {/if}
        </select>
      </label>
      {#if epic}
        <a class="epic-link" href="/devops/tickets/{epic.displayId}">Open Epic →</a>
      {/if}
    </header>
    {#if epic}
      <p class="epic-summary">
        <strong>{epic.now.done}</strong> of {epic.now.done + epic.now.open} done{epic.now.dropped
          ? ` · ${epic.now.dropped} closed without completing (out of scope)`
          : ''}.
      </p>
      <VelocityChart
        weeks={weeks.map((w) => w.weekStart)}
        {series}
        kind="stacked"
        label="{name(epic)}: members done and still open at the end of each week"
      />
      <p class="card-note">
        Uses the Epic's <em>current</em> members. Moves between Epics aren't recorded, so a ticket that
        joined later is drawn as if it always belonged.
      </p>
    {/if}
  </article>
{/if}

<style lang="scss" src="./EpicBurndownSection.scss"></style>
