<script lang="ts">
  import type { AgentTicket } from '@dashboard/shared';
  import { PRIORITY_LABELS } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';
  import type { SpinOffPlan } from '../epic-spinoff';

  /**
   * Spin a Ticket out into its own Epic (D-TMP-PD383a slice C).
   *
   * The name is editable rather than auto-derived-and-done: the Epic ends up on a band you scan by
   * eye, and a wall of Epics named after single tickets is the failure mode this is one step away
   * from. Priority and lane are shown but not editable here — they are inherited on purpose, so
   * that spinning a ticket out of a queued Epic cannot silently un-queue it.
   */
  let {
    ticket,
    plan,
    sourceEpic,
    busy = false,
    onCancel,
    onConfirm,
  }: {
    /** The Ticket being spun out; null closes the modal. */
    ticket: AgentTicket | null;
    plan: SpinOffPlan;
    sourceEpic: AgentTicket | undefined;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: (title: string) => void;
  } = $props();

  let title = $state('');
  // Re-seed each time the modal opens on a different ticket.
  let seededFor = $state<number | null>(null);
  $effect(() => {
    if (ticket && seededFor !== ticket.id) {
      title = plan.title;
      seededFor = ticket.id;
    }
    if (!ticket) seededFor = null;
  });
</script>

<Modal open={ticket !== null} title="Spin off into a new Epic" onClose={onCancel}>
  {#if ticket}
    <p class="spin-intro">
      <strong>{ticket.displayId ?? ticket.title}</strong> leaves
      {#if sourceEpic}<strong>{sourceEpic.displayId}</strong>{:else}its current place{/if}
      and becomes the first member of a new Epic.
    </p>

    <label class="spin-field">
      <span>Epic name</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="text" bind:value={title} autofocus />
    </label>

    <dl class="spin-inherits">
      <div>
        <dt>Priority</dt>
        <dd>
          {#if plan.priority}
            {plan.priority} · {PRIORITY_LABELS[plan.priority]}
          {:else}
            — None
          {/if}
          <span class="spin-from">
            from {plan.inheritedFrom === 'epic' ? (sourceEpic?.displayId ?? 'its Epic') : 'the ticket'}
          </span>
        </dd>
      </div>
      <div>
        <dt>Lane</dt>
        <dd>
          {plan.status === 'queue' ? 'Queue' : 'Backlog'}
          <span class="spin-from">
            {plan.status === 'queue'
              ? 'inherited, so the work is not un-queued by moving it'
              : 'inherited'}
          </span>
        </dd>
      </div>
    </dl>

    <div class="spin-actions">
      <Button variant="ghost" onclick={onCancel} disabled={busy}>Cancel</Button>
      <span class="spacer"></span>
      <Button variant="primary" onclick={() => onConfirm(title)} disabled={busy || !title.trim()}>
        Create Epic &amp; move
      </Button>
    </div>
  {/if}
</Modal>

<style lang="scss">
  .spin-intro {
    margin: 0 0 var(--space-lg);
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
  }

  .spin-field {
    display: block;
    margin-bottom: var(--space-lg);

    span {
      display: block;
      font-size: var(--font-size-xs);
      color: var(--muted);
      margin-bottom: var(--space-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    input {
      width: 100%;
      font-family: var(--font-sans);
      font-size: var(--font-size-base);
      color: var(--text);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: var(--space-sm);

      &:focus {
        outline: none;
        border-color: var(--accent);
      }
    }
  }

  .spin-inherits {
    margin: 0 0 var(--space-lg);
    padding: var(--space-sm) var(--space-md);
    background: var(--surface-2);
    border-radius: var(--radius);

    div {
      display: flex;
      align-items: baseline;
      gap: var(--space-sm);
      padding: var(--space-xs) 0;
    }

    dt {
      flex: 0 0 5rem;
      font-size: var(--font-size-xs);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }

    dd {
      margin: 0;
      font-size: var(--font-size-sm);
      color: var(--text);
    }
  }

  .spin-from {
    margin-left: var(--space-xs);
    font-size: var(--font-size-xs);
    color: var(--muted);
  }

  .spin-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);

    .spacer {
      flex: 1;
    }
  }
</style>
