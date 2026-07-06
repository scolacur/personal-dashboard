<script lang="ts">
  import { onMount } from 'svelte';
  import type { RefineMessage, RefineProposal } from '@dashboard/shared';
  import { latestActionableProposal, refineThreadFromEvents } from '@dashboard/shared';
  import {
    approveRefine,
    fetchTicketEvents,
    postRefineReply,
    rejectRefine,
  } from '../routes/task-monitor/api';

  // The Refine thread lives on the ticket's activity log (agent_ticket_events); this
  // component reads it via the generic events endpoint and renders the refine_* subset
  // (PD-267). PD-255 will extend the same endpoint/component to the rest of the log.
  // onChanged fires after an approve/reject so the parent can reload the ticket (PD-269).
  const { ticketId, onChanged }: { ticketId: number; onChanged?: () => void } = $props();

  let messages = $state<RefineMessage[]>([]);
  let proposal = $state<RefineProposal | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let replyText = $state('');
  let sending = $state(false);
  let sendMsg = $state<string | null>(null);
  let deciding = $state(false);
  let decideMsg = $state<string | null>(null);

  // True while we're waiting on the griller — the newest turn is Steve's.
  const awaitingAgent = $derived(messages.length > 0 && messages[messages.length - 1].role === 'human');

  async function load() {
    try {
      const events = await fetchTicketEvents(ticketId);
      messages = refineThreadFromEvents(events);
      proposal = latestActionableProposal(events)?.proposal ?? null;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function decide(action: 'approve' | 'reject') {
    if (deciding) return;
    deciding = true;
    decideMsg = null;
    try {
      await (action === 'approve' ? approveRefine(ticketId) : rejectRefine(ticketId));
      await load();
      onChanged?.();
    } catch (e) {
      decideMsg = e instanceof Error ? e.message : String(e);
    } finally {
      deciding = false;
    }
  }

  async function submit() {
    const body = replyText.trim();
    if (!body || sending) return;
    sending = true;
    sendMsg = null;
    try {
      await postRefineReply(ticketId, body);
      replyText = '';
      await load(); // reflect the just-posted human turn immediately
    } catch (e) {
      sendMsg = e instanceof Error ? e.message : String(e);
    } finally {
      sending = false;
    }
  }

  function fmt(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  onMount(() => {
    load();
    // Poll so a griller reply (async, via the shared DB) appears without a manual refresh.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  });
</script>

<section class="refine-thread">
  <h2>Refine</h2>

  {#if loading}
    <p class="muted">Loading thread…</p>
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if messages.length === 0}
    <p class="muted">
      No Refine conversation yet. Use <strong>Refine</strong> on the board card (or the button
      above) to start one — the griller's turns and your replies appear here.
    </p>
  {:else}
    <ul class="thread">
      {#each messages as m (m.id)}
        <li class="turn turn-{m.role}">
          <div class="turn-head">
            <span class="who">{m.role === 'agent' ? 'Refine agent' : 'You'}</span>
            <span class="when">{fmt(m.createdAt)}</span>
          </div>
          <div class="turn-body">{m.text}</div>
        </li>
      {/each}
    </ul>
    {#if awaitingAgent}
      <p class="muted awaiting">Waiting for the Refine agent to reply…</p>
    {/if}
  {/if}

  {#if proposal}
    <div class="proposal" role="group" aria-label="Proposed commit">
      <div class="proposal-head">
        <span class="proposal-badge">Proposed: {proposal.mode === 'decompose' ? 'Split' : 'Refine in place'}</span>
      </div>
      {#if proposal.rationale}<p class="proposal-rationale">{proposal.rationale}</p>{/if}

      {#if proposal.mode === 'refine_in_place'}
        <dl class="proposal-fields">
          {#if proposal.status}<div><dt>Lane</dt><dd>{proposal.status}</dd></div>{/if}
          {#if proposal.assignee !== undefined}<div><dt>Assignee</dt><dd>{proposal.assignee ?? '—'}</dd></div>{/if}
        </dl>
        {#if proposal.body}<pre class="proposal-body">{proposal.body}</pre>{/if}
      {:else}
        <ul class="proposal-children">
          {#each proposal.children ?? [] as child, i (i)}
            <li>
              <div class="child-head">
                <span class="child-lane">{child.status}</span>
                <span class="child-assignee">{child.assignee ?? '—'}</span>
                <span class="child-title">{child.title}</span>
              </div>
              <pre class="proposal-body">{child.body}</pre>
            </li>
          {/each}
        </ul>
      {/if}

      <div class="proposal-actions">
        <button class="approve" onclick={() => decide('approve')} disabled={deciding}>
          {deciding ? 'Working…' : 'Approve'}
        </button>
        <button class="reject" onclick={() => decide('reject')} disabled={deciding}>Reject</button>
        {#if decideMsg}<span class="decide-msg" role="alert">{decideMsg}</span>{/if}
      </div>
    </div>
  {/if}

  {#if !loading && !error}
    <div class="reply">
      <textarea
        bind:value={replyText}
        rows="3"
        placeholder="Reply to the Refine agent…"
        disabled={sending}
      ></textarea>
      <div class="reply-actions">
        <button onclick={submit} disabled={sending || !replyText.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        {#if sendMsg}<span class="send-msg">{sendMsg}</span>{/if}
      </div>
    </div>
  {/if}
</section>

<style lang="scss" src="./TicketThread.scss"></style>
