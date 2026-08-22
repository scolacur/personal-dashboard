<script lang="ts">
  import type { AgentTicket } from '@dashboard/shared';
  import { TICKET_PRIORITIES, PRIORITY_LABELS } from '@dashboard/shared';
  import { ticketMatchesQuery } from '../filter-logic';
  import type { TicketFormState } from './ticket-form';

  /**
   * The create/edit modal's Epic field (D-TMP-PD383a slice C).
   *
   * A plain `<select>` was fine at a dozen Epics and is unusable at seventy, which is where the
   * board landed after slice 0 — so this filters as you type. It also mints an Epic inline,
   * because a required field with no escape hatch just teaches people to dump work into whatever
   * Epic is nearest, which is how a category Epic full of unrelated tickets gets born.
   */
  let {
    form,
    epicOptions,
    required = true,
  }: {
    form: TicketFormState;
    /** Epics selectable as a parent — same project, excluding the ticket being edited. */
    epicOptions: AgentTicket[];
    /** Enforced on create only; editing a pre-D-TMP-PD383a orphan must stay possible. */
    required?: boolean;
  } = $props();

  let query = $state('');
  let listOpen = $state(false);

  const selected = $derived(epicOptions.find((e) => e.id === form.epicId));
  const matches = $derived(
    query.trim() === ''
      ? epicOptions.slice(0, 50)
      : epicOptions.filter((e) => ticketMatchesQuery(e, query)).slice(0, 50),
  );

  function pick(e: AgentTicket) {
    form.epicId = e.id;
    form.newEpic = null;
    query = '';
    listOpen = false;
  }

  function clear() {
    form.epicId = null;
    form.newEpic = null;
    query = '';
    listOpen = true;
  }

  function startNewEpic() {
    // Seed the name from whatever was typed — the search that found nothing is usually the name.
    form.newEpic = { title: query.trim(), priority: null };
    form.epicId = null;
    listOpen = false;
  }
</script>

<div class="epic-field">
  <span class="epic-field-label">
    Epic {#if required}<abbr title="Every Ticket belongs to an Epic">*</abbr>{/if}
  </span>

  {#if form.newEpic !== null}
    <!-- Minting a new Epic. Priority lives here rather than on the Ticket because it is an Epic
         property — this is the one moment a human chooses it for this work. -->
    <div class="new-epic">
      <div class="new-epic-head">
        <span class="new-epic-tag">New Epic</span>
        <button type="button" class="linkish" onclick={clear}>pick an existing one instead</button>
      </div>
      <input
        type="text"
        placeholder="Epic name"
        bind:value={form.newEpic.title}
        aria-label="New epic name"
      />
      <label class="new-epic-priority">
        <span>Priority</span>
        <select bind:value={form.newEpic.priority}>
          <option value={null}>— None</option>
          {#each TICKET_PRIORITIES as p (p)}
            <option value={p}>{p} · {PRIORITY_LABELS[p]}</option>
          {/each}
        </select>
      </label>
      <small class="field-note">
        This ticket becomes its first member and takes its priority.
      </small>
    </div>
  {:else if selected && !listOpen}
    <div class="epic-selected">
      <span class="epic-selected-id">{selected.displayId}</span>
      <span class="epic-selected-title">{selected.title}</span>
      {#if selected.priority}
        <span class="epic-selected-prio">{selected.priority}</span>
      {/if}
      <button type="button" class="linkish" onclick={clear}>change</button>
    </div>
  {:else}
    <input
      type="search"
      class="epic-search"
      placeholder="Filter epics…"
      bind:value={query}
      onfocus={() => (listOpen = true)}
      aria-label="Filter epics"
    />
    <ul class="epic-list">
      {#each matches as e (e.id)}
        <li>
          <button type="button" class="epic-row" onclick={() => pick(e)}>
            <span class="epic-row-id">{e.displayId}</span>
            <span class="epic-row-title">{e.title}</span>
            <span class="epic-row-prio">{e.priority ?? '—'}</span>
          </button>
        </li>
      {:else}
        <li class="epic-empty">No epic matches &ldquo;{query}&rdquo;.</li>
      {/each}
      <li>
        <button type="button" class="epic-row epic-row-new" onclick={startNewEpic}>
          ＋ New Epic{query.trim() ? ` — “${query.trim()}”` : '…'}
        </button>
      </li>
    </ul>
  {/if}
</div>

<style lang="scss" src="./EpicField.scss"></style>
