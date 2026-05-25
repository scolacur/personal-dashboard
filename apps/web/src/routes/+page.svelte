<script lang="ts">
  import { widgets } from '$lib/widgets';
</script>

<div class="grid">
  {#each widgets as widget}
    <a href={widget.route} class="tile">
      <h2>{widget.title}</h2>
      <p>{widget.description}</p>
    </a>
  {/each}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1rem;
  }
  .tile {
    padding: 1.5rem;
    background: #1a2035;
    border: 1px solid #2d3748;
    border-radius: 0.5rem;
    display: block;
    transition: border-color 0.15s;
  }
  .tile:hover { border-color: #4a6fa5; }
  .tile h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
  .tile p { margin: 0; font-size: 0.875rem; color: #94a3b8; }
</style>
