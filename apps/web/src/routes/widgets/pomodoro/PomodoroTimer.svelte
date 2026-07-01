<script lang="ts">
  import { formatTime, advancePhase, clampRoundsBeforeLongBreak } from './timer-logic';
  import type { PomodoroPhase } from './timer-logic';

  let { tomatoMode = $bindable(false) } = $props();
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

<div class="pomodoro" class:tomato-mode={tomatoMode}>
  {#if tomatoMode}
    <svg
      class="tomato-calyx"
      viewBox="0 0 200 155"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <!-- Stem: thick and tall -->
      <rect x="91" y="4" width="18" height="81" rx="9" fill="#27ae60" />
      <!-- Stem highlight for 3D roundness -->
      <rect x="93" y="6" width="8" height="76" rx="5" fill="rgba(255,255,255,0.2)" />
      <!-- 5 sepals radiating from calyx center; rotated 36° so none points straight up into the stem -->
      <g transform="translate(100, 85) rotate(36)">
        <path d="M0 0 C-24 -16 -24 -44 0 -60 C24 -44 24 -16 0 0Z" fill="#2ecc71" />
        <path d="M0 0 C-24 -16 -24 -44 0 -60 C24 -44 24 -16 0 0Z" fill="#27ae60" transform="rotate(72)" />
        <path d="M0 0 C-24 -16 -24 -44 0 -60 C24 -44 24 -16 0 0Z" fill="#2ecc71" transform="rotate(144)" />
        <path d="M0 0 C-24 -16 -24 -44 0 -60 C24 -44 24 -16 0 0Z" fill="#27ae60" transform="rotate(216)" />
        <path d="M0 0 C-24 -16 -24 -44 0 -60 C24 -44 24 -16 0 0Z" fill="#2ecc71" transform="rotate(288)" />
      </g>
    </svg>
  {/if}

  <div class="timer-display" class:done={phase === 'done'}>
    {phase === 'done' ? 'Done!' : formatTime(secondsRemaining)}
  </div>

  <div class="rows">
    <div class="row" class:active={phase === 'work'}>
      <span class="indicator">{phase === 'work' ? '●' : '○'}</span>
      <span class="label">Work</span>
      <input
        class="time-input"
        type="number"
        min="1"
        max="240"
        disabled={running}
        bind:value={workMinutes}
        onchange={onWorkMinutesChange}
      />
      <span class="unit">min</span>
    </div>

    <div class="row" class:active={phase === 'short-break'}>
      <span class="indicator">{phase === 'short-break' ? '●' : '○'}</span>
      <span class="label">Short Break</span>
      <input
        class="time-input"
        type="number"
        min="1"
        max="60"
        disabled={running}
        bind:value={shortBreakMinutes}
        onchange={onShortBreakChange}
      />
      <span class="unit">min</span>
    </div>

    <div class="row" class:active={phase === 'long-break'}>
      <span class="indicator">{phase === 'long-break' ? '●' : '○'}</span>
      <span class="label">Long Break</span>
      <input
        class="time-input"
        type="number"
        min="1"
        max="120"
        disabled={running}
        bind:value={longBreakMinutes}
        onchange={onLongBreakChange}
      />
      <span class="unit">min</span>
    </div>

    <div class="row divider">
      <span class="indicator"></span>
      <span class="label">Rounds → Long Break</span>
      <input
        class="time-input"
        type="number"
        min="1"
        max={totalRounds}
        disabled={running}
        bind:value={roundsBeforeLongBreak}
        onchange={onRoundsBeforeLongBreakChange}
      />
      <span class="unit"></span>
    </div>

    <div class="row">
      <span class="indicator"></span>
      <span class="label">Total Rounds</span>
      <input
        class="time-input"
        type="number"
        min="1"
        max="20"
        disabled={running}
        bind:value={totalRounds}
        onchange={onTotalRoundsChange}
      />
      <span class="unit"></span>
    </div>
  </div>

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
    <button
      type="button"
      class="btn btn-tomato"
      class:active={tomatoMode}
      onclick={() => (tomatoMode = !tomatoMode)}
      title={tomatoMode ? 'Back to normal' : 'Make it a tomato'}
    >
      🍅
    </button>
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
