import { describe, it, expect } from 'vitest';
import { formatDuration } from '@dashboard/shared';

describe('formatDuration', () => {
  it('formats 0ms as 0:00', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('formats 5000ms as 0:05', () => {
    expect(formatDuration(5000)).toBe('0:05');
  });

  it('formats 65000ms as 1:05', () => {
    expect(formatDuration(65000)).toBe('1:05');
  });

  it('formats 600000ms as 10:00', () => {
    expect(formatDuration(600000)).toBe('10:00');
  });
});
