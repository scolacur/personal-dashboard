<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import type { AgentTicket, AwaitingRefineItem, AwaitingVisualItem, RefineAnswerSet, TicketSuggestion } from '@dashboard/shared';
  import VisualCheck from '$lib/VisualCheck.svelte';
  import TicketSuggestionCard from '$lib/TicketSuggestionCard.svelte';
  import { applyMarkdown } from '$lib/markdown';
  import RefineQuestionForm from '$lib/RefineQuestionForm.svelte';
  import RefineProposalCard from '$lib/RefineProposalCard.svelte';
  import { approvedMergingMessage } from '$lib/visual-check-logic';
  import { decisionsAnchor, suggestionAnchor, visualAnchor } from '$lib/notification-links';
  import { refreshDecisionsCount } from '$lib/decisions-store';
  import { answerFailureMessage } from '$lib/refine-stale-logic';
  import { ApiError, fetchAwaitingRefine, fetchAwaitingVisual, fetchTickets, fetchTicketSuggestions, postRefineAnswers, postVisualReview } from '../api';
  import { askedAgo, decisionKind } from './decisions-logic';

  // The Decisions inbox (PD-746, D-096 §7): every Refine session waiting on Steve, answerable
  // inline, so many tickets' questions can be cleared in one sitting. Highest priority first, then
  // the question that has waited longest (the server sorts).
  let items = $state<AwaitingRefineItem[]>([]);
  // PD-773: Robot PRs held for Steve's visual check. Listed first: each one is a PR that is
  // otherwise ready to merge.
  let visual = $state<AwaitingVisualItem[]>([]);
  let decidedVisual = $state<Set<number>>(new Set());
  // PD-795: a check Steve just approved that will auto-merge. Kept visible with its post-approve
  // message after it leaves the server list (approving records a review that drops it), so he sees
  // the merge is coming rather than the card vanishing as if nothing happened.
  let merging = $state<Map<number, { message: string; displayId: string | null; title: string }>>(new Map());
  // PD-979 (D-119): the Evaluator's leftover findings, bundled per PR into a Ticket Suggestion.
  let suggestions = $state<TicketSuggestion[]>([]);
  let epics = $state<AgentTicket[]>([]);
  // Suggestions decided from this page, by id, with the message to show in their place until the
  // next poll replaces the card (the server keeps returning it as a recently-decided row).
  let decidedSuggestions = $state<Map<number, string>>(new Map());
  let loading = $state(true);
  let error = $state<string | null>(null);
  // Turns answered from this page. A sent round collapses at once; it leaves the list when the next
  // poll no longer returns it (the agent is now working) and comes back as a new turn if it asks again.
  let sent = $state<Set<number>>(new Set());
  // PD-843: proposals approved or rejected from this page, by the agent turn they waited on. The item
  // leaves the list at once; a rejected session comes back when the agent takes a new turn.
  let decided = $state<Map<number, string>>(new Map());
  // PD-889: a page-level notice shown when a submitted round came back `409 ROUND_STALE` — a ticket
  // it relied on changed between load and submit. The stale item drops from the list on refresh, so
  // the reason is surfaced here rather than on the (now-gone) card.
  let staleNotice = $state<string | null>(null);
  let nowTs = $state(Date.now());

  async function load() {
    try {
      const [res, vis, sug, allTickets] = await Promise.all([
        fetchAwaitingRefine(),
        fetchAwaitingVisual().catch(() => ({ items: [], count: 0 })),
        fetchTicketSuggestions().catch(() => ({ items: [] as TicketSuggestion[], count: 0 })),
        fetchTickets().catch(() => [] as AgentTicket[]),
      ]);
      items = res.items;
      visual = vis.items;
      suggestions = sug.items;
      epics = allTickets.filter((t) => t.isEpic && t.archivedAt === null);
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      nowTs = Date.now();
    }
  }

  async function answer(item: AwaitingRefineItem, answers: RefineAnswerSet) {
    try {
      await postRefineAnswers(item.ticketId, answers); // throws → the form shows the error inline
      sent = new Set([...sent, item.eventId]);
      void refreshDecisionsCount();
    } catch (e) {
      // PD-889: the round went stale between load and submit. Show the reason at page level and
      // refresh so the now-stale item drops from the list; anything else surfaces inline in the form.
      const stale = answerFailureMessage(e instanceof ApiError ? e.code : null);
      if (!stale) throw e;
      staleNotice = `${item.displayId ?? `Ticket ${item.ticketId}`}: ${stale}`;
      await load();
      void refreshDecisionsCount();
    }
  }

  async function decideProposal(item: AwaitingRefineItem, message: string) {
    decided = new Map([...decided, [item.eventId, message]]);
    void refreshDecisionsCount();
  }

  async function decideVisual(item: AwaitingVisualItem, approved: boolean, note: string) {
    await postVisualReview(item.ticketId, approved, note); // throws → the card shows the error
    decidedVisual = new Set([...decidedVisual, item.ticketId]);
    if (approved && item.mergesOnApprove) {
      merging = new Map([...merging, [item.ticketId, { message: approvedMergingMessage(item), displayId: item.displayId, title: item.title }]]);
    }
    void refreshDecisionsCount();
  }

  function decideSuggestion(item: TicketSuggestion, message: string) {
    decidedSuggestions = new Map([...decidedSuggestions, [item.id, message]]);
    void refreshDecisionsCount();
  }

  /** Same-project Epics for a suggestion's Modify picker. */
  function epicsFor(s: TicketSuggestion) {
    return epics
      .filter((e) => s.sourceProjectId === null || e.projectId === s.sourceProjectId)
      .map((e) => ({ id: e.id, displayId: e.displayId, title: e.title }));
  }

  onMount(() => {
    load().then(async () => {
      // A notification links here with #t-<id>; the entry only exists once data has loaded.
      const id = page.url.hash.slice(1);
      if (!id) return;
      await tick();
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    });
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  });

  /** The post-decision note shown in a card's place: this session's message, else derived from the
   *  server row (a suggestion decided in an earlier session or by another tab). */
  function suggestionDecidedNote(s: TicketSuggestion): string {
    const local = decidedSuggestions.get(s.id);
    if (local) return local;
    if (s.status === 'approved') {
      return s.createdTicketDisplayId ? `Approved — created ${s.createdTicketDisplayId}.` : 'Approved — ticket created.';
    }
    return s.rejectReason ? `Rejected — ${s.rejectReason}` : 'Rejected.';
  }

  const open = $derived(items.filter((i) => !sent.has(i.eventId) && !decided.has(i.eventId)));
  const openVisual = $derived(visual.filter((v) => !decidedVisual.has(v.ticketId)));
  const mergingList = $derived([...merging.entries()].map(([ticketId, m]) => ({ ticketId, ...m })));
  const sentItems = $derived(items.filter((i) => sent.has(i.eventId)));
  const decidedItems = $derived(items.filter((i) => decided.has(i.eventId)));
  // Pending suggestions still awaiting a decision (not yet decided from this page) render as cards;
  // the rest (decided this session or already decided server-side) show a compact note in their place.
  const openSuggestions = $derived(suggestions.filter((s) => s.status === 'pending' && !decidedSuggestions.has(s.id)));
  const decidedSuggestionsList = $derived(suggestions.filter((s) => s.status !== 'pending' || decidedSuggestions.has(s.id)));
</script>

<section class="decisions-page">
  <header class="decisions-head">
    <h1 class="decisions-title">Decisions</h1>
    <a class="decisions-back" href="/devops">← Dev Ops</a>
  </header>
  <p class="decisions-sub">
    Everything waiting on you: Robot PRs held for your visual check, then every Refine session,
    highest priority first. Answer here and the agent picks it up on its next turn.
  </p>

  {#if staleNotice}
    <div class="decisions-stale" role="status">
      <span>{staleNotice}</span>
      <button type="button" class="decisions-stale-dismiss" onclick={() => (staleNotice = null)}>Dismiss</button>
    </div>
  {/if}

  {#if loading}
    <p class="decisions-empty">Loading…</p>
  {:else if error}
    <p class="decisions-error" role="alert">Could not load decisions: {error}</p>
  {:else if open.length === 0 && sentItems.length === 0 && decidedItems.length === 0 && openVisual.length === 0 && mergingList.length === 0 && openSuggestions.length === 0 && decidedSuggestionsList.length === 0}
    <p class="decisions-empty">Nothing is waiting on you. New questions appear here as Refine agents ask them.</p>
  {:else}
    {#if openVisual.length > 0 || mergingList.length > 0}
      <h2 class="decisions-section">Visual checks</h2>
      <ol class="decisions-list">
        {#each openVisual as v (v.ticketId)}
          {@const anchor = v.displayId ? visualAnchor(v.displayId) : `v-${v.ticketId}`}
          <li class="decision" id={anchor}>
            <header class="decision-head">
              <a class="decision-ticket" href="/devops/tickets/{v.displayId ?? v.ticketId}">
                <span class="decision-id">{v.displayId}</span>
                <span class="decision-name">{v.title}</span>
              </a>
              <span class="decision-meta"><span class="decision-age">asked {askedAgo(v.requestedAt, nowTs)}</span></span>
            </header>
            <VisualCheck item={v} onDecide={(approved, note) => decideVisual(v, approved, note)} />
          </li>
        {/each}
        {#each mergingList as m (m.ticketId)}
          <li class="decision">
            <header class="decision-head">
              <a class="decision-ticket" href="/devops/tickets/{m.displayId ?? m.ticketId}">
                <span class="decision-id">{m.displayId}</span>
                <span class="decision-name">{m.title}</span>
              </a>
            </header>
            <p class="decision-merging" role="status">{m.message}</p>
          </li>
        {/each}
      </ol>
    {/if}

    {#if openSuggestions.length > 0 || decidedSuggestionsList.length > 0}
      <h2 class="decisions-section">Ticket suggestions</h2>
      <ol class="decisions-list">
        {#each openSuggestions as s (s.id)}
          {@const anchor = s.sourceTicketDisplayId ? suggestionAnchor(s.sourceTicketDisplayId) : `sug-${s.id}`}
          <li class="decision" id={anchor}>
            <header class="decision-head">
              <a class="decision-ticket" href="/devops/tickets/{s.sourceTicketDisplayId ?? s.sourceTicketId}">
                <span class="decision-id">{s.sourceTicketDisplayId}</span>
                <span class="decision-name">{s.sourceTicketTitle}</span>
              </a>
            </header>
            <TicketSuggestionCard
              suggestion={s}
              epics={epicsFor(s)}
              onDecided={(message) => decideSuggestion(s, message)}
            />
          </li>
        {/each}
      </ol>
      {#if decidedSuggestionsList.length > 0}
        <ul class="decisions-sent" aria-label="Decided suggestions">
          {#each decidedSuggestionsList as s (s.id)}
            <li>
              <span class="decision-id">{s.sourceTicketDisplayId}</span> {s.sourceTicketTitle}
              <span class="decision-sent-note">{suggestionDecidedNote(s)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    {#if (openVisual.length > 0 || mergingList.length > 0 || openSuggestions.length > 0 || decidedSuggestionsList.length > 0) && (open.length > 0 || sentItems.length > 0 || decidedItems.length > 0)}
      <h2 class="decisions-section">Refine questions</h2>
    {/if}
    {#if open.length === 0 && (sentItems.length > 0 || decidedItems.length > 0)}
      <p class="decisions-empty">All answered. Nothing else is waiting on you.</p>
    {/if}
    <ol class="decisions-list">
      {#each open as item (item.eventId)}
        {@const anchor = item.displayId ? decisionsAnchor(item.displayId) : `t-${item.ticketId}`}
        {@const kind = decisionKind(item)}
        <li class="decision" id={anchor}>
          <header class="decision-head">
            <a class="decision-ticket" href="/devops/tickets/{item.displayId ?? item.ticketId}">
              <span class="decision-id">{item.displayId}</span>
              <span class="decision-name">{item.title}</span>
            </a>
            <span class="decision-meta">
              {#if item.priority}<span class="decision-priority">{item.priority}</span>{/if}
              {#if item.epicDisplayId}<span class="decision-epic">{item.epicDisplayId} · {item.epicTitle}</span>{/if}
              <span class="decision-age">asked {askedAgo(item.askedAt, nowTs)}</span>
            </span>
          </header>
          {#if item.agentText}
            <div class="decision-agent prose" use:applyMarkdown={item.agentText}></div>
          {/if}
          {#if kind === 'proposal' && item.proposal}
            <!-- PD-843: a finished proposal, decided here with the ticket page's own card. -->
            <RefineProposalCard
              ticketId={item.ticketId}
              proposal={item.proposal.proposal}
              isEpic={item.isEpic}
              collapsed
              onDecided={(message) => decideProposal(item, message)}
            />
          {:else if kind === 'round' && item.round}
            <RefineQuestionForm round={item.round} formId={item.eventId} onSubmit={(a) => answer(item, a)} />
          {:else}
            <p class="decision-freetext">
              The agent replied without asking a question or making a proposal.
              <a href="/devops/tickets/{item.displayId ?? item.ticketId}">Reply on the ticket page →</a>
            </p>
          {/if}
        </li>
      {/each}
    </ol>
    {#if sentItems.length > 0 || decidedItems.length > 0}
      <ul class="decisions-sent" aria-label="Sent">
        {#each sentItems as item (item.eventId)}
          <li>
            <span class="decision-id">{item.displayId}</span> {item.title}
            <span class="decision-sent-note">Sent. The agent is working on it.</span>
          </li>
        {/each}
        {#each decidedItems as item (item.eventId)}
          <li>
            <span class="decision-id">{item.displayId}</span> {item.title}
            <span class="decision-sent-note">{decided.get(item.eventId)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style lang="scss" src="./+page.scss"></style>
