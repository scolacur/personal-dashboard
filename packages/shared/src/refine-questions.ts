// Structured Refine question rounds (PD-744, D-096 §4–5).
//
// The Refine agent asks through the `ask_questions` tool instead of prose: a round of 1–6 questions,
// each with 2–4 options and exactly one recommended, plus the assumptions it settled itself from
// DECISIONS/ and PROJECT.md. Steve answers with clicks (`RefineAnswerSet`); the server renders the
// answers back into text for the agent's next turn. Both sides validate with the functions here, so
// the agent-worker (which rejects a malformed round while the agent can still fix it) and the server
// (which rejects a malformed answer) cannot drift apart.

import type { RefineProposal } from './task-monitor';

/** One choice on a question. `description` states the trade-off — what picking it means. */
export interface RefineQuestionOption {
  label: string;
  description: string;
}

/** One question in a round. `recommended` is the index into `options` of the agent's pick. */
export interface RefineQuestion {
  /** Stable within the round (e.g. "q1", "sync"); answers reference it. */
  id: string;
  question: string;
  /** One line on why the answer matters — what it changes in the ticket. */
  why: string;
  options: RefineQuestionOption[];
  recommended: number;
}

/** Something the agent settled itself instead of asking, with what it relied on. */
export interface RefineAssumption {
  text: string;
  /** Where it came from — a decision id WITH its title, a PROJECT.md section, a file path. */
  source: string;
}

/** A round of questions, carried on a `refine_agent` event's detail as `round`. */
export interface RefineQuestionRound {
  questions: RefineQuestion[];
  assumptions: RefineAssumption[];
}

/** Steve's answer to one question: an option index, or free text in Other. Exactly one of the two. */
export interface RefineAnswer {
  questionId: string;
  choice?: number;
  other?: string;
}

/** Steve's reply to a round, carried on the `refine_human` event's detail as `answers`. */
export interface RefineAnswerSet {
  answers: RefineAnswer[];
  /** Indexes into the round's `assumptions` that Steve overruled. */
  overruled?: number[];
  /** Anything else Steve wants to say alongside the answers. */
  note?: string;
}

export const REFINE_ROUND_LIMITS = {
  minQuestions: 1,
  maxQuestions: 6,
  minOptions: 2,
  maxOptions: 4,
  maxAssumptions: 10,
} as const;

// A board or decision id: PD-743, C-49, PG-19, D-096.
const ID_PATTERN = /\b[A-Z]{1,3}-\d{1,4}\b/g;

/**
 * The ids in `text` that appear without a title beside them (the `/harness` id rule, D-096 §4).
 *
 * An id counts as titled when it is immediately followed by a parenthetical, a dash or a colon
 * ("PD-743 (Park a Refine session)", "D-091 — robot work enters the Queue only refined"), or when it
 * is itself the parenthetical after a title ("the Async Refine Epic (PD-742)"). Anything else is bare.
 * Deliberately strict: a bare id makes a question unanswerable without a lookup, and the agent gets
 * the error while it can still fix the wording.
 */
export function findBareIds(text: string): string[] {
  const bare: string[] = [];
  for (const m of text.matchAll(ID_PATTERN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const after = text.slice(end);
    const before = text.slice(0, start);
    const titledAfter = /^\s*(\(|—|–|-\s|:)/.test(after);
    const isParenthetical = /\(\s*$/.test(before) && /^\s*\)/.test(after) && /\S/.test(before.replace(/\(\s*$/, ''));
    if (!titledAfter && !isParenthetical) bare.push(m[0]);
  }
  return bare;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Check a round's shape. Returns an instructive error for the agent, or null when well-formed.
 * Pure — called by the `ask_questions` tool handler, and by the server before trusting a stored round.
 */
export function validateQuestionRound(round: RefineQuestionRound): string | null {
  const L = REFINE_ROUND_LIMITS;
  const qs = round.questions ?? [];
  if (qs.length < L.minQuestions || qs.length > L.maxQuestions) {
    return `a round has ${L.minQuestions}–${L.maxQuestions} questions; you sent ${qs.length}. If you need more, ask the ones that unblock the rest first, and the others next round.`;
  }
  const ids = new Set<string>();
  const texts: { where: string; text: string }[] = [];
  for (const [i, q] of qs.entries()) {
    const where = `question ${i + 1}${nonEmpty(q.id) ? ` ("${q.id}")` : ''}`;
    if (!nonEmpty(q.id)) return `${where} has no \`id\`. Give each question a short unique id, e.g. "sync".`;
    if (ids.has(q.id)) return `${where} reuses the id "${q.id}". Question ids must be unique within a round.`;
    ids.add(q.id);
    if (!nonEmpty(q.question)) return `${where} has no \`question\` text.`;
    if (!nonEmpty(q.why)) {
      return `${where} has no \`why\`. Say in one line what the answer changes in the ticket, so Steve can judge how much it matters.`;
    }
    const opts = q.options ?? [];
    if (opts.length < L.minOptions || opts.length > L.maxOptions) {
      return `${where} has ${opts.length} options; give ${L.minOptions}–${L.maxOptions}. A question with one sensible answer is an assumption, not a question. Put it in \`assumptions\` with its source.`;
    }
    const labels = new Set<string>();
    for (const [j, o] of opts.entries()) {
      if (!nonEmpty(o.label)) return `${where}, option ${j + 1} has no \`label\`.`;
      if (!nonEmpty(o.description)) {
        return `${where}, option "${o.label}" has no \`description\`. State the trade-off: what picking it means for the work.`;
      }
      if (labels.has(o.label.trim())) return `${where} has two options labelled "${o.label}".`;
      labels.add(o.label.trim());
      texts.push({ where: `${where}, option "${o.label}"`, text: `${o.label} ${o.description}` });
    }
    if (!Number.isInteger(q.recommended) || q.recommended < 0 || q.recommended >= opts.length) {
      return `${where} must recommend exactly one option: \`recommended\` is the 0-based index of your pick (0–${opts.length - 1}); you sent ${String(q.recommended)}.`;
    }
    texts.push({ where, text: `${q.question} ${q.why}` });
  }
  const as = round.assumptions ?? [];
  if (as.length > L.maxAssumptions) return `at most ${L.maxAssumptions} assumptions per round; you sent ${as.length}.`;
  for (const [k, a] of as.entries()) {
    if (!nonEmpty(a.text) || !nonEmpty(a.source)) {
      return `assumption ${k + 1} needs both \`text\` and \`source\` (the decision, PROJECT.md section or file it rests on).`;
    }
    texts.push({ where: `assumption ${k + 1}`, text: `${a.text} ${a.source}` });
  }
  for (const { where, text } of texts) {
    const bare = findBareIds(text);
    if (bare.length > 0) {
      return `${where} mentions ${bare.join(', ')} without a title. Steve doesn't know ids by heart: write each one with its title, e.g. "PD-743 (Park a Refine session)" or "the Async Refine Epic (PD-742)".`;
    }
  }
  return null;
}

/**
 * Check Steve's answers against the round they answer. Every question must be answered exactly once,
 * by a valid option index or non-empty Other text. Returns an error string, or null when valid.
 */
export function validateAnswerSet(round: RefineQuestionRound, set: RefineAnswerSet): string | null {
  const answers = Array.isArray(set.answers) ? set.answers : [];
  const byId = new Map(round.questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  for (const a of answers) {
    const q = byId.get(a.questionId);
    if (!q) return `there is no question "${a.questionId}" in this round`;
    if (seen.has(a.questionId)) return `question "${a.questionId}" is answered twice`;
    seen.add(a.questionId);
    const hasChoice = a.choice !== undefined && a.choice !== null;
    const hasOther = nonEmpty(a.other);
    if (hasChoice === hasOther) return `question "${a.questionId}" needs exactly one of an option or Other text`;
    if (hasChoice && (!Number.isInteger(a.choice) || (a.choice as number) < 0 || (a.choice as number) >= q.options.length)) {
      return `question "${a.questionId}" has no option ${String(a.choice)}`;
    }
  }
  const missing = round.questions.filter((q) => !seen.has(q.id)).map((q) => q.id);
  if (missing.length > 0) return `unanswered: ${missing.join(', ')}`;
  for (const i of set.overruled ?? []) {
    if (!Number.isInteger(i) || i < 0 || i >= round.assumptions.length) return `there is no assumption ${String(i)} to overrule`;
  }
  return null;
}

/**
 * Render Steve's answers as the text the agent reads on its next turn. Names each chosen option in
 * full (not by index) and says when it was the agent's own recommendation, so the agent never has
 * to map numbers back to a round it may no longer hold in context.
 */
export function renderRoundAnswers(round: RefineQuestionRound, set: RefineAnswerSet): string {
  const lines: string[] = ['Answers to your questions:'];
  const byId = new Map(set.answers.map((a) => [a.questionId, a]));
  round.questions.forEach((q, i) => {
    const a = byId.get(q.id);
    lines.push(`${i + 1}. ${q.question}`);
    if (!a) {
      lines.push('   → (no answer)');
    } else if (nonEmpty(a.other)) {
      lines.push(`   → Other: ${a.other.trim()}`);
    } else {
      const o = q.options[a.choice as number];
      const rec = a.choice === q.recommended ? ' (your recommendation)' : '';
      lines.push(`   → ${o.label}${rec}: ${o.description}`);
    }
  });
  const overruled = (set.overruled ?? []).map((i) => round.assumptions[i]).filter(Boolean);
  if (round.assumptions.length > 0) {
    if (overruled.length === 0) {
      lines.push('', 'All your stated assumptions stand.');
    } else {
      lines.push('', 'Overruled assumptions (do not rely on these; ask if the answer is unclear):');
      for (const a of overruled) lines.push(`- ${a.text} (${a.source})`);
    }
  }
  if (nonEmpty(set.note)) lines.push('', `Note: ${set.note.trim()}`);
  return lines.join('\n');
}

/**
 * A round as Markdown, for surfaces that show it read-only (the thread before the answer form
 * exists, notifications). Recommended options are marked; a typed reply still answers it.
 */
export function roundAsMarkdown(round: RefineQuestionRound): string {
  const out: string[] = [];
  round.questions.forEach((q, i) => {
    out.push(`**${i + 1}. ${q.question}**`, '', `_${q.why}_`, '');
    q.options.forEach((o, j) => {
      out.push(`- ${o.label}${j === q.recommended ? ' **(recommended)**' : ''}: ${o.description}`);
    });
    out.push('');
  });
  if (round.assumptions.length > 0) {
    out.push('**Assumptions** (say if any is wrong):', '');
    for (const a of round.assumptions) out.push(`- ${a.text} _(${a.source})_`);
  }
  return out.join('\n').trim();
}

/** Title prefix of the `agent_refine` notification raised when the agent asks a structured round
 *  (PD-746). The web links such notifications to the Decisions inbox instead of the ticket page;
 *  both sides read this constant so the title and the link rule cannot drift apart. */
export const REFINE_QUESTIONS_NOTIFICATION_PREFIX = 'Refine agent asked';

/** One ticket waiting on Steve's Refine answer, for the Decisions inbox (PD-746). What it waits
 *  on is one of three things (PD-843): an actionable commit `proposal` (Approve/Reject), a question
 *  `round`, or neither (the agent replied without asking or proposing; the inbox links to the thread). */
export interface AwaitingRefineItem {
  ticketId: number;
  displayId: string | null;
  title: string;
  /** PD-843: an Epic's decompose is a Populate, and an Epic is never offered "Approve & queue". */
  isEpic: boolean;
  priority: string | null;
  epicDisplayId: string | null;
  epicTitle: string | null;
  /** The agent turn awaiting an answer. */
  eventId: number;
  askedAt: number;
  agentText: string;
  round: RefineQuestionRound | null;
  /** PD-843: the commit proposal still awaiting Approve/Reject (`latestActionableProposal`), or null. */
  proposal: { eventId: number; proposal: RefineProposal } | null;
}
/** The Refine auto-start scheduler's last-cycle state (PD-747, D-096 §1–2), published by the
 *  agent-worker into `robot_state` and shown in system status. */
export interface RefineAutostartStatus {
  enabled: boolean;
  /** Refine sessions open now: waiting on Steve, or the agent working. */
  open: number;
  /** No new auto-session starts while `open` is at or above this. */
  cap: number;
  /** New tickets waiting for an auto-started session. */
  queued: number;
  /** PD-748: older backlog tickets still to drip in, behind the new ones. */
  backfillRemaining: number;
  /** Why the last cycle started nothing, if it was held back; null when free to start. */
  heldBy: string | null;
  /** Unix ms of the cycle that wrote this. */
  at: number;
}

/** The `robot_state` key the worker publishes `RefineAutostartStatus` under. */
export const REFINE_AUTOSTART_STATUS_KEY = 'refine_autostart_status';

/** Event type that switches an Epic in or out of the Refine backfill (PD-748). Detail
 *  `{ excluded: boolean }`; the newest one wins, and an Epic's members inherit it. */
export const REFINE_BACKFILL_EXCLUDED_EVENT = 'refine_backfill_excluded';
