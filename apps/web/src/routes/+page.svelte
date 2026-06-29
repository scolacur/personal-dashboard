<script lang="ts">
  import { widgets } from '$lib/widgets';
</script>

<div class="grid">
  {#each widgets as widget (widget.route)}
    <a href={widget.route} class="tile">
      <h2>{widget.title}</h2>
      <p>{widget.description}</p>
    </a>
  {/each}
</div>

<style lang="scss" src="./+page.scss"></style>
