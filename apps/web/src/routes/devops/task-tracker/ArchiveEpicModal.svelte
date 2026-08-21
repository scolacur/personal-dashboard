<script lang="ts">
  import type { AgentTicket } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import Button from '$lib/Button.svelte';

  /** D-054: archiving a non-empty Epic needs the unlink-vs-cascade choice. */
  let {
    epic,
    memberCount,
    onCancel,
    onArchive,
  }: {
    /** The Epic being archived; null closes the modal. */
    epic: AgentTicket | null;
    memberCount: number;
    onCancel: () => void;
    onArchive: (cascadeMembers: boolean) => void;
  } = $props();
</script>

<Modal open={epic !== null} title="Archive Epic" onClose={onCancel}>
  {#if epic}
    <p class="archive-epic-msg">
      <strong>{epic.displayId ?? epic.title}</strong> has
      {memberCount} member{memberCount === 1 ? '' : 's'}. Archive the Epic only (its members become
      free tickets), or archive the Epic and all its members?
    </p>
    <div class="archive-epic-actions">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <span class="spacer"></span>
      <Button variant="ghost" onclick={() => onArchive(false)}>Epic only (unlink members)</Button>
      <Button variant="primary" onclick={() => onArchive(true)}>
        Epic + {memberCount} member{memberCount === 1 ? '' : 's'}
      </Button>
    </div>
  {/if}
</Modal>

<style lang="scss">
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
