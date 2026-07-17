<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { marked } from 'marked';
  import type { RefineMessage, RefineProposal } from '@dashboard/shared';
  import { isReady, latestActionableProposal, refineThreadFromEvents } from '@dashboard/shared';
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
  // onStart (C4 redesign): before a thread exists, the composer is replaced by a single
  // "Start Refine" button that calls this — the conversation only opens once there's one to hold.
  // isEpic hides "Approve & queue" — an Epic can never enter the Robot's Queue (D-054/D-057).
  const {
    ticketId,
    isEpic = false,
    onChanged,
    onStart,
    starting = false,
  }: {
    ticketId: number;
    isEpic?: boolean;
    onChanged?: () => void;
    onStart?: () => void;
    starting?: boolean;
  } = $props();

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

  // Working indicator: while awaiting a reply, show that the Refine agent is processing, with the
  // elapsed time since the turn we're waiting on — concrete feedback, no whimsy. Ticks each second.
  let nowTs = $state(Date.now());
  $effect(() => {
    if (!awaitingAgent) return;
    const t = setInterval(() => (nowTs = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const workingElapsed = $derived(
    awaitingAgent && messages.length
      ? Math.max(0, Math.floor((nowTs - messages[messages.length - 1].createdAt) / 1000))
      : 0,
  );
  function fmtElapsed(s: number): string {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  // "Approve & queue" (D-057) is offered only for a non-Epic refine_in_place — decompose routes
  // per-child and an Epic can never enter the Queue. `needsShaping` is a soft hint: the
  // ticket can still be queued, but its body lacks the four Ready sections.
  const canQueue = $derived(proposal?.mode === 'refine_in_place' && !isEpic);
  const needsShaping = $derived(
    proposal?.mode === 'refine_in_place' && !isReady(proposal.body ?? null),
  );

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

  async function decide(action: 'approve' | 'approve-queue' | 'reject') {
    if (deciding) return;
    deciding = true;
    decideMsg = null;
    try {
      if (action === 'reject') {
        await rejectRefine(ticketId);
        decideMsg = 'Proposal rejected — the agent can propose again.';
      } else {
        const { queued } = await approveRefine(ticketId, { queue: action === 'approve-queue' });
        decideMsg = queued
          ? 'Approved & queued — Robot will pick it up.'
          : "Approved. Drag to the Robot's Queue when you're ready to dispatch.";
      }
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
        {#if onStart}
          No Refine conversation yet. Start one below — the Refine agent grills the ticket into a
          sharp spec, and its turns and your replies appear here.
        {:else}
          No Refine conversation yet.
        {/if}
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
              {#if canQueue}
                <button
                  class="approve-queue"
                  onclick={() => decide('approve-queue')}
                  disabled={deciding}
                  title={needsShaping
                    ? "Not in Robot-ready shape (missing the four sections) — you can still queue it, but Robot works best from a shaped ticket."
                    : "Approve and move into the Robot's Queue to dispatch now."}
                >
                  Approve &amp; queue
                </button>
                {#if needsShaping}<span class="shape-hint" title="Body is missing ## Context / ## Task / ## Done When / ## Out of scope.">needs shaping</span>{/if}
              {/if}
              <button class="reject" onclick={() => decide('reject')} disabled={deciding}>Reject</button>
            </div>
          </div>
        </li>
      {/if}

      {#if decideMsg}
        <li class="decide-msg" role="status">{decideMsg}</li>
      {/if}

      {#if awaitingAgent}
        <li class="working" aria-live="polite">
          <span class="working-dots" aria-hidden="true"><span></span><span></span><span></span></span>
          <span class="working-text">Refine agent is working… · {fmtElapsed(workingElapsed)}</span>
        </li>
      {/if}
    </ul>
  {/if}

  {#if !loading && !error}
    {#if messages.length === 0 && onStart}
      <div class="reply reply-start">
        <button class="start-refine" type="button" onclick={onStart} disabled={starting}>
          {starting ? 'Starting…' : '✦ Start Refine'}
        </button>
      </div>
    {:else}
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
  {/if}
</section>

<style lang="scss" src="./TicketThread.scss"></style>
