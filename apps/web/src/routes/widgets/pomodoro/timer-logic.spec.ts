import { describe, it, expect } from 'vitest';
import { formatTime, advancePhase, clampRoundsBeforeLongBreak, computeRemainingLegs } from './timer-logic';

describe('formatTime', () => {
  it('formats zero seconds', () => {
    expect(formatTime(0)).toBe('00:00');
  });
  it('formats 90 seconds as 01:30', () => {
    expect(formatTime(90)).toBe('01:30');
  });
  it('formats 3600 seconds as 60:00', () => {
    expect(formatTime(3600)).toBe('60:00');
  });
  it('formats 59 seconds', () => {
    expect(formatTime(59)).toBe('00:59');
  });
  it('formats 2400 seconds as 40:00', () => {
    expect(formatTime(2400)).toBe('40:00');
  });
});

const defaultConfig = {
  workMinutes: 40,
  shortBreakMinutes: 10,
  longBreakMinutes: 20,
  roundsBeforeLongBreak: 1,
  totalRounds: 1,
};

describe('advancePhase — work phase', () => {
  it('transitions to done when on the last round', () => {
    const result = advancePhase({ phase: 'work', currentRound: 1 }, defaultConfig);
    expect(result.phase).toBe('done');
    expect(result.currentRound).toBe(1);
    expect(result.secondsForPhase).toBe(0);
  });

  it('transitions to long-break when currentRound is a multiple of roundsBeforeLongBreak', () => {
    const config = { ...defaultConfig, totalRounds: 4, roundsBeforeLongBreak: 2 };
    const result = advancePhase({ phase: 'work', currentRound: 2 }, config);
    expect(result.phase).toBe('long-break');
    expect(result.secondsForPhase).toBe(20 * 60);
    expect(result.currentRound).toBe(2);
  });

  it('transitions to short-break when not at the long-break threshold', () => {
    const config = { ...defaultConfig, totalRounds: 4, roundsBeforeLongBreak: 2 };
    const result = advancePhase({ phase: 'work', currentRound: 1 }, config);
    expect(result.phase).toBe('short-break');
    expect(result.secondsForPhase).toBe(10 * 60);
  });

  it('transitions to long-break for roundsBeforeLongBreak=1 (every round)', () => {
    const config = { ...defaultConfig, totalRounds: 3, roundsBeforeLongBreak: 1 };
    const result = advancePhase({ phase: 'work', currentRound: 1 }, config);
    expect(result.phase).toBe('long-break');
  });

  it('transitions to done after last work round even with multiple rounds configured', () => {
    const config = { ...defaultConfig, totalRounds: 3, roundsBeforeLongBreak: 2 };
    const result = advancePhase({ phase: 'work', currentRound: 3 }, config);
    expect(result.phase).toBe('done');
  });
});

describe('advancePhase — break phases', () => {
  it('transitions from short-break to next work round', () => {
    const config = { ...defaultConfig, totalRounds: 4 };
    const result = advancePhase({ phase: 'short-break', currentRound: 1 }, config);
    expect(result.phase).toBe('work');
    expect(result.currentRound).toBe(2);
    expect(result.secondsForPhase).toBe(40 * 60);
  });

  it('transitions from long-break to next work round', () => {
    const config = { ...defaultConfig, totalRounds: 4 };
    const result = advancePhase({ phase: 'long-break', currentRound: 2 }, config);
    expect(result.phase).toBe('work');
    expect(result.currentRound).toBe(3);
    expect(result.secondsForPhase).toBe(40 * 60);
  });
});

describe('computeRemainingLegs', () => {
  const base = {
    workMinutes: 40,
    shortBreakMinutes: 10,
    longBreakMinutes: 20,
  };

  it('counts all legs from the start with 1 round (just work → done)', () => {
    const result = computeRemainingLegs(
      { phase: 'work', currentRound: 1 },
      { ...base, totalRounds: 1, roundsBeforeLongBreak: 1 },
    );
    expect(result).toEqual({ work: 1, shortBreak: 0, longBreak: 0 });
  });

  it('counts all legs for N=4, R=2 from the start', () => {
    // Sequence: work1 → short-break → work2 → long-break → work3 → short-break → work4 → done
    const result = computeRemainingLegs(
      { phase: 'work', currentRound: 1 },
      { ...base, totalRounds: 4, roundsBeforeLongBreak: 2 },
    );
    expect(result).toEqual({ work: 4, shortBreak: 2, longBreak: 1 });
  });

  it('counts remaining legs mid-session (in short-break at round 1)', () => {
    // From short-break at round 1: → work2 → long-break → work3 → short-break → work4 → done
    const result = computeRemainingLegs(
      { phase: 'short-break', currentRound: 1 },
      { ...base, totalRounds: 4, roundsBeforeLongBreak: 2 },
    );
    expect(result).toEqual({ work: 3, shortBreak: 2, longBreak: 1 });
  });

  it('returns all zeros when already done', () => {
    const result = computeRemainingLegs(
      { phase: 'done', currentRound: 1 },
      { ...base, totalRounds: 1, roundsBeforeLongBreak: 1 },
    );
    expect(result).toEqual({ work: 0, shortBreak: 0, longBreak: 0 });
  });

  it('counts a long break when roundsBeforeLongBreak=1', () => {
    // Sequence: work1 → long-break → work2 → done
    const result = computeRemainingLegs(
      { phase: 'work', currentRound: 1 },
      { ...base, totalRounds: 2, roundsBeforeLongBreak: 1 },
    );
    expect(result).toEqual({ work: 2, shortBreak: 0, longBreak: 1 });
  });

  it('counts from a long-break phase mid-session', () => {
    // From long-break at round 2: → work3 → done
    const result = computeRemainingLegs(
      { phase: 'long-break', currentRound: 2 },
      { ...base, totalRounds: 3, roundsBeforeLongBreak: 2 },
    );
    expect(result).toEqual({ work: 1, shortBreak: 0, longBreak: 1 });
  });
});

describe('clampRoundsBeforeLongBreak', () => {
  it('clamps down to totalRounds when value exceeds it', () => {
    expect(clampRoundsBeforeLongBreak(5, 3)).toBe(3);
  });

  it('keeps value when within valid range', () => {
    expect(clampRoundsBeforeLongBreak(2, 3)).toBe(2);
  });

  it('enforces minimum of 1', () => {
    expect(clampRoundsBeforeLongBreak(0, 3)).toBe(1);
  });

  it('allows value equal to totalRounds', () => {
    expect(clampRoundsBeforeLongBreak(3, 3)).toBe(3);
  });
});
