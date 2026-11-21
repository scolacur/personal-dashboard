<script lang="ts">
  import type { AgentTicket, RefineProposal } from '@dashboard/shared';
  import { approveRefine, markRefined, queueGateBlockers, rejectRefine } from '../routes/devops/api';
  import { predictQueueRefusals, refusalHint, refusalRows, type RefusalRow } from './refine-queue-gate';
  import {
    REJECTED_MESSAGE,
    approvedMessage,
    childBornRefined,
    proposalCanQueue,
    proposalDetailsSummary,
    proposalModeLabel,
    proposalNotReady,
  } from './refine-proposal-logic';

  // A Refine commit proposal (D-044, PD-269) with its Approve / Approve & queue / Reject actions.
  // Extracted from TicketThread (PD-843) so the Decisions inbox offers the same gate: one component,
  // one set of rules for what each button does.
  // isEpic: a decompose is a Populate and "Approve & queue" is hidden (D-054/D-057).
  // epic / epicMembers (PD-760): when the page has them, the Queue gate's refusal is foreseen
  // before the click. Optional: without them the server's 409 is still rendered.
  // collapsed: the body / children start folded (the Decisions inbox lists many at once).
  // onDecided fires after a successful approve or reject, with the message to show. The proposal
  // is gone after that, so the caller owns the message (this card is about to disappear).
  // onChanged fires after the Epic is marked refined from a Queue-gate remedy.
  const {
    ticketId,
    proposal,
    isEpic = false,
    epic = null,
    epicMembers = [],
    collapsed = false,
    onDecided,
    onChanged,
  }: {
    ticketId: number;
    proposal: RefineProposal;
    isEpic?: boolean;
    epic?: AgentTicket | null;
    epicMembers?: AgentTicket[];
    collapsed?: boolean;
    onDecided?: (message: string) => void | Promise<void>;
    onChanged?: () => void;
  } = $props();

  let deciding = $state(false);
  let msg = $state<string | null>(null);
  // PD-760: the Queue gate's refusal of "Approve & queue", shown beside the buttons with a remedy per
  // row. Null when there is none. Nothing has been written while it is showing.
  let gateRows = $state<RefusalRow[] | null>(null);

  const canQueue = $derived(proposalCanQueue(proposal, isEpic));
  const notReady = $derived(proposalNotReady(proposal));
  // PD-760: what the page can foresee the gate refusing (approval itself refines the ticket, so only
  // its Epic can). The server stays the authority: an unforeseen 409 is rendered from its criteria.
  const foreseen = $derived(predictQueueRefusals(ticketId, epic, epicMembers));
  const gateHint = $derived(refusalHint(foreseen, epic));

  async function decide(action: 'approve' | 'approve-queue' | 'reject') {
    if (deciding) return;
    msg = null;
    gateRows = null;
    // PD-760: a foreseen refusal is shown without asking the server, which would refuse anyway.
    if (action === 'approve-queue' && foreseen.length > 0) {
      gateRows = refusalRows(foreseen, epic, epicMembers, ticketId);
      return;
    }
    deciding = true;
    try {
      let message: string;
      if (action === 'reject') {
        await rejectRefine(ticketId);
        message = REJECTED_MESSAGE;
      } else {
        message = approvedMessage(await approveRefine(ticketId, { queue: action === 'approve-queue' }));
      }
      await onDecided?.(message);
    } catch (e) {
      const server = queueGateBlockers(e);
      if (server) gateRows = refusalRows(server, epic, epicMembers, ticketId);
      else msg = e instanceof Error ? e.message : String(e);
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
      msg = 'Epic marked refined. Approve & queue is clear now.';
      onChanged?.();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    } finally {
      deciding = false;
    }
  }
</script>

{#snippet details()}
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
            <!-- No lane per child (PD-598): where children land is a property of approval, not
                 of any one child. -->
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
{/snippet}

<div class="proposal-card" role="group" aria-label="Proposed commit">
  <div class="proposal-head">
    <span class="who">Refine agent</span>
    <span class="proposal-badge">Proposed: {proposalModeLabel(proposal, isEpic)}</span>
  </div>
  {#if proposal.rationale}<p class="proposal-rationale">{proposal.rationale}</p>{/if}

  {#if collapsed}
    <details class="proposal-details">
      <summary>{proposalDetailsSummary(proposal, isEpic)}</summary>
      {@render details()}
    </details>
  {:else}
    {@render details()}
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
  {#if msg}<p class="proposal-msg" role="status">{msg}</p>{/if}
</div>

<style lang="scss" src="./RefineProposalCard.scss"></style>
