<script lang="ts">
  import { findingLine, type TicketSuggestion } from '@dashboard/shared';
  import { approveTicketSuggestion, rejectTicketSuggestion } from '../routes/devops/api';
  import {
    approveEdits,
    draftApproveError,
    draftFrom,
    type SuggestionDraft,
  } from '../routes/devops/decisions/ticket-suggestion-logic';

  /**
   * One Ticket Suggestion in the Decisions inbox (PD-979, D-119): the Evaluator's leftover
   * non-blocking findings bundled from a PR that shipped at the round cap. Steve approves (creates a
   * real backlog ticket under the chosen Epic), rejects (optionally with a reason), or modifies the
   * title / body / Epic before approving. `onDecided` fires after a successful decision — the card
   * is about to leave the list, so the caller owns the message shown in its place.
   */
  let {
    suggestion,
    epics = [],
    onDecided,
  }: {
    suggestion: TicketSuggestion;
    /** Same-project Epics, for the Modify picker. */
    epics?: { id: number; displayId: string | null; title: string }[];
    onDecided?: (message: string) => void | Promise<void>;
  } = $props();

  let draft = $state<SuggestionDraft>(draftFrom(suggestion));
  let modifying = $state(false);
  let rejecting = $state(false);
  let rejectReason = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  const prUrl = $derived(suggestion.repo ? `https://github.com/${suggestion.repo}/pull/${suggestion.prNumber}` : null);
  const approveBlock = $derived(modifying ? draftApproveError(draft) : null);

  async function approve() {
    if (busy || approveBlock) return;
    busy = true;
    error = null;
    try {
      const edits = modifying ? approveEdits(suggestion, draft) : {};
      const created = await approveTicketSuggestion(suggestion.id, edits);
      await onDecided?.(
        created.createdTicketDisplayId
          ? `Approved — created ${created.createdTicketDisplayId}.`
          : 'Approved — ticket created.',
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function reject() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await rejectTicketSuggestion(suggestion.id, rejectReason);
      await onDecided?.('Rejected.');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="ts">
  <p class="ts-intro">
    The Evaluator left
    {suggestion.findings.length === 1 ? '1 non-blocking finding' : `${suggestion.findings.length} non-blocking findings`}
    open when
    {#if prUrl}<a href={prUrl} target="_blank" rel="noreferrer">PR #{suggestion.prNumber}</a>{:else}PR #{suggestion.prNumber}{/if}
    shipped. Approve to track them as a new ticket.
  </p>

  <ul class="ts-findings">
    {#each suggestion.findings as f, i (i)}<li>{findingLine(f)}</li>{/each}
  </ul>

  {#if modifying}
    <label class="ts-field">
      <span>Title</span>
      <input class="ts-input" type="text" bind:value={draft.title} />
    </label>
    <label class="ts-field">
      <span>Body</span>
      <textarea class="ts-input ts-textarea" rows="5" bind:value={draft.body}></textarea>
    </label>
    <label class="ts-field">
      <span>Epic</span>
      <select class="ts-input" bind:value={draft.epicId}>
        <option value={null} disabled>Choose an Epic…</option>
        {#each epics as e (e.id)}
          <option value={e.id}>{e.displayId ? `${e.displayId} · ` : ''}{e.title}</option>
        {/each}
      </select>
    </label>
  {:else}
    <dl class="ts-proposal">
      <dt>New ticket</dt>
      <dd>{suggestion.proposedTitle}</dd>
      <dt>Epic</dt>
      <dd>
        {#if suggestion.proposedEpicDisplayId}{suggestion.proposedEpicDisplayId} · {/if}
        {suggestion.proposedEpicTitle ?? 'none chosen'}
      </dd>
    </dl>
  {/if}

  {#if rejecting}
    <label class="ts-field">
      <span>Reason (optional)</span>
      <input class="ts-input" type="text" bind:value={rejectReason} placeholder="why it's not worth a ticket" />
    </label>
  {/if}

  {#if approveBlock}<p class="ts-hint">{approveBlock}</p>{/if}
  {#if error}<p class="ts-error" role="alert">{error}</p>{/if}

  <div class="ts-actions">
    {#if rejecting}
      <button class="ts-reject" onclick={reject} disabled={busy}>Confirm reject</button>
      <button class="ts-plain" onclick={() => (rejecting = false)} disabled={busy}>Cancel</button>
    {:else}
      <button class="ts-approve" onclick={approve} disabled={busy || !!approveBlock}>Approve</button>
      <button class="ts-plain" onclick={() => (modifying = !modifying)} disabled={busy}>
        {modifying ? 'Discard edits' : 'Modify'}
      </button>
      <button class="ts-reject" onclick={() => (rejecting = true)} disabled={busy}>Reject</button>
    {/if}
  </div>
</div>

<style lang="scss" src="./TicketSuggestionCard.scss"></style>
