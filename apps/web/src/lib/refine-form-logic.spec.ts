import { describe, it, expect } from 'vitest';
import type { RefineMessage, RefineQuestionRound } from '@dashboard/shared';
import {
  acceptAllRecommendations,
  answerSummary,
  draftIsSendable,
  draftToAnswerSet,
  emptyDraft,
  openRoundMessage,
  roundsAnsweredBy,
  unansweredCount,
} from './refine-form-logic';

const opt = (label: string) => ({ label, description: `pick ${label}` });
const ROUND: RefineQuestionRound = {
  questions: [
    { id: 'sync', question: 'Live or reload?', why: 'Both on screen.', options: [opt('Live'), opt('Reload')], recommended: 0 },
    { id: 'preview', question: 'Preview?', why: 'Unlocks audio.', options: [opt('Yes'), opt('No')], recommended: 1 },
  ],
  assumptions: [{ text: 'Synthesized audio', source: 'PROJECT.md' }],
};

describe('refine form draft (PD-745)', () => {
  it('starts with nothing chosen, so an untouched form cannot be sent', () => {
    const d = emptyDraft(ROUND);
    expect(unansweredCount(ROUND, d)).toBe(2);
    expect(draftIsSendable(ROUND, d)).toBe(false);
  });

  it('Accept all fills only the unanswered questions with their recommendations', () => {
    const d0 = emptyDraft(ROUND);
    const d1 = { ...d0, answers: { ...d0.answers, preview: { kind: 'choice' as const, index: 0 } } };
    const d2 = acceptAllRecommendations(ROUND, d1);
    expect(d2.answers.sync).toEqual({ kind: 'choice', index: 0 });
    expect(d2.answers.preview).toEqual({ kind: 'choice', index: 0 }); // Steve's own pick survives
    expect(draftIsSendable(ROUND, d2)).toBe(true);
  });

  it('builds the payload: Other text trimmed, blank Other unanswered, overruled sorted, note optional', () => {
    const d = {
      answers: { sync: { kind: 'other' as const, text: '  only after Start ' }, preview: { kind: 'other' as const, text: '  ' } },
      overruled: [0],
      note: '',
    };
    expect(draftToAnswerSet(ROUND, d)).toEqual({ answers: [{ questionId: 'sync', other: 'only after Start' }], overruled: [0] });
    expect(unansweredCount(ROUND, d)).toBe(1);
    expect(draftIsSendable(ROUND, d)).toBe(false);
  });
});

describe('thread helpers (PD-745)', () => {
  const msg = (id: number, role: 'human' | 'agent', extra: Partial<RefineMessage> = {}): RefineMessage => ({
    id,
    ticketId: 1,
    role,
    text: '',
    createdAt: id,
    ...extra,
  });

  it('the open round is the newest message, only when it is an agent turn with a round', () => {
    expect(openRoundMessage([])).toBeNull();
    expect(openRoundMessage([msg(1, 'human'), msg(2, 'agent', { round: ROUND })])?.id).toBe(2);
    expect(openRoundMessage([msg(1, 'agent', { round: ROUND }), msg(2, 'human')])).toBeNull();
    expect(openRoundMessage([msg(1, 'agent')])).toBeNull();
  });

  it('pairs each structured reply with the round before it', () => {
    const answers = { answers: [{ questionId: 'sync', choice: 1 }] };
    const pairs = roundsAnsweredBy([
      msg(1, 'human'),
      msg(2, 'agent', { round: ROUND }),
      msg(3, 'human', { answers }),
      msg(4, 'agent'),
      msg(5, 'human'),
    ]);
    expect([...pairs.keys()]).toEqual([3]);
  });

  it('summarizes answers by label and marks the recommended ones', () => {
    expect(
      answerSummary(ROUND, { answers: [{ questionId: 'sync', choice: 0 }, { questionId: 'preview', other: 'later' }] }),
    ).toEqual([
      { question: 'Live or reload?', answer: 'Live', recommended: true },
      { question: 'Preview?', answer: 'Other: later', recommended: false },
    ]);
  });
});
