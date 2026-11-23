/**
 * Live turn + token counting off an Agent SDK message stream (PD-909 / PD-910), for the Evaluator
 * and the Audit agent. Same rules as the Robot's in-session counter (PD-230, T-902, PD-898), which
 * predates this helper and keeps its own copy:
 *
 * - Only TOP-LEVEL assistant messages count. Sub-agent / tool-context messages carry a non-null
 *   `parent_tool_use_id` and are not turns of the main loop.
 * - Count DISTINCT `message.id`s. The SDK emits one assistant message per content block, several per
 *   turn sharing one id, and every one of them repeats that turn's `usage` — so both the turn count
 *   and the token sum advance once per id. A message with no id is counted as its own turn, so an
 *   SDK shape change degrades to over-counting rather than counting nothing.
 * - Tokens stay `undefined` until some message carries usage: unknown is reported as unknown, never 0.
 *
 * These are live APPROXIMATIONS; the caller overwrites them with the result message's authoritative
 * `num_turns` / `usage` when the run finishes.
 */

export interface LiveUsage {
  turns: number;
  tokens: number | undefined;
}

type AssistantLike = {
  type?: unknown;
  parent_tool_use_id?: unknown;
  message?: { id?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
};

/** A stateful counter: feed it every streamed message; it returns the new totals when a message
 *  starts a new turn, and null otherwise (so the caller writes once per turn). */
export function createLiveUsageCounter(): (message: unknown) => LiveUsage | null {
  const seen = new Set<string>();
  let turns = 0;
  let tokens: number | undefined;

  return (message) => {
    const m = message as AssistantLike;
    if (m.type !== 'assistant' || m.parent_tool_use_id != null) return null;
    const id = m.message?.id;
    if (typeof id === 'string') {
      if (seen.has(id)) return null;
      seen.add(id);
    }
    turns += 1;
    const usage = m.message?.usage;
    if (usage) {
      tokens =
        (tokens ?? 0) +
        (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) +
        (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0);
    }
    return { turns, tokens };
  };
}

/** Report progress without ever letting a reporting failure (a locked DB, a missing column on a
 *  not-yet-migrated table) reach the session that is doing the actual work. */
export function safeProgress(
  onProgress: ((turns: number, tokens?: number) => void) | undefined,
  usage: LiveUsage | null,
  onError: (err: unknown) => void,
): void {
  if (!onProgress || !usage) return;
  try {
    onProgress(usage.turns, usage.tokens);
  } catch (err) {
    onError(err);
  }
}
