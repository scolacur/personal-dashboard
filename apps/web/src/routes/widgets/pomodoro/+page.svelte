<script lang="ts">
  import PomodoroTimer from './PomodoroTimer.svelte';

  let tomatoMode = $state(false);
</script>

<div class="pomodoro-page">
  <h1>Pomodoro Timer</h1>
  <div class="timer-card" class:tomato-mode={tomatoMode}>
    <PomodoroTimer bind:tomatoMode />
  </div>
</div>

<style lang="scss" src="./+page.scss"></style>
