<script lang="ts">
  import type { AgentProject, AgentTicket, TicketStatus } from '@dashboard/shared';
  import {
    ASSIGNEE_LABELS,
    TICKET_KIND_LABELS,
    PRIORITY_LABELS,
    REFINE_STATE_LABELS,
    ROBOT_MAX_TURNS_DEFAULT,
    TICKET_STATUSES,
  } from '@dashboard/shared';
  import { Layers, Pencil, Ticket as TicketIcon } from 'lucide-svelte';
  import GithubMark from '$lib/icons/GithubMark.svelte';
  import { projectIdColor } from '../../api';
  import { goto } from '$app/navigation';
  import { toast } from '$lib/toast-store.svelte';
  import { portal } from '$lib/portal';
  import * as api from '../../api';
  import { isStatusLocked } from '../../board-logic';
  import { coderAreaChip } from '../../coder-area';
  import { resolveUnrefineChoice } from '../../refine-prompt';
  import { joinsEpic, joinWriteOpts, planEpicJoin, unrefinedToast, type EpicJoinChoice, type EpicJoinPlan } from '../../epic-join';
  import EpicJoinModal from '../../EpicJoinModal.svelte';
  import TicketFormModal from '../../task-tracker/TicketFormModal.svelte';
  import {
    emptyTicketForm,
    epicRequired,
    saveChecks,
    ticketToForm,
    type SaveCheck,
    type TicketFormState,
  } from '../../task-tracker/ticket-form';

  /**
   * The detail page's Details panel — the one place a ticket's attributes are listed (PD-605): the
   * header above is identity only (id, P pill, Robot state), so lane, priority, project and the
   * GitHub issue are read here and not repeated there. Editing goes through the same add/edit modal
   * the board uses (Edit button), rather than a row of inline selects — one form, one set of rules.
   *
   * The save mirrors the board's edit path: a drafted Epic is minted first, joining a refined Epic
   * asks first (PD-703), and a body change on a refined ticket asks whether it stays refined
   * (D-097). The Queue gate is left to the server — its refusal is shown inside the modal.
   */
  const {
    ticket,
    allTickets,
    allProjects,
    project,
    parentEpic,
    memberCount,
    frozen,
    onSaved,
  }: {
    ticket: AgentTicket;
    allTickets: AgentTicket[];
    allProjects: AgentProject[];
    project: AgentProject | null;
    /** The Ticket's Epic, when it has one — a member's priority is the Epic's (D-080). */
    parentEpic: AgentTicket | undefined;
    /** This Epic's member count — a non-empty Epic's lane is derived from its members (D-054). */
    memberCount: number;
    /** D-083: a terminal Ticket is read-only. */
    frozen: boolean;
    onSaved: () => void;
  } = $props();

  const STATUS_LABELS: Record<TicketStatus, string> = {
    backlog: 'Backlog',
    queue: 'Queue',
    completed: 'Completed',
    closed: 'Closed',
  };
  const COLUMNS = TICKET_STATUSES.map((status) => ({ status, label: STATUS_LABELS[status] }));

  function fmt(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  // D-080: a member reads its Epic's priority (an unclassified Epic leaves the member's own value).
  const priorityFrom = $derived(
    !ticket.isEpic && parentEpic !== undefined && parentEpic.priority !== null ? parentEpic : null,
  );

  const refinement = $derived(
    ticket.refined ? '✓ Refined' : ticket.refineState ? REFINE_STATE_LABELS[ticket.refineState] : 'Not started',
  );

  // PD-955 (PD-880): the Coder code-area this ticket would run under. On an Epic it is the Epic's own
  // default; on a Ticket it resolves its own override, then its Epic's default, then `general`.
  const areaChip = $derived(coderAreaChip(ticket, ticket.isEpic ? null : parentEpic));

  // ── Edit modal ──
  let formOpen = $state(false);
  // Filled from the ticket each time the modal opens (openEdit), so it never edits a stale copy.
  let form = $state<TicketFormState>(emptyTicketForm('backlog', null));
  let busy = $state(false);
  let submitError = $state<string | null>(null);
  // The loading state: what this save checks, and how far it has got (minting a drafted Epic is a
  // separate client-side step before the server's PATCH).
  let progress = $state<{ checks: SaveCheck[]; stage: SaveCheck['stage'] } | null>(null);
  let joinPlan = $state<EpicJoinPlan | null>(null);

  const locked = $derived(isStatusLocked(ticket));
  const epicOptions = $derived(
    allTickets.filter((t) => t.isEpic && t.projectId === form.projectId && t.id !== ticket.id),
  );
  const requireEpic = $derived(
    epicRequired({ creating: false, hadEpic: ticket.epicId !== null, status: form.status }),
  );
  const statusDerived = $derived(form.isEpic && memberCount > 0);

  function openEdit() {
    if (frozen) return;
    form = ticketToForm(ticket, allProjects[0]?.id ?? null);
    submitError = null;
    formOpen = true;
  }

  async function submit() {
    if (!form.title.trim() || form.projectId === null) return;
    // PD-703: joining a refined Epic is asked about first. A drafted Epic is new and unrefined.
    const drafting = form.newEpic !== null && form.newEpic.title.trim() !== '';
    if (!form.isEpic && !drafting && joinsEpic(ticket, form.epicId)) {
      const target = form.epicId;
      const plan = planEpicJoin(allTickets.find((t) => t.id === target), allTickets);
      if (plan) {
        joinPlan = plan;
        return;
      }
    }
    await write(null);
  }

  async function chooseJoin(choice: EpicJoinChoice) {
    const plan = joinPlan;
    joinPlan = null;
    if (!plan) return;
    if (!(await write({ plan, choice }))) return;
    if (!choice.reRefine) {
      toast.show(unrefinedToast(plan.epic), 'info');
      return;
    }
    try {
      // PD-996: a delta check on this ticket joining, not a from-scratch re-refine of the Epic.
      await api.startRefine(plan.epic.id, { addedMemberId: ticket.id });
    } catch (e) {
      // Most likely a session is already open on the Epic: the move stands, and going there is
      // still the right next step.
      toast.show(e instanceof Error ? e.message : String(e), 'info');
    }
    if (plan.epic.displayId) await goto(`/devops/tickets/${plan.epic.displayId}`);
  }

  /** Returns whether the write landed. */
  async function write(join: { plan: EpicJoinPlan; choice: EpicJoinChoice } | null): Promise<boolean> {
    const title = form.title.trim();
    if (!title || form.projectId === null) return false;
    busy = true;
    submitError = null;
    const checks = saveChecks(ticket, form);
    progress = { checks, stage: checks[0].stage };
    let minted: AgentTicket | null = null;
    try {
      // An Epic never belongs to another Epic (D-054). A drafted Epic is minted first so the ticket
      // lands in it with the Epic's priority in one write (D-080 slice C).
      let epicId = form.isEpic ? null : form.epicId;
      if (!form.isEpic && form.newEpic !== null && form.newEpic.title.trim()) {
        minted = await api.createTicket({
          title: form.newEpic.title.trim(),
          projectId: form.projectId,
          priority: form.newEpic.priority,
          status: 'backlog',
          isEpic: true,
          body: null,
        });
        epicId = minted.id;
      }
      progress = { checks, stage: 'server' };
      const maxTurns = form.maxTurns.trim() === '' ? null : Number(form.maxTurns);
      const body = form.body.trim() || null;
      // D-097: a body change on a refined ticket must say whether it stays refined.
      const refinedChoice = resolveUnrefineChoice(ticket, body, (m) => confirm(m));
      await api.updateTicket(
        ticket.id,
        {
          title,
          body,
          priority: form.priority,
          projectId: form.projectId,
          assignee: form.assignee,
          isEpic: form.isEpic,
          epicId,
          maxTurns,
          kind: form.isEpic ? null : form.kind,
          coderArea: form.coderArea,
          // An agent-controlled ticket's status is not ours to send.
          ...(locked ? {} : { status: form.status }),
          ...(refinedChoice !== undefined ? { refined: refinedChoice } : {}),
        },
        join ? joinWriteOpts(join.plan, join.choice) : {},
      );
      formOpen = false;
      if (minted) toast.show(`Created Epic ${minted.displayId} — ${ticket.displayId ?? title} is its first member.`, 'info');
      onSaved();
      return true;
    } catch (e) {
      submitError = e instanceof Error ? e.message : String(e);
      if (minted) submitError += ` (Epic ${minted.displayId} was created before this failed — it is now empty.)`;
      return false;
    } finally {
      busy = false;
      progress = null;
    }
  }
</script>

<div class="details-head">
  <h2>Details</h2>
  <button
    type="button"
    class="edit-btn"
    onclick={openEdit}
    disabled={frozen}
    title={frozen ? 'Completed work is read-only — use Reopen' : `Edit ${ticket.isEpic ? 'Epic' : 'Ticket'}`}
  >
    <Pencil size={13} aria-hidden="true" />
    Edit
  </button>
</div>

<dl class="fields">
  <!-- Type first: an Epic and a Ticket share this page, and which one you are on changes what
       every other row means (an Epic's lane is derived, its priority cascades). -->
  <div>
    <dt>Type</dt>
    <dd>
      {#if ticket.isEpic}
        <span class="type type-epic"><Layers size={13} aria-hidden="true" />Epic</span>
      {:else}
        <span class="type"><TicketIcon size={13} aria-hidden="true" />Ticket</span>
      {/if}
    </dd>
  </div>
  {#if !ticket.isEpic}
    <div>
      <dt>Kind</dt>
      <dd>{ticket.kind ? TICKET_KIND_LABELS[ticket.kind] : 'Unclassified'}</dd>
    </div>
  {/if}
  <!-- PD-955: the Coder code-area (PD-880). On an Epic this is the default its members inherit. -->
  <div>
    <dt>{ticket.isEpic ? 'Default code area' : 'Code area'}</dt>
    <dd>
      <span class="area-chip">{areaChip.label}</span>
      {#if areaChip.inherited && parentEpic}
        <a class="inherited-from" href="/devops/tickets/{parentEpic.displayId}" title="Inherited from its Epic — set it there or override it here"
          >from {parentEpic.displayId}</a
        >
      {/if}
    </dd>
  </div>
  <div>
    <dt>Lane</dt>
    <dd title={ticket.isEpic && memberCount > 0 ? "An Epic's lane is derived from its members" : undefined}>
      {STATUS_LABELS[ticket.status] ?? ticket.status}
    </dd>
  </div>
  <div>
    <dt>Priority</dt>
    <dd>
      {#if ticket.priority}{ticket.priority} · {PRIORITY_LABELS[ticket.priority]}{:else}—{/if}
      {#if priorityFrom}
        <a class="inherited-from" href="/devops/tickets/{priorityFrom.displayId}" title="Set on the Epic — every member follows"
          >from {priorityFrom.displayId}</a
        >
      {/if}
    </dd>
  </div>
  <div>
    <dt>Project</dt>
    <dd>
      {#if project}
        <span class="project-chip" style="--chip: {projectIdColor(project)}">{project.name}</span>
      {:else}—{/if}
    </dd>
  </div>
  <div>
    <dt>Assignee</dt>
    <dd>{ticket.assignee ? (ASSIGNEE_LABELS[ticket.assignee] ?? ticket.assignee) : 'Unassigned'}</dd>
  </div>
  <div>
    <dt>Refinement</dt>
    <dd>{refinement}</dd>
  </div>
  <!-- PD-432: only rendered when the ticket carries an override. A row reading "default" on every
       ticket would be noise; an unusual budget is the thing worth seeing. -->
  {#if ticket.maxTurns !== null}
    <div>
      <dt>Turn ceiling</dt>
      <dd>{ticket.maxTurns} <span class="muted">(raised from {ROBOT_MAX_TURNS_DEFAULT})</span></dd>
    </div>
  {/if}
  <div><dt>Source</dt><dd>{ticket.source}</dd></div>
  <div><dt>Created</dt><dd>{fmt(ticket.createdAt)}</dd></div>
  <div><dt>Updated</dt><dd>{fmt(ticket.updatedAt)}</dd></div>
  {#if ticket.githubIssueUrl}
    <div>
      <dt>GitHub</dt>
      <dd>
        <a class="gh-link" href={ticket.githubIssueUrl} target="_blank" rel="noreferrer">
          <GithubMark size={13} /> Issue #{ticket.githubIssueNumber}
        </a>
      </dd>
    </div>
  {/if}
</dl>

<!-- Portalled: this panel sits in the sticky Details column, a stacking context that would otherwise
     put the modal underneath the floating dock. -->
<div use:portal>
  <TicketFormModal
    open={formOpen}
    {form}
    editing={true}
    {locked}
    {statusDerived}
    projects={allProjects}
    {epicOptions}
    columns={COLUMNS}
    {requireEpic}
    {submitError}
    {busy}
    {progress}
    onClose={() => (formOpen = false)}
    onSubmit={submit}
  />

  <!-- After the form, so it stacks above it when a save asks about joining a refined Epic. -->
  <EpicJoinModal
    plan={joinPlan}
    joining={ticket.displayId ?? ticket.title}
    busy={busy}
    onCancel={() => (joinPlan = null)}
    onChoose={chooseJoin}
  />
</div>

<style lang="scss" src="./DetailsPanel.scss"></style>
