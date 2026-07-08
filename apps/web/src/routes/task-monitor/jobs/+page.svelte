<script lang="ts">
  import JobsList from '../JobsList.svelte';
</script>

<section class="jobs-page">
  <header class="jobs-page-head">
    <h1 class="jobs-page-title">Recurring Jobs</h1>
    <a class="jobs-page-back" href="/task-monitor#jobs">← Task Monitor</a>
  </header>
  <p class="jobs-page-sub">
    Scheduled background jobs the dashboard runs. Times are computed from each job's cron
    schedule.
  </p>

  <JobsList heading="All jobs" />
</section>

<style lang="scss">
  .jobs-page {
    max-width: 60rem;
    margin: 0 auto;
    padding: var(--space-lg) var(--space-md);
  }

  .jobs-page-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-md);
  }

  .jobs-page-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.5rem;
  }

  .jobs-page-back {
    color: var(--muted);
    font-size: var(--font-size-sm);

    &:hover {
      color: var(--text);
    }
  }

  .jobs-page-sub {
    margin: var(--space-xs) 0 var(--space-lg);
    color: var(--muted);
    font-size: var(--font-size-sm);
  }
</style>
