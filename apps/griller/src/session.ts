import { query } from '@anthropic-ai/claude-agent-sdk';
import type { GrillerConfig } from './config';

/** Read-only built-in tools — the griller grounds against the checkout, never edits. */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

export interface GrillTurnInput {
  config: GrillerConfig;
  /** Compact, cached project-context prefix (glossary + building-block index). */
  contextPack: string;
  /** The human turn: the ticket body on the first turn, or a reply afterwards. */
  prompt: string;
  /** Resume a prior grill session (async follow-up); omit to start fresh. */
  resumeSessionId?: string;
}

export interface GrillTurnResult {
  text: string;
  sessionId: string | undefined;
}

function systemPrompt(contextPack: string): string {
  return [
    'You are the Refine agent for the Personal Dashboard board (see DECISIONS.md D-044).',
    'You work INTERACTIVELY with Steve to sharpen a Prioritized ticket BEFORE any Sortie worker',
    'is dispatched. Plan first: ask the right number of clarifying questions (err toward more),',
    'always do some up-front planning, and GROUND every claim in the real codebase — use your',
    'read-only Read/Grep/Glob tools against the checkout, and check whether a tool/widget already',
    'exists before proposing new work. You only read, plan, and propose; you never write or edit.',
    '',
    'Sizing guidance: a small change (a design tweak, a simple display component, few files, no',
    'decomposition) is instantly plannable; medium or vague tickets need follow-up questions;',
    'large features (many files, front-end AND back-end, or anything touching critical infra)',
    'warrant a full grill.',
    '',
    'Project context:',
    contextPack,
  ].join('\n');
}

/**
 * Run one grill turn via the Claude Agent SDK (D-044). Opus, grounded in the
 * read-only checkout (`cwd`), read-only tools only. Returns the assistant text plus
 * the session id so the caller can persist it and `resume` on the next async turn.
 */
export async function runGrillTurn(input: GrillTurnInput): Promise<GrillTurnResult> {
  let sessionId: string | undefined;
  let text = '';

  for await (const message of query({
    prompt: input.prompt,
    options: {
      model: input.config.model,
      cwd: input.config.checkoutDir,
      systemPrompt: systemPrompt(input.contextPack),
      allowedTools: READ_ONLY_TOOLS,
      // Headless: deny any tool outside the allowlist without prompting (would hang).
      permissionMode: 'dontAsk',
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    },
  })) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
    }
    if (message.type === 'result') {
      sessionId = message.session_id;
      if (message.subtype === 'success') text = message.result;
    }
  }

  return { text, sessionId };
}
