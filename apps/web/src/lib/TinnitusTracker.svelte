<script lang="ts">
  import { onMount } from 'svelte';
  import {
    TINNITUS_DEFAULT_TAGS,
    TINNITUS_FUTURE_TOLERANCE_MS,
    tinnitusLabel,
    type TinnitusEntry,
  } from '@dashboard/shared';
  import { toast } from '$lib/toast-store.svelte';
  import { createOutbox } from '$lib/outbox';
  import { RejectedError, createEntry, createTag, fetchEntries, fetchTags, hideTag } from '../routes/widgets/tinnitus-tracker/api';
  import { newClientId, QUEUE_KEY, type PendingEntry } from '../routes/widgets/tinnitus-tracker/queue';
  import { fromLocalInput, toLocalInput } from '../routes/widgets/tinnitus-tracker/time';
  import IntensitySlider from '../routes/widgets/tinnitus-tracker/IntensitySlider.svelte';
  import TagCloud from '../routes/widgets/tinnitus-tracker/TagCloud.svelte';
  import EntryList from '../routes/widgets/tinnitus-tracker/EntryList.svelte';
  import EntryEditModal from '../routes/widgets/tinnitus-tracker/EntryEditModal.svelte';
  import TrendsView from '../routes/widgets/tinnitus-tracker/TrendsView.svelte';
  import Tabs from '$lib/Tabs.svelte';

  /**
   * Tinnitus Tracker (PD-705). `page` is the mobile-first full screen. `widget` is the dashboard
   * card: the same capture, including notes, backdating and custom tags (PD-716), without tag
   * editing or history.
   *
   * Every Enter goes through the offline queue (see `queue.ts`), so a reading taken with no signal
   * keeps its timestamp and syncs when the server is reachable again.
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

  const TAGS_CACHE_KEY = 'tinnitus-tracker:tags';

  // id per tag name, for hiding. Absent for a tag added offline that the server hasn't confirmed.
  let tagIds = $state<Record<string, number>>({});
  let tags = $state<string[]>([...TINNITUS_DEFAULT_TAGS]);
  let entries = $state<TinnitusEntry[]>([]);
  let pending = $state<PendingEntry[]>([]);

  // The offline outbox lives in `$lib/outbox` (PD-736); this binds it to a Tinnitus entry. `onChange`
  // mirrors its queue into the reactive `pending` above so the "N pending sync" line stays live.
  const outbox = createOutbox<PendingEntry, TinnitusEntry>({
    key: QUEUE_KEY,
    send: createEntry,
    isRejected: (e) => e instanceof RejectedError,
    onChange: (list) => (pending = list),
    onSent: (sent) => {
      if (!compact) mergeEntries(sent);
    },
    onRejected: (_entry, message) => toast.show(`An entry was refused: ${message}`, 'error', 6000),
  });

  let value = $state(0);
  let selected = $state<string[]>([]);
  let notes = $state('');
  let backdating = $state(false);
  let when = $state('');
  let editing = $state<TinnitusEntry | null>(null);

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
      const [serverTags, serverEntries] = await Promise.all([fetchTags(), compact ? Promise.resolve([]) : fetchEntries()]);
      tags = serverTags.map((t) => t.name);
      tagIds = Object.fromEntries(serverTags.map((t) => [t.name, t.id]));
      entries = serverEntries;
      cacheTags();
    } catch {
      loadCachedTags();
    }
  }

  function mergeEntries(incoming: TinnitusEntry[]) {
    const incomingIds = new Set(incoming.map((e) => e.id));
    entries = [...entries.filter((e) => !incomingIds.has(e.id)), ...incoming].sort(
      (a, b) => b.recordedAt - a.recordedAt || b.id - a.id,
    );
  }

  function submit() {
    let recordedAt = Date.now();
    if (backdating) {
      const parsed = fromLocalInput(when);
      if (parsed === null) {
        toast.show('Pick a valid time, or switch back to now.', 'error');
        return;
      }
      if (parsed > recordedAt + TINNITUS_FUTURE_TOLERANCE_MS) {
        toast.show("That time hasn't happened yet.", 'error');
        return;
      }
      recordedAt = parsed;
    }
    const entry: PendingEntry = {
      clientId: newClientId(),
      recordedAt,
      intensity: value,
      tags: [...selected],
      notes: notes.trim() || null,
    };
    outbox.add(entry);

    // Tags, notes and the time override clear; the slider stays where it is.
    selected = [];
    notes = '';
    backdating = false;
    toast.show(`Logged ${entry.intensity}`);
  }

  function addTag(name: string) {
    tags = [...tags, name];
    cacheTags();
    // Best effort: if this fails, the entry that uses the tag creates it on sync.
    createTag(name)
      .then((t) => (tagIds = { ...tagIds, [t.name]: t.id }))
      .catch(() => {});
  }

  async function removeTag(name: string) {
    const id = tagIds[name];
    try {
      if (id !== undefined) await hideTag(id);
      tags = tags.filter((t) => t !== name);
      selected = selected.filter((t) => t !== name);
      cacheTags();
    } catch {
      toast.show("Couldn't hide that tag. Check the connection.", 'error');
    }
  }

  function toggleBackdate() {
    backdating = !backdating;
    if (backdating) when = toLocalInput(Date.now());
  }

  onMount(() => {
    // `start` loads any persisted queue and wires the retry triggers; flush after the server load
    // resolves, as before, so a sync folds into freshly fetched entries.
    const teardown = outbox.start();
    void load().then(() => outbox.flush());
    return teardown;
  });
</script>

{#snippet capture()}
<div class="tinnitus" class:compact>
  <TagCloud {tags} bind:selected {compact} editable={!compact} onAdd={addTag} onHide={removeTag} />

  <div class="reading">
    <output class="value-block" aria-live="polite">
      <span class="value">{value}</span>
      <!-- Always rendered, so the slider doesn't jump when 0 (no label) is reached. -->
      <span class="label">{tinnitusLabel(value) ?? '\u00a0'}</span>
    </output>
    <IntensitySlider bind:value {compact} />
  </div>

  <!-- Notes and backdating on the card too (PD-716); only tag editing and history are page-only. -->
  <textarea class="notes" rows={compact ? 1 : 2} placeholder="Notes" aria-label="Notes" bind:value={notes}></textarea>

  <div class="when">
    <button type="button" class="when-toggle" aria-expanded={backdating} onclick={toggleBackdate}>
      {backdating ? 'Use now' : 'Now ▾'}
    </button>
    {#if backdating}
      <input type="datetime-local" aria-label="When" bind:value={when} max={toLocalInput(Date.now())} />
    {/if}
  </div>

  <button type="button" class="enter" onclick={submit}>Enter</button>

  {#if pending.length > 0}
    <p class="pending" role="status">{pending.length} pending sync</p>
  {/if}

  <!-- No "History" link on the card: the card's own title already links to the page. -->
  {#if !compact}
    <section class="history" aria-label="Recent entries">
      <EntryList {entries} {pending} onEdit={(e) => (editing = e)} />
    </section>
    <EntryEditModal
      entry={editing}
      {tags}
      onClose={() => (editing = null)}
      onSaved={(e) => {
        mergeEntries([e]);
        editing = null;
      }}
      onDeleted={(id) => {
        entries = entries.filter((e) => e.id !== id);
        editing = null;
      }}
    />
  {/if}
</div>
{/snippet}

{#if compact}
  {@render capture()}
{:else}
  <!-- Log | Trends (PD-706). Trends mounts on selection, so it refetches and includes new entries. -->
  <Tabs tabs={TABS} bind:active={tab} storeKey="tinnitus-tracker" label="Tinnitus Tracker sections">
    {#snippet panel(id)}
      {#if id === 'trends'}
        <TrendsView />
      {:else}
        {@render capture()}
      {/if}
    {/snippet}
  </Tabs>
{/if}

<style lang="scss" src="./TinnitusTracker.scss"></style>
