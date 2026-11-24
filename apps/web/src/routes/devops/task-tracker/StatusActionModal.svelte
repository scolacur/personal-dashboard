<script lang="ts">
  import type { AgentTicket, AgentRun, TicketEvent } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import Collapsible from '$lib/Collapsible.svelte';
  import * as api from '../api';
  import {
    STATUS_ACTION_REGISTRY,
    buildStatusContent,
    type StatusActionKind,
  } from './status-action';

  /**
   * The "needs you" modal (T900). Opens on the board for a ticket whose Robot pill is in an
   * input-needed state (`stuck` / `awaiting-human` / `needs-human` / `checkpoint`). Shows what happened, the agent's own words, the run count + cumulative
   * turns, and the state's actions — none of which leave the board. All per-state content comes from
   * `status-action.ts`; this file is the renderer + the action wiring.
   */
  let {
    ticket,
    onClose,
    onUpdate,
  }: {
    /** The ticket whose pill was clicked; null closes the modal. */
    ticket: AgentTicket | null;
    onClose: () => void;
    /** Called after an action lands so the board can refresh the card. */
    onUpdate: () => void;
  } = $props();

  let runs = $state<AgentRun[]>([]);
  let events = $state<TicketEvent[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let replyText = $state('');

  const entry = $derived(
    ticket?.agentState ? (STATUS_ACTION_REGISTRY[ticket.agentState] ?? null) : null,
  );
  const content = $derived(entry ? buildStatusContent(entry, runs, events) : null);

  // Load the run + event data each time the modal opens on a ticket. The reads here are only
  // `ticket`; everything written is untracked, so this never loops.
  $effect(() => {
    const t = ticket;
    runs = [];
    events = [];
    replyText = '';
    error = null;
    if (!t) return;
    void Promise.all([
      api.fetchTicketRuns(t.id).catch(() => [] as AgentRun[]),
      api.fetchTicketEvents(t.id).catch(() => [] as TicketEvent[]),
    ]).then(([r, e]) => {
      // Guard against a resolve that lands after the modal moved on to another ticket.
      if (ticket?.id === t.id) {
        runs = r;
        events = e;
      }
    });
  });

  async function runAction(kind: StatusActionKind) {
    if (!ticket || busy || kind === 'open-pr') return;
    busy = true;
    error = null;
    try {
      if (kind === 'unstick') await api.unstickTicket(ticket.id);
      else if (kind === 'reset') await api.resetTicketRuns(ticket.id);
      else if (kind === 'continue') await api.continueTicket(ticket.id);
      else if (kind === 'restart') await api.restartTicket(ticket.id);
      onUpdate();
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function submitReply() {
    if (!ticket || busy || !replyText.trim()) return;
    busy = true;
    error = null;
    try {
      await api.replyToTicket(ticket.id, replyText.trim());
      onUpdate();
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<Modal open={ticket !== null} title={content?.title} onClose={onClose}>
  {#if ticket && content}
    <div class="sa">
      <p class="sa-desc">{content.description}</p>
      {#if content.reason}
        <p class="sa-reason">{content.reason}</p>
      {/if}

      <!-- The agent's own words: the ask_human question (inline), a status report (inline), or the
           run output tail (collapsed). A missing field shows the fallback copy instead. -->
      {#if content.words !== null && content.wordsCollapsed}
        <Collapsible title={content.wordsLabel} open={false} storeKey="status-action-tail">
          <pre class="sa-tail">{content.words}</pre>
        </Collapsible>
      {:else}
        <div class="sa-words">
          <span class="sa-words-label">{content.wordsLabel}</span>
          {#if content.words !== null}
            <blockquote class="sa-quote">{content.words}</blockquote>
          {:else}
            <p class="sa-empty muted">{content.wordsFallback}</p>
          {/if}
        </div>
      {/if}

      <p class="sa-stats">
        {content.runCount}
        {content.runCount === 1 ? 'run' : 'runs'} · {content.totalTurns} cumulative turns
      </p>

      {#if error}
        <p class="sa-error" role="alert">{error}</p>
      {/if}

      {#if content.reply}
        <div class="sa-reply">
          <textarea
            bind:value={replyText}
            rows="4"
            placeholder="Type your answer…"
            disabled={busy}
          ></textarea>
          <button class="sa-btn primary" disabled={busy || !replyText.trim()} onclick={submitReply}>
            {busy ? 'Sending…' : 'Send reply'}
          </button>
        </div>
      {/if}

      {#if content.actions.length}
        <div class="sa-actions">
          {#each content.actions as action (action.kind)}
            {#if action.kind === 'open-pr'}
              {#if content.prUrl}
                <a class="sa-btn" href={content.prUrl} target="_blank" rel="noreferrer"
                  >{action.label}</a
                >
              {/if}
            {:else}
              <button class="sa-btn" disabled={busy} onclick={() => runAction(action.kind)}
                >{action.label}</button
              >
            {/if}
          {/each}
        </div>
      {/if}

      {#if ticket.displayId}
        <a class="sa-detail-link" href="/devops/tickets/{ticket.displayId}">Open full ticket →</a>
      {/if}
    </div>
  {/if}
</Modal>

<style lang="scss" src="./StatusActionModal.scss"></style>
