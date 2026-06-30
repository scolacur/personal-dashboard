// Shared types between server and web.
// Import from '@dashboard/shared' in both apps.
export { formatTime, advancePhase, clampRoundsBeforeLongBreak } from './pomodoro';
export type { PomodoroPhase, PomodoroConfig, PomodoroTransition } from './pomodoro';
