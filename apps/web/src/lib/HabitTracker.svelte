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
  import { createOutbox } from '$lib/outbox';
  import TodayList from '../routes/widgets/habit-tracker/TodayList.svelte';
  import HabitsManager from '../routes/widgets/habit-tracker/HabitsManager.svelte';
  import {
    createItem,
    deleteItem,
    fetchCompletions,
    fetchItems,
    fetchSettings,
    patchSettings,
    RejectedError,
    renameItem,
    reorderItems,
    setArchived,
  } from '../routes/widgets/habit-tracker/api';
  import {
    applyPendingCompletions,
    pendingKey,
    QUEUE_KEY,
    sendHabitWrite,
    type PendingHabitWrite,
  } from '../routes/widgets/habit-tracker/queue';

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
  let pending = $state<PendingHabitWrite[]>([]);

  /**
   * Every tick / untick (and, when the metric UI lands, every metric write) rides the shared
   * offline outbox (`$lib/outbox`, D-093; this ticket). The UI updates optimistically; the outbox
   * persists the write, flushes when the server is reachable, and collapses pending writes per
   * `(item, day)` so a flurry of toggles on one habit sends only the final state. `onChange` mirrors
   * the queue into `pending` for the live "N pending sync" line.
   */
  const outbox = createOutbox<PendingHabitWrite, void>({
    key: QUEUE_KEY,
    send: sendHabitWrite,
    isRejected: (e) => e instanceof RejectedError,
    collapseKey: pendingKey,
    onChange: (list) => (pending = list),
    onRejected: (_entry, message) => toast.show(`A habit write was refused: ${message}`, 'error', 6000),
  });

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
      // Fold any queued-but-unsynced ticks over the server state, so an offline tick doesn't
      // visually revert on reload (PROJECT.md §4).
      completedToday.clear();
      for (const id of applyPendingCompletions(comps.map((c) => c.itemId), outbox.pending(), day))
        completedToday.add(id);
    } catch {
      toast.show('Could not load habits.', 'error');
    } finally {
      loaded = true;
    }
  }

  function toggle(item: HabitItemView) {
    const done = !completedToday.has(item.id);
    if (done) completedToday.add(item.id);
    else completedToday.delete(item.id); // optimistic
    // The write is queued, not awaited: it shows immediately and syncs when the server is reachable.
    outbox.add({ kind: 'completion', itemId: item.id, day: today, done });
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

  onMount(() => {
    // `start` loads any persisted queue and wires the retry triggers; load() then folds that queue
    // over the server state, and a flush pushes anything already queued once the server answers.
    const teardown = outbox.start();
    void load().then(() => outbox.flush());
    return teardown;
  });
</script>

{#snippet todayPanel()}
  <TodayList items={activeItems} completed={completedToday} onToggle={toggle} {loaded} {compact} />
  {#if pending.length > 0}
    <p class="pending" role="status">{pending.length} pending sync</p>
  {/if}
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
