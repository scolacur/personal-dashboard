<script lang="ts">
  import { onMount } from 'svelte';
  import { sleepWakeDate, SLEEP_DEFAULT_TAGS, type CreateSleepEntryInput, type SleepEntry } from '@dashboard/shared';
  import { toast } from '$lib/toast-store.svelte';
  import { createOutbox } from '$lib/outbox';
  import Tabs from '$lib/Tabs.svelte';
  import {
    RejectedError,
    createEntry,
    createTag,
    fetchEntries,
    fetchEntriesSince,
    fetchTags,
    hideTag,
  } from '../routes/widgets/sleep-journal/api';
  import { newClientId, QUEUE_KEY, type PendingNight } from '../routes/widgets/sleep-journal/queue';
  import { blankDraft, draftFromEntry, draftTimes, tagsFromCounts, type NightDraft } from '../routes/widgets/sleep-journal/draft';
  import { formatWakeDate, todayWakeDate } from '../routes/widgets/sleep-journal/time';
  import NightForm from '../routes/widgets/sleep-journal/NightForm.svelte';
  import NightList from '../routes/widgets/sleep-journal/NightList.svelte';
  import NightCalendar from '../routes/widgets/sleep-journal/NightCalendar.svelte';
  import NightEditModal, { type EditTarget } from '../routes/widgets/sleep-journal/NightEditModal.svelte';
  import TrendsView from '../routes/widgets/sleep-journal/TrendsView.svelte';

  /**
   * Sleep Journal (PD-51, Sleep Journal widget). `page` is the full screen — Log | History | Trends.
   * `widget` is the dashboard card: the capture form only, without the date override, tag editing
   * or history.
   *
   * One night per wake date. Every save goes through the offline outbox and the server upserts by
   * wake date, so saving a night twice updates it rather than logging it twice.
   */
  interface Props {
    variant: 'widget' | 'page';
  }

  let { variant }: Props = $props();
  const compact = $derived(variant === 'widget');

  const TABS = [
    { id: 'log', label: 'Log' },
    { id: 'history', label: 'History' },
    { id: 'trends', label: 'Trends' },
  ];
  let tab = $state('log');

  const TAGS_CACHE_KEY = 'sleep-journal:tags';

  // id per tag name, for hiding. Absent for a tag added offline that the server hasn't confirmed.
  let tagIds = $state<Record<string, number>>({});
  let tags = $state<string[]>([...SLEEP_DEFAULT_TAGS]);
  let entries = $state<SleepEntry[]>([]);
  let pending = $state<PendingNight[]>([]);
  // The "N pending sync" line reads the outbox's delayed-visible signal, so a save that syncs
  // normally never flashes it (PD-778). `pending` stays the raw queue, for the list.
  let visiblePending = $state<PendingNight[]>([]);
  let today = $state(todayWakeDate());

  let draft = $state<NightDraft>(blankDraft(null));
  /** The wake date the form was prefilled from (today's saved night), if it was. */
  let loadedFrom = $state<string | null>(null);
  let editTarget = $state<EditTarget | null>(null);

  const outbox = createOutbox<PendingNight, SleepEntry>({
    key: QUEUE_KEY,
    send: createEntry,
    isRejected: (e) => e instanceof RejectedError,
    onChange: (list) => (pending = list),
    onVisibleChange: (list) => (visiblePending = list),
    onSent: (sent) => mergeEntries(sent),
    onRejected: (_night, message) => toast.show(`A night was refused: ${message}`, 'error', 6000),
  });

  const latest = $derived(entries[0] ?? null);
  const savedForDraftDate = $derived(entries.some((e) => e.wakeDate === draft.wakeDate));
  const status = $derived.by(() => {
    if (loadedFrom !== null && loadedFrom === draft.wakeDate) return 'Editing last night';
    if (savedForDraftDate) return `Saving replaces the night of ${formatWakeDate(draft.wakeDate)}`;
    return null;
  });

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

  /** Prefill the form from today's night if it is saved, else from the latest night's habits. */
  function seedDraft() {
    const todays = entries.find((e) => e.wakeDate === today);
    if (todays) {
      draft = draftFromEntry(todays);
      loadedFrom = todays.wakeDate;
    } else {
      draft = blankDraft(latest);
      loadedFrom = null;
    }
  }

  async function load() {
    const untouched = JSON.stringify(draft);
    try {
      // The page loads every night (one row a night: small) for the calendar; the card only needs
      // the latest, to prefill.
      const [serverTags, serverEntries] = await Promise.all([
        fetchTags(),
        compact ? fetchEntries(1) : fetchEntriesSince('0000-01-01'),
      ]);
      tags = serverTags.map((t) => t.name);
      tagIds = Object.fromEntries(serverTags.map((t) => [t.name, t.id]));
      entries = serverEntries;
      cacheTags();
    } catch {
      loadCachedTags();
    }
    // Don't clobber anything typed while the load was in flight.
    if (JSON.stringify(draft) === untouched) seedDraft();
  }

  function mergeEntries(incoming: SleepEntry[]) {
    const ids = new Set(incoming.map((e) => e.id));
    const dates = new Set(incoming.map((e) => e.wakeDate));
    entries = [...entries.filter((e) => !ids.has(e.id) && !dates.has(e.wakeDate)), ...incoming].sort((a, b) =>
      b.wakeDate.localeCompare(a.wakeDate),
    );
  }

  function queue(input: CreateSleepEntryInput) {
    outbox.add(input);
    toast.show(`Saved night of ${formatWakeDate(sleepWakeDate(input.wakeAt))}`);
  }

  function submit() {
    const t = draftTimes(draft);
    if (!t.ok) {
      toast.show(t.error, 'error');
      return;
    }
    queue({
      clientId: newClientId(),
      sleepAt: t.sleepAt,
      wakeAt: t.wakeAt,
      rested: draft.rested,
      tags: tagsFromCounts(draft.counts),
      notes: draft.notes.trim() || null,
    });
    // Notes, tags, the date and the slider reset; the sleep time is kept as tomorrow's default.
    today = todayWakeDate();
    draft = { ...blankDraft(null), sleepTime: draft.sleepTime };
    loadedFrom = null;
  }

  function addTag(name: string) {
    tags = [...tags, name];
    cacheTags();
    // Best effort: if this fails, the night that uses the tag creates it on sync.
    createTag(name)
      .then((t) => (tagIds = { ...tagIds, [t.name]: t.id }))
      .catch(() => {});
  }

  async function removeTag(name: string) {
    const id = tagIds[name];
    try {
      if (id !== undefined) await hideTag(id);
      tags = tags.filter((t) => t !== name);
      draft.counts = Object.fromEntries(Object.entries(draft.counts).filter(([t]) => t !== name));
      cacheTags();
    } catch {
      toast.show("Couldn't hide that tag. Check the connection.", 'error');
    }
  }

  onMount(() => {
    // `start` loads any persisted queue and wires the retry triggers; flush after the server load
    // resolves, so a sync folds into freshly fetched nights.
    const teardown = outbox.start();
    void load().then(() => outbox.flush());
    return teardown;
  });
</script>

{#snippet capture()}
  <div class="sleep" class:compact>
    {#if status}<p class="status">{status}</p>{/if}

    <NightForm
      bind:draft
      {tags}
      {compact}
      dateMode={compact ? 'none' : 'toggle'}
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
  <Tabs tabs={TABS} bind:active={tab} storeKey="sleep-journal" label="Sleep Journal sections">
    {#snippet panel(id)}
      {#if id === 'trends'}
        <!-- Mounts on selection, so it refetches and includes new nights. -->
        <TrendsView />
      {:else if id === 'history'}
        <div class="history">
          <NightCalendar {entries} {today} onOpen={(date, entry) => (editTarget = { date, entry })} />
          <NightList {entries} {pending} onEdit={(e) => (editTarget = { date: e.wakeDate, entry: e })} />
        </div>
      {:else}
        {@render capture()}
      {/if}
    {/snippet}
  </Tabs>
  <NightEditModal
    target={editTarget}
    {tags}
    previous={latest}
    onClose={() => (editTarget = null)}
    onSaved={(e) => {
      mergeEntries([e]);
      editTarget = null;
    }}
    onDeleted={(id) => {
      entries = entries.filter((e) => e.id !== id);
      editTarget = null;
    }}
    onQueue={(input) => {
      queue(input);
      editTarget = null;
    }}
  />
{/if}

<style lang="scss" src="./SleepJournal.scss"></style>
