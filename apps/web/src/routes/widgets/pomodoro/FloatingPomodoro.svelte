<script lang="ts">
  import {
    formatTime,
    advancePhase,
    clampRoundsBeforeLongBreak,
    computeRemainingLegs,
  } from './timer-logic';
  import type { PomodoroPhase } from './timer-logic';

  type Mode = 'closed' | 'expanded' | 'minimized';

  let mode = $state<Mode>('closed');
  let title = $state('');

  let workMinutes = $state(40);
  let shortBreakMinutes = $state(10);
  let longBreakMinutes = $state(20);
  let roundsBeforeLongBreak = $state(1);
  let totalRounds = $state(1);

  let phase = $state<PomodoroPhase>('work');
  let currentRound = $state(1);
  let secondsRemaining = $state(40 * 60);
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

  const phaseLabel = $derived(
    phase === 'work'
      ? 'Work'
      : phase === 'short-break'
        ? 'Short Break'
        : phase === 'long-break'
          ? 'Long Break'
          : 'Done',
  );

  const isBreak = $derived(phase === 'short-break' || phase === 'long-break');

  const remaining = $derived(
    computeRemainingLegs(
      { phase, currentRound },
      { workMinutes, shortBreakMinutes, longBreakMinutes, roundsBeforeLongBreak, totalRounds },
    ),
  );
</script>

{#if mode === 'closed'}
  <button
    class="fp-trigger"
    onclick={() => (mode = 'expanded')}
    aria-label="Open Pomodoro timer"
  >
    🍅
  </button>
{:else if mode === 'minimized'}
  <button
    class="fp-minimized"
    class:fp-minimized--work={!isBreak}
    class:fp-minimized--break={isBreak}
    onclick={() => (mode = 'expanded')}
    aria-label="Expand Pomodoro timer"
  >
    <div class="fp-min-row fp-min-row--top">
      <span class="fp-min-title">{title || 'Pomodoro'}</span>
      <span class="fp-min-time">{formatTime(secondsRemaining)}</span>
    </div>
    <div class="fp-min-row fp-min-row--bottom">
      <span class="fp-min-phase">{phaseLabel}</span>
      <span class="fp-min-legs">W:{remaining.work} SB:{remaining.shortBreak} LB:{remaining.longBreak}</span>
    </div>
  </button>
{:else}
  <div class="fp-panel">
    <div class="fp-header">
      <input
        class="fp-title-input"
        type="text"
        placeholder="Timer title…"
        bind:value={title}
        aria-label="Timer title"
      />
      <button
        class="fp-icon-btn"
        onclick={() => (mode = 'minimized')}
        aria-label="Minimize timer"
        title="Minimize"
      >−</button>
      <button
        class="fp-icon-btn"
        onclick={() => (mode = 'closed')}
        aria-label="Close timer"
        title="Close"
      >✕</button>
    </div>

    <div class="fp-timer-display" class:done={phase === 'done'}>
      {phase === 'done' ? 'Done!' : formatTime(secondsRemaining)}
    </div>

    <div class="fp-rows">
      <div class="fp-row" class:active={phase === 'work'}>
        <span class="fp-indicator">{phase === 'work' ? '●' : '○'}</span>
        <span class="fp-label">Work</span>
        <input
          class="fp-time-input"
          type="number"
          min="1"
          max="240"
          disabled={running}
          bind:value={workMinutes}
          onchange={onWorkMinutesChange}
        />
        <span class="fp-unit">min</span>
      </div>

      <div class="fp-row" class:active={phase === 'short-break'}>
        <span class="fp-indicator">{phase === 'short-break' ? '●' : '○'}</span>
        <span class="fp-label">Short Break</span>
        <input
          class="fp-time-input"
          type="number"
          min="1"
          max="60"
          disabled={running}
          bind:value={shortBreakMinutes}
          onchange={onShortBreakChange}
        />
        <span class="fp-unit">min</span>
      </div>

      <div class="fp-row" class:active={phase === 'long-break'}>
        <span class="fp-indicator">{phase === 'long-break' ? '●' : '○'}</span>
        <span class="fp-label">Long Break</span>
        <input
          class="fp-time-input"
          type="number"
          min="1"
          max="120"
          disabled={running}
          bind:value={longBreakMinutes}
          onchange={onLongBreakChange}
        />
        <span class="fp-unit">min</span>
      </div>

      <div class="fp-row fp-row--divider">
        <span class="fp-indicator"></span>
        <span class="fp-label">Rounds → Long Break</span>
        <input
          class="fp-time-input"
          type="number"
          min="1"
          max={totalRounds}
          disabled={running}
          bind:value={roundsBeforeLongBreak}
          onchange={onRoundsBeforeLongBreakChange}
        />
        <span class="fp-unit"></span>
      </div>

      <div class="fp-row">
        <span class="fp-indicator"></span>
        <span class="fp-label">Total Rounds</span>
        <input
          class="fp-time-input"
          type="number"
          min="1"
          max="20"
          disabled={running}
          bind:value={totalRounds}
          onchange={onTotalRoundsChange}
        />
        <span class="fp-unit"></span>
      </div>
    </div>

    <div class="fp-controls">
      <button
        type="button"
        class="fp-btn fp-btn--primary"
        onclick={startPause}
        disabled={phase === 'done'}
      >{running ? '⏸ Pause' : '▶ Start'}</button>
      <button type="button" class="fp-btn fp-btn--secondary" onclick={reset}>↺ Reset</button>
    </div>

    <div class="fp-round-info">
      {#if phase === 'done'}
        All rounds complete
      {:else}
        Round {currentRound} of {totalRounds}
      {/if}
    </div>
  </div>
{/if}

<style lang="scss" src="./FloatingPomodoro.scss"></style>
