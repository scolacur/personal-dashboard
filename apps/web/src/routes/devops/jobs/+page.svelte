<script lang="ts">
  import JobsList from '../JobsList.svelte';
  import MaintenanceHoldsSection from '../MaintenanceHoldsSection.svelte';
</script>

<section class="jobs-page">
  <header class="jobs-page-head">
    <h1 class="jobs-page-title">Jobs</h1>
    <a class="jobs-page-back" href="/devops">← Dev Ops</a>
  </header>
  <p class="jobs-page-sub">
    Background jobs the dashboard runs. Recurring jobs fire on a cron schedule; maintenance-hold
    jobs run inside a window where Robot dispatch is paused.
  </p>

  <JobsList heading="Recurring Jobs" />

  <MaintenanceHoldsSection />
</section>

<style lang="scss" src="./+page.scss"></style>
