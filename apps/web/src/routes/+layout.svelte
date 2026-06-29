<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children }: { children: Snippet } = $props();
</script>

<nav class="top-nav">
  <a href="/" class="nav-brand">Dashboard</a>
</nav>
<main class="content">
  {@render children()}
</main>

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
    background: #0f1117;
    color: #e2e8f0;
  }
  :global(a) {
    color: inherit;
    text-decoration: none;
  }

  .top-nav {
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #1e2433;
    display: flex;
    align-items: center;
  }
  .nav-brand {
    font-weight: 600;
    font-size: 1.1rem;
    letter-spacing: -0.01em;
  }
  .content {
    padding: 2rem 1.5rem;
    max-width: 1200px;
  }
</style>
