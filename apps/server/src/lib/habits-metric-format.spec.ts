import { describe, it, expect } from 'vitest';
import {
  choiceValue,
  isValidMetricValueFormat,
  isValidNumberValue,
  isValidTimeValue,
  parseChoiceValue,
} from '@dashboard/shared';

/**
 * Pure metric-value format validators (PD-724). They live in `@dashboard/shared` so the server (the
 * metric route) and the client (optimistic logging) agree on what a value of each type looks like;
 * tested here, the way the schedule/set logic is, since the shared package has no runner of its own.
 */

describe('isValidTimeValue', () => {
  it('accepts HH:MM 24-hour, rejects out-of-range and malformed', () => {
    expect(isValidTimeValue('00:00')).toBe(true);
    expect(isValidTimeValue('23:59')).toBe(true);
    expect(isValidTimeValue('08:42')).toBe(true);
    expect(isValidTimeValue('24:00')).toBe(false);
    expect(isValidTimeValue('8:42')).toBe(false);
    expect(isValidTimeValue('08:60')).toBe(false);
    expect(isValidTimeValue('')).toBe(false);
    expect(isValidTimeValue(842)).toBe(false);
  });
});

describe('isValidNumberValue', () => {
  it('accepts a finite decimal string including "0", rejects empty and non-numeric', () => {
    expect(isValidNumberValue('0')).toBe(true); // a logged zero is a real value
    expect(isValidNumberValue('2')).toBe(true);
    expect(isValidNumberValue('1.5')).toBe(true);
    expect(isValidNumberValue('-3')).toBe(true);
    expect(isValidNumberValue('')).toBe(false);
    expect(isValidNumberValue('  ')).toBe(false);
    expect(isValidNumberValue('lots')).toBe(false);
    expect(isValidNumberValue('Infinity')).toBe(false);
  });
});

describe('parseChoiceValue / choiceValue', () => {
  it('round-trips an id array and rejects non-array / non-integer JSON', () => {
    expect(parseChoiceValue(choiceValue([1, 3]))).toEqual([1, 3]);
    expect(parseChoiceValue('[]')).toEqual([]); // empty is well-formed
    expect(parseChoiceValue('[1,"x"]')).toBeNull();
    expect(parseChoiceValue('{"a":1}')).toBeNull();
    expect(parseChoiceValue('not json')).toBeNull();
    expect(parseChoiceValue(123)).toBeNull();
  });
});

describe('isValidMetricValueFormat', () => {
  it('dispatches on the metric type', () => {
    expect(isValidMetricValueFormat('time', '08:42')).toBe(true);
    expect(isValidMetricValueFormat('time', '0')).toBe(false);
    expect(isValidMetricValueFormat('number', '0')).toBe(true);
    expect(isValidMetricValueFormat('number', '08:42')).toBe(false);
    expect(isValidMetricValueFormat('choice', choiceValue([1]))).toBe(true);
    expect(isValidMetricValueFormat('choice', '1')).toBe(false);
  });
});
