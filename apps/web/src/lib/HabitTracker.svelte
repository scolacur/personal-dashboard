<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    DEFAULT_DAY_BOUNDARY_MINUTES,
    DEFAULT_HABIT_TIMEZONE,
    habitDay,
    type HabitItemView,
    type HabitSettings,
  } from '@dashboard/shared';
  import { toast } from '$lib/toast-store.svelte';
  import Tabs from '$lib/Tabs.svelte';
  import TodayList from '../routes/widgets/habit-tracker/TodayList.svelte';
  import HabitsManager from '../routes/widgets/habit-tracker/HabitsManager.svelte';
  import {
    createItem,
    deleteItem,
    fetchCompletions,
    fetchItems,
    fetchSettings,
    patchSettings,
    renameItem,
    reorderItems,
    setArchived,
    setCompletion,
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
  // SvelteSet so in-place add/delete are reactive (optimistic ticking mutates it directly).
  const completedToday = new SvelteSet<number>();
  let loaded = $state(false);

  // Recomputes if the day boundary / timezone change on the Habits tab; otherwise stable.
  const today = $derived(habitDay(Date.now(), settings));
  const activeItems = $derived(items.filter((i) => i.archivedAt === null));

  async function load() {
    try {
      const s = await fetchSettings();
      settings = s;
      const day = habitDay(Date.now(), s);
      const [its, comps] = await Promise.all([fetchItems(true), fetchCompletions(day, day)]);
      items = its;
      completedToday.clear();
      for (const c of comps) completedToday.add(c.itemId);
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
    } catch {
      if (done) completedToday.delete(item.id);
      else completedToday.add(item.id);
      toast.show('Could not save. Check the connection.', 'error');
    }
  }

  // ── Habits-tab actions (page only) ─────────────────────────────────────────────
  async function addHabit(name: string) {
    const created = await createItem(name);
    items = [...items, created];
  }

  async function rename(id: number, name: string) {
    const updated = await renameItem(id, name);
    items = items.map((i) => (i.id === updated.id ? updated : i));
  }

  async function archive(id: number, archived: boolean) {
    const updated = await setArchived(id, archived);
    items = items.map((i) => (i.id === updated.id ? updated : i));
  }

  async function remove(id: number) {
    await deleteItem(id);
    items = items.filter((i) => i.id !== id);
    completedToday.delete(id);
  }

  async function reorder(ids: number[]) {
    items = await reorderItems(ids);
  }

  async function updateSettings(patch: Partial<HabitSettings>) {
    settings = await patchSettings(patch);
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
  <TodayList items={activeItems} completed={completedToday} onToggle={toggle} {loaded} {compact} />
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
            {settings}
            onAdd={addHabit}
            onRename={rename}
            onArchive={archive}
            onDelete={remove}
            onReorder={reorder}
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
