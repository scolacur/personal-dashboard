<script lang="ts">
  import type { AgentTicket, TicketPriority, TicketSurface } from '@dashboard/shared';
  import { TICKET_PRIORITIES, PRIORITY_LABELS } from '@dashboard/shared';
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';
  import TicketThread from './TicketThread.svelte';
  import { fileSurfaceTicket } from '../routes/devops/api';
  import { portal } from './portal';

  // The compose dialog behind every suggestion trigger (PD-578, In-widget prompt to ticket to
  // Robot — its front door): the widget card +, the page footer, and the app-wide nav button.
  // Whatever Steve types becomes a backlog ticket carrying `surface` as provenance. "Grill me
  // first" files the same ticket and opens a Refine session on it, rendered right here, so the ask
  // gets interrogated before it is shaped into work. Nothing in here can queue a ticket for the
  // Robot except Refine's own approve-and-queue, which is unchanged.
  const {
    open,
    surface,
    label,
    placeholder,
    onClose,
  }: {
    open: boolean;
    surface: TicketSurface;
    /** What the ticket is about, for the dialog title: a widget or page name, or "the app". */
    label: string;
    placeholder: string;
    onClose: () => void;
  } = $props();

  type Phase = 'compose' | 'filed' | 'grilling';

  // PD-836: suggestions used to land with no priority and sink to the bottom of the backlog.
  // Default to the middle level so a quick note still lands somewhere sensible; Steve bumps it
  // when it matters. The triage-inbox Epic is unclassified, so D-080 keeps this value.
  const DEFAULT_PRIORITY: TicketPriority = 'P3';

  let phase = $state<Phase>('compose');
  let text = $state('');
  let priority = $state<TicketPriority | ''>(DEFAULT_PRIORITY);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let ticket = $state<AgentTicket | null>(null);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  function reset() {
    phase = 'compose';
    text = '';
    priority = DEFAULT_PRIORITY;
    error = null;
    ticket = null;
  }

  // Every open starts a fresh draft.
  $effect(() => {
    if (open) reset();
  });

  // Focus the textarea once the modal has rendered it. The Modal focuses its own dialog on open,
  // so this runs after and takes focus into the field Steve came here to type in.
  $effect(() => {
    if (open && phase === 'compose' && textareaEl) queueMicrotask(() => textareaEl?.focus());
  });

  async function submit(refine: boolean) {
    if (busy || text.trim() === '') return;
    busy = true;
    error = null;
    try {
      const res = await fileSurfaceTicket({
        text,
        surface,
        refine,
        priority: priority === '' ? null : priority,
      });
      ticket = res.ticket;
      phase = refine ? 'grilling' : 'filed';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit(false);
    }
  }

  // A widget card sets `perspective`, which makes it the containing block for `position: fixed`
  // descendants — the modal would render trapped inside the card. `portal` moves the wrapper to
  // <body>, keeping it a true full-screen dialog wherever the trigger lives.

  const modalTitle = $derived(
    phase === 'grilling' && ticket ? `Grilling · ${ticket.displayId}` : `New ticket · ${label}`,
  );
</script>

<div use:portal>
  <Modal {open} title={modalTitle} size={phase === 'grilling' ? 'wide' : 'default'} {onClose}>
    <div class="wt">
      {#if phase === 'compose'}
        <textarea
          class="wt-input"
          rows="6"
          {placeholder}
          bind:value={text}
          bind:this={textareaEl}
          onkeydown={onKeydown}
          disabled={busy}
        ></textarea>
        <p class="wt-hint">
          The first line becomes the title. It goes to the backlog, in the triage inbox Epic.
          <kbd>⌘</kbd><kbd>↵</kbd> submits.
        </p>
        {#if error}<p class="wt-error" role="alert">{error}</p>{/if}
        <div class="wt-actions">
          <label class="wt-priority">
            <span>Priority</span>
            <select bind:value={priority} disabled={busy}>
              <option value="">— None</option>
              {#each TICKET_PRIORITIES as p (p)}
                <option value={p}>{p} · {PRIORITY_LABELS[p]}</option>
              {/each}
            </select>
          </label>
          <Button
            variant="ghost"
            disabled={busy || text.trim() === ''}
            title="File it, then open a Refine session that questions the ask before it becomes work"
            onclick={() => submit(true)}>Grill me first</Button
          >
          <Button
            variant="primary"
            disabled={busy || text.trim() === ''}
            onclick={() => submit(false)}
          >
            {busy ? 'Submitting…' : 'Submit ticket'}
          </Button>
        </div>
      {:else if phase === 'filed' && ticket}
        <p class="wt-done">
          Filed <a href="/devops/tickets/{ticket.displayId}" onclick={onClose}>{ticket.displayId}</a
          > to the backlog.
        </p>
        <p class="wt-done-title">{ticket.title}</p>
        <div class="wt-actions">
          <Button variant="ghost" onclick={reset}>File another</Button>
          <Button variant="primary" onclick={onClose}>Done</Button>
        </div>
      {:else if phase === 'grilling' && ticket}
        <p class="wt-hint">
          Filed <a href="/devops/tickets/{ticket.displayId}" onclick={onClose}>{ticket.displayId}</a
          > to the backlog. The Refine agent picks it up shortly; you can close this and keep going on
          the ticket's page.
        </p>
        <div class="wt-thread">
          <TicketThread ticketId={ticket.id} />
        </div>
      {/if}
    </div>
  </Modal>
</div>

<style lang="scss" src="./TicketComposeModal.scss"></style>
