import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentWorkerConfig } from '../../shared/config';

/** Read-only tools — the audit agent grounds against the checkout, never edits (D-045). */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

export interface AuditTurnResult {
  /** The assistant's final text (a JSON findings block on success), or error text. */
  text: string;
  /** True only for a clean result — API errors (billing, rate limit) come back false. */
  ok: boolean;
}

/**
 * Run ONE audit pass via a fresh Agent SDK query (mirrors the refine job's runRefineTurn):
 * Opus by default, grounded in the read-only checkout, read-only tools, no prompting. The
 * caller supplies the system prompt (methodology) and the user prompt (the ticket list).
 */
export async function runAuditTurn(
  config: AgentWorkerConfig,
  systemPrompt: string,
  prompt: string,
): Promise<AuditTurnResult> {
  let result: AuditTurnResult = { text: '', ok: false };

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
    if (message.type === 'result') {
      const ok = message.subtype === 'success' && !message.is_error;
      result = {
        text: message.subtype === 'success' ? message.result : (message.errors ?? []).join('; '),
        ok,
      };
    }
  }

  return result;
}
