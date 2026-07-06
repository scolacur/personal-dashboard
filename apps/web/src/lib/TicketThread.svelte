<script lang="ts">
  import { onMount } from 'svelte';
  import type { RefineMessage } from '@dashboard/shared';
  import { refineThreadFromEvents } from '@dashboard/shared';
  import { fetchTicketEvents, postRefineReply } from '../routes/task-monitor/api';

  // The Refine thread lives on the ticket's activity log (agent_ticket_events); this
  // component reads it via the generic events endpoint and renders the refine_* subset
  // (PD-267). PD-255 will extend the same endpoint/component to the rest of the log.
  const { ticketId }: { ticketId: number } = $props();

  let messages = $state<RefineMessage[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let replyText = $state('');
  let sending = $state(false);
  let sendMsg = $state<string | null>(null);

  // True while we're waiting on the griller — the newest turn is Steve's.
  const awaitingAgent = $derived(messages.length > 0 && messages[messages.length - 1].role === 'human');

  async function load() {
    try {
      const events = await fetchTicketEvents(ticketId);
      messages = refineThreadFromEvents(events);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
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
      No Refine conversation yet. Start one with the Refine button on the board (coming in
      PD-268), then the thread appears here.
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
