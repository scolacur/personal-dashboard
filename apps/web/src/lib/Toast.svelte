<script lang="ts">
  import { toast } from './toast-store.svelte';
</script>

{#if toast.message}
  <!-- `status` rather than `alert`: these are confirmations and save failures, not interruptions
       that should preempt whatever a screen reader is currently saying. -->
  <div class="toast" class:error={toast.tone === 'error'} class:has-action={toast.action !== null} role="status">
    <span class="toast-message">{toast.message}</span>
    {#if toast.action}
      <!-- Only this button takes pointer events; the rest of the toast stays click-through. -->
      <button type="button" class="toast-action" onclick={() => toast.act()}>{toast.action.label}</button>
    {/if}
  </div>
{/if}

<style lang="scss" src="./Toast.scss"></style>
