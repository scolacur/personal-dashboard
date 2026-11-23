import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ROBOT_EVENT, type RobotEventDetail } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { parsePrUrl } from './pr-state';
import { ensureRobotStateTable, readStateString, writeState } from './state';

const run = promisify(execFile);

/**
 * The live loop-status block on a Robot PR (PD-901). When a Robot PR is open, GitHub otherwise shows
 * almost nothing about where its ticket is in the loop — the required checks and the visual-pass
 * comments, but not which Evaluator round it is on, what each lens said, or whether it is waiting on
 * Steve. All of that already exists as Robot milestones on the ticket timeline (`agent_ticket_events`,
 * written by `logMilestone`). This module RENDERS those events into one markdown block and keeps it
 * at the top of the PR description, rewritten in place between two HTML-comment markers.
 *
 * Two halves, deliberately split:
 *  - a PURE renderer (`renderStatusBlock`, `upsertStatusBlock`): events[] → markdown, and
 *    body + block → body. Derived from the timeline every time, never accumulated, so it cannot drift.
 *  - an updater (`runPrStatusUpdate`) that runs inside the existing loop tick. It is NOT in
 *    `logMilestone`, which must stay a cheap, best-effort DB write; and it is best-effort itself — a
 *    GitHub failure is logged and retried next tick, and never affects dispatch.
 */

export const STATUS_START = '<!-- robot:status:start -->';
export const STATUS_END = '<!-- robot:status:end -->';

/** One timeline event, in the shape the renderer consumes (detail already parsed). */
export interface StatusEvent {
  type: string;
  detail: RobotEventDetail;
  createdAt: number;
}

export interface StatusRenderInput {
  ticketId: number;
  displayId: string | null;
  title: string;
  /** The board detail page for this ticket, or null when no `DASHBOARD_PUBLIC_URL` is set. */
  ticketUrl: string | null;
  /** The ticket's robot_* events, ascending by time, from its first dispatch onward. */
  events: StatusEvent[];
  now: number;
}

const LENS_ORDER = ['code', 'security'] as const;
type Lens = (typeof LENS_ORDER)[number];

type LensState = {
  /** 'reviewing' while a pass is open; otherwise the recorded verdict. */
  status: 'reviewing' | 'ship' | 'revise' | 'escalate' | string;
  findings: number;
  blockingFindings: number;
  reason: string;
};

type Round = Map<Lens, LensState>;

/** The first non-empty line of a possibly-multiline string, trimmed and length-capped for a one-liner. */
export function firstLine(s: string | undefined, max = 140): string {
  if (!s) return '';
  const line = s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `2026-11-23 14:05 UTC` — a stable, timezone-fixed stamp so renders are deterministic to test. */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

function lensOf(detail: RobotEventDetail): Lens {
  return detail.lens === 'security' ? 'security' : 'code';
}

/** Fold the Evaluator events into a round → lens → state map. Chronological order matters: a later
 *  `robot_evaluated` overwrites the `reviewing` an earlier `robot_evaluating` set for the same cell. */
function buildRounds(events: StatusEvent[]): Map<number, Round> {
  const rounds = new Map<number, Round>();
  const cell = (round: number): Round => {
    let r = rounds.get(round);
    if (!r) rounds.set(round, (r = new Map()));
    return r;
  };
  for (const e of events) {
    if (e.type !== ROBOT_EVENT.evaluating && e.type !== ROBOT_EVENT.evaluated) continue;
    const round = e.detail.round ?? 1;
    const lens = lensOf(e.detail);
    const r = cell(round);
    if (e.type === ROBOT_EVENT.evaluating) {
      r.set(lens, { status: 'reviewing', findings: 0, blockingFindings: 0, reason: '' });
    } else {
      r.set(lens, {
        status: e.detail.verdict ?? 'unknown',
        findings: e.detail.findings ?? 0,
        blockingFindings: e.detail.blockingFindings ?? 0,
        reason: firstLine(e.detail.reason),
      });
    }
  }
  return rounds;
}

/** Which lenses appear anywhere — so the table shows a `security` column only when there is one. */
function lensesPresent(rounds: Map<number, Round>): Lens[] {
  const present = new Set<Lens>();
  for (const r of rounds.values()) for (const lens of r.keys()) present.add(lens);
  return LENS_ORDER.filter((l) => present.has(l));
}

const GLYPH: Record<string, string> = { ship: '✓ ship', revise: '✗ revise', escalate: '⚠ escalate', reviewing: '… reviewing' };

function lensPhrase(s: LensState): string {
  return GLYPH[s.status] ?? s.status;
}

/** The current-state one-liner from the aggregated rounds, used when the latest event is an
 *  Evaluator pass (a round in flight, or one that just produced verdicts). */
function evaluatorStateLine(rounds: Map<number, Round>): string {
  const current = Math.max(...rounds.keys());
  const r = rounds.get(current)!;
  const lenses = LENS_ORDER.filter((l) => r.has(l));
  const states = lenses.map((l) => r.get(l)!);
  if (states.some((s) => s.status === 'reviewing')) {
    const parts = lenses.map((l) => `${l} ${lensPhrase(r.get(l)!)}`);
    return `Evaluator reviewing — round ${current} (${parts.join(', ')})`;
  }
  if (states.every((s) => s.status === 'ship')) {
    if (lenses.length === 2) return 'Ready to merge: both lenses ship';
    if (lenses.length === 1) return `Ready to merge: ${lenses[0]} shipped`;
    return `Ready to merge: all ${lenses.length} lenses ship`;
  }
  if (states.some((s) => s.status === 'revise')) return `Reworking: Evaluator asked for changes (round ${current})`;
  if (states.some((s) => s.status === 'escalate')) return `Waiting on Steve: Evaluator escalated (round ${current})`;
  return `Evaluator review — round ${current}`;
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The latest hand-off time (0 if none) — tells a working phase apart as a rework. */
function lastHandoffAt(events: StatusEvent[]): number {
  let t = 0;
  for (const e of events) if (e.type === ROBOT_EVENT.handoff && e.createdAt > t) t = e.createdAt;
  return t;
}

function latestOf(events: StatusEvent[], type: string): StatusEvent | undefined {
  let found: StatusEvent | undefined;
  for (const e of events) if (e.type === type) found = e;
  return found;
}

export interface CurrentState {
  line: string;
  at: number;
  done: boolean;
}

/**
 * The current-state line + its timestamp, derived by walking events newest-first and returning the
 * first one that defines a state. Evaluator passes are the one exception: they aggregate (round +
 * per-lens), so when the newest state-defining event is an Evaluator pass the line comes from
 * `evaluatorStateLine`, not that single event.
 */
export function currentState(input: StatusRenderInput): CurrentState {
  const { events } = input;
  const rounds = buildRounds(events);
  const handoffAt = lastHandoffAt(events);
  const lastReact = latestOf(events, ROBOT_EVENT.reactivated);

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const d = e.detail;
    switch (e.type) {
      case ROBOT_EVENT.completed:
        return { line: 'Merged ✓', at: e.createdAt, done: true };
      case ROBOT_EVENT.prClosed:
        return { line: 'PR closed unmerged — waiting on Steve', at: e.createdAt, done: true };
      case ROBOT_EVENT.askHuman:
        return { line: `Waiting on Steve: ${firstLine(d.question) || 'a question'}`, at: e.createdAt, done: false };
      case ROBOT_EVENT.parked:
        return { line: `Parked${d.reason ? `: ${firstLine(d.reason)}` : ''} — waiting on Steve`, at: e.createdAt, done: false };
      case ROBOT_EVENT.fault:
        return { line: `Run failed${d.reason ? `: ${firstLine(d.reason)}` : ''} — the loop will retry`, at: e.createdAt, done: false };
      case ROBOT_EVENT.visualReviewRequested:
        return { line: "Waiting on Steve's visual check", at: e.createdAt, done: false };
      case ROBOT_EVENT.visualReviewed:
        return d.approved
          ? { line: 'Visual check approved by Steve', at: e.createdAt, done: false }
          : { line: 'Reworking: visual check needs changes', at: e.createdAt, done: false };
      case ROBOT_EVENT.evaluated:
      case ROBOT_EVENT.evaluating:
        return { line: evaluatorStateLine(rounds), at: e.createdAt, done: false };
      case ROBOT_EVENT.conflictResolved:
        return { line: 'Merge conflict resolved — awaiting re-review', at: e.createdAt, done: false };
      case ROBOT_EVENT.reactivated:
        return { line: `Reworking: ${firstLine(d.reason) || 'PR feedback'}`, at: e.createdAt, done: false };
      case ROBOT_EVENT.resumed:
        return { line: 'Working — resuming after your reply', at: e.createdAt, done: false };
      case ROBOT_EVENT.handoff:
        return { line: 'Handed off — awaiting Evaluator review', at: e.createdAt, done: false };
      case ROBOT_EVENT.dispatched:
        if (lastReact && lastReact.createdAt > handoffAt) {
          return { line: `Reworking: ${firstLine(lastReact.detail.reason) || 'PR feedback'}`, at: e.createdAt, done: false };
        }
        return { line: 'Working — Robot implementing', at: e.createdAt, done: false };
      default:
        continue;
    }
  }
  return { line: 'Dispatched', at: events[events.length - 1]?.createdAt ?? input.now, done: false };
}

/** The Evaluator table markdown (null when no evaluation has happened yet). */
function evaluatorTable(rounds: Map<number, Round>): string[] {
  if (rounds.size === 0) return [];
  const lenses = lensesPresent(rounds);
  const header = ['Round', ...lenses, 'Notes'];
  const lines = ['#### Evaluator', `| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const round of [...rounds.keys()].sort((a, b) => a - b)) {
    const r = rounds.get(round)!;
    const cells = lenses.map((l) => {
      const s = r.get(l);
      if (!s) return '—';
      if (s.status === 'reviewing') return '… reviewing';
      return `${lensPhrase(s)} (${s.blockingFindings}/${s.findings})`;
    });
    // One Notes cell: prefer a blocking lens's reason, else the first reason present.
    const reasons = lenses.map((l) => r.get(l)).filter((s): s is LensState => !!s);
    const blocking = reasons.find((s) => s.status === 'revise' || s.status === 'escalate');
    const note = (blocking ?? reasons.find((s) => s.reason))?.reason ?? '';
    lines.push(`| ${round} | ${cells.join(' | ')} | ${note.replace(/\|/g, '\\|') || '—'} |`);
  }
  return lines;
}

/** Human-readable history line for one event, or null to drop it from the history list. */
function historyLine(e: StatusEvent): string | null {
  const d = e.detail;
  const at = fmtTime(e.createdAt);
  const say = (text: string): string => `- ${at} — ${text}`;
  switch (e.type) {
    case ROBOT_EVENT.dispatched:
      return say('Dispatched');
    case ROBOT_EVENT.handoff:
      return say('Handed off for review');
    case ROBOT_EVENT.reactivated:
      return say(`Re-queued for rework${d.reason ? ` — ${firstLine(d.reason)}` : ''}`);
    case ROBOT_EVENT.parked:
      return say(`Parked${d.reason ? ` — ${firstLine(d.reason)}` : ''}`);
    case ROBOT_EVENT.fault:
      return say(`Run failed${d.reason ? ` — ${firstLine(d.reason)}` : ''}`);
    case ROBOT_EVENT.askHuman:
      return say(`Asked Steve — ${firstLine(d.question) || 'a question'}`);
    case ROBOT_EVENT.humanReply:
      return say('Steve replied');
    case ROBOT_EVENT.resumed:
      return say('Resumed after reply');
    case ROBOT_EVENT.conflictResolved:
      return say('Merge conflict resolved');
    case ROBOT_EVENT.visualReviewRequested:
      return say('Visual check requested');
    case ROBOT_EVENT.visualReviewed:
      return say(`Visual check ${d.approved ? 'approved' : 'changes requested'}`);
    case ROBOT_EVENT.stalled:
      return say('Run stalled — reclaimed');
    case ROBOT_EVENT.completed:
      return say('PR merged');
    case ROBOT_EVENT.prClosed:
      return say('PR closed unmerged');
    default:
      return null;
  }
}

const HISTORY_CAP = 10;

/** Render the full status block (markers included). Pure — the single source of the block's text. */
export function renderStatusBlock(input: StatusRenderInput): string {
  const state = currentState(input);
  const rounds = buildRounds(input.events);
  const idLabel = input.displayId ?? `#${input.ticketId}`;
  const titleLine = input.ticketUrl ? `[${idLabel} — ${input.title}](${input.ticketUrl})` : `${idLabel} — ${input.title}`;

  const lines = [STATUS_START, '### 🤖 Loop status', '', `**${capitalize(state.line)}** · ${fmtTime(state.at)}`, '', titleLine];

  const table = evaluatorTable(rounds);
  if (table.length) lines.push('', ...table);

  const history = input.events
    .map(historyLine)
    .filter((l): l is string => l !== null)
    .slice(-HISTORY_CAP);
  if (history.length) lines.push('', '#### History', ...history);

  lines.push('', STATUS_END);
  return lines.join('\n');
}

/**
 * Put `block` into `body`: replace what is between the markers if they are present, otherwise insert
 * the block at the very top. Only ever touches the marked span — everything else in the body is left
 * exactly as it was. Pure.
 */
export function upsertStatusBlock(body: string, block: string): string {
  const text = body ?? '';
  const start = text.indexOf(STATUS_START);
  const end = text.indexOf(STATUS_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = text.slice(0, start);
    const after = text.slice(end + STATUS_END.length);
    return `${before}${block}${after}`;
  }
  return text.trim() === '' ? block : `${block}\n\n${text}`;
}

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

// ── The updater ────────────────────────────────────────────────────────────────

interface StatusTarget {
  ticketId: number;
  displayId: string | null;
  title: string;
  repo: string;
  prNumber: number;
}

/**
 * Robot-assigned, non-terminal tickets paired with the PR of their newest handed-off run. Found the
 * same way `inReviewPrTargets`/the visual pass find a PR (the run's `pr_url`) but WITHOUT the
 * `in-review` filter, so a parked or reworking ticket keeps updating its PR.
 */
export function robotPrStatusTargets(db: Database.Database): StatusTarget[] {
  const rows = db
    .prepare(
      `SELECT t.id AS ticket_id, t.display_id, t.title, r.pr_url AS pr_url
         FROM agent_tickets t
         JOIN agent_runs r ON r.id = (
           SELECT id FROM agent_runs
            WHERE ticket_id = t.id AND status = 'handed-off' AND pr_url IS NOT NULL
            ORDER BY finished_at DESC, id DESC LIMIT 1
         )
        WHERE t.archived_at IS NULL AND t.assignee = 'robot'
          AND t.status NOT IN ('completed', 'closed')`,
    )
    .all() as { ticket_id: number; display_id: string | null; title: string | null; pr_url: string | null }[];
  const targets: StatusTarget[] = [];
  for (const row of rows) {
    const parsed = parsePrUrl(row.pr_url);
    if (parsed) targets.push({ ticketId: row.ticket_id, displayId: row.display_id, title: row.title ?? '', repo: parsed.repo, prNumber: parsed.prNumber });
  }
  return targets;
}

/** The ticket's robot_* events from its first dispatch onward, ascending by time (detail parsed). */
export function readRobotEvents(db: Database.Database, ticketId: number): StatusEvent[] {
  let rows: { type: string; detail: string | null; created_at: number }[];
  try {
    rows = db
      .prepare(
        "SELECT type, detail, created_at FROM agent_ticket_events WHERE ticket_id = ? AND type LIKE 'robot\\_%' ESCAPE '\\' ORDER BY created_at ASC, id ASC",
      )
      .all(ticketId) as typeof rows;
  } catch {
    return [];
  }
  const events: StatusEvent[] = rows.map((r) => {
    let detail: RobotEventDetail = {};
    try {
      detail = r.detail ? (JSON.parse(r.detail) as RobotEventDetail) : {};
    } catch {
      detail = {};
    }
    return { type: r.type, detail, createdAt: r.created_at };
  });
  const firstDispatch = events.findIndex((e) => e.type === ROBOT_EVENT.dispatched);
  return firstDispatch <= 0 ? events : events.slice(firstDispatch);
}

/** The board detail page for a ticket, using the same base the visual comment uses. */
export function boardUrl(config: AgentWorkerConfig, displayId: string | null): string | null {
  const base = config.visual.publicUrl;
  if (!base || !displayId) return null;
  return `${base.replace(/\/+$/, '')}/devops/tickets/${encodeURIComponent(displayId)}`;
}

export type BodyReader = (repo: string, prNumber: number) => Promise<string | null>;
export type BodyWriter = (repo: string, prNumber: number, body: string) => Promise<boolean>;

export interface PrStatusDeps {
  readBody?: BodyReader;
  writeBody?: BodyWriter;
}

function ghEnv(config: AgentWorkerConfig, token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
    ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
  };
}

function defaultReadBody(config: AgentWorkerConfig): BodyReader {
  return async (repo, prNumber) => {
    try {
      const { stdout } = await run('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body'], {
        env: ghEnv(config, config.githubReadToken),
      });
      return (JSON.parse(stdout) as { body?: string }).body ?? '';
    } catch (err) {
      logger.warn({ err, prNumber }, 'robot: PR body read failed (status block retried next tick)');
      return null;
    }
  };
}

function defaultWriteBody(config: AgentWorkerConfig): BodyWriter {
  return async (repo, prNumber, body) => {
    if (!config.robot.writeToken) return false;
    try {
      await run('gh', ['pr', 'edit', String(prNumber), '--repo', repo, '--body', body], {
        env: ghEnv(config, config.robot.writeToken),
      });
      return true;
    } catch (err) {
      logger.warn({ err, prNumber }, 'robot: PR body edit failed (status block retried next tick)');
      return false;
    }
  };
}

const HASH_KEY = (ticketId: number): string => `pr_status_hash:${ticketId}`;

/**
 * Re-render the status block for every open Robot PR and write it back when it changed (PD-901).
 * Best-effort: a GitHub failure is logged and retried on the next tick, and it never touches dispatch.
 *
 * The last-rendered hash in `robot_state` is the cheap gate — when the rendered block matches what we
 * last wrote for this ticket, there is nothing to do and no GitHub call is made. A rework that adds
 * events (a new dispatch + hand-off) changes the render, so a body a rework rewrote gets the block
 * re-inserted on the next tick. Returns the number of PRs whose body was edited.
 */
export async function runPrStatusUpdate(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number = Date.now(),
  deps: PrStatusDeps = {},
): Promise<number> {
  ensureRobotStateTable(db);
  const readBody = deps.readBody ?? defaultReadBody(config);
  const writeBody = deps.writeBody ?? defaultWriteBody(config);
  let edited = 0;

  let targets: StatusTarget[];
  try {
    targets = robotPrStatusTargets(db);
  } catch (err) {
    logger.warn({ err }, 'robot: PR-status targets query failed (status blocks retried next tick)');
    return 0;
  }

  for (const target of targets) {
    if (target.repo !== config.githubRepo) continue;
    const events = readRobotEvents(db, target.ticketId);
    if (events.length === 0) continue;

    const block = renderStatusBlock({
      ticketId: target.ticketId,
      displayId: target.displayId,
      title: target.title,
      ticketUrl: boardUrl(config, target.displayId),
      events,
      now,
    });
    const hash = sha1(block);
    const key = HASH_KEY(target.ticketId);
    if (readStateString(db, key) === hash) continue; // nothing new since the last render

    const body = await readBody(target.repo, target.prNumber);
    if (body === null) continue; // GitHub read failed — retry next tick, don't advance the hash

    const next = upsertStatusBlock(body, block);
    if (next !== body) {
      if (!(await writeBody(target.repo, target.prNumber, next))) continue; // write failed — retry next tick
      edited++;
    }
    // Reconciled (edited, or the body already carried this exact block) — remember the hash so an
    // unchanged timeline makes no further GitHub calls.
    writeState(db, key, hash, now);
  }
  return edited;
}
