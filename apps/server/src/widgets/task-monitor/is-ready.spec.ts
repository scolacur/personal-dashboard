import { describe, it, expect } from 'vitest';
import { isReady } from '@dashboard/shared';

const FULL_BODY = `## Context
Some background.

## Task
Do the thing.

## Done When
- It works.

## Out of scope
Not this.`;

const FULL_BODY_CHECKLIST = `## Context
Background.

## Task
Do it.

## Done When (acceptance checklist)
- [ ] Works.

## Out of scope
Not that.`;

describe('isReady', () => {
  it('returns true when all four headers are present', () => {
    expect(isReady(FULL_BODY)).toBe(true);
  });

  it('accepts the "(acceptance checklist)" variant of Done When', () => {
    expect(isReady(FULL_BODY_CHECKLIST)).toBe(true);
  });

  it('returns false when ## Context is missing', () => {
    const body = FULL_BODY.replace(/^## context.*$/im, '');
    expect(isReady(body)).toBe(false);
  });

  it('returns false when ## Task is missing', () => {
    const body = FULL_BODY.replace(/^## task.*$/im, '');
    expect(isReady(body)).toBe(false);
  });

  it('returns false when ## Done When is missing', () => {
    const body = FULL_BODY.replace(/^## done when.*$/im, '');
    expect(isReady(body)).toBe(false);
  });

  it('returns false when ## Out of scope is missing', () => {
    const body = FULL_BODY.replace(/^## out of scope.*$/im, '');
    expect(isReady(body)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isReady(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isReady('')).toBe(false);
  });

  it('is case-insensitive', () => {
    const body = `## CONTEXT\nfoo\n## TASK\nbar\n## DONE WHEN\nbaz\n## OUT OF SCOPE\nqux`;
    expect(isReady(body)).toBe(true);
  });

  it('tolerates trailing text on heading lines', () => {
    const body = `## Context (extra)\nfoo\n## Task — important\nbar\n## Done When: see below\nbaz\n## Out of scope for now\nqux`;
    expect(isReady(body)).toBe(true);
  });
});
