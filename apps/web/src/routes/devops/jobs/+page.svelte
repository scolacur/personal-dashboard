<script lang="ts">
  import JobsList from '../JobsList.svelte';
</script>

<section class="jobs-page">
  <header class="jobs-page-head">
    <h1 class="jobs-page-title">Recurring Jobs</h1>
    <a class="jobs-page-back" href="/devops">← Dev Ops</a>
  </header>
  <p class="jobs-page-sub">
    Scheduled background jobs the dashboard runs. Times are computed from each job's cron
    schedule.
  </p>

  <JobsList heading="All jobs" />
</section>

<style lang="scss" src="./+page.scss"></style>
