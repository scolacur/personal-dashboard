<script lang="ts">
  import type {
    AgentTicket,
    AutoQueueEligibilityResponse,
    TicketAssignee,
  } from '@dashboard/shared';
  import { AUTO_QUEUE_CRITERIA, AUTO_QUEUE_CAPACITY_DEFS } from '@dashboard/shared';
  import { buildChecklistView } from './queue-eligibility-view';

  /**
   * The auto-queue eligibility checklist (D-103, PD-809): a flat list of ✓/✗ criteria with the
   * promoter's verdict on top and the board/worker-wide capacity rows at the bottom, exactly what the
   * promoter judges against. Read-only apart from remedy links. Shared so the ticket/Epic detail page
   * and the board's criteria modal render the same answer.
   *
   * With `definitions` set it renders instead a plain label + one-line description for every criterion
   * and capacity limit from the exported definitions — no ✓/✗, no verdict, no live counts. That is the
   * mode the board's "Queue eligibility criteria" modal uses (PD-810): a reference list of the rules,
   * not a verdict on one ticket.
   *
   * All derivation lives in `queue-eligibility-view.ts` (pure, tested); this only paints the model.
   */
  const {
    data,
    definitions = false,
    assignee = null,
    members = [],
    ticketHref,
  }: {
    /** The `GET …/queue-eligibility` payload for this ticket or Epic. Omitted in `definitions` mode. */
    data?: AutoQueueEligibilityResponse;
    /** Render the static criterion/capacity definitions rather than a ticket's verdict (PD-810). */
    definitions?: boolean;
    /** The ticket's assignee — splits the two human-work verdicts. Ignored in `definitions` mode. */
    assignee?: TicketAssignee | null;
    /** The Epic's member Tickets, to label and link the roll-up (ignored for a member Ticket). */
    members?: readonly AgentTicket[];
    /** Resolve a ticket id to a detail-page href, or null to render it without a link (e.g. self). */
    ticketHref: (ticketId: number) => string | null;
  } = $props();

  const view = $derived(
    data
      ? buildChecklistView({
          isEpic: data.isEpic,
          assignee,
          mode: data.mode,
          eligibility: data.eligibility,
          epicEligibility: data.epicEligibility,
          capacity: data.capacity,
          members,
          ticketHref,
        })
      : null,
  );
</script>

{#if definitions}
  <section class="qec qec-defs" aria-label="Queue eligibility criteria">
    <ul class="rows">
      {#each AUTO_QUEUE_CRITERIA as c (c.id)}
        <li>
          <span class="body"><span class="label">{c.label}</span>
            <span class="reason">— {c.description}</span></span>
        </li>
      {/each}
    </ul>
    <div class="divider"><span>capacity</span></div>
    <ul class="rows">
      {#each AUTO_QUEUE_CAPACITY_DEFS as c (c.id)}
        <li>
          <span class="body"><span class="label">{c.label}</span>
            <span class="reason">— {c.description}</span></span>
        </li>
      {/each}
    </ul>
  </section>
{:else if view}
<section class="qec" aria-label="Auto-queue eligibility">
  <h3>Auto-queue</h3>

  <p class="verdict verdict-{view.verdictTone}">{view.verdictLine}</p>
  {#if view.modeNote}
    <p class="mode-note">{view.modeNote}</p>
  {/if}

  <ul class="rows">
    {#each view.criteria as c (c.id)}
      <li class:unmet={!c.met}>
        <span class="mark" aria-hidden="true">{c.mark}</span>
        <span class="body">
          <span class="label">{c.label}</span>
          {#if !c.met && c.reason}
            <span class="reason">
              — {#if c.href}<a href={c.href}>{c.reason}</a>{:else}{c.reason}{/if}
            </span>
          {/if}
        </span>
      </li>
    {/each}
  </ul>

  {#if view.showCapacity}
    <div class="divider"><span>capacity</span></div>
    <ul class="rows">
      {#each view.capacity as r (r.id)}
        <li class:unmet={!r.met}>
          <span class="mark" aria-hidden="true">{r.mark}</span>
          <span class="body">
            <span class="label">{r.label}</span>
            {#if !r.met && r.reason}<span class="reason">— {r.reason}</span>{/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if view.isEpic}
    <p class="rollup">{view.rollup}</p>
    <ul class="members">
      {#each view.members ?? [] as m (m.ticketId)}
        <li>
          <span class="mark" aria-hidden="true">{m.mark}</span>
          <span class="body">
            {#if m.href}
              <a class="label" href={m.href}>{m.displayId ? `${m.displayId} ` : ''}{m.title}</a>
            {:else}
              <span class="label">{m.displayId ? `${m.displayId} ` : ''}{m.title}</span>
            {/if}
            <span class="mverdict">{m.verdictShort}</span>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>
{/if}

<style lang="scss" src="./QueueEligibilityChecklist.scss"></style>
