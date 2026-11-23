<script lang="ts">
  // The Agent Dashboard (PD-413). Home of SystemStatus, which PD-422 left unmounted when it
  // removed the old `#site-status` section: the Robot fleet counts, the loop's global
  // dispatch state (with the pause/resume control), and worker heartbeats.
  //
  // PD-306 added the Agent Glossary: what each agent is responsible for and the exact prompts it
  // receives, rendered from the same code the worker runs.
  //
  // PD-818 / PD-819 (Epic PD-682): the page renders its own tiled fleet view with live 8-bit robot
  // tiles; the compact /devops card keeps the plain SystemStatus strip.
  import AgentFleet from './AgentFleet.svelte';
  import AgentGlossaryModal from './AgentGlossaryModal.svelte';

  let glossaryOpen = $state(false);
</script>

<section class="agent-dashboard">
  <div class="section-head">
    <h2 class="section-title">Agent Dashboard</h2>
    <button class="glossary-button" type="button" onclick={() => (glossaryOpen = true)}>Agent Glossary</button>
  </div>
  <AgentFleet />
</section>

<AgentGlossaryModal open={glossaryOpen} onClose={() => (glossaryOpen = false)} />

<style lang="scss" src="./+page.scss"></style>
