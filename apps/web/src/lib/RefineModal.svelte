<script lang="ts">
  import type { AgentTicket } from '@dashboard/shared';
  import Modal from './Modal.svelte';
  import GlossaryModal from './GlossaryModal.svelte';
  import TicketThread from './TicketThread.svelte';
  import { portal } from './portal';
  import { markRefined, startRefine } from '../routes/devops/api';

  /**
   * The Refine modal (PD-643): one ticket's Refine session in a large dialog, built from the same
   * `TicketThread` the mobile Refine pane uses, over the existing session API — no parallel UI and
   * no new backend path. It owns the Refine-only controls (Start refine, Mark refined, the glossary
   * `i`), so a page that opens it does not repeat them.
   *
   * Takes the ticket as a prop and holds no page state, so any entry point can open it: today the
   * detail page's floating Refine button; PD-603's header pill and a "Save & Refine" are meant to
   * reuse it rather than copy it. Works for Tickets and Epics alike.
   */
  const {
    open,
    ticket,
    epic = null,
    epicMembers = [],
    onClose,
    onChanged,
  }: {
    open: boolean;
    ticket: AgentTicket;
    /** The ticket's Epic and its members, when known — lets the thread foresee a Queue-gate refusal. */
    epic?: AgentTicket | null;
    epicMembers?: AgentTicket[];
    onClose: () => void;
    /** Something about the ticket changed (session started, proposal approved, marked refined). */
    onChanged?: () => void;
  } = $props();

  let starting = $state(false);
  let marking = $state(false);
  let error = $state<string | null>(null);
  let glossaryOpen = $state(false);

  async function start() {
    if (starting) return;
    starting = true;
    error = null;
    try {
      await startRefine(ticket.id);
      onChanged?.();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      starting = false;
    }
  }

  async function mark() {
    if (marking) return;
    marking = true;
    error = null;
    try {
      // PD-610: the dedicated route — it also clears staleness and re-arms a paused Epic's members.
      await markRefined(ticket.id);
      onChanged?.();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      marking = false;
    }
  }

  const title = $derived(`✦ Refine · ${ticket.displayId ?? ticket.title}`);
</script>

<!-- Portalled so no ancestor's stacking context (sticky column, floating dock) can trap it. -->
<div use:portal>
  <Modal {open} {title} size="wide" {onClose}>
    <div class="refine-modal">
      <p class="refine-modal-subject">
        {ticket.title}
        {#if ticket.refined}<span class="refined-badge" title="This ticket has been refined">✓ Refined</span>{/if}
      </p>
      {#if error}<p class="refine-modal-error" role="alert">{error}</p>{/if}
      <TicketThread
        ticketId={ticket.id}
        isEpic={ticket.isEpic}
        {epic}
        {epicMembers}
        {onChanged}
        onStart={start}
        {starting}
      />
      <div class="refine-modal-footer">
        <button
          class="info-btn"
          type="button"
          title="Refinement statuses"
          aria-label="Refinement statuses"
          onclick={() => (glossaryOpen = true)}>i</button
        >
        {#if !ticket.refined && ticket.refineState !== null}
          <button class="mark-refined" type="button" onclick={mark} disabled={marking}>
            {marking ? 'Marking…' : '✓ Mark refined'}
          </button>
        {/if}
      </div>
    </div>
  </Modal>
  <!-- After the dialog, so it stacks above it. -->
  <GlossaryModal open={glossaryOpen} tab="refinement" onClose={() => (glossaryOpen = false)} />
</div>

<style lang="scss" src="./RefineModal.scss"></style>
