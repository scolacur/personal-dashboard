<script lang="ts">
  /**
   * The floating "✦ Refine" pill that opens the Refine modal on desktop, bottom-centre beside
   * "Change something". The dot means the Refine agent has replied and is waiting on Steve.
   */
  const { waiting = false, onclick }: { waiting?: boolean; onclick: () => void } = $props();
</script>

<button
  type="button"
  class="refine-btn"
  {onclick}
  title={waiting ? 'The Refine agent is waiting on you' : 'Open the Refine chat'}
>
  <span aria-hidden="true">✦</span>
  Refine
  {#if waiting}
    <span class="attn-dot" aria-hidden="true"></span>
    <span class="sr-only">— waiting on you</span>
  {/if}
</button>

<style lang="scss" src="./RefineButton.scss"></style>
