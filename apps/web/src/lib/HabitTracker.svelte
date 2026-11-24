<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { fly } from 'svelte/transition';
  import {
    addHabitDays,
    DEFAULT_DAY_BOUNDARY_MINUTES,
    DEFAULT_HABIT_TIMEZONE,
    HABIT_DAY_PATTERN,
    habitDay,
    habitWeekStart,
    type HabitChoiceOption,
    type HabitItemView,
    type HabitMetricTodayRow,
    type HabitMetricType,
    type HabitSchedule,
    type HabitSettings,
    type HabitTodayRow,
    type SetHabitScheduleInput,
  } from '@dashboard/shared';
  import { toast } from '$lib/toast-store.svelte';
  import Tabs from '$lib/Tabs.svelte';
  import { createOutbox } from '$lib/outbox';
  import TodayList from '../routes/widgets/habit-tracker/TodayList.svelte';
  import HabitsManager from '../routes/widgets/habit-tracker/HabitsManager.svelte';
  import LogView from '../routes/widgets/habit-tracker/LogView.svelte';
  import DayHeader from '../routes/widgets/habit-tracker/DayHeader.svelte';
  import { stepHabitDay } from '../routes/widgets/habit-tracker/day-nav';
  import {
    createChoiceOption,
    createItem,
    createMetric,
    deleteChoiceOption,
    deleteItem,
    fetchChoiceOptions,
    fetchCompletions,
    fetchItems,
    fetchSchedules,
    fetchSettings,
    fetchToday,
    moveItem,
    patchSettings,
    RejectedError,
    renameChoiceOption,
    renameItem,
    setArchived,
    setChoiceOptionArchived,
    setMetricType,
    setSchedule,
  } from '../routes/widgets/habit-tracker/api';
  import { buildHabitTree, dueLeaves, type HabitTreeNode } from '../routes/widgets/habit-tracker/tree';
  import { uncheckedYesterdayCount } from '../routes/widgets/habit-tracker/yesterday';
  import { isDayComplete, shouldFireDayBurst } from '../routes/widgets/habit-tracker/completion-feedback';
  import {
    applyPendingCompletions,
    applyPendingMetrics,
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
  let schedules = $state<HabitSchedule[]>([]);
  // The Today view (due state, per-week progress, streaks) is computed server-side (D-095).
  let todayRows = $state<HabitTodayRow[]>([]);
  // Active metrics for today (item + options); their values live in the optimistic `metricValues` map.
  let metricRows = $state<HabitMetricTodayRow[]>([]);
  // SvelteSet so in-place add/delete are reactive (optimistic ticking mutates it directly).
  const completedToday = new SvelteSet<number>();
  // Optimistic metric values: itemId → value ('HH:MM' | number string | JSON option ids), null = cleared.
  const metricValues = new SvelteMap<number, string | null>();
  let loaded = $state(false);
  let pending = $state<PendingHabitWrite[]>([]);
  // The "N pending sync" line renders from the outbox's delayed-visible signal, not the raw queue, so
  // a tick that syncs normally never flashes it (PD-778). `pending` stays the raw queue for LogView.
  let visiblePending = $state<PendingHabitWrite[]>([]);

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
    onVisibleChange: (list) => (visiblePending = list),
    // A tick that reached the server changes its streak / per-week figures, so re-pull the
    // server-computed Today view once writes flush (D-095).
    onSent: () => {
      void refreshToday();
    },
    onRejected: (_entry, message) => toast.show(`A habit write was refused: ${message}`, 'error', 6000),
  });

  // Recomputes if the day boundary / timezone change on the Habits tab; otherwise stable. The server
  // Today view carries its own `day`; this is the fallback the optimistic tick writes against.
  const today = $derived(habitDay(Date.now(), settings));
  const yesterday = $derived(addHabitDays(today, -1));

  // ── Day navigation (PD-779 ([Habit Tracker] date header + day arrows on Today)) ──────────────
  // The Today surface (card and page) can step back through past habit days and forward again, never
  // past today. `pickedDay` is the day asked for (null = the current habit day); `shownDay` is the day
  // the rendered rows actually belong to (the server view's `day`), set once its fetch lands. Every
  // Today write — tick, untick, set tick-all, metric — targets `shownDay`, through the one shared
  // outbox, so a past day is edited exactly as today is.
  let pickedDay = $state<string | null>(null);
  const viewedDay = $derived(pickedDay !== null && pickedDay < today ? pickedDay : today);
  let shownDay = $state<string | null>(null);
  const writeDay = $derived(shownDay ?? today);
  // Slide direction for the day change: -1 = back (incoming day enters from the left), 1 = forward.
  let slideDir = $state<-1 | 1>(-1);
  // The filter chip, held here so it survives the list being re-created for each day's slide.
  let chip = $state<'all' | number>('all');
  // Guards against out-of-order responses when arrows are tapped faster than the server answers.
  let refreshSeq = 0;
  const SLIDE_PX = 48;
  const SLIDE_MS = 220;

  function goToDay(day: string) {
    if (day === viewedDay) return;
    slideDir = day < viewedDay ? -1 : 1;
    pickedDay = day >= today ? null : day;
    refreshToday().catch(() => {
      toast.show('Could not load that day.', 'error');
      pickedDay = shownDay === null || shownDay >= today ? null : shownDay;
    });
  }

  function stepDay(delta: -1 | 1) {
    goToDay(stepHabitDay(viewedDay, delta, today));
  }

  // ── Yesterday banner (T889) ──────────────────────────────────────────────────────
  // "Yesterday: N habits unchecked" — due leaf habits only (no metrics, no sets). Dismissible per
  // habit day and only ever covering yesterday; tapping it opens Log › By Day scrolled to yesterday.
  const YESTERDAY_DISMISS_KEY = 'habit-tracker:yesterday-dismissed';
  let yesterdayCount = $state(0);
  let yesterdayDismissed = $state<string | null>(readLs(YESTERDAY_DISMISS_KEY));
  const showYesterdayBanner = $derived(loaded && yesterdayCount > 0 && yesterdayDismissed !== yesterday);

  function readLs(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeLs(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private-mode / quota failure just means the state isn't remembered — not fatal.
    }
  }

  /**
   * Compute the yesterday count from the server's completions for the habit week containing yesterday
   * (enough history for a per-week habit's weekly target). `items` + `schedules` are already loaded.
   * A fetch failure just hides the banner — it is never worth a toast.
   */
  async function refreshYesterday() {
    try {
      const y = addHabitDays(habitDay(Date.now(), settings), -1);
      // The habit week containing yesterday is enough history for a per-week target.
      const completions = await fetchCompletions(habitWeekStart(y), y);
      yesterdayCount = uncheckedYesterdayCount(items, schedules, completions, y);
    } catch {
      yesterdayCount = 0;
    }
  }

  function dismissYesterday() {
    yesterdayDismissed = yesterday;
    writeLs(YESTERDAY_DISMISS_KEY, yesterday);
  }

  /** Open Log › By Day scrolled to yesterday (the PD-725 deep link). Works from the card and the page. */
  function openYesterday() {
    // On the page a repeat click leaves the URL unchanged, so the deep-link effect wouldn't re-fire;
    // switch the tab directly too (PD-971). From the card, `goto` navigates to the page.
    if (!compact) tab = 'log';
    void goto(`/widgets/habit-tracker?view=day&day=${yesterday}`, { keepFocus: true, noScroll: true });
  }

  /**
   * Pull the server-computed view for the viewed habit day (today unless the day arrows moved it,
   * PD-779 ([Habit Tracker] date header + day arrows on Today)). A response superseded by a later
   * pull is dropped, and so is its error.
   */
  async function refreshToday() {
    const seq = ++refreshSeq;
    const day = viewedDay;
    let view;
    try {
      view = await fetchToday(day === today ? undefined : day);
    } catch (e) {
      if (seq !== refreshSeq) return;
      throw e;
    }
    if (seq !== refreshSeq) return;
    shownDay = view.day;
    todayRows = view.rows;
    metricRows = view.metrics;
    completedToday.clear();
    // Fold any queued-but-unsynced ticks over the server's done-set, so an offline tick doesn't
    // visually revert on refresh (PROJECT.md §4). The server view already carries the streak /
    // per-week figures (D-095); pending writes only move the done-set until they flush.
    const serverDone = view.rows.filter((r) => r.completedToday).map((r) => r.item.id);
    for (const id of applyPendingCompletions(serverDone, outbox.pending(), view.day))
      completedToday.add(id);
    // Same fold for metric values: an unsynced value must not revert to the server's older one.
    metricValues.clear();
    const serverValues = view.metrics.map((m) => [m.item.id, m.value] as const);
    for (const [id, value] of applyPendingMetrics(serverValues, outbox.pending(), view.day))
      metricValues.set(id, value);
  }

  async function load() {
    try {
      settings = await fetchSettings();
      const [its, scheds] = await Promise.all([fetchItems(true), fetchSchedules()]);
      items = its;
      schedules = scheds;
      await refreshToday();
      await refreshYesterday();
    } catch {
      toast.show('Could not load habits.', 'error');
    } finally {
      loaded = true;
    }
  }

  // Today's render tree (PD-723), rebuilt from the server rows + the optimistic done-set so a set's
  // done/progress recompute the instant a child is ticked. Set streaks come from the server rows.
  const tree = $derived(buildHabitTree(todayRows, completedToday));

  // ── Whole-day burst (T889, layer 3) ──────────────────────────────────────────────
  // A short burst when the whole day is done, at most once per habit day: `lastBurstDay` is persisted
  // so an untick + re-tick (or a reload) never replays it. Skipped entirely under reduced motion.
  const BURST_KEY = 'habit-tracker:burst-day';
  const dayComplete = $derived(isDayComplete(tree));
  let lastBurstDay = $state<string | null>(readLs(BURST_KEY));
  let bursting = $state(false);

  function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  $effect(() => {
    // Only today's completion earns the burst; a complete past day viewed with the arrows does not.
    if (shownDay !== today) return;
    if (!shouldFireDayBurst(today, dayComplete, lastBurstDay)) return;
    lastBurstDay = today;
    writeLs(BURST_KEY, today);
    if (prefersReducedMotion()) return; // reduced motion → no visual, just the once-per-day record
    bursting = true;
    setTimeout(() => (bursting = false), 1200);
  });

  // Metrics for Today (PD-724): the server rows (item + options) with the optimistic value folded in,
  // so a just-logged value shows immediately and survives the next refresh.
  const metrics = $derived(
    metricRows.map((m) => ({
      ...m,
      value: metricValues.has(m.item.id) ? (metricValues.get(m.item.id) ?? null) : m.value,
    })),
  );

  function queueMetric(itemId: number, value: string | null) {
    metricValues.set(itemId, value); // optimistic
    outbox.add({ kind: 'metric', itemId, day: writeDay, value });
  }

  /**
   * Set a metric's value on an arbitrary habit day — the Log › By Day past-day edits (PD-725). Rides
   * the same shared outbox as Today (PROJECT.md §4, D-093); when the day is the one the Today tab is
   * showing, its optimistic value is kept in sync too.
   */
  function setMetricValueOnDay(itemId: number, day: string, value: string | null) {
    if (day === writeDay) metricValues.set(itemId, value);
    outbox.add({ kind: 'metric', itemId, day, value });
  }

  function queueToggle(itemId: number, done: boolean) {
    if (done) completedToday.add(itemId);
    else completedToday.delete(itemId); // optimistic
    // The write is queued, not awaited: it shows immediately and syncs when the server is reachable.
    // Once it flushes, `onSent` re-pulls the server-computed streak / per-week figures (D-095).
    outbox.add({ kind: 'completion', itemId, day: writeDay, done });
  }

  function toggle(item: HabitItemView) {
    queueToggle(item.id, !completedToday.has(item.id));
  }

  /**
   * Toggle a completion on an arbitrary habit day — the Log views' past-day edits (PD-726). Rides the
   * same shared outbox as Today (PROJECT.md §4, D-093): never the write API directly. When the day is
   * the one the Today tab is showing, its optimistic done-set is kept in sync too.
   */
  function toggleCompletionOnDay(itemId: number, day: string, done: boolean) {
    if (day === writeDay) {
      if (done) completedToday.add(itemId);
      else completedToday.delete(itemId);
    }
    outbox.add({ kind: 'completion', itemId, day, done });
  }

  /** Open Log › By Habit for an item (a deep link, so it is shareable and back-navigable). */
  function openInCalendar(itemId: number) {
    void goto(`?view=habit&item=${itemId}`, { keepFocus: true, noScroll: true });
  }

  /**
   * Ticking a set ticks all its due leaf descendants; unticking a done set unticks them. A partly
   * done set completes the remainder without clearing what's done (PD-723): if every due leaf is
   * already done we clear them, otherwise we complete the ones still outstanding.
   */
  function toggleSet(node: HabitTreeNode) {
    const leaves = dueLeaves(node);
    if (leaves.length === 0) return;
    const target = !leaves.every((l) => completedToday.has(l.item.id));
    for (const leaf of leaves) {
      if (completedToday.has(leaf.item.id) !== target) queueToggle(leaf.item.id, target);
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

  async function move(itemId: number, parentId: number | null, siblingIds: number[]) {
    items = await moveItem(itemId, parentId, siblingIds);
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
    // A boundary / timezone change can move which day is "yesterday", so recount the banner.
    await refreshYesterday();
  }

  // ── Metric-tab actions (PD-724) ─────────────────────────────────────────────────
  async function addMetric(name: string, metricType: HabitMetricType) {
    const created = await createMetric(name, metricType);
    items = [...items, created];
    await refreshToday();
  }

  async function changeMetricType(id: number, metricType: HabitMetricType) {
    const updated = await setMetricType(id, metricType);
    items = items.map((i) => (i.id === updated.id ? updated : i));
    await refreshToday();
  }

  // Choice-option edits change what Today's multi-select offers, so each refreshes the Today view.
  function listOptions(id: number): Promise<HabitChoiceOption[]> {
    return fetchChoiceOptions(id, true);
  }

  async function addOption(id: number, label: string): Promise<HabitChoiceOption> {
    const option = await createChoiceOption(id, label);
    await refreshToday();
    return option;
  }

  async function editOption(optionId: number, label: string): Promise<HabitChoiceOption> {
    const option = await renameChoiceOption(optionId, label);
    await refreshToday();
    return option;
  }

  async function archiveOption(optionId: number, archived: boolean): Promise<HabitChoiceOption> {
    const option = await setChoiceOptionArchived(optionId, archived);
    await refreshToday();
    return option;
  }

  async function removeOption(optionId: number): Promise<void> {
    await deleteChoiceOption(optionId);
    await refreshToday();
  }

  // Ids are stable (persisted tab, deep links); only the labels were renamed.
  const TABS = [
    { id: 'today', label: 'Daily Log' },
    { id: 'log', label: 'History' },
    { id: 'habits', label: 'Config' },
  ];
  let tab = $state('today');

  // Deep links into the Log tab: `?view=habit&item=<id>` opens the By Habit calendar for an item;
  // `?view=day&day=<YYYY-MM-DD>` opens the By Day grid scrolled to that day (the yesterday banner).
  const deepView = $derived(page.url.searchParams.get('view'));
  const deepItem = $derived.by(() => {
    const raw = page.url.searchParams.get('item');
    const n = raw === null ? null : Number(raw);
    return n !== null && Number.isInteger(n) ? n : null;
  });
  const deepDay = $derived.by(() => {
    const raw = page.url.searchParams.get('day');
    return raw !== null && HABIT_DAY_PATTERN.test(raw) ? raw : null;
  });
  $effect(() => {
    if (deepView === 'habit' || deepView === 'day') tab = 'log';
  });

  onMount(() => {
    // `start` loads any persisted queue and wires the retry triggers; load() then folds that queue
    // over the server state, and a flush pushes anything already queued once the server answers.
    const teardown = outbox.start();
    void load().then(() => outbox.flush());
    return teardown;
  });
</script>

{#snippet todayPanel()}
  <div class="today-panel" class:compact>
    {#if showYesterdayBanner}
      <div class="yesterday-banner">
        <button type="button" class="yesterday-link" onclick={openYesterday}>
          Yesterday: {yesterdayCount}
          {yesterdayCount === 1 ? 'habit' : 'habits'} unchecked
        </button>
        <button type="button" class="yesterday-dismiss" aria-label="Dismiss" onclick={dismissYesterday}>
          ×
        </button>
      </div>
    {/if}
    <DayHeader day={writeDay} {today} onStep={stepDay} onToday={() => goToDay(today)} {compact} />
    <div class="day-slider">
      {#key writeDay}
        <div
          class="day-slide"
          in:fly={{ x: slideDir * SLIDE_PX, duration: prefersReducedMotion() ? 0 : SLIDE_MS }}
          out:fly={{ x: -slideDir * SLIDE_PX, duration: prefersReducedMotion() ? 0 : SLIDE_MS }}
        >
          <TodayList
            {tree}
            {metrics}
            onToggleLeaf={toggle}
            onToggleSet={toggleSet}
            onMetric={queueMetric}
            {loaded}
            {compact}
            isToday={writeDay === today}
            bind:chip
          />
        </div>
      {/key}
    </div>
    {#if visiblePending.length > 0}
      <p class="pending" role="status">{visiblePending.length} pending sync</p>
    {/if}
    {#if bursting}
      <div class="day-burst" aria-hidden="true"><span>🎉</span></div>
    {/if}
  </div>
{/snippet}

{#if compact}
  {@render todayPanel()}
{:else}
  <div class="habit-tracker-page">
    <Tabs tabs={TABS} bind:active={tab} storeKey="habit-tracker" label="Habit Tracker sections">
      {#snippet panel(id)}
        {#if id === 'habits'}
          <div class="panel-narrow">
            <HabitsManager
              {items}
              {schedules}
              {today}
              {settings}
              onAdd={addHabit}
              onAddMetric={addMetric}
              onRename={rename}
              onArchive={archive}
              onDelete={remove}
              onMove={move}
              onSchedule={updateSchedule}
              onSettings={updateSettings}
              onMetricType={changeMetricType}
              onListOptions={listOptions}
              onAddOption={addOption}
              onEditOption={editOption}
              onArchiveOption={archiveOption}
              onDeleteOption={removeOption}
            />
          </div>
        {:else if id === 'log'}
          <!-- History runs wider than the other tabs on desktop: the By Day grid wants the room. -->
          <div class="panel-wide">
            <LogView
              {items}
              {schedules}
              {settings}
              {today}
              {pending}
              {metricRows}
              initialView={deepView === 'habit' ? 'habit' : 'day'}
              initialItemId={deepItem}
              initialDay={deepDay}
              onToggle={toggleCompletionOnDay}
              onMetricWrite={setMetricValueOnDay}
              onOpenItem={openInCalendar}
            />
          </div>
        {:else}
          <div class="panel-narrow">{@render todayPanel()}</div>
        {/if}
      {/snippet}
    </Tabs>
  </div>
{/if}

<style lang="scss" src="../routes/widgets/habit-tracker/HabitTracker.scss"></style>
