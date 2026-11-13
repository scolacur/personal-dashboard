<script lang="ts">
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';
  import type { QueueCriterion } from '@dashboard/shared';
  import {
    epicAggregate,
    gateOutcome,
    ticketHref,
    type EpicGate,
    type GateRef,
    type TicketGate,
  } from '../queue-gate';

  /**
   * The Queue gate, rendered (PD-633, D-091). Every door into `queue ∧ robot` opens this one modal:
   * the criteria in `queueBlockers()` order, ✓ for met and ☐ for unmet, and against each unmet one
   * the control that satisfies it.
   *
   * Replaces two one-off modals: D-058's "queue an unformatted ticket?" confirm (now the `ready`
   * row plus a Confirm labelled as the bypass it is) and PD-611's stale-Epic refusal (now the
   * `epic-not-stale` row). Confirm is enabled only when no criterion refuses entry; `ready` alone
   * leaves it enabled, and confirming records `ready_bypassed` exactly as before.
   *
   * The decisions live in `queue-gate.ts`, which is tested. This file only lays them out.
   */
  let {
    gate,
    busy = false,
    fallback = null,
    onCancel,
    onConfirm,
    onMarkRefined,
    onRefine,
  }: {
    /** The answer to render; null closes the modal. */
    gate: TicketGate | EpicGate | null;
    busy?: boolean;
    /** A different write that does pass, e.g. "Create in Backlog" when creating into the Queue. */
    fallback?: { label: string; run: () => void } | null;
    onCancel: () => void;
    onConfirm: () => void;
    onMarkRefined: (ticketId: number) => void;
    onRefine: (ticketId: number) => void;
  } = $props();

  const outcome = $derived(gate ? gateOutcome(gate) : 'refuse');

  const title = $derived.by(() => {
    if (!gate) return '';
    if (outcome === 'refuse') {
      return gate.kind === 'epic' ? `${gate.label} can't be queued yet` : `${gate.label} can't go to the Robot yet`;
    }
    if (outcome === 'bypass') return `${gate.label} isn't formatted`;
    return `${gate.label} is clear to queue`;
  });

  // Without an Epic the shared predicate reports the three Epic rows as met "No Epic"; one is enough.
  const rows = $derived.by((): QueueCriterion[] => {
    if (!gate) return [];
    let seenNoEpic = false;
    return gate.criteria.filter((c) => {
      if (c.label !== 'No Epic') return true;
      if (seenNoEpic) return false;
      seenNoEpic = true;
      return true;
    });
  });

  const ticket = $derived(gate?.kind === 'ticket' ? gate.ticket : null);
  const epic = $derived(gate?.kind === 'ticket' ? gate.epic : gate?.kind === 'epic' ? gate.epic : null);

  const name = (r: GateRef) => r.displayId ?? r.title;
</script>

{#snippet link(r: GateRef | null, text: string)}
  {@const href = ticketHref(r)}
  {#if href}<a class="gate-link" {href} target="_blank" rel="noreferrer">{text}</a>{/if}
{/snippet}

{#snippet refs(list: GateRef[])}
  <span class="gate-refs">
    {#each list as r (r.id)}
      {@const href = ticketHref(r)}
      {#if href}<a class="gate-link" {href} target="_blank" rel="noreferrer" title={r.title}>{name(r)}</a>{:else}{r.title}{/if}
    {/each}
  </span>
{/snippet}

{#snippet remedy(c: QueueCriterion)}
  {#if c.id === 'refined'}
    {#if ticket}
      <Button variant="ghost" disabled={busy} onclick={() => onRefine(ticket.id)}>Refine</Button>
      <Button variant="ghost" disabled={busy} onclick={() => onMarkRefined(ticket.id)}>✓ Mark refined</Button>
    {:else}
      <span class="gate-note">A new ticket starts unrefined.</span>
    {/if}
  {:else if c.id === 'epic-refined' || c.id === 'epic-not-stale'}
    {#if gate?.kind === 'epic'}
      <Button variant="ghost" disabled={busy} onclick={() => gate && onRefine(gate.epic.id)}>Refine</Button>
      <Button variant="ghost" disabled={busy} onclick={() => gate && onMarkRefined(gate.epic.id)}>✓ Mark refined</Button>
    {:else}
      {@render link(epic, `Open ${epic ? name(epic) : 'the Epic'}`)}
    {/if}
  {:else if c.id === 'members-refined'}
    {#if gate?.kind === 'ticket'}
      {@render refs(gate.unrefinedMembers)}
    {/if}
    {#if gate?.kind === 'ticket'}{@render link(epic, 'Open the Epic')}{/if}
  {:else if c.id === 'ready'}
    {@render link(ticket, 'Edit the body')}
  {:else if c.id === 'unblocked'}
    {#if gate?.kind === 'ticket'}{@render refs(gate.blockers)}{/if}
  {/if}
{/snippet}

<Modal open={gate !== null} {title} size="wide" onClose={onCancel}>
  {#if gate !== null}
    {#if gate.kind === 'epic'}
      <p class="gate-msg">
        Queueing <strong>{gate.epic.title}</strong> arms its Robot members.
        <strong>{epicAggregate(gate)}</strong>.
      </p>
    {:else if outcome === 'refuse'}
      <p class="gate-msg">
        Robot work enters the Queue only once it has been read through and agreed. Fix the unticked
        rows below — most can be fixed from here.
      </p>
    {:else if outcome === 'bypass'}
      <p class="gate-msg">
        The body is missing one of the four sections (## Context / ## Task / ## Done When / ## Out of
        scope). The Robot works best from a formatted ticket, so <strong>output may be
        suboptimal</strong>. You can still queue it.
      </p>
    {/if}

    <ul class="gate-criteria">
      {#each rows as c (c.id)}
        <li class="gate-row" class:met={c.met} class:soft={!c.met && !c.refusesEntry}>
          <span class="gate-mark" aria-label={c.met ? 'met' : 'not met'}>{c.met ? '✓' : '☐'}</span>
          <span class="gate-label">
            {c.label}
            {#if !c.met && !c.refusesEntry}<span class="gate-note">— does not stop it queueing</span>{/if}
          </span>
          {#if !c.met}<span class="gate-remedy">{@render remedy(c)}</span>{/if}
        </li>
      {/each}
    </ul>

    {#if gate.kind === 'epic' && gate.members.length > 0}
      <h4 class="gate-subhead">Members with something unmet</h4>
      <ul class="gate-members">
        {#each gate.members as row (row.member.id)}
          <li>
            {@render refs([row.member])}
            <span class="gate-member-title">{row.member.title}</span>
            <span class="gate-note">{row.unmet.map((c) => c.label.replace(/^This ticket is |^The body /, '')).join(' · ')}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="gate-actions">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <span class="spacer"></span>
      {#if fallback && outcome === 'refuse'}
        <Button variant="ghost" disabled={busy} onclick={fallback.run}>{fallback.label}</Button>
      {/if}
      <Button variant="primary" disabled={busy || outcome === 'refuse'} onclick={onConfirm}>
        {outcome === 'bypass' ? 'Queue unformatted' : 'Queue'}
      </Button>
    </div>
  {/if}
</Modal>

<style lang="scss">
  .gate-msg {
    margin: 0 0 var(--space-md);
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
  }

  .gate-criteria,
  .gate-members {
    list-style: none;
    margin: 0 0 var(--space-md);
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
  }

  .gate-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-sm);
    font-size: var(--font-size-sm);
    color: var(--text);

    .gate-mark {
      width: 1.25em;
      text-align: center;
      color: var(--muted);
    }

    &.met {
      color: var(--muted);

      .gate-mark {
        color: var(--status-done);
      }
    }

    &.soft .gate-mark {
      color: var(--status-warn);
    }

    .gate-label {
      flex: 1;
      min-width: 12rem;
    }
  }

  .gate-remedy,
  .gate-refs {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-xs);
  }

  .gate-link {
    font-size: var(--font-size-xs);
    color: var(--accent);
  }

  .gate-note {
    font-size: var(--font-size-xs);
    color: var(--muted);
  }

  .gate-subhead {
    margin: var(--space-md) 0 var(--space-xs);
    font-size: var(--font-size-xs);
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .gate-members li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-sm);
    font-size: var(--font-size-sm);

    .gate-member-title {
      flex: 1;
      min-width: 10rem;
      color: var(--text);
    }
  }

  .gate-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;

    .spacer {
      flex: 1;
    }
  }
</style>
