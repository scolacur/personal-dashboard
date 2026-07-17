<script lang="ts">
  import { marked } from 'marked';
  import type { AgentRun, RobotFaultTier, RobotRunStatus } from '@dashboard/shared';
  import { fetchTicketRuns } from '../routes/task-monitor/api';
  import Collapsible from './Collapsible.svelte';

  // Robot run history for a ticket (C3/PD-344). Self-fetching like TicketThread. The loop is
  // off by default, so most tickets have no runs — this renders nothing until there are any.
  const { ticketId }: { ticketId: number } = $props();

  let runs = $state<AgentRun[]>([]);
  let loading = $state(true);

  async function load(): Promise<void> {
    try {
      runs = await fetchTicketRuns(ticketId);
    } catch {
      runs = []; // a failed fetch just renders nothing — observability is non-critical
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (ticketId) load();
  });

  const STATUS_LABEL: Record<RobotRunStatus, string> = {
    running: 'Running',
    'handed-off': 'Handed off',
    'no-verify': 'No verify',
    'ask-human': 'Asked human',
    error: 'Error',
  };

  const TIER_LABEL: Record<RobotFaultTier, string> = {
    transient: 'Transient',
    deterministic: 'Deterministic',
    'system-wide': 'System-wide',
  };

  // The Robot's outstanding question, from the newest ask-human run (PD-255 — render inline).
  const askHuman = $derived(runs.find((r) => r.status === 'ask-human' && r.faultReason)?.faultReason ?? null);

  // The most recent failed run's reason, surfaced as a callout so "why did it fail" is one glance.
  const latestFailure = $derived(
    runs.find((r) => (r.status === 'error' || r.status === 'no-verify') && r.faultReason) ?? null,
  );

  function fmt(ts: number | null): string {
    return ts ? new Date(ts).toLocaleString() : '—';
  }

  function duration(r: AgentRun): string {
    if (!r.finishedAt) return '—';
    const s = Math.round((r.finishedAt - r.startedAt) / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function renderMd(node: HTMLElement, text: string) {
    node.innerHTML = marked.parse(text) as string;
    return { update: (t: string) => (node.innerHTML = marked.parse(t) as string) };
  }
</script>

{#if !loading && runs.length > 0}
  <section class="run-history">
    <!-- The ask_human question stays always-visible (it needs an answer); the run table lives
         inside the collapsible "Runs" section so a long history can be folded away. -->
    {#if askHuman}
      <div class="ask-human" role="status">
        <div class="ah-head">❓ The Robot asked for input</div>
        <div class="ah-body prose" use:renderMd={askHuman}></div>
      </div>
    {/if}

    {#if latestFailure}
      <div class="latest-failure tier-{latestFailure.faultTier ?? 'transient'}">
        <span class="lf-label">Latest failure</span>
        {#if latestFailure.faultTier}<span class="tier-badge">{TIER_LABEL[latestFailure.faultTier]}</span>{/if}
        <span class="lf-reason">{latestFailure.faultReason}</span>
      </div>
    {/if}

    <Collapsible title="Runs" count={runs.length} storeKey="runs">
    <div class="runs-scroll">
      <table class="runs-table">
        <thead>
          <tr>
            <th>#</th><th>Status</th><th>Fault</th><th>Reason</th>
            <th>Turns</th><th>Tokens</th><th>Dur</th><th>PR</th><th>Started</th>
          </tr>
        </thead>
        <tbody>
          {#each runs as r, i (r.id)}
            <tr>
              <td class="num">{runs.length - i}</td>
              <td><span class="status-badge status-{r.status}">{STATUS_LABEL[r.status] ?? r.status}</span></td>
              <td>
                {#if r.faultTier}<span class="tier-badge tier-{r.faultTier}">{TIER_LABEL[r.faultTier]}</span>{:else}—{/if}
              </td>
              <td class="reason" title={r.faultReason ?? r.error ?? ''}>{r.faultReason ?? r.error ?? '—'}</td>
              <td class="num">{r.turns ?? '—'}</td>
              <td class="num">{r.tokens != null ? r.tokens.toLocaleString() : '—'}</td>
              <td class="num">{duration(r)}</td>
              <td>{#if r.prUrl}<a href={r.prUrl} target="_blank" rel="noreferrer">PR</a>{:else}—{/if}</td>
              <td class="when">{fmt(r.startedAt)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    </Collapsible>
  </section>
{/if}

<style lang="scss" src="./RunHistory.scss"></style>
