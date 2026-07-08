<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { marked } from 'marked';
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
  let threadEl = $state<HTMLElement | null>(null);

  // True while we're waiting on the agent-worker — the newest turn is Steve's.
  const awaitingAgent = $derived(messages.length > 0 && messages[messages.length - 1].role === 'human');

  // Svelte action: renders markdown into a node's innerHTML without using {@html}.
  function applyMarkdown(node: HTMLElement, text: string) {
    node.innerHTML = marked.parse(text) as string;
    return {
      update(newText: string) {
        node.innerHTML = marked.parse(newText) as string;
      },
    };
  }

  // Scroll the thread to the latest message. Called explicitly on initial load and after
  // sending — NOT on every poll: a reactive $effect on `messages` re-scrolled every 5s (load
  // rebuilds the array each poll), which fought the user trying to scroll back up the history.
  async function scrollToBottom() {
    await tick(); // let the DOM paint the new messages before measuring scrollHeight
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
  }

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
      await scrollToBottom(); // jump to the message the user just sent
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
    // Scroll to the newest message once, after the initial load paints.
    load().then(scrollToBottom);
    // Poll so a agent-worker reply (async, via the shared DB) appears without a manual refresh.
    // Deliberately does NOT scroll — see scrollToBottom.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  });
</script>

<section class="refine-thread">
  {#if loading}
    <ul class="thread" bind:this={threadEl}>
      <li class="muted loading-msg">Loading thread…</li>
    </ul>
  {:else if error}
    <ul class="thread" bind:this={threadEl}>
      <li class="error" role="alert">{error}</li>
    </ul>
  {:else if messages.length === 0}
    <ul class="thread" bind:this={threadEl}>
      <li class="muted empty-msg">
        No Refine conversation yet. Use <strong>Refine</strong> on the board card (or the button
        above) to start one — the agent-worker's turns and your replies appear here.
      </li>
    </ul>
  {:else}
    <ul class="thread" bind:this={threadEl}>
      {#each messages as m (m.id)}
        <li class="turn turn-{m.role}">
          <div class="bubble">
            <div class="turn-head">
              <span class="who">{m.role === 'agent' ? 'Refine agent' : 'You'}</span>
              <span class="when">{fmt(m.createdAt)}</span>
            </div>
            {#if m.role === 'agent'}
              <div class="turn-body prose" use:applyMarkdown={m.text}></div>
            {:else}
              <div class="turn-body">{m.text}</div>
            {/if}
          </div>
        </li>
      {/each}

      {#if proposal}
        <li class="turn turn-agent turn-proposal">
          <div class="bubble proposal" role="group" aria-label="Proposed commit">
            <div class="turn-head">
              <span class="who">Refine agent</span>
              <span class="proposal-badge">Proposed: {proposal.mode === 'decompose' ? 'Split' : 'Refine in place'}</span>
            </div>
            {#if proposal.rationale}<p class="proposal-rationale">{proposal.rationale}</p>{/if}

            {#if proposal.mode === 'refine_in_place'}
              <dl class="proposal-fields">
                {#if proposal.status}<div><dt>Lane</dt><dd>{proposal.status}</dd></div>{/if}
                {#if proposal.assignee !== undefined}<div><dt>Assignee</dt><dd>{proposal.assignee ?? '—'}</dd></div>{/if}
                {#if proposal.priority !== undefined}<div><dt>Priority</dt><dd>{proposal.priority ?? '—'}</dd></div>{/if}
              </dl>
              {#if proposal.body}<pre class="proposal-body">{proposal.body}</pre>{/if}
            {:else}
              <ul class="proposal-children">
                {#each proposal.children ?? [] as child, i (i)}
                  <li>
                    <div class="child-head">
                      <span class="child-lane">{child.status}</span>
                      <span class="child-assignee">{child.assignee ?? '—'}</span>
                      {#if child.priority}<span class="child-priority">{child.priority}</span>{/if}
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
        </li>
      {/if}

      {#if awaitingAgent}
        <li class="muted awaiting">Waiting for the Refine agent to reply…</li>
      {/if}
    </ul>
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
