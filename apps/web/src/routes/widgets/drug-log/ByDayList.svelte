<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    addHabitDays,
    contrastText,
    type DrugLogDrug,
    type DrugLogEvent,
    type HabitSettings,
  } from '@dashboard/shared';
  import EventList from './EventList.svelte';
  import EventEditModal from './EventEditModal.svelte';
  import { fetchEvents } from './api';
  import { dayLabel, fetchSinceForDay, groupByDay, mergeEvents, sortDrugs } from './drug-log';
  import { defaultAddTime } from './time';

  /**
   * Log › By Day (PD-975, Drug log widget): habit days newest first, each with per-drug count chips;
   * a day expands to its events (edit / delete), and "+" adds an entry to that day by hand.
   * "Load older" widens the window a fortnight at a time.
   */
  interface Props {
    drugs: DrugLogDrug[];
    settings: HabitSettings;
    today: string;
    /** Something changed server-side (so the parent can refresh today's counts). */
    onChanged: () => void;
  }

  let { drugs, settings, today, onChanged }: Props = $props();

  const PAGE_DAYS = 14;
  let dayCount = $state(PAGE_DAYS);
  let events = $state<DrugLogEvent[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  const expanded = new SvelteSet<string>();

  const fromDay = $derived(addHabitDays(today, -(dayCount - 1)));
  const drugsById = $derived(new Map(drugs.map((d) => [d.id, d])));
  const order = $derived(sortDrugs(drugs).map((d) => d.id));
  const groups = $derived(groupByDay(events, order, fromDay, today, settings));

  async function load(): Promise<void> {
    loading = true;
    failed = false;
    try {
      events = await fetchEvents({ since: fetchSinceForDay(fromDay), limit: 10_000 });
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  function loadOlder(): void {
    dayCount += PAGE_DAYS;
    void load();
  }

  function toggle(day: string): void {
    if (expanded.has(day)) expanded.delete(day);
    else expanded.add(day);
  }

  // ── Edit / add modal ──
  let modalOpen = $state(false);
  let editing = $state<DrugLogEvent | null>(null);
  let addAt = $state(Date.now());

  function edit(e: DrugLogEvent): void {
    editing = e;
    modalOpen = true;
  }

  function add(day: string): void {
    editing = null;
    addAt = defaultAddTime(day, today, Date.now());
    modalOpen = true;
  }

  function saved(e: DrugLogEvent): void {
    events = mergeEvents(events, [e]);
    modalOpen = false;
    onChanged();
  }

  function deleted(id: number): void {
    events = events.filter((e) => e.id !== id);
    modalOpen = false;
    onChanged();
  }
</script>

<div class="by-day">
  {#if loading && events.length === 0}
    <p class="note">Loading…</p>
  {:else if failed}
    <p class="note">
      Couldn't load the log. <button type="button" class="link" onclick={load}>Retry</button>
    </p>
  {/if}

  <ol class="days">
    {#each groups as g (g.day)}
      {@const open = expanded.has(g.day)}
      <li class="day" class:empty={g.total === 0}>
        <div class="day-head">
          <button
            type="button"
            class="day-toggle"
            aria-expanded={open}
            onclick={() => toggle(g.day)}
          >
            <span class="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
            <span class="day-name">{dayLabel(g.day, today)}</span>
            <span class="chips">
              {#each g.counts as c (c.drugId)}
                {@const d = drugsById.get(c.drugId)}
                <span
                  class="chip"
                  style:background={d?.color}
                  style:color={d ? contrastText(d.color) : null}
                >
                  {d?.label ?? '?'} ×{c.count}
                </span>
              {:else}
                <span class="nothing">—</span>
              {/each}
            </span>
          </button>
          {#if drugs.length > 0}
            <button
              type="button"
              class="add"
              aria-label={`Add an entry to ${dayLabel(g.day, today)}`}
              onclick={() => add(g.day)}
            >
              +
            </button>
          {/if}
        </div>
        {#if open}
          <div class="day-body">
            <EventList events={g.events} {drugsById} onEdit={edit} />
          </div>
        {/if}
      </li>
    {/each}
  </ol>

  <button type="button" class="more" disabled={loading} onclick={loadOlder}>
    {loading ? 'Loading…' : 'Load older days'}
  </button>

  <EventEditModal
    open={modalOpen}
    event={editing}
    {addAt}
    {drugs}
    onClose={() => (modalOpen = false)}
    onSaved={saved}
    onDeleted={deleted}
  />
</div>

<style lang="scss" src="./ByDayList.scss"></style>
