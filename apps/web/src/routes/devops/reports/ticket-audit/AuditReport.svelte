<script lang="ts">
  import type { AgentProject, AgentTicket, AuditFinding, TicketPriority } from '@dashboard/shared';
  import { TICKET_PRIORITIES } from '@dashboard/shared';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    groupByProjectAndBucket,
    openActionableFindings,
    isActionable,
    canAccept,
    needsReviewBeforeAccept,
    suggestedPriority,
    batchEligibleFindings,
  } from '$lib/audit-logic';
  import { bucketLabel, bucketColor, ticketStatusLabel } from '$lib/audit-display';
  import { setFindingDecision } from '$lib/audit-api';

  // Shared grouped-findings view (PD-286). The `/reports/ticket-audit` page passes mode="open"
  // (undecided + actionable only — the living view); the per-run permalink passes mode="all".
  // Apply mechanics (PD-826): Accept / Reject land here, gated by confidence. `onChanged` lets the
  // parent reload after a write so the lists reflect the new decision state.
  let {
    findings,
    projects,
    tickets,
    mode = 'all',
    onChanged,
  }: {
    findings: AuditFinding[];
    projects: AgentProject[];
    tickets: AgentTicket[];
    mode?: 'open' | 'all';
    onChanged?: () => void | Promise<void>;
  } = $props();

  const projectsById = $derived(new Map(projects.map((p) => [p.id, p])));
  const ticketsById = $derived(new Map(tickets.map((t) => [t.id, t])));

  const shown = $derived(mode === 'open' ? openActionableFindings(findings) : findings);
  const groups = $derived(groupByProjectAndBucket(shown));
  const batchEligible = $derived(batchEligibleFindings(shown));

  function projectName(id: number | null): string {
    return (id !== null && projectsById.get(id)?.name) || 'No project';
  }

  // ── Decision state (PD-826) ──────────────────────────────────────────────
  const reviewed = new SvelteSet<number>(); // findings opened before a gated Accept
  let priorityChoice = $state<Record<number, TicketPriority>>({});
  let rejectingId = $state<number | null>(null);
  let rejectReason = $state('');
  let busyId = $state<number | null>(null);
  let batchBusy = $state(false);
  let actionError = $state<string | null>(null);
  let batchResult = $state<string | null>(null);

  function markReviewed(f: AuditFinding): void {
    reviewed.add(f.id);
  }

  function priorityFor(f: AuditFinding): TicketPriority {
    return priorityChoice[f.id] ?? suggestedPriority(f) ?? 'P3';
  }

  function acceptBlocked(f: AuditFinding): boolean {
    return needsReviewBeforeAccept(f) && !reviewed.has(f.id);
  }

  async function decide(f: AuditFinding, input: Parameters<typeof setFindingDecision>[1]): Promise<void> {
    busyId = f.id;
    actionError = null;
    try {
      await setFindingDecision(f.id, input);
      rejectingId = null;
      rejectReason = '';
      await onChanged?.();
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      busyId = null;
    }
  }

  function accept(f: AuditFinding): void {
    const input =
      f.type === 'reprioritize'
        ? { decision: 'accepted' as const, targetPriority: priorityFor(f) }
        : { decision: 'accepted' as const };
    void decide(f, input);
  }

  function reject(f: AuditFinding): void {
    void decide(f, { decision: 'rejected', reason: rejectReason.trim() || null });
  }

  async function applyAccepted(): Promise<void> {
    batchBusy = true;
    actionError = null;
    batchResult = null;
    const eligible = batchEligible;
    let applied = 0;
    try {
      for (const f of eligible) {
        await setFindingDecision(f.id, { decision: 'accepted' });
        applied++;
      }
    } catch (e) {
      actionError = e instanceof Error ? e.message : String(e);
    } finally {
      batchBusy = false;
      batchResult = `Applied ${applied} of ${eligible.length} eligible.`;
      await onChanged?.();
    }
  }
</script>

{#if shown.length === 0}
  <p class="audit-empty">
    {mode === 'open'
      ? 'No open findings — the backlog is clean, or every finding has been actioned.'
      : 'This run produced no findings.'}
  </p>
{:else}
  <div class="audit-toolbar">
    <button
      type="button"
      class="batch-btn"
      disabled={batchBusy || batchEligible.length === 0}
      onclick={applyAccepted}
    >
      {batchBusy ? 'Applying…' : `Apply accepted (${batchEligible.length})`}
    </button>
    <span class="batch-hint">High-confidence archive/complete only.</span>
    {#if batchResult}<span class="batch-result">{batchResult}</span>{/if}
  </div>
  {#if actionError}
    <p class="audit-action-error" role="alert">{actionError}</p>
  {/if}

  <div class="audit-groups">
    {#each groups as group (group.projectId)}
      <section class="audit-project">
        <h2 class="audit-project-head">{projectName(group.projectId)}</h2>
        {#each group.buckets as bucket (bucket.type)}
          <div class="audit-bucket">
            <h3 class="audit-bucket-head">
              <span class="rec-pill" style="--rec: {bucketColor(bucket.type)}">
                {bucketLabel(bucket.type)}
              </span>
              <span class="audit-bucket-count">{bucket.findings.length}</span>
            </h3>
            <ul class="audit-findings">
              {#each bucket.findings as f (f.id)}
                {@const ticket = f.ticketId !== null ? ticketsById.get(f.ticketId) : undefined}
                <li class="audit-finding">
                  <div class="finding-top">
                    {#if ticket?.displayId}
                      <a class="finding-ticket" href="/devops/tickets/{ticket.displayId}">
                        {ticket.displayId}
                      </a>
                    {:else}
                      <span class="finding-ticket finding-ticket-missing">
                        {f.ticketId !== null ? `#${f.ticketId}` : 'unlinked'}
                      </span>
                    {/if}
                    <span class="finding-title">{ticket?.title ?? '(ticket not found)'}</span>
                    <span class="finding-pills">
                      {#if ticket}
                        <span class="pill pill-status">{ticketStatusLabel(ticket.status)}</span>
                        {#if ticket.priority}<span class="pill pill-prio">{ticket.priority}</span>{/if}
                      {/if}
                      {#if f.confidence}<span class="pill pill-conf">conf: {f.confidence}</span>{/if}
                    </span>
                  </div>
                  {#if f.recommendation}<p class="finding-rec">{f.recommendation}</p>{/if}
                  {#if f.reason}<p class="finding-reason">{f.reason}</p>{/if}
                  {#if f.proposedChange}
                    <details class="finding-proposed">
                      <summary>Proposed change</summary>
                      <pre>{f.proposedChange}</pre>
                    </details>
                  {/if}

                  {#if f.decision !== 'undecided'}
                    <div class="finding-decided" data-decision={f.decision}>
                      {#if f.decision === 'accepted'}✓ Accepted
                      {:else if f.decision === 'rejected'}✗ Rejected{#if f.decisionReason}: {f.decisionReason}{/if}
                      {:else}{f.decision}{/if}
                    </div>
                  {:else if isActionable(f)}
                    <div class="finding-actions">
                      {#if canAccept(f)}
                        {#if f.type === 'reprioritize'}
                          <label class="prio-select">
                            Target
                            <select
                              value={priorityFor(f)}
                              onchange={(e) =>
                                (priorityChoice = {
                                  ...priorityChoice,
                                  [f.id]: e.currentTarget.value as TicketPriority,
                                })}
                            >
                              {#each TICKET_PRIORITIES as p (p)}
                                <option value={p}>{p}</option>
                              {/each}
                            </select>
                          </label>
                        {/if}
                        {#if acceptBlocked(f)}
                          <a
                            class="review-link"
                            href={ticket?.displayId ? `/devops/tickets/${ticket.displayId}` : '#'}
                            target="_blank"
                            rel="noopener"
                            onclick={() => markReviewed(f)}
                          >
                            Open to review
                          </a>
                        {/if}
                        <button
                          type="button"
                          class="act-btn act-accept"
                          disabled={busyId === f.id || acceptBlocked(f)}
                          title={acceptBlocked(f) ? 'Open the ticket to review before accepting' : ''}
                          onclick={() => accept(f)}
                        >
                          Accept
                        </button>
                      {:else}
                        <span class="act-unsupported">Accept lands with the update slice</span>
                      {/if}

                      {#if rejectingId === f.id}
                        <textarea
                          class="reject-reason"
                          placeholder="Reason (optional)"
                          bind:value={rejectReason}
                        ></textarea>
                        <button
                          type="button"
                          class="act-btn act-reject"
                          disabled={busyId === f.id}
                          onclick={() => reject(f)}
                        >
                          Confirm reject
                        </button>
                        <button
                          type="button"
                          class="act-btn act-cancel"
                          onclick={() => {
                            rejectingId = null;
                            rejectReason = '';
                          }}
                        >
                          Cancel
                        </button>
                      {:else}
                        <button
                          type="button"
                          class="act-btn act-reject"
                          disabled={busyId === f.id}
                          onclick={() => {
                            rejectingId = f.id;
                            rejectReason = '';
                          }}
                        >
                          Reject
                        </button>
                      {/if}
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </section>
    {/each}
  </div>
{/if}

<style lang="scss" src="./AuditReport.scss"></style>
