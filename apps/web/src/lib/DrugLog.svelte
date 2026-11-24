<script lang="ts">
  import { onMount } from 'svelte';
  import {
    DRUG_LOG_DEFAULT_DRUG,
    DRUG_LOG_FALLBACK_DAY_SETTINGS,
    habitDay,
    isValidDayBoundaryMinutes,
    isValidTimezone,
    type DrugLogDrug,
    type DrugLogEvent,
    type HabitSettings,
  } from '@dashboard/shared';
  import { toast } from '$lib/toast-store.svelte';
  import { createOutbox } from '$lib/outbox';
  import Tabs from '$lib/Tabs.svelte';
  import {
    deleteEvent,
    fetchDrugs,
    fetchEvents,
    RejectedError,
    createEvent,
  } from '../routes/widgets/drug-log/api';
  import { newClientId, QUEUE_KEY, type PendingTap } from '../routes/widgets/drug-log/queue';
  import {
    activeDrugs,
    countsForDay,
    mergeEvents,
    TODAY_LOOKBACK_MS,
  } from '../routes/widgets/drug-log/drug-log';
  import DrugButtons from '../routes/widgets/drug-log/DrugButtons.svelte';
  import ButtonsPanel from '../routes/widgets/drug-log/ButtonsPanel.svelte';
  import LogView from '../routes/widgets/drug-log/LogView.svelte';

  /**
   * Drug Log (PD-975, Drug log widget) — a tap counter for what Steve's video-game character does.
   * `widget` is the dashboard card: the button grid with today's badges and the undo toast, nothing
   * else. `page` adds Buttons (with edit mode) | Log tabs.
   *
   * Every tap goes through the offline outbox with a client id (the server is idempotent on it), so
   * a tap with no signal keeps its real timestamp. Undo drops a still-queued tap from the outbox, or
   * deletes the synced event; a tap undone while its send is in flight is deleted when the send
   * lands (`cancelled`).
   *
   * "Today" is a habit day under the Habit Tracker's settings, which `GET /drugs` returns and this
   * caches for offline use.
   */
  interface Props {
    variant: 'widget' | 'page';
  }

  let { variant }: Props = $props();
  const compact = $derived(variant === 'widget');

  const DRUGS_CACHE_KEY = 'drug-log:drugs';
  const SETTINGS_CACHE_KEY = 'drug-log:day-settings';
  const UNDO_MS = 5000;

  // A placeholder until the server (or the cache) answers, so the card isn't blank on first paint.
  const PLACEHOLDER: DrugLogDrug = {
    id: -1,
    label: DRUG_LOG_DEFAULT_DRUG.label,
    color: DRUG_LOG_DEFAULT_DRUG.color,
    sortOrder: 0,
    archivedAt: null,
    createdAt: 0,
    eventCount: 0,
  };

  let drugs = $state<DrugLogDrug[]>([]);
  let loaded = $state(false);
  let settings = $state<HabitSettings>(DRUG_LOG_FALLBACK_DAY_SETTINGS);
  /** Synced events from roughly the last day — enough for today's badges. */
  let recent = $state<DrugLogEvent[]>([]);
  let pending = $state<PendingTap[]>([]);
  // The "N pending sync" line reads the outbox's delayed-visible signal, so a tap that syncs
  // normally never flashes it (PD-778). `pending` stays the raw queue, for today's counts.
  let visiblePending = $state<PendingTap[]>([]);
  let now = $state(Date.now());
  /** Client ids undone while their send may still be in flight. Bookkeeping only — nothing renders
   *  from it — so a plain Set is deliberate. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const cancelled = new Set<string>();

  const today = $derived(habitDay(now, settings));
  const counts = $derived(countsForDay([...recent, ...pending], today, settings));
  const gridDrugs = $derived(activeDrugs(drugs));

  const TABS = [
    { id: 'buttons', label: 'Buttons' },
    { id: 'log', label: 'Log' },
  ];
  let tab = $state('buttons');

  const outbox = createOutbox<PendingTap, DrugLogEvent>({
    key: QUEUE_KEY,
    send: createEvent,
    isRejected: (e) => e instanceof RejectedError,
    onChange: (list) => (pending = list),
    onVisibleChange: (list) => (visiblePending = list),
    onSent: (sent) => {
      const kept: DrugLogEvent[] = [];
      for (const e of sent) {
        if (cancelled.has(e.clientId)) {
          cancelled.delete(e.clientId);
          deleteEvent(e.id).catch(() =>
            toast.show("Couldn't undo that tap. Delete it from the Log.", 'error', 6000),
          );
        } else {
          kept.push(e);
        }
      }
      recent = mergeEvents(recent, kept);
      if (!compact) void refreshDrugs();
    },
    onRejected: (_entry, message) => toast.show(`A tap was refused: ${message}`, 'error', 6000),
  });

  function readCache<T>(key: string, valid: (v: unknown) => v is T): T | null {
    try {
      const raw = localStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return valid(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeCache(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // per-device convenience only
    }
  }

  const isDrugList = (v: unknown): v is DrugLogDrug[] =>
    Array.isArray(v) &&
    v.every(
      (d) => typeof d === 'object' && d !== null && typeof (d as DrugLogDrug).id === 'number',
    );
  const isSettings = (v: unknown): v is HabitSettings =>
    typeof v === 'object' &&
    v !== null &&
    isValidDayBoundaryMinutes((v as HabitSettings).dayBoundaryMinutes) &&
    isValidTimezone((v as HabitSettings).timezone);

  async function refreshDrugs(): Promise<void> {
    try {
      const res = await fetchDrugs();
      drugs = res.drugs;
      settings = res.daySettings;
      writeCache(DRUGS_CACHE_KEY, drugs);
      writeCache(SETTINGS_CACHE_KEY, settings);
    } finally {
      loaded = true;
    }
  }

  async function refreshRecent(): Promise<void> {
    recent = await fetchEvents({ since: Date.now() - TODAY_LOOKBACK_MS, limit: 10_000 });
  }

  async function load(): Promise<void> {
    drugs = readCache(DRUGS_CACHE_KEY, isDrugList) ?? [];
    settings = readCache(SETTINGS_CACHE_KEY, isSettings) ?? DRUG_LOG_FALLBACK_DAY_SETTINGS;
    try {
      await Promise.all([refreshDrugs(), refreshRecent()]);
    } catch {
      // Offline: the cached grid still logs taps into the outbox.
    }
  }

  function tap(drug: DrugLogDrug): void {
    if (drug.id < 0) return; // placeholder before the first load
    const entry: PendingTap = { clientId: newClientId(), drugId: drug.id, recordedAt: Date.now() };
    outbox.add(entry);
    try {
      navigator.vibrate?.(12);
    } catch {
      // not supported — fine
    }
    toast.show(`Logged ${drug.label}`, 'info', UNDO_MS, {
      label: 'Undo',
      onClick: () => void undo(entry.clientId, drug.label),
    });
  }

  async function undo(clientId: string, label: string): Promise<void> {
    // Still queued (or mid-send): drop it, and remember it in case the send lands anyway.
    if (outbox.remove((e) => e.clientId === clientId) > 0) {
      cancelled.add(clientId);
      toast.show(`Undid ${label}`);
      return;
    }
    const synced = recent.find((e) => e.clientId === clientId);
    if (!synced) return;
    try {
      await deleteEvent(synced.id);
      recent = recent.filter((e) => e.id !== synced.id);
      if (!compact) void refreshDrugs();
      toast.show(`Undid ${label}`);
    } catch {
      toast.show("Couldn't undo — check the connection, or delete it from the Log.", 'error', 6000);
    }
  }

  function onLogChanged(): void {
    void refreshRecent().catch(() => {});
    void refreshDrugs().catch(() => {});
  }

  onMount(() => {
    const teardown = outbox.start();
    void load().then(() => outbox.flush());
    // Keep "today" current across the day boundary on a long-open page.
    const clock = setInterval(() => (now = Date.now()), 60_000);
    return () => {
      teardown();
      clearInterval(clock);
    };
  });
</script>

{#snippet pendingLine()}
  {#if visiblePending.length > 0}
    <p class="pending" role="status">{visiblePending.length} pending sync</p>
  {/if}
{/snippet}

{#if compact}
  <div class="drug-log compact">
    {#if loaded && gridDrugs.length === 0}
      <p class="empty">No buttons. Add one on the Drug Log page.</p>
    {:else}
      <DrugButtons
        drugs={loaded || drugs.length > 0 ? gridDrugs : [PLACEHOLDER]}
        {counts}
        compact
        onTap={tap}
      />
    {/if}
    {@render pendingLine()}
  </div>
{:else}
  <div class="drug-log">
    <Tabs tabs={TABS} bind:active={tab} storeKey="drug-log" label="Drug Log sections">
      {#snippet panel(id)}
        {#if id === 'log'}
          <LogView {drugs} {settings} {today} onChanged={onLogChanged} />
        {:else}
          <ButtonsPanel
            {drugs}
            {counts}
            onTap={tap}
            onDrugsChange={(next) => {
              drugs = next;
              writeCache(DRUGS_CACHE_KEY, next);
            }}
          />
          {@render pendingLine()}
        {/if}
      {/snippet}
    </Tabs>
  </div>
{/if}

<style lang="scss" src="./DrugLog.scss"></style>
