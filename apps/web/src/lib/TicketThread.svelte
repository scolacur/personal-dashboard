<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { applyMarkdown } from '$lib/markdown';
  import type { AgentTicket, RefineAnswerSet, RefineChildProposal, RefineMessage, RefineProposal } from '@dashboard/shared';
  import {
    isReady,
    latestActionableProposal,
    refineSessionEnd,
    refineThreadFromEvents,
    roundAsMarkdown,
  } from '@dashboard/shared';
  import {
    approveRefine,
    fetchTicketEvents,
    markRefined,
    parkRefine,
    postRefineReply,
    postRefineAnswers,
    rejectRefine,
    queueGateBlockers,
  } from '../routes/devops/api';
  import { predictQueueRefusals, refusalHint, refusalRows, type RefusalRow } from './refine-queue-gate';
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
  let deciding = $state(false);
  let decideMsg = $state<string | null>(null);
  let threadEl = $state<HTMLElement | null>(null);
  // PD-760: the Queue gate's refusal of "Approve & queue", shown beside the buttons with a remedy per
  // row. Null when there is none. Nothing has been written while it is showing.
  let gateRows = $state<RefusalRow[] | null>(null);
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

  // "Approve & queue" (D-057) is offered only for a non-Epic refine_in_place — decompose routes
  // per-child and an Epic can never enter the Queue. `notReady` is a soft hint: the
  // ticket can still be queued, but its body lacks the four Ready sections.
  const canQueue = $derived(proposal?.mode === 'refine_in_place' && !isEpic);
  const notReady = $derived(
    proposal?.mode === 'refine_in_place' && !isReady(proposal.body ?? null),
  );
  // PD-760: what the page can foresee the gate refusing (approval itself refines the ticket, so only
  // its Epic can). The server stays the authority: an unforeseen 409 is rendered from its criteria.
  const foreseen = $derived(predictQueueRefusals(ticketId, epic, epicMembers));
  const gateHint = $derived(refusalHint(foreseen, epic));

  // PD-634: mirrors `approveRefine` — a child lands refined unless the agent said otherwise, or it is
  // robot-assigned and fails the Ready check. Shown so the panel displays what approval will write.
  function childBornRefined(child: RefineChildProposal): boolean {
    return (child.refined ?? true) && (child.assignee !== 'robot' || isReady(child.body));
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

  async function decide(action: 'approve' | 'approve-queue' | 'reject') {
    if (deciding) return;
    decideMsg = null;
    gateRows = null;
    // PD-760: a foreseen refusal is shown without asking the server, which would refuse anyway.
    if (action === 'approve-queue' && foreseen.length > 0) {
      gateRows = refusalRows(foreseen, epic, epicMembers, ticketId);
      return;
    }
    deciding = true;
    try {
      if (action === 'reject') {
        await rejectRefine(ticketId);
        decideMsg = 'Proposal rejected — the agent can propose again.';
      } else {
        const { queued, populated } = await approveRefine(ticketId, {
          queue: action === 'approve-queue',
        });
        decideMsg = populated
          ? 'Approved — members created under this Epic. Queue the ready ones when you are.'
          : queued
            ? 'Approved & queued — Robot will pick it up.'
            : "Approved. Drag to the Robot's Queue when you're ready to dispatch.";
      }
      await load();
      onChanged?.();
    } catch (e) {
      const server = queueGateBlockers(e);
      if (server) gateRows = refusalRows(server, epic, epicMembers, ticketId);
      else decideMsg = e instanceof Error ? e.message : String(e);
    } finally {
      deciding = false;
    }
  }

  // PD-760: the remedy for "Epic not refined". The same dedicated route the ticket page's own
  // button uses (PD-610). It does not approve or queue anything: Steve clicks Approve & queue again.
  async function markEpicRefined(epicId: number) {
    if (deciding) return;
    deciding = true;
    try {
      await markRefined(epicId);
      gateRows = null;
      decideMsg = 'Epic marked refined. Approve & queue is clear now.';
      onChanged?.();
    } catch (e) {
      decideMsg = e instanceof Error ? e.message : String(e);
    } finally {
      deciding = false;
    }
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
          <div class="bubble proposal" role="group" aria-label="Proposed commit">
            <div class="turn-head">
              <span class="who">Refine agent</span>
              <span class="proposal-badge">Proposed: {proposal.mode === 'decompose' ? (isEpic ? 'Populate' : 'Split') : 'Refine in place'}</span>
            </div>
            {#if proposal.rationale}<p class="proposal-rationale">{proposal.rationale}</p>{/if}

            <!-- PD-510: only fields an approval actually writes are shown. Lane and priority used
                 to be listed here and are no longer applied — a panel that displays a value the
                 approve button then ignores is worse than one that omits it. -->
            {#if proposal.mode === 'refine_in_place'}
              <dl class="proposal-fields">
                {#if proposal.assignee !== undefined}<div><dt>Assignee</dt><dd>{proposal.assignee ?? '—'}</dd></div>{/if}
              </dl>
              {#if proposal.body}<pre class="proposal-body">{proposal.body}</pre>{/if}
            {:else}
              <!-- PD-634: approving a Populate rewrites the Epic's description and marks it refined,
                   so the new description is shown here — the panel is the evidence the claim rests on. -->
              {#if isEpic && proposal.body}
                <p class="proposal-section-label">Epic description (rewritten)</p>
                <pre class="proposal-body">{proposal.body}</pre>
                <p class="proposal-section-label">Members</p>
              {/if}
              <ul class="proposal-children">
                {#each proposal.children ?? [] as child, i (i)}
                  <li>
                    <div class="child-head">
                      <!-- No lane per child (PD-598). PD-510 stopped reading the proposed lane
                           and this printed "backlog" as a fact instead — but a value identical on
                           every row says nothing, and it still read as a lane the agent chose,
                           which is what PD-510 set out to remove. Where children land is a
                           property of approval, not of any one child. -->
                      <span class="child-assignee">{child.assignee ?? '—'}</span>
                      <span class="child-title">{child.title}</span>
                      <!-- PD-634: children are born refined unless the agent opted out, or the
                           server will downgrade a robot child whose body is not Ready-shaped. -->
                      {#if !childBornRefined(child)}<span class="child-unrefined">not refined</span>{/if}
                    </div>
                    <pre class="proposal-body">{child.body}</pre>
                  </li>
                {/each}
              </ul>
              <!-- PD-842: sibling relations written on approval, shown so Steve approves what lands. -->
              {#if proposal.relations && proposal.relations.length > 0}
                <p class="proposal-section-label">Relations</p>
                <ul class="proposal-relations">
                  {#each proposal.relations as rel, i (i)}
                    <li>
                      <span class="child-title">{proposal.children?.[rel.from]?.title ?? `#${rel.from + 1}`}</span>
                      <span class="relation-verb">{rel.type === 'blocks' ? 'blocks' : 'relates to'}</span>
                      <span class="child-title">{proposal.children?.[rel.to]?.title ?? `#${rel.to + 1}`}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
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
                  title={notReady
                    ? "Not in Robot-ready shape (missing the four sections) — you can still queue it, but Robot works best from a shaped ticket."
                    : "Approve and move into the Robot's Queue to dispatch now."}
                >
                  Approve &amp; queue
                </button>
                {#if gateHint}<span class="gate-hint" title="The Queue gate (D-091) will refuse this until it is fixed. Click for the remedy.">{gateHint}</span>{/if}
                {#if notReady}<span class="shape-hint" title="Body is missing ## Context / ## Task / ## Done When / ## Out of scope.">not formatted</span>{/if}
              {/if}
              <button class="reject" onclick={() => decide('reject')} disabled={deciding}>Reject</button>
            </div>
            {#if gateRows}
              <!-- PD-760: the refusal sits under the button that caused it, not at the end of the list. -->
              <div class="queue-refusal" role="alert">
                <p class="queue-refusal-lead">Can't queue this yet. Nothing has been written.</p>
                <ul class="queue-refusal-rows">
                  {#each gateRows as row (row.id)}
                    <li>
                      <span>{row.label}</span>
                      {#if row.action?.kind === 'mark-epic-refined'}
                        {@const epicId = row.action.epicId}
                        <button class="queue-refusal-fix" onclick={() => markEpicRefined(epicId)} disabled={deciding}>{row.action.text}</button>
                      {:else if row.action?.kind === 'link'}
                        <a class="queue-refusal-fix" href={row.action.href}>{row.action.text}</a>
                      {/if}
                    </li>
                  {/each}
                </ul>
                <div class="queue-refusal-actions">
                  <button class="approve" onclick={() => decide('approve')} disabled={deciding}>Approve without queueing</button>
                  <button class="queue-refusal-cancel" onclick={() => (gateRows = null)} disabled={deciding}>Cancel</button>
                </div>
              </div>
            {/if}
          </div>
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
