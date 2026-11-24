import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  PROGRESS_VERDICTS,
  type ProgressCheckSource,
  type ProgressTripwire,
  type ProgressVerdict,
} from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { asOwnerOf } from './workspace';

const run = promisify(execFile);

/**
 * PD-964 (D-114) — the rolling progress check.
 *
 * Every `checkpointWindowTurns` turns the loop stops the session and asks one question of the window
 * it just ran: is this run making progress? Hard signals first (the tripwires, deterministic and
 * cheap), then — only when none fires — a separate judge agent. The run never grades itself
 * (generation ≠ evaluation): the judge is a different call with no tools and no access to the repo,
 * fed only what the loop observed.
 *
 * Everything here except `runProgressJudge` and `snapshotTree` is pure, so each tripwire and every
 * judge-parse outcome is unit-testable without a session.
 */

// ── The window transcript ───────────────────────────────────────────────────────────────────────

/** One thing the session did or said in a window, as the loop observed it on the SDK stream. */
export type TranscriptEntry =
  | { kind: 'tool_use'; turn: number; id?: string; name: string; input: string }
  | { kind: 'tool_result'; turn: number; toolUseId?: string; text: string; isError: boolean }
  | { kind: 'text'; turn: number; text: string };

/** Per-entry text cap, so one huge tool result (a full verify log) cannot crowd out the window. */
export const TRANSCRIPT_TEXT_MAX = 4_000;
/** Entry cap per window. A 25-turn window is ~100 entries; this only stops a runaway. */
export const TRANSCRIPT_ENTRIES_MAX = 600;

function clip(text: string, max: number = TRANSCRIPT_TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return String(input);
  }
}

/**
 * Pull transcript entries out of one SDK message. Read defensively, like the rest of session.ts: an
 * unrecognized block is skipped, never assumed. Sub-agent messages are not filtered — the Robot has
 * no `Task` tool (D-068), so there are none.
 */
export function transcriptEntries(message: unknown, turn: number): TranscriptEntry[] {
  if (message === null || typeof message !== 'object') return [];
  const m = message as { type?: string; message?: { content?: unknown } };
  if (m.type !== 'assistant' && m.type !== 'user') return [];
  const content = m.message?.content;
  if (!Array.isArray(content)) {
    return m.type === 'assistant' && typeof content === 'string' && content.trim()
      ? [{ kind: 'text', turn, text: clip(content.trim()) }]
      : [];
  }
  const out: TranscriptEntry[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && m.type === 'assistant') {
      out.push({ kind: 'text', turn, text: clip(b.text.trim()) });
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      out.push({ kind: 'tool_use', turn, name: b.name, input: clip(stringifyInput(b.input)), ...(typeof b.id === 'string' ? { id: b.id } : {}) });
    } else if (b.type === 'tool_result') {
      let text = '';
      if (typeof b.content === 'string') text = b.content;
      else if (Array.isArray(b.content)) {
        text = b.content
          .map((c) => ((c as { type?: string; text?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
          .filter(Boolean)
          .join('\n');
      }
      out.push({
        kind: 'tool_result',
        turn,
        text: clip(text),
        isError: b.is_error === true,
        ...(typeof b.tool_use_id === 'string' ? { toolUseId: b.tool_use_id } : {}),
      });
    }
  }
  return out;
}

/** Append, holding the window to `TRANSCRIPT_ENTRIES_MAX` by dropping the oldest. */
export function appendTranscript(buf: TranscriptEntry[], entries: TranscriptEntry[]): void {
  buf.push(...entries);
  if (buf.length > TRANSCRIPT_ENTRIES_MAX) buf.splice(0, buf.length - TRANSCRIPT_ENTRIES_MAX);
}

/** The run's plan: the newest `TodoWrite` the session made, as written. Null when it kept none. */
export function latestPlan(transcript: readonly TranscriptEntry[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.kind === 'tool_use' && e.name === 'TodoWrite') return e.input;
  }
  return null;
}

// ── Tripwires ───────────────────────────────────────────────────────────────────────────────────

/** Collapse the incidental parts of an error (numbers, hex ids, temp paths, whitespace) so the same
 *  failure reads the same each time it recurs. */
export function normalizeError(text: string): string {
  return text
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '#')
    .replace(/[0-9a-f]{12,}/g, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\/tmp\/\S+/g, '/tmp/…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** Tools whose repetition is normal, not a loop: polling a background shell, and plan bookkeeping. */
const REPEAT_EXEMPT_TOOLS = new Set(['BashOutput', 'TodoWrite']);

/** Is this a call to the repo's verify? Matches `npm run verify` however it is chained. */
function isVerifyCall(e: TranscriptEntry): boolean {
  return e.kind === 'tool_use' && e.name === 'Bash' && /npm\s+run\s+verify\b/.test(e.input);
}

/**
 * The last `npm run verify` in the window, if it failed: a normalized signature of how it failed.
 * Null when verify did not run in the window, or its last run passed. The tail of the output is
 * where the failing check names itself, so the signature is taken from the end.
 */
export function verifyFailureSignature(transcript: readonly TranscriptEntry[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const call = transcript[i];
    if (!isVerifyCall(call) || call.kind !== 'tool_use') continue;
    const result = transcript
      .slice(i + 1)
      .find((e): e is Extract<TranscriptEntry, { kind: 'tool_result' }> => e.kind === 'tool_result' && (!call.id || e.toolUseId === call.id));
    if (!result) return null; // verify still running / result not seen — no verdict on it
    if (!result.isError) return null;
    return normalizeError(result.text.slice(-1_200)) || 'verify failed (no output)';
  }
  return null;
}

export interface TripwireInput {
  transcript: readonly TranscriptEntry[];
  /** How many repeats of one tool call / one error trip the wire. */
  repeatLimit: number;
  /** Tree fingerprint at the window's start and end; null when it could not be taken. */
  treeBefore: string | null;
  treeAfter: string | null;
  /** This window's and the previous window's verify-failure signature (see `verifyFailureSignature`). */
  verifyFailure: string | null;
  previousVerifyFailure: string | null;
}

export interface TripwireHit {
  tripwire: ProgressTripwire;
  /** Short evidence for the card: what repeated, how often. */
  detail: string;
}

/**
 * The deterministic checks, in order. The first that fires wins; null when none does. Each is a
 * signal the judge would only see dimly through a truncated transcript, so they run first and are
 * never overridden by it.
 */
export function checkTripwires(input: TripwireInput): TripwireHit | null {
  const { transcript, repeatLimit } = input;
  const limit = Math.max(2, repeatLimit);

  // A loop is the same call getting the same answer. Re-running `npm run verify` after each fix is
  // the same input but NEW output each time — the agent is learning something — so the result is
  // part of the key. A call whose result was not seen keys on the call alone.
  const resultFor = new Map<string, string>();
  for (const e of transcript) {
    if (e.kind === 'tool_result' && e.toolUseId) resultFor.set(e.toolUseId, normalizeError(e.text));
  }
  const calls = new Map<string, { n: number; name: string }>();
  for (const e of transcript) {
    if (e.kind !== 'tool_use' || REPEAT_EXEMPT_TOOLS.has(e.name)) continue;
    const key = `${e.name}\u0000${e.input}\u0000${(e.id && resultFor.get(e.id)) ?? ''}`;
    const c = calls.get(key) ?? { n: 0, name: e.name };
    c.n += 1;
    calls.set(key, c);
    if (c.n >= limit) return { tripwire: 'repeated_tool_call', detail: `${e.name} with the same input and the same result ${c.n}× in one window` };
  }

  const errors = new Map<string, number>();
  for (const e of transcript) {
    if (e.kind !== 'tool_result' || !e.isError) continue;
    const sig = normalizeError(e.text);
    if (!sig) continue;
    const n = (errors.get(sig) ?? 0) + 1;
    errors.set(sig, n);
    if (n >= limit) return { tripwire: 'repeated_error', detail: `the same error ${n}× in one window: ${sig.slice(0, 120)}` };
  }

  if (input.treeBefore !== null && input.treeAfter !== null && input.treeBefore === input.treeAfter) {
    return { tripwire: 'no_diff_change', detail: 'the working tree is identical at the start and end of the window' };
  }

  if (input.verifyFailure !== null && input.verifyFailure === input.previousVerifyFailure) {
    return { tripwire: 'verify_same_failure', detail: `verify failed the same way two windows running: ${input.verifyFailure.slice(0, 120)}` };
  }
  return null;
}

// ── The judge ───────────────────────────────────────────────────────────────────────────────────

/** The judge's input budget, in characters (~4 chars per token → ~20k tokens). The transcript is cut
 *  from the FRONT, so the judge always sees how the window ended. */
export const JUDGE_INPUT_MAX_CHARS = 80_000;
const JUDGE_DIFF_MAX_CHARS = 24_000;
const JUDGE_BODY_MAX_CHARS = 12_000;
const JUDGE_PLAN_MAX_CHARS = 4_000;
/** Wall-clock bound, so a hung judge cannot hold the cycle. A timeout parks, like any judge failure. */
export const JUDGE_TIMEOUT_MS = 3 * 60_000;

export const JUDGE_SYSTEM_PROMPT = [
  'You are a progress judge for an autonomous coding agent. You are NOT the agent and you do not',
  'write code. You see one window of its work: the ticket, its plan, the code diff the window',
  'produced, and what it did and saw. Decide whether it is making real progress toward the ticket.',
  '',
  'Verdicts:',
  '- progressing: it is moving toward the Done When — new code, a failing check being narrowed down,',
  '  investigation that is converging. Slow is fine.',
  '- stalled: it is going in circles — retrying the same fix, re-reading the same things, the same',
  '  failure every attempt, or doing nothing that changes the outcome.',
  '- drifted: it is working on something the ticket does not ask for, or has changed the task.',
  '- hallucinating: it is acting on things that are not there — files, APIs, results or passing',
  '  checks its own tool output contradicts.',
  '',
  'Reply with ONE JSON object and nothing else:',
  '{"verdict": "progressing" | "stalled" | "drifted" | "hallucinating", "reason": "<one sentence>"}',
].join('\n');

export interface JudgeInput {
  title: string;
  body: string | null;
  plan: string | null;
  diff: string | null;
  transcript: readonly TranscriptEntry[];
  window: number;
  turnsSoFar: number;
}

function renderEntry(e: TranscriptEntry): string {
  if (e.kind === 'tool_use') return `[turn ${e.turn}] CALL ${e.name}: ${e.input}`;
  if (e.kind === 'tool_result') return `[turn ${e.turn}] ${e.isError ? 'ERROR' : 'RESULT'}: ${e.text}`;
  return `[turn ${e.turn}] SAID: ${e.text}`;
}

function cut(text: string, max: number, fromFront: boolean): string {
  if (text.length <= max) return text;
  return fromFront ? `…[earlier part cut]\n${text.slice(text.length - max)}` : `${text.slice(0, max)}\n…[rest cut]`;
}

/** The judge's user prompt, held to `JUDGE_INPUT_MAX_CHARS`. Pure. */
export function buildJudgePrompt(input: JudgeInput): string {
  const head = [
    `# Ticket: ${input.title}`,
    '',
    cut(input.body?.trim() || '(no body)', JUDGE_BODY_MAX_CHARS, false),
    '',
    '# The agent\'s plan (its latest TodoWrite)',
    cut(input.plan?.trim() || '(it kept no plan)', JUDGE_PLAN_MAX_CHARS, false),
    '',
    `# The code diff this window produced (window ${input.window}, ${input.turnsSoFar} turns so far)`,
    cut(input.diff?.trim() || '(no diff available, or nothing changed)', JUDGE_DIFF_MAX_CHARS, false),
    '',
    '# What it did and saw in this window (oldest first)',
  ].join('\n');
  const tail = '\n\nGive your verdict as the JSON object.';
  const room = Math.max(2_000, JUDGE_INPUT_MAX_CHARS - head.length - tail.length);
  const log = input.transcript.map(renderEntry).join('\n') || '(nothing recorded)';
  return `${head}\n${cut(log, room, true)}${tail}`;
}

export interface JudgeVerdict {
  verdict: ProgressVerdict;
  reason: string;
}

/**
 * Parse the judge's reply. Anything that is not exactly one of the four verdicts with a reason is a
 * malformed answer, which comes back as `error` — and parks. A judge that cannot answer clearly has
 * not shown the run is progressing.
 */
export function parseJudgeReply(text: string | undefined | null): JudgeVerdict {
  if (!text?.trim()) return { verdict: 'error', reason: 'the judge gave no answer' };
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: 'error', reason: 'the judge answer was not JSON' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { verdict: 'error', reason: 'the judge answer was not valid JSON' };
  }
  const v = (parsed as { verdict?: unknown }).verdict;
  const r = (parsed as { reason?: unknown }).reason;
  if (typeof v !== 'string' || v === 'error' || !(PROGRESS_VERDICTS as readonly string[]).includes(v)) {
    return { verdict: 'error', reason: `the judge answered an unknown verdict (${String(v).slice(0, 40)})` };
  }
  const reason = typeof r === 'string' && r.trim() ? r.trim().slice(0, 300) : '(no reason given)';
  return { verdict: v as ProgressVerdict, reason };
}

export interface JudgeResult extends JudgeVerdict {
  /** The judge call's own usage — it counts against the loop budget (D-064) and the run's usage. */
  turns: number;
  tokens: number;
}

/** Injectable SDK query, as in session.ts. */
export type JudgeQuery = typeof query;

/**
 * Ask the judge. A separate SDK query with NO tools (it cannot read the repo, run anything, or reach
 * the session), one turn, bounded in time. Never throws: any failure is an `error` verdict, which
 * parks. Runs as the worker, not the coding uid — it touches nothing on disk.
 */
export async function runProgressJudge(
  config: AgentWorkerConfig,
  input: JudgeInput,
  runQuery: JudgeQuery = query,
  timeoutMs: number = JUDGE_TIMEOUT_MS,
): Promise<JudgeResult> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort('progress judge timeout'), timeoutMs);
  let text: string | undefined;
  let lastAssistant = '';
  let turns = 0;
  let tokens = 0;
  let failure: string | undefined;
  try {
    for await (const message of runQuery({
      prompt: buildJudgePrompt(input),
      options: {
        model: config.robot.checkpointJudgeModel || config.model,
        cwd: os.tmpdir(),
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        tools: [],
        mcpServers: {},
        maxTurns: 1,
        abortController,
      },
    }) as AsyncIterable<SDKMessage>) {
      if (message.type === 'assistant') {
        const content = (message as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          const t = content
            .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
          if (t) lastAssistant = t;
        }
      }
      if (message.type === 'result') {
        const r = message as { subtype?: string; result?: unknown; num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number }; errors?: string[] };
        if (typeof r.num_turns === 'number') turns = r.num_turns;
        if (r.usage) tokens = (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0);
        if (r.subtype === 'success' && typeof r.result === 'string') text = r.result;
        else if (r.subtype !== 'success') failure = (r.errors ?? []).join('; ') || r.subtype;
      }
    }
  } catch (err) {
    failure = abortController.signal.aborted ? 'the judge timed out' : err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  const reply = text ?? (lastAssistant || undefined);
  const verdict = reply ? parseJudgeReply(reply) : { verdict: 'error' as const, reason: `the judge call failed: ${failure ?? 'no answer'}` };
  if (verdict.verdict === 'error') logger.warn({ reason: verdict.reason, failure }, 'robot: progress judge failed — parking');
  return { ...verdict, turns: Math.max(turns, 1), tokens };
}

// ── Tree snapshots ──────────────────────────────────────────────────────────────────────────────

/**
 * Fingerprints the clone's working tree (untracked included, gitignored excluded) as a git tree id,
 * and diffs two of them, for the `no_diff_change` tripwire and the judge's window diff.
 *
 * The objects go into a PRIVATE object directory and index, with the clone's own objects as an
 * alternate. The worker is root and the clone belongs to the coding uid, and the session resumes
 * after the check: root-owned files written into the clone's `.git` mid-run could make the Robot's
 * own `git add` fail. Nothing here writes inside the clone.
 */
export interface TreeSnapshotter {
  /** A tree id for the working tree right now, or null when it could not be taken. */
  snapshot(): Promise<string | null>;
  /** The diff between two snapshots, or null when it could not be produced. */
  diff(before: string, after: string): Promise<string | null>;
  /** Remove the private object directory. */
  dispose(): void;
}

export function gitTreeSnapshotter(worktreeDir: string): TreeSnapshotter {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'robot-progress-'));
  const objects = path.join(scratch, 'objects');
  // Git refuses to treat the clone as a repository at all when GIT_OBJECT_DIRECTORY does not exist.
  mkdirSync(path.join(objects, 'info'), { recursive: true });
  mkdirSync(path.join(objects, 'pack'), { recursive: true });
  const index = path.join(scratch, 'index');
  const gitDir = path.join(worktreeDir, '.git');
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, 'objects'),
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = async (args: string[]): Promise<string> =>
    (await run('git', [...asOwnerOf(worktreeDir), ...args], { env, maxBuffer: 32 * 1024 * 1024 })).stdout;
  return {
    async snapshot() {
      try {
        // Seed from the clone's index so only changed files are re-hashed.
        const live = path.join(gitDir, 'index');
        if (existsSync(live)) copyFileSync(live, index);
        await git(['add', '-A']);
        const tree = (await git(['write-tree'])).trim();
        return tree || null;
      } catch (err) {
        logger.warn({ err, dir: worktreeDir }, 'robot: progress snapshot failed — the no-change tripwire is skipped this window');
        return null;
      }
    },
    async diff(before, after) {
      try {
        return await git(['diff-tree', '-r', '-p', '--stat', before, after]);
      } catch (err) {
        logger.warn({ err, dir: worktreeDir }, 'robot: progress diff failed');
        return null;
      }
    },
    dispose() {
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

// ── The check ───────────────────────────────────────────────────────────────────────────────────

export interface ProgressCheckOutcome {
  /** Continue the run for one more window? Only a judge `progressing` (and no tripwire) says yes. */
  proceed: boolean;
  checkedBy: ProgressCheckSource;
  verdict: ProgressVerdict;
  reason: string;
  tripwire?: ProgressTripwire;
  /** Judge usage, when the judge ran. */
  judgeTurns: number;
  judgeTokens: number;
}

/** Turn a tripwire hit or a judge result into the outcome the loop acts on. Pure. */
export function outcomeFrom(hit: TripwireHit | null, judge: JudgeResult | null): ProgressCheckOutcome {
  if (hit) return { proceed: false, checkedBy: 'tripwire', verdict: 'stalled', reason: hit.detail, tripwire: hit.tripwire, judgeTurns: 0, judgeTokens: 0 };
  const j = judge ?? { verdict: 'error' as const, reason: 'the judge did not run', turns: 0, tokens: 0 };
  return { proceed: j.verdict === 'progressing', checkedBy: 'judge', verdict: j.verdict, reason: j.reason, judgeTurns: j.turns, judgeTokens: j.tokens };
}
