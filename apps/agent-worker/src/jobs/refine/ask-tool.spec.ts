import { describe, it, expect } from 'vitest';
import {
  findBareIds,
  renderRoundAnswers,
  roundAsMarkdown,
  validateAnswerSet,
  validateQuestionRound,
  type RefineQuestionRound,
} from '@dashboard/shared';

// The shared validators behind ask_questions (PD-744, D-096 §4). packages/shared has no test runner
// of its own yet, so they are exercised here, beside the tool that calls them.

const opt = (label: string) => ({ label, description: `pick ${label}` });
const round = (over: Partial<RefineQuestionRound> = {}): RefineQuestionRound => ({
  questions: [
    { id: 'sync', question: 'Live sync or reload-only?', why: 'Both surfaces are on screen at once.', options: [opt('Live'), opt('Reload')], recommended: 0 },
    { id: 'preview', question: 'Preview on select?', why: 'Doubles as the audio-unlock gesture.', options: [opt('Yes'), opt('No'), opt('Only on desktop')], recommended: 0 },
  ],
  assumptions: [{ text: 'Sounds are synthesized, not downloaded.', source: 'PD-596 (Pomodoro sound picker), Context section' }],
  ...over,
});

describe('findBareIds', () => {
  it('accepts ids followed by a title or written as the parenthetical after one', () => {
    expect(findBareIds('PD-743 (Park a Refine session) ships first')).toEqual([]);
    expect(findBareIds('D-091 — robot work enters the Queue only refined')).toEqual([]);
    expect(findBareIds('D-091: robot work enters the Queue only refined')).toEqual([]);
    expect(findBareIds('the Async Refine Epic (PD-742) holds it')).toEqual([]);
  });

  it('flags bare ids, including in lists and at the end of a sentence', () => {
    expect(findBareIds('blocked by PD-543.')).toEqual(['PD-543']);
    expect(findBareIds('see C-49 and PD-1 (x)')).toEqual(['C-49']);
    expect(findBareIds('(PD-9)')).toEqual(['PD-9']); // a parenthetical with nothing before it names nothing
  });

  it('ignores hyphenated numbers that are not id-shaped', () => {
    expect(findBareIds('a Robot with a 50-turn budget, 2-4 options')).toEqual([]);
  });

  it('is deliberately strict: an id-shaped token is flagged even if it is not a board id', () => {
    // A false positive costs the agent one rewording; a missed bare id costs Steve a lookup.
    expect(findBareIds('target ES-2022 syntax')).toEqual(['ES-2022']);
  });
});

describe('validateQuestionRound', () => {
  it('accepts a well-formed round', () => {
    expect(validateQuestionRound(round())).toBeNull();
  });

  it('rejects too few or too many questions', () => {
    expect(validateQuestionRound(round({ questions: [] }))).toMatch(/1–6 questions/);
    const many = Array.from({ length: 7 }, (_, i) => ({ ...round().questions[0], id: `q${i}` }));
    expect(validateQuestionRound(round({ questions: many }))).toMatch(/1–6 questions/);
  });

  it('rejects a single-option question, and points at assumptions instead', () => {
    const q = { ...round().questions[0], options: [opt('Live')] };
    expect(validateQuestionRound(round({ questions: [q] }))).toMatch(/assumption, not a question/);
  });

  it('requires exactly one recommendation within range', () => {
    for (const recommended of [-1, 2, 0.5]) {
      const q = { ...round().questions[0], recommended };
      expect(validateQuestionRound(round({ questions: [q] }))).toMatch(/recommend exactly one option/);
    }
  });

  it('requires a why, option descriptions, and unique ids and labels', () => {
    const [a, b] = round().questions;
    expect(validateQuestionRound(round({ questions: [{ ...a, why: ' ' }] }))).toMatch(/no `why`/);
    expect(validateQuestionRound(round({ questions: [{ ...a, options: [opt('Live'), { label: 'Reload', description: '' }] }] }))).toMatch(/no `description`/);
    expect(validateQuestionRound(round({ questions: [a, { ...b, id: 'sync' }] }))).toMatch(/reuses the id/);
    expect(validateQuestionRound(round({ questions: [{ ...a, options: [opt('Live'), opt('Live')] }] }))).toMatch(/two options labelled/);
  });

  it('rejects a bare id anywhere: question, option, or assumption source', () => {
    const [a] = round().questions;
    expect(validateQuestionRound(round({ questions: [{ ...a, question: 'Merge into PD-124?' }] }))).toMatch(/PD-124 without a title/);
    expect(validateQuestionRound(round({ questions: [{ ...a, options: [opt('Live'), { label: 'Reload', description: 'like C-49' }] }] }))).toMatch(/C-49 without a title/);
    expect(validateQuestionRound(round({ assumptions: [{ text: 'x', source: 'D-091' }] }))).toMatch(/D-091 without a title/);
  });

  it('requires both text and source on an assumption', () => {
    expect(validateQuestionRound(round({ assumptions: [{ text: 'x', source: '' }] }))).toMatch(/needs both/);
  });
});

describe('validateAnswerSet + renderRoundAnswers', () => {
  it('accepts one answer per question, by option or Other', () => {
    const set = { answers: [{ questionId: 'sync', choice: 0 }, { questionId: 'preview', other: 'only after Start' }] };
    expect(validateAnswerSet(round(), set)).toBeNull();
  });

  it('rejects unanswered, duplicated, unknown, out-of-range and doubly-filled answers', () => {
    const r = round();
    expect(validateAnswerSet(r, { answers: [{ questionId: 'sync', choice: 0 }] })).toMatch(/unanswered: preview/);
    expect(validateAnswerSet(r, { answers: [{ questionId: 'sync', choice: 0 }, { questionId: 'sync', choice: 1 }] })).toMatch(/answered twice/);
    expect(validateAnswerSet(r, { answers: [{ questionId: 'nope', choice: 0 }] })).toMatch(/no question "nope"/);
    expect(validateAnswerSet(r, { answers: [{ questionId: 'sync', choice: 5 }, { questionId: 'preview', choice: 0 }] })).toMatch(/no option 5/);
    expect(validateAnswerSet(r, { answers: [{ questionId: 'sync', choice: 0, other: 'x' }, { questionId: 'preview', choice: 0 }] })).toMatch(/exactly one/);
    expect(validateAnswerSet(r, { answers: [{ questionId: 'sync', choice: 0 }, { questionId: 'preview', choice: 0 }], overruled: [3] })).toMatch(/no assumption 3/);
  });

  it('renders each answer in full, marks the recommendation, and lists overruled assumptions', () => {
    const text = renderRoundAnswers(round(), {
      answers: [{ questionId: 'sync', choice: 0 }, { questionId: 'preview', choice: 1 }],
      overruled: [0],
      note: 'ship it',
    });
    expect(text).toContain('1. Live sync or reload-only?\n   → Live (your recommendation): pick Live');
    expect(text).toContain('2. Preview on select?\n   → No: pick No');
    expect(text).toContain('Overruled assumptions');
    expect(text).toContain('- Sounds are synthesized, not downloaded. (PD-596 (Pomodoro sound picker), Context section)');
    expect(text).toContain('Note: ship it');
  });

  it('says so when every assumption stands', () => {
    const text = renderRoundAnswers(round(), { answers: [{ questionId: 'sync', choice: 1 }, { questionId: 'preview', other: 'maybe' }] });
    expect(text).toContain('All your stated assumptions stand.');
    expect(text).toContain('→ Other: maybe');
  });
});

describe('roundAsMarkdown', () => {
  it('numbers questions, marks the recommendation, and lists assumptions with sources', () => {
    const md = roundAsMarkdown(round());
    expect(md).toContain('**1. Live sync or reload-only?**');
    expect(md).toContain('- Live **(recommended)**: pick Live');
    expect(md).toContain('- Reload: pick Reload');
    expect(md).toContain('- Sounds are synthesized, not downloaded. _(PD-596 (Pomodoro sound picker), Context section)_');
  });
});
