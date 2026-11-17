<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    DEFAULT_DAY_BOUNDARY_MINUTES,
    DEFAULT_HABIT_TIMEZONE,
    habitDay,
    type HabitItemView,
    type HabitSchedule,
    type HabitSettings,
    type HabitTodayRow,
    type SetHabitScheduleInput,
  } from '@dashboard/shared';
  import { toast } from '$lib/toast-store.svelte';
  import Tabs from '$lib/Tabs.svelte';
  import TodayList from '../routes/widgets/habit-tracker/TodayList.svelte';
  import HabitsManager from '../routes/widgets/habit-tracker/HabitsManager.svelte';
  import {
    createItem,
    deleteItem,
    fetchItems,
    fetchSchedules,
    fetchSettings,
    fetchToday,
    patchSettings,
    renameItem,
    reorderItems,
    setArchived,
    setCompletion,
    setSchedule,
  } from '../routes/widgets/habit-tracker/api';

  /**
   * Habit Tracker (PD-721, the tracer slice). `widget` is the dashboard card — the Today checklist,
   * tap to tick, no editing. `page` is the full screen with Today · Log · Habits.
   *
   * All data (settings, items, today's completions) is owned here so the Habits tab and the Today
   * tab stay in sync within one page instance. "Today" is computed with the shared `habitDay`
   * (D-092), so the card, the page and the server agree on the current habit day.
   */
  interface Props {
    variant: 'widget' | 'page';
  }

  let { variant }: Props = $props();
  const compact = $derived(variant === 'widget');

  let settings = $state<HabitSettings>({
    dayBoundaryMinutes: DEFAULT_DAY_BOUNDARY_MINUTES,
    timezone: DEFAULT_HABIT_TIMEZONE,
  });
  let items = $state<HabitItemView[]>([]);
  let schedules = $state<HabitSchedule[]>([]);
  // The Today view (due state, per-week progress, streaks) is computed server-side (D-095).
  let todayRows = $state<HabitTodayRow[]>([]);
  // SvelteSet so in-place add/delete are reactive (optimistic ticking mutates it directly).
  const completedToday = new SvelteSet<number>();
  let loaded = $state(false);

  // Recomputes if the day boundary / timezone change on the Habits tab; otherwise stable. The server
  // Today view carries its own `day`; this is the fallback the optimistic tick writes against.
  const today = $derived(habitDay(Date.now(), settings));

  function seedCompleted(rows: HabitTodayRow[]) {
    completedToday.clear();
    for (const r of rows) if (r.completedToday) completedToday.add(r.item.id);
  }

  async function refreshToday() {
    const view = await fetchToday();
    todayRows = view.rows;
    seedCompleted(view.rows);
  }

  async function load() {
    try {
      settings = await fetchSettings();
      const [its, scheds] = await Promise.all([fetchItems(true), fetchSchedules()]);
      items = its;
      schedules = scheds;
      await refreshToday();
    } catch {
      toast.show('Could not load habits.', 'error');
    } finally {
      loaded = true;
    }
  }

  async function toggle(item: HabitItemView) {
    const done = !completedToday.has(item.id);
    if (done) completedToday.add(item.id);
    else completedToday.delete(item.id); // optimistic

    try {
      await setCompletion(item.id, today, done);
      // Refresh the server-computed streak/per-week figures the tick just changed.
      await refreshToday();
    } catch {
      if (done) completedToday.delete(item.id);
      else completedToday.add(item.id);
      toast.show('Could not save. Check the connection.', 'error');
    }
  }

  // ── Habits-tab actions (page only) ─────────────────────────────────────────────
  // Edits here can change what is due today (a new habit, an archive, a schedule change), so each
  // refreshes the Today view as well as its own slice of state.
  async function addHabit(name: string) {
    const created = await createItem(name);
    items = [...items, created];
    await refreshToday();
  }

  async function rename(id: number, name: string) {
    const updated = await renameItem(id, name);
    items = items.map((i) => (i.id === updated.id ? updated : i));
    await refreshToday();
  }

  async function archive(id: number, archived: boolean) {
    const updated = await setArchived(id, archived);
    items = items.map((i) => (i.id === updated.id ? updated : i));
    await refreshToday();
  }

  async function remove(id: number) {
    await deleteItem(id);
    items = items.filter((i) => i.id !== id);
    completedToday.delete(id);
    await refreshToday();
  }

  async function reorder(ids: number[]) {
    items = await reorderItems(ids);
    await refreshToday();
  }

  async function updateSchedule(id: number, input: SetHabitScheduleInput) {
    const saved = await setSchedule(id, input);
    // Replace today's row for this item, keeping the item's other (past) rows.
    schedules = [
      ...schedules.filter((s) => !(s.itemId === saved.itemId && s.effectiveFromDay === saved.effectiveFromDay)),
      saved,
    ];
    await refreshToday();
  }

  async function updateSettings(patch: Partial<HabitSettings>) {
    settings = await patchSettings(patch);
    await refreshToday();
  }

  const TABS = [
    { id: 'today', label: 'Today' },
    { id: 'log', label: 'Log' },
    { id: 'habits', label: 'Habits' },
  ];
  let tab = $state('today');

  onMount(load);
</script>

{#snippet todayPanel()}
  <TodayList rows={todayRows} completed={completedToday} onToggle={toggle} {loaded} {compact} />
{/snippet}

{#if compact}
  {@render todayPanel()}
{:else}
  <div class="habit-tracker-page">
    <Tabs tabs={TABS} bind:active={tab} storeKey="habit-tracker" label="Habit Tracker sections">
      {#snippet panel(id)}
        {#if id === 'habits'}
          <HabitsManager
            {items}
            {schedules}
            {today}
            {settings}
            onAdd={addHabit}
            onRename={rename}
            onArchive={archive}
            onDelete={remove}
            onReorder={reorder}
            onSchedule={updateSchedule}
            onSettings={updateSettings}
          />
        {:else if id === 'log'}
          <!-- Log views arrive in PD-725 / PD-726. -->
          <p class="placeholder">The Log is coming soon.</p>
        {:else}
          {@render todayPanel()}
        {/if}
      {/snippet}
    </Tabs>
  </div>
{/if}

<style lang="scss" src="../routes/widgets/habit-tracker/HabitTracker.scss"></style>
