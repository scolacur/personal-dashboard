<script lang="ts">
  let {
    title,
    description,
    route,
  }: { title: string; description: string; route: string } = $props();

  let flipped = $state(false);

  function flip(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    flipped = !flipped;
  }
</script>

<div class="widget">
  <div class="widget-inner" class:flipped>
    <a href={route} class="face face-front">
      <h2>{title}</h2>
      <p>{description}</p>
      <button type="button" class="flip-btn" onclick={flip} aria-label="Flip widget">↺</button>
    </a>
    <div class="face face-back">
      <p class="back-name">{title}</p>
      <p class="back-label">Rear panel</p>
      <button type="button" class="flip-btn" onclick={flip} aria-label="Flip widget">↺</button>
    </div>
  </div>
</div>

<style lang="scss" src="./Widget.scss"></style>
