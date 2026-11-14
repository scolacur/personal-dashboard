<script lang="ts">
  import type { AgentTicket } from '@dashboard/shared';
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';
  import TicketThread from './TicketThread.svelte';
  import { fileWidgetTicket } from '../routes/devops/api';

  // The + floating in a widget card's bottom-left corner (PD-578, In-widget prompt to ticket to
  // Robot — its front door). Whatever Steve types becomes a backlog ticket carrying the widget as
  // provenance. "Grill me first" files the same ticket and opens a Refine session on it, rendered
  // right here, so the ask gets interrogated before it is shaped into work. Nothing in here can
  // queue a ticket for the Robot except Refine's own approve-and-queue, which is unchanged.
  const {
    widgetId,
    widgetTitle,
    route,
  }: { widgetId: string; widgetTitle: string; route: string } = $props();

  type Phase = 'compose' | 'filed' | 'grilling';

  let open = $state(false);
  let phase = $state<Phase>('compose');
  let text = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let ticket = $state<AgentTicket | null>(null);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  function reset() {
    phase = 'compose';
    text = '';
    error = null;
    ticket = null;
  }

  function openModal(e: MouseEvent) {
    // The card's stretched link sits underneath; never let this click navigate.
    e.preventDefault();
    e.stopPropagation();
    reset();
    open = true;
  }

  function close() {
    open = false;
  }

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
      const res = await fileWidgetTicket({ text, widgetId, widgetTitle, route, refine });
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

  // The button lives inside the card, and `.widget` sets `perspective`, which makes the card the
  // containing block for `position: fixed` descendants — the modal would render trapped inside the
  // card. Moving its wrapper to <body> keeps it a true full-screen dialog.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  const modalTitle = $derived(
    phase === 'grilling' && ticket ? `Grilling · ${ticket.displayId}` : `New ticket · ${widgetTitle}`,
  );
</script>

<button
  type="button"
  class="widget-ticket-btn"
  aria-label={`Submit a ticket for ${widgetTitle}`}
  title="Submit a ticket for this widget"
  onclick={openModal}>+</button
>

<div use:portal>
<Modal {open} title={modalTitle} size={phase === 'grilling' ? 'wide' : 'default'} onClose={close}>
  <div class="wt">
    {#if phase === 'compose'}
      <textarea
        class="wt-input"
        rows="6"
        placeholder="What should change about this widget?"
        bind:value={text}
        bind:this={textareaEl}
        onkeydown={onKeydown}
        disabled={busy}
      ></textarea>
      <p class="wt-hint">
        The first line becomes the title. It goes to the backlog, in the widget-tickets inbox Epic.
        <kbd>⌘</kbd><kbd>↵</kbd> submits.
      </p>
      {#if error}<p class="wt-error" role="alert">{error}</p>{/if}
      <div class="wt-actions">
        <Button
          variant="ghost"
          disabled={busy || text.trim() === ''}
          title="File it, then open a Refine session that questions the ask before it becomes work"
          onclick={() => submit(true)}>Grill me first</Button
        >
        <Button variant="primary" disabled={busy || text.trim() === ''} onclick={() => submit(false)}>
          {busy ? 'Submitting…' : 'Submit ticket'}
        </Button>
      </div>
    {:else if phase === 'filed' && ticket}
      <p class="wt-done">
        Filed <a href="/devops/tickets/{ticket.displayId}">{ticket.displayId}</a> to the backlog.
      </p>
      <p class="wt-done-title">{ticket.title}</p>
      <div class="wt-actions">
        <Button variant="ghost" onclick={reset}>File another</Button>
        <Button variant="primary" onclick={close}>Done</Button>
      </div>
    {:else if phase === 'grilling' && ticket}
      <p class="wt-hint">
        Filed <a href="/devops/tickets/{ticket.displayId}">{ticket.displayId}</a> to the backlog. The
        Refine agent picks it up shortly; you can close this and keep going on the ticket's page.
      </p>
      <div class="wt-thread">
        <TicketThread ticketId={ticket.id} />
      </div>
    {/if}
  </div>
</Modal>
</div>

<style lang="scss" src="./WidgetTicketButton.scss"></style>
