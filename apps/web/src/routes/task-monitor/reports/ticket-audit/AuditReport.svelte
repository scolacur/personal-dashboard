<script lang="ts">
  import type { AgentProject, AgentTicket, AuditFinding } from '@dashboard/shared';
  import { groupByProjectAndBucket, openActionableFindings } from '$lib/audit-logic';
  import { bucketLabel, bucketColor, ticketStatusLabel } from '$lib/audit-display';

  // Shared grouped-findings view (PD-286). The `/reports/ticket-audit` page passes mode="open"
  // (undecided + actionable only — the living view); the per-run permalink passes mode="all".
  let {
    findings,
    projects,
    tickets,
    mode = 'all',
  }: {
    findings: AuditFinding[];
    projects: AgentProject[];
    tickets: AgentTicket[];
    mode?: 'open' | 'all';
  } = $props();

  const projectsById = $derived(new Map(projects.map((p) => [p.id, p])));
  const ticketsById = $derived(new Map(tickets.map((t) => [t.id, t])));

  const shown = $derived(mode === 'open' ? openActionableFindings(findings) : findings);
  const groups = $derived(groupByProjectAndBucket(shown));

  function projectName(id: number | null): string {
    return (id !== null && projectsById.get(id)?.name) || 'No project';
  }
</script>

{#if shown.length === 0}
  <p class="audit-empty">
    {mode === 'open'
      ? 'No open findings — the backlog is clean, or every finding has been actioned.'
      : 'This run produced no findings.'}
  </p>
{:else}
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
                      <a class="finding-ticket" href="/task-monitor/tickets/{ticket.displayId}">
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
