<script lang="ts">
  // The Agent Dashboard (PD-413). Home of SystemStatus, which PD-422 left unmounted when it
  // removed the old `#site-status` section: the Robot fleet counts, the loop's global
  // dispatch state (with the pause/resume control), and worker heartbeats.
  import SystemStatus from '../SystemStatus.svelte';
</script>

<section class="agent-dashboard">
  <div class="section-head">
    <h2 class="section-title">Agent Dashboard</h2>
  </div>
  <SystemStatus />
</section>

<style lang="scss" src="./+page.scss"></style>
