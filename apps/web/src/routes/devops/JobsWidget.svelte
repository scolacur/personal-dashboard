<script lang="ts">
  // The "Jobs" summary card on the /devops overview (PD-413). Reuses the same JobsList the
  // full /devops/jobs page renders, with its section head suppressed — the widget card's own
  // header carries the title and the link through to the full page.
  import JobsList from './JobsList.svelte';
</script>

<div class="jobs-widget">
  <JobsList showHead={false} limit={4} />
</div>

<style lang="scss" src="./JobsWidget.scss"></style>
