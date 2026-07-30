<script lang="ts">
  // Dev Ops overview. Deliberately minimal (PD-422, Dev Ops 3/3): the Kanban moved to
  // task-tracker/ (PD-421) and the #site-status section is gone — DeployStatus relocates to the
  // top nav (PD-414) and SystemStatus to the Agent Dashboard (PD-413). The Jobs preview stays so
  // this page isn't blank in the meantime; PD-413 fills it with the widget grid.
  //
  // No sibling +page.scss: with the section chrome gone there were no rules left, and JobsList
  // carries its own styles. PD-413 can add one back when the grid needs it.
  import JobsList from './JobsList.svelte';
</script>

<JobsList heading="Jobs" limit={5} viewAllHref="/devops/jobs" />
