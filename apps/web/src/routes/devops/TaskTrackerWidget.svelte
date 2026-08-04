<script lang="ts">
  import type { AgentState, AgentTicket } from '@dashboard/shared';
  import { AGENT_STATE_LABELS } from '@dashboard/shared';
  import { formatRelativeTime } from '../deploy-status-utils';
  import { fetchTickets } from './api';

  // The "Task Tracker" summary card on the /devops overview (PD-413): what's being worked
  // right now, and what landed most recently. TicketCard itself isn't reused here — it's the
  // full board card (drag handlers, kebab actions, ~18 required props), far too heavy for a
  // read-only summary, so this renders compact rows off the same `fetchTickets` board data.

  const MAX_ACTIVE = 6;
  const MAX_SHIPPED = 4;
  const REFRESH_MS = 60_000;

  // Most-interesting-first, so a truncated list keeps the states worth acting on. Anything
  // unlisted (or a queued ticket with no agent state yet) sorts last.
  const STATE_ORDER: AgentState[] = [
    'stuck',
    'needs-human',
    'awaiting-human',
    'working',
    'in-review',
    'queued',
  ];

  let tickets = $state<AgentTicket[]>([]);
  let loaded = $state(false);
  let failed = $state(false);
  let now = $state(Date.now());

  async function load(): Promise<void> {
    try {
      tickets = await fetchTickets();
      failed = false;
    } catch {
      failed = true;
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    load();
    const timer = setInterval(() => {
      now = Date.now();
      load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  });

  const live = $derived(tickets.filter((t) => t.archivedAt === null));

  // In progress = the single `queue` lane (D-058); the agent state is what distinguishes
  // the rows within it.
  const active = $derived(
    live
      .filter((t) => t.status === 'queue')
      .sort((a, b) => {
        const rank = (t: AgentTicket) => {
          const i = t.agentState ? STATE_ORDER.indexOf(t.agentState) : -1;
          return i === -1 ? STATE_ORDER.length : i;
        };
        return rank(a) - rank(b) || a.sortOrder - b.sortOrder;
      })
      .slice(0, MAX_ACTIVE),
  );

  const shipped = $derived(
    live
      .filter((t) => t.status === 'completed')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SHIPPED),
  );

  function href(t: AgentTicket): string | undefined {
    return t.displayId ? `/devops/tickets/${t.displayId}` : undefined;
  }
</script>

<div class="tt-widget">
  {#if !loaded}
    <p class="tt-empty">Loading tickets…</p>
  {:else if failed}
    <p class="tt-empty">Couldn't reach the board.</p>
  {:else}
    <section class="tt-group">
      <h3 class="tt-group-title">In progress <span class="tt-count">{active.length}</span></h3>
      {#if active.length === 0}
        <p class="tt-empty">Nothing in the queue.</p>
      {:else}
        <ul class="tt-list">
          {#each active as t (t.id)}
            <li class="tt-row">
              <a class="tt-link" href={href(t)}>
                <span class="tt-id">{t.displayId ?? `#${t.id}`}</span>
                <span class="tt-title">{t.title}</span>
              </a>
              {#if t.agentState}
                <span class="tt-state agent-state-{t.agentState}">
                  <span class="dot" aria-hidden="true"></span>
                  {AGENT_STATE_LABELS[t.agentState]}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="tt-group">
      <h3 class="tt-group-title">Recently shipped</h3>
      {#if shipped.length === 0}
        <p class="tt-empty">Nothing shipped yet.</p>
      {:else}
        <ul class="tt-list">
          {#each shipped as t (t.id)}
            <li class="tt-row">
              <a class="tt-link" href={href(t)}>
                <span class="tt-id">{t.displayId ?? `#${t.id}`}</span>
                <span class="tt-title">{t.title}</span>
              </a>
              <span class="tt-when">{formatRelativeTime(t.updatedAt, now)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style lang="scss" src="./TaskTrackerWidget.scss"></style>
