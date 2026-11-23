import type { ActiveAgent, ActiveAgentKind } from '@dashboard/shared';

/**
 * Pure view logic for the Agent Dashboard's fleet view (PD-818 / PD-819). Kept out of the Svelte
 * components because apps/web has no DOM test runner — this is the part that can be tested.
 */

/**
 * PD-819: the avatar toggle. Two modes, chosen by Steve from the Line / Ripple comparison:
 *   robot — single-stroke robot faces: the Line face for Robots and Auditors, the TV set for
 *           Evaluators (each still carrying its kind accessory: magnifier / green visor)
 *   orbit — a solid kind shape (square / circle / diamond) with three dots circling it
 * Remembered per browser (localStorage), defaulting to Robot.
 */
export const AVATAR_MODES = ['robot', 'orbit'] as const;
export type AvatarMode = (typeof AVATAR_MODES)[number];
export const DEFAULT_AVATAR_MODE: AvatarMode = 'robot';
export const AVATAR_MODE_LABELS: Record<AvatarMode, string> = { robot: 'Robot', orbit: 'Orbit' };
export const AVATAR_MODE_STORAGE_KEY = 'agent-dashboard.avatar-mode';

/** The drawings behind the modes. `line` and `tv` are LineAvatar faces; `orbit` is OrbitAvatar. */
export type AvatarStyle = 'line' | 'tv' | 'orbit';

/** Which drawing a kind gets in a mode. */
export function avatarStyleFor(mode: AvatarMode, kind: ActiveAgentKind): AvatarStyle {
  if (mode === 'orbit') return 'orbit';
  return kind === 'evaluator' ? 'tv' : 'line';
}

/** A stored mode, or the default for anything missing or unrecognised (an old/hand-edited value). */
export function parseAvatarMode(stored: string | null): AvatarMode {
  return (AVATAR_MODES as readonly string[]).includes(stored ?? '') ? (stored as AvatarMode) : DEFAULT_AVATAR_MODE;
}

/** Column order on the page. Fixed so columns don't reshuffle between polls. */
export const KIND_ORDER: ActiveAgentKind[] = ['robot', 'evaluator', 'auditor'];

export const KIND_LABELS: Record<ActiveAgentKind, { group: string; one: string; blurb: string }> = {
  robot: { group: 'Robots', one: 'Robot', blurb: 'writing code' },
  evaluator: { group: 'Evaluators', one: 'Evaluator', blurb: 'reviewing a PR' },
  auditor: { group: 'Auditors', one: 'Auditor', blurb: 'auditing the board' },
};

export interface AgentGroup {
  kind: ActiveAgentKind;
  agents: ActiveAgent[];
}

/** One column per kind in KIND_ORDER — always all of them, so the layout doesn't jump when a kind
 *  starts or stops — oldest run first within a column. */
export function groupByKind(agents: readonly ActiveAgent[]): AgentGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    agents: agents.filter((a) => a.kind === kind).sort((a, b) => a.startedAt - b.startedAt),
  }));
}

/** "850", "34.2k", "128k", "1.2M"; "—" when unknown (never 0 — unknown is not none). */
export function formatTokens(n: number | null): string {
  if (n === null) return '—';
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "12/50" against a ceiling, "12" without one, "—" when unknown. */
export function formatTurns(turns: number | null, maxTurns: number | null): string {
  if (turns === null) return '—';
  return maxTurns ? `${turns}/${maxTurns}` : String(turns);
}

/** True once a run is within the last fifth of its turn ceiling — mirrors the board's PD-230 warn. */
export function nearTurnCap(turns: number | null, maxTurns: number | null): boolean {
  return turns !== null && !!maxTurns && turns / maxTurns >= 0.8;
}

/** "claude-opus-5-5" → "Opus 5.5". Anything unrecognised is shown verbatim; null → "—". */
export function formatModel(model: string | null): string {
  if (!model) return '—';
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return model;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}

/** "45s", "12m", "1h 05m" since `startedAt`. */
export function formatElapsed(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Steel grey for an agent with no project (an Audit) or a project with no colour. */
export const DEFAULT_BOT_COLOR = '#7a8794';

/** The robot's body / tile tint: the project's colour when it is a usable hex, else the default. */
export function botColor(agent: Pick<ActiveAgent, 'project'>): string {
  const c = agent.project?.color;
  return c && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c) ? c : DEFAULT_BOT_COLOR;
}

/** A stable identity for a tile across polls, so keyed `{#each}` doesn't remount live tiles. */
export function agentKey(a: Pick<ActiveAgent, 'kind' | 'runId'>): string {
  return `${a.kind}:${a.runId}`;
}
