<script lang="ts">
  import type { Snippet } from 'svelte';

  // `size` controls the dialog's max width. The default suits the confirm/picker dialogs that
  // make up most callers; `wide` exists for the multi-column edit form (ListEditModal), whose
  // content is genuinely wider than a prose dialog. Before this the form set its own width and
  // the dialog capped it 400px narrower, so the form overflowed and scrolled sideways.
  let {
    open,
    title,
    size = 'default',
    onClose,
    children,
  }: {
    open: boolean;
    title?: string;
    size?: 'default' | 'wide';
    onClose: () => void;
    children: Snippet;
  } = $props();

  let dialogEl = $state<HTMLDivElement | null>(null);

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) onClose();
  }

  // Lock body scroll while open; restore on close/unmount.
  $effect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  });

  // Move focus into the dialog when it opens.
  $effect(() => {
    if (open) dialogEl?.focus();
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="modal-backdrop">
    <!-- Full-screen click-catcher behind the dialog (a button so it's keyboard-accessible). -->
    <button class="modal-scrim" type="button" aria-label="Close dialog" onclick={onClose}></button>
    <div
      class="modal"
      class:modal-wide={size === 'wide'}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      bind:this={dialogEl}
    >
      {#if title}
        <header class="modal-head">
          <h2>{title}</h2>
          <button class="modal-close" type="button" aria-label="Close" onclick={onClose}>×</button>
        </header>
      {/if}
      <div class="modal-body">
        {@render children()}
      </div>
    </div>
  </div>
{/if}

<style lang="scss" src="./Modal.scss"></style>
