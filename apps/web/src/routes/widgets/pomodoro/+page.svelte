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
        viewBox="0 0 100 60"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <!-- stem: short, chunky, rounded top — sticks up above the tomato body -->
        <rect x="44" y="2" width="12" height="33" rx="6" fill="#27ae60" />
        <!-- stem highlight for 3-D depth -->
        <rect x="47" y="4" width="5" height="27" rx="3" fill="rgba(255,255,255,0.28)" />
        <!-- calyx: 5 leaves fanning downward and sideways from stem base (50,35).
             All leaves spread into the lower half so none point back up toward the stem.
             Angles: −70° −35° 0° +35° +70° from straight-down (positive y in SVG).
             rotate() in SVG is clockwise, so rotate(-70) fans to the right, rotate(70) to the left. -->
        <g transform="translate(50,35)">
          <path d="M0 0 C-6 4 -6 14 0 20 C6 14 6 4 0 0Z" fill="#2ecc71" transform="rotate(-70)" />
          <path d="M0 0 C-6 4 -6 14 0 20 C6 14 6 4 0 0Z" fill="#27ae60" transform="rotate(-35)" />
          <path d="M0 0 C-6 4 -6 14 0 20 C6 14 6 4 0 0Z" fill="#2ecc71" />
          <path d="M0 0 C-6 4 -6 14 0 20 C6 14 6 4 0 0Z" fill="#27ae60" transform="rotate(35)" />
          <path d="M0 0 C-6 4 -6 14 0 20 C6 14 6 4 0 0Z" fill="#2ecc71" transform="rotate(70)" />
          <!-- cap: fills the gap where stem meets calyx leaves -->
          <circle cx="0" cy="0" r="7" fill="#27ae60" />
        </g>
      </svg>
    {/if}
    <div class="timer-card" class:tomato-mode={tomatoMode}>
      <PomodoroTimer bind:tomatoMode />
    </div>
  </div>
</div>

<style lang="scss" src="./+page.scss"></style>
