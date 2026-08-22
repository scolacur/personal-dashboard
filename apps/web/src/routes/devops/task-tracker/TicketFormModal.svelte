<script lang="ts">
  import type { AgentProject, AgentTicket, TicketStatus } from '@dashboard/shared';
  import {
    TICKET_ASSIGNEES,
    ASSIGNEE_LABELS,
    TICKET_PRIORITIES,
    PRIORITY_LABELS,
    ROBOT_MAX_TURNS_DEFAULT,
    ROBOT_MAX_TURNS_LIMIT,
  } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';
  import EpicField from './EpicField.svelte';
  import { maxTurnsInvalid, ticketFormError, type TicketFormState } from './ticket-form';

  /** The add / edit ticket modal. `form` is the page's `$state` object, mutated in place. */
  let {
    open,
    form,
    editing,
    locked = false,
    statusDerived = false,
    projects,
    epicOptions,
    columns,
    requireEpic,
    onClose,
    onSubmit,
  }: {
    open: boolean;
    form: TicketFormState;
    /** True when editing an existing ticket; false while adding. */
    editing: boolean;
    /** The ticket is agent-controlled — status and assignee are not ours to set. */
    locked?: boolean;
    /** D-054: a non-empty Epic's lane is derived from its members, so its own status is inert. */
    statusDerived?: boolean;
    projects: AgentProject[];
    /** Epics selectable as a parent — same project, excluding the ticket being edited. */
    epicOptions: AgentTicket[];
    columns: { status: TicketStatus; label: string }[];
    /** From `epicRequired()` — a Ticket may move between Epics but never out of one. */
    requireEpic: boolean;
    onClose: () => void;
    onSubmit: () => void;
  } = $props();

  // D-TMP-PD383a: a member's priority comes from its Epic. An unclassified Epic (`null`) leaves the
  // member's own value alone — matching the server — so there is still something to set in that case.
  const parentEpic = $derived(
    form.isEpic || form.epicId === null
      ? undefined
      : epicOptions.find((e) => e.id === form.epicId),
  );
  // A drafted Epic drives the read-out too, so the priority field doesn't flip back to an editable
  // control the moment you choose "New Epic" — the value is decided, just not saved yet.
  const inheritedPriority = $derived(
    form.newEpic !== null ? form.newEpic.priority : (parentEpic?.priority ?? null),
  );
  const inheritsPriority = $derived(
    !form.isEpic && (form.newEpic !== null || parentEpic !== undefined) && inheritedPriority !== null,
  );
  const priorityDisplay = $derived(
    inheritedPriority ? `${inheritedPriority} · ${PRIORITY_LABELS[inheritedPriority]}` : '— None',
  );
  const priorityFrom = $derived(
    form.newEpic !== null ? 'the new Epic' : (parentEpic?.displayId ?? 'its Epic'),
  );

  const saveError = $derived(ticketFormError(form, { requireEpic }));
</script>

<Modal {open} title={editing ? 'Edit Ticket' : 'New Ticket'} {onClose}>
  <div class="ticket-form">
    <label class="epic-flag">
      <input type="checkbox" bind:checked={form.isEpic} />
      This is an Epic (an umbrella for other tickets)
    </label>
    {#if !form.isEpic}
      <EpicField {form} {epicOptions} required={requireEpic} />
    {/if}
    <label>
      <span>Project</span>
      <select bind:value={form.projectId}>
        {#each projects as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Title</span>
      <input type="text" bind:value={form.title} />
    </label>
    <label>
      <span>Details</span>
      <textarea bind:value={form.body} rows="12"></textarea>
    </label>
    <label>
      <span>Status</span>
      <select bind:value={form.status} disabled={locked || statusDerived}>
        {#each columns as c (c.status)}
          <option value={c.status}>{c.label}</option>
        {/each}
      </select>
      {#if locked}
        <small class="field-note">Locked — this ticket is controlled by its agent.</small>
      {:else if statusDerived}
        <small class="field-note">Derived from members — prioritize a member to move the Epic.</small>
      {/if}
    </label>
    <label>
      <span>Priority</span>
      {#if inheritsPriority}
        <!-- D-TMP-PD383a: priority is an Epic property. The server overrides whatever a member's
             patch carries, so an editable control here would silently not take. -->
        <input type="text" value={priorityDisplay} readonly />
        <small class="field-note">
          Inherited from {priorityFrom} — set the priority there and every member follows.
        </small>
      {:else}
        <select bind:value={form.priority}>
          <option value={null}>— None</option>
          {#each TICKET_PRIORITIES as p (p)}
            <option value={p}>{p} · {PRIORITY_LABELS[p]}</option>
          {/each}
        </select>
        {#if form.isEpic}
          <small class="field-note">Cascades to every member of this Epic.</small>
        {/if}
      {/if}
    </label>
    <label>
      <span>Assignee</span>
      <select bind:value={form.assignee} disabled={locked}>
        <option value={null}>— None</option>
        {#each TICKET_ASSIGNEES as a (a)}
          <option value={a}>{ASSIGNEE_LABELS[a]}</option>
        {/each}
      </select>
      {#if locked}
        <small class="field-note">Locked — controlled by its agent.</small>
      {/if}
    </label>
    <label>
      <span>Turn ceiling</span>
      <input
        type="number"
        min="1"
        max={ROBOT_MAX_TURNS_LIMIT}
        placeholder={`default (${ROBOT_MAX_TURNS_DEFAULT})`}
        bind:value={form.maxTurns}
      />
      <small class="field-note">
        {#if maxTurnsInvalid(form.maxTurns)}
          Must be a whole number between 1 and {ROBOT_MAX_TURNS_LIMIT}.
        {:else}
          Leave blank for the default. Raise it only for work that cannot be split further.
        {/if}
      </small>
    </label>
    <div class="form-actions">
      {#if saveError}
        <span class="save-blocker">{saveError}</span>
      {/if}
      <Button variant="ghost" onclick={onClose}>Cancel</Button>
      <Button variant="primary" onclick={onSubmit} disabled={saveError !== null}>
        {editing ? 'Save' : 'Add'}
      </Button>
    </div>
  </div>
</Modal>

<style lang="scss" src="./TicketFormModal.scss"></style>
