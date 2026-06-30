<script lang="ts">
  type Mode = 'work' | 'short-break' | 'long-break';

  const DURATIONS: Record<Mode, number> = {
    work: 25 * 60,
    'short-break': 5 * 60,
    'long-break': 15 * 60,
  };

  const MODE_LABELS: Record<Mode, string> = {
    work: 'Focus',
    'short-break': 'Short Break',
    'long-break': 'Long Break',
  };

  let mode = $state<Mode>('work');
  let remaining = $state(DURATIONS['work']);
  let running = $state(false);
  let completedPomodoros = $state(0);
  let intervalId: ReturnType<typeof setInterval> | null = null;

  function pad(n: number) {
    return String(n).padStart(2, '0');
  }

  function formattedTime() {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    return `${pad(m)}:${pad(s)}`;
  }

  function setMode(next: Mode) {
    stop();
    mode = next;
    remaining = DURATIONS[next];
  }

  function stop() {
    running = false;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function start() {
    if (running) return;
    running = true;
    intervalId = setInterval(tick, 1000);
  }

  function toggle() {
    if (running) stop();
    else start();
  }

  function reset() {
    stop();
    remaining = DURATIONS[mode];
  }

  function tick() {
    if (remaining <= 0) {
      stop();
      onComplete();
      return;
    }
    remaining -= 1;
  }

  function onComplete() {
    if (mode === 'work') {
      const next = completedPomodoros + 1;
      completedPomodoros = next;
      setMode(next % 4 === 0 ? 'long-break' : 'short-break');
    } else {
      setMode('work');
    }
    start();
  }

  function skip() {
    stop();
    onComplete();
  }

  $effect(() => {
    return () => {
      if (intervalId !== null) clearInterval(intervalId);
    };
  });
</script>

<div class="pomodoro">
  <div class="mode-tabs">
    {#each (['work', 'short-break', 'long-break'] as const) as m (m)}
      <button
        type="button"
        class="mode-tab"
        class:active={mode === m}
        onclick={() => setMode(m)}
      >
        {MODE_LABELS[m]}
      </button>
    {/each}
  </div>

  <div class="timer-display" class:running>
    {formattedTime()}
  </div>

  <div class="session-dots">
    {#each { length: 4 } as _, i (i)}
      <span class="dot" class:filled={i < completedPomodoros % 4 || (completedPomodoros > 0 && completedPomodoros % 4 === 0)}></span>
    {/each}
    {#if completedPomodoros >= 4}
      <span class="session-count">{Math.floor(completedPomodoros / 4)} set{Math.floor(completedPomodoros / 4) !== 1 ? 's' : ''}</span>
    {/if}
  </div>

  <div class="controls">
    <button type="button" class="btn btn-secondary" onclick={reset} disabled={remaining === DURATIONS[mode] && !running}>
      Reset
    </button>
    <button type="button" class="btn btn-primary" onclick={toggle}>
      {running ? 'Pause' : 'Start'}
    </button>
    <button type="button" class="btn btn-secondary" onclick={skip}>
      Skip →
    </button>
  </div>
</div>

<style lang="scss" src="./+page.scss"></style>
