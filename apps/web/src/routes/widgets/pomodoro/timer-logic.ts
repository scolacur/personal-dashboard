export type PomodoroPhase = 'work' | 'short-break' | 'long-break' | 'done';

export interface PomodoroConfig {
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  roundsBeforeLongBreak: number;
  totalRounds: number;
}

export interface PomodoroTransition {
  phase: PomodoroPhase;
  currentRound: number;
  secondsForPhase: number;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function advancePhase(
  current: { phase: PomodoroPhase; currentRound: number },
  config: PomodoroConfig,
): PomodoroTransition {
  if (current.phase === 'work') {
    if (current.currentRound >= config.totalRounds) {
      return { phase: 'done', currentRound: current.currentRound, secondsForPhase: 0 };
    }
    if (current.currentRound % config.roundsBeforeLongBreak === 0) {
      return {
        phase: 'long-break',
        currentRound: current.currentRound,
        secondsForPhase: config.longBreakMinutes * 60,
      };
    }
    return {
      phase: 'short-break',
      currentRound: current.currentRound,
      secondsForPhase: config.shortBreakMinutes * 60,
    };
  }
  const nextRound = current.currentRound + 1;
  return { phase: 'work', currentRound: nextRound, secondsForPhase: config.workMinutes * 60 };
}

export function clampRoundsBeforeLongBreak(value: number, totalRounds: number): number {
  return Math.max(1, Math.min(value, totalRounds));
}
