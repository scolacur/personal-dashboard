<script lang="ts">
  import type { AgentTicket } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';

  /** D-054: archiving a non-empty Epic needs the unlink-vs-cascade choice. */
  let {
    epic,
    memberCount,
    activeMemberCount,
    onCancel,
    onArchive,
  }: {
    /** The Epic being archived; null closes the modal. */
    epic: AgentTicket | null;
    memberCount: number;
    /** Members still in Backlog or Queue. Unlinking these would orphan live work. */
    activeMemberCount: number;
    onCancel: () => void;
    onArchive: (cascadeMembers: boolean) => void;
  } = $props();

  // D-TMP-PD383a slice C: a Ticket may be moved between Epics, never out of one — and "Epic only"
  // orphans every member at once, which is the same act at scale. Terminal members are exempt for
  // the same reason the edit form exempts them: they are history, not work.
  const canUnlink = $derived(activeMemberCount === 0);
</script>

<Modal open={epic !== null} title="Archive Epic" onClose={onCancel}>
  {#if epic}
    <p class="archive-epic-msg">
      <strong>{epic.displayId ?? epic.title}</strong> has
      {memberCount} member{memberCount === 1 ? '' : 's'}{#if activeMemberCount > 0}, {activeMemberCount}
      of them still active{/if}.
    </p>
    {#if !canUnlink}
      <p class="archive-epic-note">
        Its active members can&rsquo;t be left without an Epic — priority and dispatch both come from
        one, so an Epic-less ticket is unpriced and can never be picked up. Move them to another
        Epic first (&ldquo;Move to Epic…&rdquo; on each card), or archive them along with it.
      </p>
    {/if}
    <div class="archive-epic-actions">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <span class="spacer"></span>
      {#if canUnlink}
        <Button variant="ghost" onclick={() => onArchive(false)}>Epic only (unlink members)</Button>
      {/if}
      <Button variant="primary" onclick={() => onArchive(true)}>
        Epic + {memberCount} member{memberCount === 1 ? '' : 's'}
      </Button>
    </div>
  {/if}
</Modal>

<style lang="scss">
  .archive-epic-note {
    margin: 0 0 var(--space-lg);
    padding: var(--space-sm) var(--space-md);
    background: var(--surface-2);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius);
    font-size: var(--font-size-xs);
    color: var(--muted);
    line-height: 1.5;
  }

  .archive-epic-msg {
    margin: 0 0 var(--space-lg);
    font-size: var(--font-size-sm);
    color: var(--text);
    line-height: 1.5;
  }

  .archive-epic-actions {
    display: flex;
    align-items: center;
    gap: var(--space-sm);
    flex-wrap: wrap;

    .spacer {
      flex: 1;
    }
  }
</style>
