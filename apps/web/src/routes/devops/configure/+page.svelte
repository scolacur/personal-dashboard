<script lang="ts">
  import { onMount } from 'svelte';
  import { WORKER_SETTING_GROUPS, type WorkerConfigEntry } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import { fetchWorkerConfig, resetWorkerSetting, saveWorkerSetting } from '../api';
  import {
    bootLabel,
    formatSettingValue,
    isOverridden,
    liveBadge,
    msInputUnit,
    parseInputText,
    toInputText,
  } from './configure-logic';

  // The Dev Ops Configuration page (PD-1006, D-121): every "set to taste" agent-worker tunable, with
  // its env/default value, a DB override, and the value in force. Live settings apply on the worker's
  // next pass; the rest say "applies on worker restart".
  let entries = $state<WorkerConfigEntry[]>([]);
  let workerBootAt = $state<number | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  // Per-row input text and per-row state, keyed by setting key.
  let drafts = $state<Record<string, string>>({});
  let rowErrors = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});

  function replaceEntry(next: WorkerConfigEntry) {
    entries = entries.map((e) => (e.key === next.key ? next : e));
    drafts = { ...drafts, [next.key]: toInputText(next, next.override) };
  }

  async function load() {
    try {
      const res = await fetchWorkerConfig();
      entries = res.entries;
      workerBootAt = res.workerBootAt;
      drafts = Object.fromEntries(res.entries.map((e) => [e.key, toInputText(e, e.override)]));
      loadError = null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function save(entry: WorkerConfigEntry) {
    const value = parseInputText(entry, drafts[entry.key] ?? '');
    if (value === null) {
      rowErrors = { ...rowErrors, [entry.key]: `${entry.key} must be a number.` };
      return;
    }
    busy = { ...busy, [entry.key]: true };
    try {
      replaceEntry(await saveWorkerSetting(entry.key, value));
      rowErrors = { ...rowErrors, [entry.key]: '' };
    } catch (e) {
      // The server's reason (bounds, type) is shown as-is.
      rowErrors = { ...rowErrors, [entry.key]: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = { ...busy, [entry.key]: false };
    }
  }

  async function reset(entry: WorkerConfigEntry) {
    busy = { ...busy, [entry.key]: true };
    try {
      replaceEntry(await resetWorkerSetting(entry.key));
      rowErrors = { ...rowErrors, [entry.key]: '' };
    } catch (e) {
      rowErrors = { ...rowErrors, [entry.key]: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = { ...busy, [entry.key]: false };
    }
  }

  onMount(() => {
    void load();
  });

  const groups = $derived(
    WORKER_SETTING_GROUPS.map((g) => ({ ...g, entries: entries.filter((e) => e.group === g.id) })).filter(
      (g) => g.entries.length > 0,
    ),
  );

  function inputSuffix(e: WorkerConfigEntry): string {
    if (e.unit === 'ms') return msInputUnit(e.default);
    return e.unit === 'count' ? '' : e.unit;
  }
</script>

<section class="configure-page">
  <header class="configure-head">
    <h1 class="configure-title">Configuration</h1>
    <a class="configure-back" href="/devops">← Dev Ops</a>
  </header>
  <p class="configure-sub">
    The agent-worker's budgets, intervals, caps and thresholds. The env file sets each one's default; a
    value saved here overrides it. <strong>Live</strong> settings apply on the worker's next pass. The rest
    apply on worker restart. Reset removes the override.
  </p>
  {#if !loading && !loadError && workerBootAt === null}
    <p class="configure-note">
      The worker hasn't reported its env values yet, so code defaults are shown. They fill in when it next starts.
    </p>
  {/if}

  {#if loading}
    <p class="configure-empty">Loading…</p>
  {:else if loadError}
    <p class="configure-error" role="alert">Could not load the configuration: {loadError}</p>
  {:else}
    {#each groups as group (group.id)}
      <h2 class="configure-section">{group.label}</h2>
      <ul class="configure-list">
        {#each group.entries as e (e.key)}
          <li class="setting" class:overridden={e.override !== null} data-key={e.key}>
            <div class="setting-main">
              <div class="setting-name">
                <span class="setting-label">{e.label}</span>
                <code class="setting-key">{e.key}</code>
                <span class="setting-badge" class:restart={!e.live}>{liveBadge(e)}</span>
                {#if e.readBy === 'server'}<span class="setting-badge server">web server</span>{/if}
              </div>
              <p class="setting-desc">{e.description}</p>
              <dl class="setting-values">
                <div>
                  <dt>Env / default</dt>
                  <dd>{bootLabel(e)}</dd>
                </div>
                <div>
                  <dt>Effective</dt>
                  <dd class="setting-effective">
                    {formatSettingValue(e.effective, e.unit)}
                    {#if e.override !== null}
                      <span class="setting-diff">
                        {isOverridden(e) ? 'overridden here' : 'override matches env'}
                      </span>
                    {/if}
                    {#if e.pendingRestart}
                      <span class="setting-pending">not in force until the worker restarts</span>
                    {/if}
                  </dd>
                </div>
              </dl>
            </div>
            <form
              class="setting-edit"
              onsubmit={(ev) => {
                ev.preventDefault();
                void save(e);
              }}
            >
              <label class="setting-input">
                <span class="visually-hidden">Override for {e.key}</span>
                <input
                  type="text"
                  inputmode="decimal"
                  placeholder="override"
                  bind:value={drafts[e.key]}
                  aria-invalid={rowErrors[e.key] ? 'true' : undefined}
                />
                {#if inputSuffix(e)}<span class="setting-unit">{inputSuffix(e)}</span>{/if}
              </label>
              <Button variant="primary" type="submit" disabled={busy[e.key]}>Save</Button>
              <Button variant="ghost" disabled={busy[e.key] || e.override === null} onclick={() => reset(e)}>
                Reset
              </Button>
            </form>
            {#if rowErrors[e.key]}
              <p class="setting-error" role="alert">{rowErrors[e.key]}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/each}
  {/if}
</section>

<style lang="scss" src="./+page.scss"></style>
