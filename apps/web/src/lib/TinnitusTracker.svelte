<script lang="ts">
  import { onMount } from 'svelte';
  import { TINNITUS_DEFAULT_TAGS, TINNITUS_FUTURE_TOLERANCE_MS, type TinnitusEntry } from '@dashboard/shared';
  import { toast } from '$lib/toast-store.svelte';
  import { createEntry, createTag, fetchEntries, fetchTags, hideTag } from '../routes/widgets/tinnitus-tracker/api';
  import { flushPending, loadPending, newClientId, savePending, type PendingEntry } from '../routes/widgets/tinnitus-tracker/queue';
  import { fromLocalInput, toLocalInput } from '../routes/widgets/tinnitus-tracker/time';
  import IntensitySlider from '../routes/widgets/tinnitus-tracker/IntensitySlider.svelte';
  import TagCloud from '../routes/widgets/tinnitus-tracker/TagCloud.svelte';
  import EntryList from '../routes/widgets/tinnitus-tracker/EntryList.svelte';
  import EntryEditModal from '../routes/widgets/tinnitus-tracker/EntryEditModal.svelte';

  /**
   * Tinnitus Tracker (PD-705). `page` is the mobile-first full screen. `widget` is the dashboard
   * card: the same capture with no notes, backdating, or history.
   *
   * Every Enter goes through the offline queue (see `queue.ts`), so a reading taken with no signal
   * keeps its timestamp and syncs when the server is reachable again.
   */
  interface Props {
    variant: 'widget' | 'page';
  }

  let { variant }: Props = $props();
  const compact = $derived(variant === 'widget');

  const TAGS_CACHE_KEY = 'tinnitus-tracker:tags';
  const RETRY_MS = 20_000;

  // id per tag name, for hiding. Absent for a tag added offline that the server hasn't confirmed.
  let tagIds = $state<Record<string, number>>({});
  let tags = $state<string[]>([...TINNITUS_DEFAULT_TAGS]);
  let entries = $state<TinnitusEntry[]>([]);
  let pending = $state<PendingEntry[]>([]);
  let flushing = false;

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

  async function flush() {
    if (flushing || pending.length === 0) return;
    flushing = true;
    const snapshot = pending;
    try {
      const r = await flushPending(snapshot, createEntry);
      // Anything entered while the flush was in flight was appended after the snapshot; keep it.
      pending = [...r.remaining, ...pending.slice(snapshot.length)];
      savePending(pending);
      if (!compact) mergeEntries(r.sent);
      for (const { message } of r.rejected) toast.show(`An entry was refused: ${message}`, 'error', 6000);
    } finally {
      flushing = false;
    }
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
    pending = [...pending, entry];
    savePending(pending);

    // Tags, notes and the time override clear; the slider stays where it is.
    selected = [];
    notes = '';
    backdating = false;
    toast.show(`Logged ${entry.intensity}`);
    void flush();
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
    pending = loadPending();
    void load().then(flush);

    const retry = () => void flush();
    const onVisible = () => document.visibilityState === 'visible' && retry();
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => pending.length > 0 && retry(), RETRY_MS);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  });
</script>

<div class="tinnitus" class:compact>
  <TagCloud {tags} bind:selected {compact} onAdd={addTag} onHide={removeTag} />

  <div class="reading">
    <output class="value" aria-live="polite">{value}</output>
    <IntensitySlider bind:value {compact} />
  </div>

  {#if !compact}
    <textarea class="notes" rows="2" placeholder="Notes" aria-label="Notes" bind:value={notes}></textarea>

    <div class="when">
      <button type="button" class="when-toggle" aria-expanded={backdating} onclick={toggleBackdate}>
        {backdating ? 'Use now' : 'Now ▾'}
      </button>
      {#if backdating}
        <input type="datetime-local" aria-label="When" bind:value={when} max={toLocalInput(Date.now())} />
      {/if}
    </div>
  {/if}

  <button type="button" class="enter" onclick={submit}>Enter</button>

  {#if pending.length > 0}
    <p class="pending" role="status">{pending.length} pending sync</p>
  {/if}

  {#if compact}
    <a class="more" href="/widgets/tinnitus-tracker">History →</a>
  {:else}
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

<style lang="scss" src="./TinnitusTracker.scss"></style>
