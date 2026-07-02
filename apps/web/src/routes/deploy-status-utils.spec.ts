import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './deploy-status-utils';

const NOW = 1_000_000_000_000; // fixed reference point

describe('formatRelativeTime', () => {
  it('returns "just now" for < 60 seconds', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('just now');
  });

  it('returns "just now" at exactly 0 seconds', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('just now');
  });

  it('returns minutes for 1–59 minutes ago', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago');
  });

  it('returns hours for 1–23 hours ago', () => {
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(formatRelativeTime(NOW - 23 * 3_600_000, NOW)).toBe('23h ago');
  });

  it('returns days for 24+ hours ago', () => {
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });

  it('uses Date.now() when now is omitted', () => {
    const recentMs = Date.now() - 30_000;
    expect(formatRelativeTime(recentMs)).toBe('just now');
  });
});
