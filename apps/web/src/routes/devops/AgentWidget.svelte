<script lang="ts">
  // The "Agent" summary card on the /devops overview (PD-413). A thin padded wrapper so the
  // same SystemStatus that fills /devops/agent-dashboard reads correctly inside a widget card.
  import SystemStatus from './SystemStatus.svelte';
</script>

<div class="agent-widget">
  <SystemStatus />
</div>

<style lang="scss" src="./AgentWidget.scss"></style>
