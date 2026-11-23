import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentWorkerConfig } from '../../shared/config';
import { createLiveUsageCounter, safeProgress } from '../../shared/live-usage';
import { logger } from '../../shared/logger';

/** Read-only tools — the audit agent grounds against the checkout, never edits (D-045). */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

export interface AuditTurnResult {
  /** The assistant's final text (a JSON findings block on success), or error text. */
  text: string;
  /** True only for a clean result — API errors (billing, rate limit) come back false. */
  ok: boolean;
  /** PD-910: authoritative totals off the result message, when it carries them. */
  turns?: number;
  tokens?: number;
}

/** PD-910: live progress — the turn count and running token total, once per new turn. */
export type AuditProgress = (turns: number, tokens?: number) => void;

/**
 * Run ONE audit pass via a fresh Agent SDK query (mirrors the refine job's runRefineTurn):
 * Opus by default, grounded in the read-only checkout, read-only tools, no prompting. The
 * caller supplies the system prompt (methodology) and the user prompt (the ticket list).
 */
export async function runAuditTurn(
  config: AgentWorkerConfig,
  systemPrompt: string,
  prompt: string,
  onProgress?: AuditProgress,
): Promise<AuditTurnResult> {
  let result: AuditTurnResult = { text: '', ok: false };
  const countTurn = createLiveUsageCounter();

  for await (const message of query({
    prompt,
    options: {
      model: config.model,
      cwd: config.checkoutDir,
      systemPrompt,
      allowedTools: READ_ONLY_TOOLS,
      // Headless: deny anything off-allowlist without prompting (would hang).
      permissionMode: 'dontAsk' as const,
    },
  }) as AsyncIterable<SDKMessage>) {
    // PD-910: live turns/tokens for the Agent Dashboard tile. Never interrupts the audit.
    safeProgress(onProgress, countTurn(message), (err) => logger.warn({ err }, 'audit: progress report failed'));
    if (message.type === 'result') {
      const ok = message.subtype === 'success' && !message.is_error;
      const r = message as unknown as { num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number } };
      result = {
        text: message.subtype === 'success' ? message.result : (message.errors ?? []).join('; '),
        ok,
        ...(typeof r.num_turns === 'number' ? { turns: r.num_turns } : {}),
        ...(r.usage ? { tokens: (r.usage.input_tokens ?? 0) + (r.usage.output_tokens ?? 0) } : {}),
      };
    }
  }

  return result;
}
