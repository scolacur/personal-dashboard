<script lang="ts">
  import { onMount } from 'svelte';
  import { habitDay, MOOD_ENERGY_DEFAULT_TAGS, type MoodEnergyEntry } from '@dashboard/shared';
  import { toast } from '$lib/toast-store.svelte';
  import { createOutbox } from '$lib/outbox';
  import Tabs from '$lib/Tabs.svelte';
  import {
    RejectedError,
    createTag,
    fetchEntries,
    fetchEntryForDay,
    fetchHabitSettings,
    fetchTags,
    hideTag,
    saveEntry,
  } from '../routes/widgets/mood-energy/api';
  import { newClientId, QUEUE_KEY, type PendingSave } from '../routes/widgets/mood-energy/queue';
  import {
    blankDraft,
    cacheSettings,
    draftFromEntry,
    formatDay,
    loadCachedSettings,
    mergeEntries,
    overlayPending,
    pendingDay,
    weekdayName,
    type DayDraft,
  } from '../routes/widgets/mood-energy/days';
  import MoodEnergyForm from '../routes/widgets/mood-energy/MoodEnergyForm.svelte';
  import DayCalendar from '../routes/widgets/mood-energy/DayCalendar.svelte';
  import DayList from '../routes/widgets/mood-energy/DayList.svelte';
  import DayEditModal, { type EditTarget } from '../routes/widgets/mood-energy/DayEditModal.svelte';
  import TrendsView from '../routes/widgets/mood-energy/TrendsView.svelte';

  /**
   * Mood & Energy (PD-95, Mood & Energy widget). `page` is the full screen — Log | Trends. `widget` is
   * the dashboard card: the capture only, without the date override, tag editing or history.
   *
   * One entry per habit day (the Habit Tracker's day boundary and timezone, D-092). Every save goes
   * through the offline outbox and the server upserts by day, so saving twice updates the day.
   */
  interface Props {
    variant: 'widget' | 'page';
  }

  let { variant }: Props = $props();
  const compact = $derived(variant === 'widget');

  const TABS = [
    { id: 'log', label: 'Log' },
    { id: 'trends', label: 'Trends' },
  ];
  let tab = $state('log');

  const TAGS_CACHE_KEY = 'mood-energy:tags';

  let settings = $state(loadCachedSettings());
  let nowMs = $state(Date.now());
  const today = $derived(habitDay(nowMs, settings));

  // id per tag name, for hiding. Absent for a tag added offline that the server hasn't confirmed.
  let tagIds = $state<Record<string, number>>({});
  let tags = $state<string[]>([...MOOD_ENERGY_DEFAULT_TAGS]);
  let entries = $state<MoodEnergyEntry[]>([]);
  let pending = $state<PendingSave[]>([]);
  // The "N pending sync" line renders from the outbox's delayed-visible signal (PD-778), so a save
  // that syncs normally never flashes it.
  let visiblePending = $state<PendingSave[]>([]);

  /** Server entries with unsent saves folded over them: what the server will hold once they sync. */
  const shown = $derived(overlayPending(entries, pending, settings));

  /** Page only: a past day picked to backfill. Null means today. */
  let override = $state<string | null>(null);
  let pickingDate = $state(false);
  const targetDay = $derived(override ?? today);
  const targetEntry = $derived(shown.find((e) => e.day === targetDay) ?? null);

  let draft = $state<DayDraft>(blankDraft());
  /** The draft as last seeded, so a background reload never clobbers anything typed since. */
  let seeded = JSON.stringify(blankDraft());
  let editTarget = $state<EditTarget | null>(null);

  const status = $derived(
    targetEntry ? `Editing ${targetDay === today ? 'today' : formatDay(targetDay)}` : null,
  );

  const outbox = createOutbox<PendingSave, MoodEnergyEntry>({
    key: QUEUE_KEY,
    send: saveEntry,
    isRejected: (e) => e instanceof RejectedError,
    onChange: (list) => (pending = list),
    onVisibleChange: (list) => (visiblePending = list),
    onSent: (sent) => (entries = mergeEntries(entries, sent)),
    onRejected: (_save, message) => toast.show(`A save was refused: ${message}`, 'error', 6000),
  });

  function seed() {
    draft = draftFromEntry(targetEntry);
    seeded = JSON.stringify(draft);
  }

  /** Re-seed the form for the target day, unless it holds unsaved edits. */
  function reseedIfClean() {
    if (JSON.stringify(draft) === seeded) seed();
  }

  function cacheTags() {
    try {
      localStorage.setItem(TAGS_CACHE_KEY, JSON.stringify(tags));
    } catch {
      // per-device convenience only
    }
  }

  function loadCachedTags() {
    try {
      const raw = localStorage.getItem(TAGS_CACHE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) tags = parsed;
    } catch {
      // keep the defaults
    }
  }

  async function load() {
    try {
      settings = await fetchHabitSettings();
      cacheSettings(settings);
    } catch {
      // offline: the cached settings (or the shared defaults) stand
    }
    try {
      // The page loads every day (one small row each) for the calendar and trends; the card only
      // needs today, to load it into the form.
      const [serverTags, serverEntries] = await Promise.all([
        fetchTags(),
        compact ? fetchEntryForDay(today).then((e) => (e ? [e] : [])) : fetchEntries({ limit: 5000 }),
      ]);
      tags = serverTags.map((t) => t.name);
      tagIds = Object.fromEntries(serverTags.map((t) => [t.name, t.id]));
      entries = serverEntries;
      cacheTags();
    } catch {
      loadCachedTags();
    }
    reseedIfClean();
  }

  function queue(save: PendingSave) {
    outbox.add(save);
    toast.show(`Saved ${weekdayName(pendingDay(save, settings))}`);
  }

  function toPayload(d: DayDraft, day: string | null): PendingSave {
    return {
      clientId: newClientId(),
      recordedAt: Date.now(),
      ...(day ? { day } : {}),
      mood: d.mood,
      energy: d.energy,
      tags: [...d.tags],
      note: d.note.trim() || null,
    };
  }

  function submit() {
    nowMs = Date.now();
    queue(toPayload(draft, override));
    // The form now shows the saved day ("Editing today"); a backfill returns to today.
    if (override !== null) {
      override = null;
      pickingDate = false;
    }
    seed();
  }

  function pickDate(value: string) {
    override = value && value < today ? value : null;
    seed();
  }

  function resetDate() {
    pickingDate = false;
    override = null;
    seed();
  }

  function addTag(name: string) {
    tags = [...tags, name];
    cacheTags();
    // Best effort: if this fails, the save that uses the tag creates it on sync.
    createTag(name)
      .then((t) => (tagIds = { ...tagIds, [t.name]: t.id }))
      .catch(() => {});
  }

  async function removeTag(name: string) {
    const id = tagIds[name];
    try {
      if (id !== undefined) await hideTag(id);
      tags = tags.filter((t) => t !== name);
      draft.tags = draft.tags.filter((t) => t !== name);
      cacheTags();
    } catch {
      toast.show("Couldn't hide that tag. Check the connection.", 'error');
    }
  }

  /** The habit day rolls over while the page is open: move the form to the new day if untouched. */
  function tickClock() {
    const before = today;
    nowMs = Date.now();
    if (today !== before && override === null) reseedIfClean();
  }

  onMount(() => {
    // `start` loads any persisted queue and wires the retry triggers; flush after the server load
    // resolves, so a sync folds into freshly fetched days.
    const teardown = outbox.start();
    void load().then(() => outbox.flush());
    const clock = setInterval(tickClock, 60_000);
    const onVisible = () => document.visibilityState === 'visible' && tickClock();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      teardown();
      clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });
</script>

{#snippet capture()}
  <div class="mood-energy" class:compact>
    {#if !compact}
      <div class="date">
        {#if pickingDate || override !== null}
          <label>
            <span>Day</span>
            <input type="date" value={targetDay} max={today} aria-label="Day" onchange={(e) => pickDate(e.currentTarget.value)} />
          </label>
          <button type="button" class="link" onclick={resetDate}>Today</button>
        {:else}
          <button type="button" class="link" aria-expanded="false" onclick={() => (pickingDate = true)}>
            Today ({formatDay(today)}) ▾
          </button>
        {/if}
      </div>
    {/if}

    {#if status}<p class="status">{status}</p>{/if}

    <MoodEnergyForm
      bind:draft
      {tags}
      {compact}
      noteRows={compact ? 1 : 3}
      editableTags={!compact}
      onAddTag={addTag}
      onHideTag={removeTag}
    />

    <button type="button" class="save" onclick={submit}>Save</button>

    {#if visiblePending.length > 0}
      <p class="pending" role="status">{visiblePending.length} pending sync</p>
    {/if}
  </div>
{/snippet}

{#if compact}
  {@render capture()}
{:else}
  <Tabs tabs={TABS} bind:active={tab} storeKey="mood-energy" label="Mood & Energy sections">
    {#snippet panel(id)}
      {#if id === 'trends'}
        <TrendsView entries={shown} {today} />
      {:else}
        {@render capture()}
        <section class="history" aria-label="Past days">
          <DayCalendar entries={shown} {today} onOpen={(day, entry) => (editTarget = { day, entry })} />
          <DayList entries={shown} onEdit={(e) => (editTarget = { day: e.day, entry: e })} />
        </section>
      {/if}
    {/snippet}
  </Tabs>
  <DayEditModal
    target={editTarget}
    {tags}
    onClose={() => (editTarget = null)}
    onSave={(day, d) => {
      queue(toPayload(d, day));
      editTarget = null;
      reseedIfClean();
    }}
    onDeleted={(day) => {
      entries = entries.filter((e) => e.day !== day);
      editTarget = null;
      reseedIfClean();
    }}
  />
{/if}

<style lang="scss" src="./MoodEnergy.scss"></style>
