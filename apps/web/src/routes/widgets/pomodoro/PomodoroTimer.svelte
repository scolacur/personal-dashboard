<script lang="ts">
  import { formatTime, advancePhase, clampRoundsBeforeLongBreak } from './timer-logic';
  import type { PomodoroPhase } from './timer-logic';
  import IntervalBars from '$lib/pomodoro/IntervalBars.svelte';

  let workMinutes = $state(40);
  let shortBreakMinutes = $state(10);
  let longBreakMinutes = $state(20);
  let roundsBeforeLongBreak = $state(1);
  let totalRounds = $state(1);

  let phase = $state<PomodoroPhase>('work');
  let currentRound = $state(1);
  let secondsRemaining = $state(40 * 60); // initial value matches workMinutes default
  let running = $state(false);

  $effect(() => {
    if (running) {
      const id = setInterval(tick, 1000);
      return () => clearInterval(id);
    }
  });

  function tick() {
    if (secondsRemaining > 0) {
      secondsRemaining--;
    } else {
      const next = advancePhase(
        { phase, currentRound },
        { workMinutes, shortBreakMinutes, longBreakMinutes, roundsBeforeLongBreak, totalRounds },
      );
      phase = next.phase;
      currentRound = next.currentRound;
      secondsRemaining = next.secondsForPhase;
      if (phase === 'done') running = false;
    }
  }

  function startPause() {
    if (phase === 'done') return;
    running = !running;
  }

  function reset() {
    running = false;
    phase = 'work';
    currentRound = 1;
    secondsRemaining = workMinutes * 60;
  }

  function onWorkMinutesChange() {
    if (!running && phase === 'work') secondsRemaining = workMinutes * 60;
  }

  function onShortBreakChange() {
    if (!running && phase === 'short-break') secondsRemaining = shortBreakMinutes * 60;
  }

  function onLongBreakChange() {
    if (!running && phase === 'long-break') secondsRemaining = longBreakMinutes * 60;
  }

  function onTotalRoundsChange() {
    roundsBeforeLongBreak = clampRoundsBeforeLongBreak(roundsBeforeLongBreak, totalRounds);
  }

  function onRoundsBeforeLongBreakChange() {
    roundsBeforeLongBreak = clampRoundsBeforeLongBreak(roundsBeforeLongBreak, totalRounds);
  }
</script>

<div class="pomodoro">
  <div class="timer-display" class:done={phase === 'done'}>
    {phase === 'done' ? 'Done!' : formatTime(secondsRemaining)}
  </div>

  <IntervalBars
    bind:workMinutes
    bind:shortBreakMinutes
    bind:longBreakMinutes
    bind:roundsBeforeLongBreak
    bind:totalRounds
    disabled={running}
    activePhase={phase}
    onWorkChange={onWorkMinutesChange}
    onShortBreakChange={onShortBreakChange}
    onLongBreakChange={onLongBreakChange}
    onTotalRoundsChange={onTotalRoundsChange}
    onRoundsBeforeLongBreakChange={onRoundsBeforeLongBreakChange}
  />

  <div class="controls">
    <button
      type="button"
      class="btn btn-primary"
      onclick={startPause}
      disabled={phase === 'done'}
    >
      {running ? '⏸ Pause' : '▶ Start'}
    </button>
    <button type="button" class="btn btn-secondary" onclick={reset}> ↺ Reset </button>
  </div>

  <div class="round-info">
    {#if phase === 'done'}
      All rounds complete
    {:else}
      Round {currentRound} of {totalRounds}
    {/if}
  </div>
</div>

<style lang="scss" src="./PomodoroTimer.scss"></style>
