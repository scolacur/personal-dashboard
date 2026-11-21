<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { applyMarkdown } from '$lib/markdown';
  import type { AgentTicket, RefineAnswerSet, RefineMessage, RefineProposal } from '@dashboard/shared';
  import {
    latestActionableProposal,
    refineSessionEnd,
    refineThreadFromEvents,
    roundAsMarkdown,
  } from '@dashboard/shared';
  import { fetchTicketEvents, parkRefine, postRefineReply, postRefineAnswers } from '../routes/devops/api';
  import RefineProposalCard from './RefineProposalCard.svelte';
  import RefineQuestionForm from './RefineQuestionForm.svelte';
  import { answerSummary, openRoundMessage, roundsAnsweredBy } from './refine-form-logic';

  // The Refine thread lives on the ticket's activity log (agent_ticket_events); this
  // component reads it via the generic events endpoint and renders the refine_* subset
  // (PD-267). PD-255 will extend the same endpoint/component to the rest of the log.
  // onChanged fires after an approve/reject so the parent can reload the ticket (PD-269).
  // onStart (C4 redesign): before a thread exists, the composer is replaced by a single
  // "Start Refine" button that calls this — the conversation only opens once there's one to hold.
  // isEpic hides "Approve & queue" — an Epic can never enter the Robot's Queue (D-054/D-057).
  // epic / epicMembers (PD-760): the ticket's Epic and its members, when the page has them, so the
  // thread can say BEFORE the click that the Queue gate will refuse. Optional: without them the
  // server's 409 is still rendered, it just isn't foreseen.
  const {
    ticketId,
    isEpic = false,
    epic = null,
    epicMembers = [],
    onChanged,
    onStart,
    starting = false,
  }: {
    ticketId: number;
    isEpic?: boolean;
    epic?: AgentTicket | null;
    epicMembers?: AgentTicket[];
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
  let decideMsg = $state<string | null>(null);
  let threadEl = $state<HTMLElement | null>(null);
  // PD-743: how the session ended (approved commit or parked), or null while it is open.
  let sessionEnd = $state<'committed' | 'parked' | null>(null);
  let parking = $state(false);

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
      sessionEnd = refineSessionEnd(events);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // PD-269: after an approve or reject the proposal is gone, so its message is shown by the thread.
  async function decided(message: string) {
    decideMsg = message;
    await load();
    onChanged?.();
  }

  // PD-745: the round Steve can answer now (newest turn is an agent round, session still open), and
  // for each structured reply the round it answered, so the reply renders as a summary.
  const openRound = $derived(sessionEnd === null ? openRoundMessage(messages) : null);
  const answeredRounds = $derived(roundsAnsweredBy(messages));

  async function submitAnswers(answers: RefineAnswerSet) {
    await postRefineAnswers(ticketId, answers); // throws → the form shows the error
    await load();
    await scrollToBottom();
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

  // PD-743: end the session with no commit. Nothing is waiting on Steve after this; replying
  // reopens it. The server refuses a second park, so a double-click is harmless.
  async function park() {
    if (parking) return;
    parking = true;
    sendMsg = null;
    try {
      await parkRefine(ticketId);
      await load();
      onChanged?.();
    } catch (e) {
      sendMsg = e instanceof Error ? e.message : String(e);
    } finally {
      parking = false;
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
              {#if m.round && openRound?.id === m.id}
                <!-- PD-745: the open round, answered with clicks. Keyed by turn so a new round always
                     starts from an empty draft. -->
                <div class="turn-round">
                  {#key m.id}
                    <RefineQuestionForm round={m.round} formId={m.id} onSubmit={submitAnswers} />
                  {/key}
                </div>
              {:else if m.round}
                <!-- An answered or superseded round: kept readable, folded away. -->
                <details class="turn-round turn-round-past">
                  <summary>{m.round.questions.length === 1 ? '1 question' : `${m.round.questions.length} questions`}</summary>
                  <div class="turn-body prose" use:applyMarkdown={roundAsMarkdown(m.round)}></div>
                </details>
              {/if}
            {:else if m.answers && answeredRounds.has(m.id)}
              {@const r = answeredRounds.get(m.id)!}
              <!-- PD-745: a structured reply, shown as what was chosen rather than the rendered text. -->
              <ul class="turn-body answer-summary">
                {#each answerSummary(r, m.answers) as line, li (li)}
                  <li>
                    <span class="answer-q">{line.question}</span>
                    <span class="answer-a">{line.answer}{#if line.recommended}<span class="answer-rec"> (recommended)</span>{/if}</span>
                  </li>
                {/each}
                {#each m.answers.overruled ?? [] as ai (ai)}
                  {#if r.assumptions[ai]}<li><span class="answer-q">Overruled</span><span class="answer-a">{r.assumptions[ai].text}</span></li>{/if}
                {/each}
                {#if m.answers.note}<li><span class="answer-q">Note</span><span class="answer-a">{m.answers.note}</span></li>{/if}
              </ul>
            {:else}
              <div class="turn-body">{m.text}</div>
            {/if}
          </div>
        </li>
      {/each}

      {#if proposal}
        <li class="turn turn-agent turn-proposal">
          <RefineProposalCard
            {ticketId}
            {proposal}
            {isEpic}
            {epic}
            {epicMembers}
            onDecided={decided}
            onChanged={() => onChanged?.()}
          />
        </li>
      {/if}

      {#if decideMsg}
        <li class="decide-msg" role="status">{decideMsg}</li>
      {/if}

      {#if sessionEnd}
        <li class="session-ended" role="status">
          {sessionEnd === 'parked'
            ? 'Session parked. Nothing is waiting on you. Reply to reopen it.'
            : 'Proposal approved, so this session has ended. Reply to reopen it.'}
        </li>
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
          placeholder={openRound ? 'Or reply in your own words…' : 'Reply to the Refine agent…'}
          disabled={sending}
        ></textarea>
        <div class="reply-actions">
          <button onclick={submit} disabled={sending || !replyText.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </button>
          {#if sendMsg}<span class="send-msg">{sendMsg}</span>{/if}
          {#if messages.length > 0 && sessionEnd === null}
            <button
              class="park"
              type="button"
              onclick={park}
              disabled={parking}
              title="End this Refine session without a commit. It stops waiting on you; a reply reopens it."
            >
              {parking ? 'Parking…' : 'Park'}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</section>

<style lang="scss" src="./TicketThread.scss"></style>
