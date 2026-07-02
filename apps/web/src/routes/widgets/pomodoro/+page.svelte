<script lang="ts">
  import PomodoroTimer from './PomodoroTimer.svelte';

  let tomatoMode = $state(false);
</script>

<div class="pomodoro-page">
  {#if !tomatoMode}
    <h1>Pomodoro Timer</h1>
  {/if}
  <div class="tomato-widget" class:active={tomatoMode}>
    {#if tomatoMode}
      <svg
        class="tomato-calyx"
        viewBox="0 0 100 90"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <!-- stem: tall, thick, rounded, pointing upward (top of SVG = top of screen) -->
        <rect x="43" y="2" width="14" height="56" rx="7" fill="#27ae60" />
        <!-- highlight for 3-D roundness -->
        <rect x="46" y="4" width="5" height="50" rx="3" fill="rgba(255,255,255,0.28)" />
        <!-- calyx: 5 sepals radiating from stem base at (50,60); sepal path points DOWN (y+)
             so at rotate(0) it goes into the tomato, others spread to sides/slightly up  -->
        <g transform="translate(50,62)">
          <path d="M0 0 C-14 9 -16 28 0 42 C16 28 14 9 0 0Z" fill="#2ecc71" />
          <path d="M0 0 C-14 9 -16 28 0 42 C16 28 14 9 0 0Z" fill="#27ae60" transform="rotate(72)" />
          <path d="M0 0 C-14 9 -16 28 0 42 C16 28 14 9 0 0Z" fill="#2ecc71" transform="rotate(144)" />
          <path d="M0 0 C-14 9 -16 28 0 42 C16 28 14 9 0 0Z" fill="#27ae60" transform="rotate(216)" />
          <path d="M0 0 C-14 9 -16 28 0 42 C16 28 14 9 0 0Z" fill="#2ecc71" transform="rotate(288)" />
        </g>
      </svg>
    {/if}
    <div class="timer-card" class:tomato-mode={tomatoMode}>
      <PomodoroTimer bind:tomatoMode />
    </div>
  </div>
</div>

<style lang="scss" src="./+page.scss"></style>
