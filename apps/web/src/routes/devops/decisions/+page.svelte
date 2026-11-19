<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { page } from '$app/state';
  import type { AwaitingRefineItem, RefineAnswerSet } from '@dashboard/shared';
  import { applyMarkdown } from '$lib/markdown';
  import RefineQuestionForm from '$lib/RefineQuestionForm.svelte';
  import { decisionsAnchor } from '$lib/notification-links';
  import { refreshDecisionsCount } from '$lib/decisions-store';
  import { fetchAwaitingRefine, postRefineAnswers } from '../api';
  import { askedAgo } from './decisions-logic';

  // The Decisions inbox (PD-746, D-096 §7): every Refine session waiting on Steve, answerable
  // inline, so many tickets' questions can be cleared in one sitting. Highest priority first, then
  // the question that has waited longest (the server sorts).
  let items = $state<AwaitingRefineItem[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  // Turns answered from this page. A sent round collapses at once; it leaves the list when the next
  // poll no longer returns it (the agent is now working) and comes back as a new turn if it asks again.
  let sent = $state<Set<number>>(new Set());
  let nowTs = $state(Date.now());

  async function load() {
    try {
      const res = await fetchAwaitingRefine();
      items = res.items;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      nowTs = Date.now();
    }
  }

  async function answer(item: AwaitingRefineItem, answers: RefineAnswerSet) {
    await postRefineAnswers(item.ticketId, answers); // throws → the form shows the error inline
    sent = new Set([...sent, item.eventId]);
    void refreshDecisionsCount();
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

  const open = $derived(items.filter((i) => !sent.has(i.eventId)));
  const sentItems = $derived(items.filter((i) => sent.has(i.eventId)));
</script>

<section class="decisions-page">
  <header class="decisions-head">
    <h1 class="decisions-title">Decisions</h1>
    <a class="decisions-back" href="/devops">← Dev Ops</a>
  </header>
  <p class="decisions-sub">
    Every Refine session waiting on you, highest priority first. Answer here and the agent picks it
    up on its next turn; a ticket comes back when the agent has more questions.
  </p>

  {#if loading}
    <p class="decisions-empty">Loading…</p>
  {:else if error}
    <p class="decisions-error" role="alert">Could not load decisions: {error}</p>
  {:else if open.length === 0 && sentItems.length === 0}
    <p class="decisions-empty">Nothing is waiting on you. New questions appear here as Refine agents ask them.</p>
  {:else}
    {#if open.length === 0}
      <p class="decisions-empty">All answered. The agents are working on your replies.</p>
    {/if}
    <ol class="decisions-list">
      {#each open as item (item.eventId)}
        {@const anchor = item.displayId ? decisionsAnchor(item.displayId) : `t-${item.ticketId}`}
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
          {#if item.round}
            <RefineQuestionForm round={item.round} formId={item.eventId} onSubmit={(a) => answer(item, a)} />
          {:else}
            <p class="decision-freetext">
              This session asked in free text, before structured questions existed.
              <a href="/devops/tickets/{item.displayId ?? item.ticketId}">Reply on the ticket page →</a>
            </p>
          {/if}
        </li>
      {/each}
    </ol>
    {#if sentItems.length > 0}
      <ul class="decisions-sent" aria-label="Sent">
        {#each sentItems as item (item.eventId)}
          <li>
            <span class="decision-id">{item.displayId}</span> {item.title}
            <span class="decision-sent-note">Sent. The agent is working on it.</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style lang="scss" src="./+page.scss"></style>
