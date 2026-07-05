<script lang="ts">
  let {
    title,
    description,
    route,
  }: { title: string; description: string; route: string } = $props();

  let flipped = $state(false);

  function flip() {
    flipped = !flipped;
  }
</script>

<div class="widget">
  <div class="widget-inner" class:flipped>
    <div class="face face-front">
      <!-- Stretched link: covers the whole face so clicking anywhere on the
           card navigates — except the flip button, which sits above it. -->
      <a href={route} class="stretched-link" aria-label={title}></a>
      <h2>{title}</h2>
      <p>{description}</p>
      <button type="button" class="flip-btn" onclick={flip} aria-label="Flip widget">↺</button>
    </div>
    <div class="face face-back">
      <p class="back-name">{title}</p>
      <p class="back-label">Rear panel</p>
      <button type="button" class="flip-btn" onclick={flip} aria-label="Flip widget">↺</button>
    </div>
  </div>
</div>

<style lang="scss" src="./Widget.scss"></style>
