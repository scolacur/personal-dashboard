import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentWorkerConfig } from '../../shared/config';

/**
 * The Evaluator's session (PD-487, [[D-076]]).
 *
 * Read-only tools, grounded in the persistent read-only checkout — the same posture as the Audit
 * agent (D-045). The redundancy check is the reason `Grep`/`Glob` are essential rather than
 * convenient: "is there already a helper that does this?" is unanswerable from a diff alone, and an
 * Evaluator without search would either skip the check or guess at it.
 *
 * No `mcp__docs__fetch` (D-075) and no `Write`/`Edit`/`Bash`. It reviews what is in front of it; it
 * does not investigate the internet and it does not fix what it finds.
 */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

export interface EvaluatorTurnResult {
  /** The assistant's final text — a JSON report on success, error text otherwise. */
  text: string;
  /** False for an API-level failure (billing, rate limit, transport) as well as a refusal. */
  ok: boolean;
  turns?: number;
  tokens?: number;
}

/** Injectable so orchestration tests never spawn a real agent. */
export type RunEvaluatorTurn = (
  config: AgentWorkerConfig,
  systemPrompt: string,
  prompt: string,
) => Promise<EvaluatorTurnResult>;

/**
 * Run one evaluation pass. Turns and tokens are reported back so the caller can record them against
 * the Evaluator's OWN ledger (`evaluator_runs`) — never `agent_runs`, which would fold this spend
 * into the Robot loop's ceiling.
 */
export async function runEvaluatorTurn(
  config: AgentWorkerConfig,
  systemPrompt: string,
  prompt: string,
): Promise<EvaluatorTurnResult> {
  let result: EvaluatorTurnResult = { text: '', ok: false };

  for await (const message of query({
    prompt,
    options: {
      model: config.evaluator.model,
      cwd: config.checkoutDir,
      systemPrompt,
      allowedTools: READ_ONLY_TOOLS,
      // Headless: never prompt (it would hang), deny anything off-allowlist.
      permissionMode: 'dontAsk' as const,
    },
  }) as AsyncIterable<SDKMessage>) {
    if (message.type === 'result') {
      const ok = message.subtype === 'success' && !message.is_error;
      const usage = message as unknown as { num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number } };
      const tokens =
        usage.usage && (usage.usage.input_tokens || usage.usage.output_tokens)
          ? (usage.usage.input_tokens ?? 0) + (usage.usage.output_tokens ?? 0)
          : undefined;
      result = {
        text: message.subtype === 'success' ? message.result : (message.errors ?? []).join('; '),
        ok,
        ...(usage.num_turns !== undefined ? { turns: usage.num_turns } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
      };
    }
  }

  return result;
}
