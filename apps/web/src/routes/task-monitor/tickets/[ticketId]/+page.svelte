<script lang="ts">
  import { page } from '$app/state';
  import type {
    AgentProject,
    AgentTicket,
    EpicSummary,
    ResolvedRelation,
    TicketRelation,
    TicketStatus,
    TicketPriority,
    TicketAssignee,
    UpdateTicketInput,
  } from '@dashboard/shared';
  import {
    PRIORITY_LABELS,
    AGENT_STATE_LABELS,
    ASSIGNEE_LABELS,
    TICKET_STATUSES,
    TICKET_PRIORITIES,
    TICKET_ASSIGNEES,
  } from '@dashboard/shared';
  import * as api from '../../api';
  import { projectIdColor } from '../../api';
  import GithubMark from '$lib/icons/GithubMark.svelte';
  import TicketThread from '$lib/TicketThread.svelte';
  import RunHistory from '$lib/RunHistory.svelte';
  import ActivityTimeline from '$lib/ActivityTimeline.svelte';
  import Collapsible from '$lib/Collapsible.svelte';
  import GlossaryModal from '$lib/GlossaryModal.svelte';
  import Modal from '$lib/Modal.svelte';
  import RelationPicker from '../../RelationPicker.svelte';
  import { RELATION_ACTIONS, relationLabel, type RelationAction } from '../../relation-logic';
  import { ticketMatchesQuery } from '../../filter-logic';

  // The route param is the human-facing display id, e.g. 'PD-173'.
  const ticketId = $derived(page.params.ticketId);

  let ticket = $state<AgentTicket | null>(null);
  let project = $state<AgentProject | null>(null);
  let allProjects = $state<AgentProject[]>([]);
  let allTickets = $state<AgentTicket[]>([]);
  let relations = $state<ResolvedRelation[]>([]);
  // Epic members + roll-up (D-054, PD-338), loaded only when this ticket is an Epic.
  let epicMembers = $state<AgentTicket[]>([]);
  let epicSummary = $state<EpicSummary | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notFound = $state(false);

  // Option C layout (PD-345). Desktop: Overview is the always-on left column; the right column
  // toggles between Details and Refine. Mobile: one pane at a time via the bottom nav. The two
  // states are independent (they belong to different viewports) — CSS shows the relevant one.
  let rightTab = $state<'details' | 'refine'>('details');
  let mobilePane = $state<'overview' | 'details' | 'refine'>('overview');

  const STATUS_LABELS: Record<TicketStatus, string> = {
    backlog: 'Backlog',
    prioritized: 'Prioritized',
    robot_queue: "Robot's Queue",
    steve_queue: "Steve's Queue",
    completed: 'Completed',
    closed: 'Closed',
  };

  // No single-ticket API endpoint yet, so find it in the list (works against the
  // deployed API without a server change). Cheap enough for this board's size.
  async function load(id: string) {
    loading = true;
    error = null;
    notFound = false;
    ticket = null;
    project = null;
    try {
      const [projects, tickets] = await Promise.all([api.fetchProjects(), api.fetchTickets()]);
      allProjects = projects;
      allTickets = tickets;
      const found = tickets.find((t) => t.displayId === id) ?? null;
      if (!found) {
        notFound = true;
        return;
      }
      ticket = found;
      project =
        found.projectId !== null ? (projects.find((p) => p.id === found.projectId) ?? null) : null;
      relations = await api.fetchRelations(found.id);
      if (found.isEpic) {
        const m = await api.fetchEpicMembers(found.id);
        epicMembers = m.members;
        epicSummary = m.summary;
      } else {
        epicMembers = [];
        epicSummary = null;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (ticketId) load(ticketId);
  });

  function fmt(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  // Inline attribute editing (PD-374) — the detail page can now edit what a card can, reusing
  // the same updateTicket call. A non-empty Epic's lane is derived from its members (D-054), so
  // status editing is disabled for Epics.
  const statusLocked = $derived(ticket?.isEpic ?? false);
  async function updateField(patch: UpdateTicketInput) {
    if (!ticket || !ticketId) return;
    error = null;
    try {
      await api.updateTicket(ticket.id, patch);
      await load(ticketId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // PD-250 inline reply: shown when the agent has parked for input on a linked issue.
  let replyText = $state('');
  let replying = $state(false);
  let replyMsg = $state<string | null>(null);

  const isParked = $derived(
    ticket?.agentState === 'awaiting-human' || ticket?.agentState === 'needs-human',
  );

  // A ticket the Robot loop has parked and won't retry on its own — the C4 remediation controls
  // (Reset / Unstick) show on the Overview banner for exactly these states.
  const isRobotParked = $derived(
    ticket?.agentState === 'stuck' ||
      ticket?.agentState === 'awaiting-human' ||
      ticket?.agentState === 'needs-human',
  );

  // C4 remediation: clear a ticket's retry budget (reset) or a park (unstick) and re-queue it.
  let remediating = $state(false);
  async function remediate(kind: 'reset' | 'unstick') {
    if (!ticket || remediating || !ticketId) return;
    remediating = true;
    error = null;
    try {
      await (kind === 'reset' ? api.resetTicketRuns(ticket.id) : api.unstickTicket(ticket.id));
      await load(ticketId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      remediating = false;
    }
  }

  async function submitReply() {
    if (!ticket || !replyText.trim()) return;
    replying = true;
    replyMsg = null;
    try {
      await api.replyToTicket(ticket.id, replyText.trim());
      replyMsg = 'Reply sent — the agent will resume shortly.';
      replyText = '';
    } catch (e) {
      replyMsg = e instanceof Error ? e.message : String(e);
    } finally {
      replying = false;
    }
  }

  // Start a Refine session (D-044, PD-268) from the detail page. The TicketThread below
  // polls, so the kickoff turn appears shortly after; reload to flip refineState now.
  let starting = $state(false);
  async function startRefine() {
    if (!ticket || starting || !ticketId) return;
    starting = true;
    error = null;
    try {
      await api.startRefine(ticket.id);
      await load(ticketId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      starting = false;
    }
  }

  // Mark the ticket refined (D-044, PD-268). PD-269's commit step will also set this; until
  // then it's a manual "I'm satisfied with this refinement" action.
  let markingRefined = $state(false);

  let glossaryOpen = $state(false);
  async function markRefined() {
    if (!ticket || markingRefined || !ticketId) return;
    markingRefined = true;
    error = null;
    try {
      await api.updateTicket(ticket.id, { refined: true });
      await load(ticketId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      markingRefined = false;
    }
  }

  // ── Relations management (PD-322, D-051) ──────────────────────────────────
  // The relations picker + a per-row Remove make the detail page the authoritative place to
  // hand-manage every relation type; this supersedes PD-269's read-only split-only lineage view.
  let addMenuOpen = $state(false);
  let pickerOpen = $state(false);
  let pickerAction = $state<RelationAction | null>(null);

  // The picker excludes tickets already related of the chosen type; it reads raw rows, so map
  // this ticket's resolved relations back into (from,to) pairs for it.
  const relationRows = $derived<TicketRelation[]>(
    ticket
      ? relations.map((r) => ({
          id: r.id,
          fromTicketId: r.direction === 'from' ? ticket!.id : r.other.ticketId,
          toTicketId: r.direction === 'from' ? r.other.ticketId : ticket!.id,
          type: r.type,
          origin: r.origin,
          createdAt: r.createdAt,
        }))
      : [],
  );

  function chooseAdd(action: RelationAction) {
    addMenuOpen = false;
    pickerAction = action;
    pickerOpen = true;
  }

  async function removeRelation(rel: ResolvedRelation) {
    if (!ticket) return;
    const other = rel.other.displayId ?? `#${rel.other.ticketId}`;
    if (!confirm(`Remove "${relationLabel(rel)} ${other}"?`)) return;
    error = null;
    try {
      await api.deleteRelation(ticket.id, rel.id);
      if (ticketId) await load(ticketId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // ── Epic membership (D-054, PD-338) ───────────────────────────────────────
  const memberDone = $derived(epicSummary?.done ?? 0);
  const memberTotal = $derived(epicSummary?.total ?? 0);
  const memberPct = $derived(memberTotal > 0 ? Math.round((memberDone / memberTotal) * 100) : 0);

  let memberPickerOpen = $state(false);
  let memberQuery = $state('');
  $effect(() => {
    if (memberPickerOpen) memberQuery = '';
  });

  // Candidate members: non-epic tickets in the same project, not already in this Epic.
  const memberCandidates = $derived(
    ticket
      ? allTickets
          .filter(
            (t) =>
              !t.isEpic &&
              t.projectId === ticket!.projectId &&
              t.id !== ticket!.id &&
              t.epicId !== ticket!.id &&
              ticketMatchesQuery(t, memberQuery),
          )
          .slice(0, 50)
      : [],
  );

  async function setMemberEpic(memberId: number, epicId: number | null) {
    error = null;
    try {
      await api.updateTicket(memberId, { epicId });
      if (ticketId) await load(ticketId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function addMember(t: AgentTicket) {
    if (!ticket) return;
    memberPickerOpen = false;
    await setMemberEpic(t.id, ticket.id);
  }
</script>

<nav class="detail-nav">
  <a href="/task-monitor">← Back to board</a>
</nav>

{#if loading}
  <p class="muted">Loading…</p>
{:else if error}
  <p class="error" role="alert">{error}</p>
{:else if notFound}
  <div class="not-found">
    <h1>Ticket not found</h1>
    <p class="muted">No ticket with id <strong>{ticketId}</strong>.</p>
  </div>
{:else if ticket}
  <article class="ticket-detail" data-rt={rightTab} data-pane={mobilePane}>
    <!-- Header: full width, above the columns. -->
    <header class="detail-head">
      <div class="head-badges">
        <span class="detail-id">{ticket.displayId}</span>
        <span class="priority priority-{ticket.priority ?? 'none'}">{ticket.priority ?? '—'}</span>
        {#if ticket.priority}
          <span class="priority-name">{PRIORITY_LABELS[ticket.priority]}</span>
        {/if}
        <span class="status-badge">{STATUS_LABELS[ticket.status] ?? ticket.status}</span>
        {#if ticket.agentState}
          <span class="agent-pill agent-{ticket.agentState}">
            {AGENT_STATE_LABELS[ticket.agentState] ?? ticket.agentState}
          </span>
        {/if}
        {#if project}
          <span class="project-chip" style="--chip: {projectIdColor(project)}">{project.name}</span>
        {/if}
        {#if ticket.githubIssueUrl}
          <a
            class="gh-link"
            href={ticket.githubIssueUrl}
            target="_blank"
            rel="noreferrer"
            title="GitHub issue #{ticket.githubIssueNumber}"
            aria-label="GitHub issue #{ticket.githubIssueNumber}"
          >
            <GithubMark size={15} />
          </a>
        {/if}
      </div>
      <h1 class="detail-title">{ticket.title}</h1>
    </header>

    <!-- ── OVERVIEW (desktop left 70% · mobile tab 1) ── -->
    <section class="pane pane-overview">
      {#if isRobotParked}
        <div class="parked-banner agent-{ticket.agentState}">
          <span class="pb-lead">⛔ {AGENT_STATE_LABELS[ticket.agentState!] ?? ticket.agentState}</span>
          <span class="pb-note">The Robot won't retry this on its own.</span>
          <span class="pb-actions">
            <button class="pb-btn unstick" type="button" onclick={() => remediate('unstick')} disabled={remediating}>
              Unstick
            </button>
            <button class="pb-btn reset" type="button" onclick={() => remediate('reset')} disabled={remediating}>
              Reset
            </button>
          </span>
        </div>
      {/if}

      {#if isParked}
        <section class="reply-box">
          <h2>Reply to the agent</h2>
          <p class="muted">
            The agent paused ({ticket.agentState?.replace(/-/g, ' ')}) and needs your input. Your
            reply is recorded on the ticket and re-queues it for the Robot.
          </p>
          <textarea
            bind:value={replyText}
            rows="4"
            placeholder="Type your answer…"
            disabled={replying}
          ></textarea>
          <div class="reply-actions">
            <button onclick={submitReply} disabled={replying || !replyText.trim()}>
              {replying ? 'Sending…' : 'Send reply'}
            </button>
            {#if replyMsg}<span class="reply-msg">{replyMsg}</span>{/if}
          </div>
        </section>
      {/if}

      <Collapsible title="Description" storeKey="description">
        {#if ticket.body}
          <p class="detail-body">{ticket.body}</p>
        {:else}
          <p class="muted">No description.</p>
        {/if}
      </Collapsible>

      {#if !ticket.isEpic && ticket.epicId}
        {@const parent = allTickets.find((t) => t.id === ticket!.epicId)}
        {#if parent}
          <p class="belongs-to-epic">
            Part of epic
            <a href="/task-monitor/tickets/{parent.displayId}">{parent.displayId} — {parent.title}</a>
          </p>
        {/if}
      {/if}

      {#if ticket.isEpic}
        <section class="epic-members">
          <div class="epic-members-head">
            <h2>Members</h2>
            <span class="epic-rollup-label">{memberDone}/{memberTotal} done</span>
            <button class="add-member-btn" type="button" onclick={() => (memberPickerOpen = true)}
              >+ Add member</button
            >
          </div>
          <div class="epic-members-bar">
            <div class="epic-members-fill" style="width: {memberPct}%"></div>
          </div>
          {#if epicMembers.length === 0}
            <p class="muted">No members yet.</p>
          {:else}
            <ul class="member-list">
              {#each epicMembers as m (m.id)}
                <li class="member-row">
                  <a class="member-ref" href="/task-monitor/tickets/{m.displayId}"
                    >{m.displayId} — {m.title}</a
                  >
                  <span class="member-status">{STATUS_LABELS[m.status] ?? m.status}</span>
                  <button
                    class="member-remove"
                    type="button"
                    title="Remove from epic"
                    aria-label="Remove from epic"
                    onclick={() => setMemberEpic(m.id, null)}>×</button
                  >
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}

      <Collapsible title="Relations" count={relations.length} storeKey="relations">
        <div class="rel-add-row">
          <div class="add-rel-wrap">
            <button class="add-rel-btn" type="button" onclick={() => (addMenuOpen = !addMenuOpen)}
              >+ Add</button
            >
            {#if addMenuOpen}
              <button
                class="add-rel-scrim"
                type="button"
                aria-label="Close menu"
                onclick={() => (addMenuOpen = false)}
              ></button>
              <div class="add-rel-menu" role="menu">
                {#each RELATION_ACTIONS as action (action.key)}
                  <button
                    class="add-rel-item"
                    type="button"
                    role="menuitem"
                    onclick={() => chooseAdd(action)}>{action.label}</button
                  >
                {/each}
              </div>
            {/if}
          </div>
        </div>
        {#if relations.length === 0}
          <p class="muted">No relations.</p>
        {:else}
          <ul class="relation-list">
            {#each relations as rel (rel.id)}
              <li class="relation-row">
                <span class="relation-kind">{relationLabel(rel)}</span>
                <a class="relation-ref" href="/task-monitor/tickets/{rel.other.displayId}"
                  >{rel.other.displayId ?? `#${rel.other.ticketId}`} — {rel.other.title}</a
                >
                <span class="relation-status">{STATUS_LABELS[rel.other.status] ?? rel.other.status}</span>
                <button
                  class="relation-remove"
                  type="button"
                  title="Remove relation"
                  aria-label="Remove relation"
                  onclick={() => removeRelation(rel)}>×</button
                >
              </li>
            {/each}
          </ul>
        {/if}
      </Collapsible>

      <ActivityTimeline ticketId={ticket.id} />
      <RunHistory ticketId={ticket.id} />
    </section>

    <!-- ── RIGHT COLUMN: Details | Refine (desktop toggle · mobile tabs 2 & 3) ── -->
    <div class="right-col">
      <div class="segbar" role="tablist" aria-label="Right panel">
        <button
          class="seg"
          role="tab"
          aria-selected={rightTab === 'details'}
          onclick={() => (rightTab = 'details')}>Details</button
        >
        <button
          class="seg"
          role="tab"
          aria-selected={rightTab === 'refine'}
          onclick={() => (rightTab = 'refine')}>✦ Refine</button
        >
      </div>

      <section class="pane pane-details">
        <!-- Editable inline (PD-374): the detail page can now change attributes, not just cards. -->
        <dl class="fields">
          <div>
            <dt>Status</dt>
            <dd>
              <select
                class="field-select"
                value={ticket.status}
                disabled={statusLocked}
                title={statusLocked ? "An Epic's lane is derived from its members" : 'Set status'}
                onchange={(e) => updateField({ status: e.currentTarget.value as TicketStatus })}
              >
                {#each TICKET_STATUSES as s (s)}
                  <option value={s}>{STATUS_LABELS[s] ?? s}</option>
                {/each}
              </select>
            </dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>
              <select
                class="field-select"
                value={ticket.priority ?? ''}
                title="Set priority"
                onchange={(e) => updateField({ priority: (e.currentTarget.value || null) as TicketPriority | null })}
              >
                <option value="">—</option>
                {#each TICKET_PRIORITIES as p (p)}
                  <option value={p}>{p} · {PRIORITY_LABELS[p]}</option>
                {/each}
              </select>
            </dd>
          </div>
          <div>
            <dt>Assignee</dt>
            <dd>
              <select
                class="field-select"
                value={ticket.assignee ?? ''}
                title="Set assignee"
                onchange={(e) => updateField({ assignee: (e.currentTarget.value || null) as TicketAssignee | null })}
              >
                <option value="">Unassigned</option>
                {#each TICKET_ASSIGNEES as a (a)}
                  <option value={a}>{ASSIGNEE_LABELS[a] ?? a}</option>
                {/each}
              </select>
            </dd>
          </div>
          <div>
            <dt>Project</dt>
            <dd>
              <select
                class="field-select"
                value={ticket.projectId ?? ''}
                title="Set project"
                onchange={(e) => e.currentTarget.value && updateField({ projectId: Number(e.currentTarget.value) })}
              >
                {#each allProjects as p (p.id)}
                  <option value={p.id}>{p.name}</option>
                {/each}
              </select>
            </dd>
          </div>
          <div>
            <dt>Refinement</dt>
            <dd>{ticket.refined ? '✓ Refined' : (ticket.refineState ?? 'Not started')}</dd>
          </div>
          <div><dt>Source</dt><dd>{ticket.source}</dd></div>
          <div><dt>Created</dt><dd>{fmt(ticket.createdAt)}</dd></div>
          <div><dt>Updated</dt><dd>{fmt(ticket.updatedAt)}</dd></div>
        </dl>
        {#if ticket.githubIssueUrl}
          <p class="details-issue">
            <a class="issue-link gh-inline" href={ticket.githubIssueUrl} target="_blank" rel="noreferrer">
              <GithubMark size={14} /> Issue #{ticket.githubIssueNumber}
            </a>
          </p>
        {/if}
      </section>

      <section class="pane pane-refine">
        {#if ticket.refined}
          <div class="refine-controls"><span class="refined-badge" title="This ticket has been refined">✓ Refined</span></div>
        {/if}
        <TicketThread
          ticketId={ticket.id}
          isEpic={ticket.isEpic}
          onChanged={() => ticketId && load(ticketId)}
          onStart={startRefine}
          {starting}
        />
        <div class="refine-footer">
          <button
            class="info-btn"
            type="button"
            title="Refinement statuses"
            aria-label="Refinement statuses"
            onclick={() => (glossaryOpen = true)}>i</button
          >
          {#if !ticket.refined && ticket.refineState !== null}
            <button class="mark-refined" type="button" onclick={markRefined} disabled={markingRefined}>
              {markingRefined ? 'Marking…' : '✓ Mark refined'}
            </button>
          {/if}
        </div>
      </section>
    </div>

    <!-- ── Mobile bottom nav (hidden on desktop) ── -->
    <nav class="botnav" aria-label="Ticket sections">
      <button
        class="botnav-btn"
        aria-pressed={mobilePane === 'overview'}
        onclick={() => (mobilePane = 'overview')}
      >
        <span class="ic" aria-hidden="true">▤</span>
        <span>Overview</span>
        {#if isRobotParked}<span class="attn-dot" title="Needs attention"></span>{/if}
      </button>
      <button
        class="botnav-btn"
        aria-pressed={mobilePane === 'details'}
        onclick={() => (mobilePane = 'details')}
      >
        <span class="ic" aria-hidden="true">ℹ️</span>
        <span>Details</span>
      </button>
      <button
        class="botnav-btn"
        aria-pressed={mobilePane === 'refine'}
        onclick={() => (mobilePane = 'refine')}
      >
        <span class="ic" aria-hidden="true">✦</span>
        <span>Refine</span>
      </button>
    </nav>

    <GlossaryModal open={glossaryOpen} tab="refinement" onClose={() => (glossaryOpen = false)} />

    <RelationPicker
      open={pickerOpen}
      action={pickerAction}
      source={ticket}
      tickets={allTickets}
      relations={relationRows}
      onClose={() => (pickerOpen = false)}
      onCreated={() => ticketId && load(ticketId)}
    />

    <Modal open={memberPickerOpen} title="Add member to epic" onClose={() => (memberPickerOpen = false)}>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="member-search"
        type="search"
        placeholder="Filter tickets…"
        bind:value={memberQuery}
        autofocus
      />
      <ul class="member-picker-list">
        {#each memberCandidates as t (t.id)}
          <li>
            <button type="button" class="member-picker-row" onclick={() => addMember(t)}>
              <span class="member-picker-id">{t.displayId ?? `#${t.id}`}</span>
              <span class="member-picker-title">{t.title}</span>
              <span class="member-picker-status">{t.status.replace(/_/g, ' ')}</span>
            </button>
          </li>
        {:else}
          <li class="member-picker-empty">No eligible tickets in this project.</li>
        {/each}
      </ul>
    </Modal>
  </article>
{/if}

<style lang="scss" src="./+page.scss"></style>
