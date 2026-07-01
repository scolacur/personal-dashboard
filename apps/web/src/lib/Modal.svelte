<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    open,
    title,
    onClose,
    children,
  }: {
    open: boolean;
    title?: string;
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
