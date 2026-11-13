import { describe, expect, it } from 'vitest';
import { formatWhen, fromLocalInput, toLocalInput } from './time';

describe('datetime-local round trip', () => {
  it('survives a round trip to the minute', () => {
    const ms = new Date(2026, 10, 13, 9, 7).getTime();
    expect(toLocalInput(ms)).toBe('2026-11-13T09:07');
    expect(fromLocalInput('2026-11-13T09:07')).toBe(ms);
  });

  it('rejects junk', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('yesterday')).toBeNull();
  });
});

describe('formatWhen', () => {
  const now = new Date(2026, 10, 13, 15, 0).getTime();
  it('shows only the time for today, and labels yesterday', () => {
    expect(formatWhen(new Date(2026, 10, 13, 8, 5).getTime(), now)).toBe('08:05');
    expect(formatWhen(new Date(2026, 10, 12, 23, 59).getTime(), now)).toBe('Yesterday 23:59');
  });
  it('includes the date for anything older', () => {
    expect(formatWhen(new Date(2026, 10, 10, 12, 0).getTime(), now)).toMatch(/12:00$/);
    expect(formatWhen(new Date(2026, 10, 10, 12, 0).getTime(), now)).not.toMatch(/^Yesterday/);
  });
});
