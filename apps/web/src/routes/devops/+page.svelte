<script lang="ts">
  import DeployStatus from '../DeployStatus.svelte';
  import SystemStatus from './SystemStatus.svelte';
  import JobsList from './JobsList.svelte';
</script>

<section class="deploy-section" id="site-status">
  <div class="section-head">
    <h2 class="section-title">Site Status</h2>
  </div>
  <DeployStatus />
  <SystemStatus />
</section>

<JobsList heading="Jobs" limit={5} viewAllHref="/devops/jobs" />

<style lang="scss" src="./+page.scss"></style>
