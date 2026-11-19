// Pure state for the structured-question form (PD-745, D-096 §4). Kept out of the component so it
// is unit-testable: apps/web's vitest runs without the SvelteKit plugin, so nothing reachable from a
// spec may import a `.svelte` file.
import type { RefineAnswerSet, RefineMessage, RefineQuestionRound } from '@dashboard/shared';
import { validateAnswerSet } from '@dashboard/shared';

/** One question's in-progress answer: an option index, or Other (with its text). */
export type DraftAnswer = { kind: 'none' } | { kind: 'choice'; index: number } | { kind: 'other'; text: string };

export interface RoundDraft {
  answers: Record<string, DraftAnswer>;
  /** Indexes into the round's assumptions that Steve has overruled. */
  overruled: number[];
  note: string;
}

/** A fresh draft: nothing chosen, nothing overruled. Recommendations are a click away, not preselected,
 *  so an untouched form can never be sent by accident as "Steve agreed with everything". */
export function emptyDraft(round: RefineQuestionRound): RoundDraft {
  return {
    answers: Object.fromEntries(round.questions.map((q) => [q.id, { kind: 'none' } as DraftAnswer])),
    overruled: [],
    note: '',
  };
}

/** Fill every UNANSWERED question with the agent's recommendation. Answers already given stay. */
export function acceptAllRecommendations(round: RefineQuestionRound, draft: RoundDraft): RoundDraft {
  const answers = { ...draft.answers };
  for (const q of round.questions) {
    if ((answers[q.id] ?? { kind: 'none' }).kind === 'none') answers[q.id] = { kind: 'choice', index: q.recommended };
  }
  return { ...draft, answers };
}

/** The draft as the reply payload. Other with blank text counts as unanswered. */
export function draftToAnswerSet(round: RefineQuestionRound, draft: RoundDraft): RefineAnswerSet {
  const answers: RefineAnswerSet['answers'] = [];
  for (const q of round.questions) {
    const a = draft.answers[q.id];
    if (a?.kind === 'choice') answers.push({ questionId: q.id, choice: a.index });
    else if (a?.kind === 'other' && a.text.trim() !== '') answers.push({ questionId: q.id, other: a.text.trim() });
  }
  return {
    answers,
    ...(draft.overruled.length > 0 ? { overruled: [...draft.overruled].sort((x, y) => x - y) } : {}),
    ...(draft.note.trim() !== '' ? { note: draft.note.trim() } : {}),
  };
}

/** How many questions are still unanswered — drives the Send button and its hint. */
export function unansweredCount(round: RefineQuestionRound, draft: RoundDraft): number {
  return round.questions.length - draftToAnswerSet(round, draft).answers.length;
}

/** True when the draft is a valid reply (the same check the server applies). */
export function draftIsSendable(round: RefineQuestionRound, draft: RoundDraft): boolean {
  return validateAnswerSet(round, draftToAnswerSet(round, draft)) === null;
}

/** The round Steve can answer now: the newest message is an agent turn carrying a round. */
export function openRoundMessage(messages: readonly RefineMessage[]): RefineMessage | null {
  const last = messages[messages.length - 1];
  return last && last.role === 'agent' && last.round ? last : null;
}

/** One line per answered question, for the collapsed summary of a round already sent. */
export interface AnswerSummaryLine {
  question: string;
  answer: string;
  recommended: boolean;
}

export function answerSummary(round: RefineQuestionRound, set: RefineAnswerSet): AnswerSummaryLine[] {
  const byId = new Map(set.answers.map((a) => [a.questionId, a]));
  return round.questions.map((q) => {
    const a = byId.get(q.id);
    if (!a) return { question: q.question, answer: 'No answer', recommended: false };
    if (a.other !== undefined && a.other.trim() !== '') return { question: q.question, answer: `Other: ${a.other}`, recommended: false };
    const o = q.options[a.choice as number];
    return { question: q.question, answer: o ? o.label : 'Unknown option', recommended: a.choice === q.recommended };
  });
}

/** For each human turn that sent structured answers, the round it answered: the nearest earlier
 *  agent turn with a round. Keyed by the human message id. */
export function roundsAnsweredBy(messages: readonly RefineMessage[]): Map<number, RefineQuestionRound> {
  const out = new Map<number, RefineQuestionRound>();
  let lastRound: RefineQuestionRound | null = null;
  for (const m of messages) {
    if (m.role === 'agent' && m.round) lastRound = m.round;
    else if (m.role === 'human' && m.answers && lastRound) out.set(m.id, lastRound);
  }
  return out;
}
