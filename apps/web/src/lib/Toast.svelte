<script lang="ts">
  import { toast } from './toast-store.svelte';
</script>

{#if toast.message}
  <!-- `status` rather than `alert`: these are confirmations and save failures, not interruptions
       that should preempt whatever a screen reader is currently saying. -->
  <div class="toast" class:error={toast.tone === 'error'} role="status">{toast.message}</div>
{/if}

<style lang="scss" src="./Toast.scss"></style>
