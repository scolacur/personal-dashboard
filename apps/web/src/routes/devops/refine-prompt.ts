import type { AgentTicket } from '@dashboard/shared';

/**
 * D-097: a body edit to a *refined* ticket must say whether it stays refined.
 *
 * This is the one place the "Mark this unrefined?" decision lives, shared by every surface that
 * edits a ticket body (the board's edit modal, and — once PD-396 ships it — the detail page's
 * description edit). Keeping it here, rather than re-deriving the condition at each call site, is
 * what makes the two surfaces behave identically and lets the logic be unit-tested without a DOM.
 *
 * The server refuses a body-changing PATCH on a refined ticket that omits `refined`
 * (409 `REFINED_CHOICE_REQUIRED`), so the UI must always resolve the choice before it saves.
 */

/**
 * Does saving `newBody` over `existing` need the prompt? True only when the ticket is currently
 * refined and the body actually changed. The comparison is byte-for-byte against `newBody` (the
 * value about to be PATCHed), mirroring the server guard — an identical body is not a change.
 */
export function needsUnrefinePrompt(
  existing: Pick<AgentTicket, 'refined' | 'body'>,
  newBody: string | null,
): boolean {
  return existing.refined && newBody !== (existing.body ?? null);
}

/**
 * Resolve the `refined` value to send with a body-changing PATCH, prompting when needed.
 *
 * Returns `undefined` when no prompt is warranted (a non-refined ticket, or an unchanged body) —
 * the caller then omits `refined` entirely and the body edit behaves exactly as before. Otherwise
 * it asks "Mark this unrefined?" and returns `false` (clear) when answered yes, `true` (keep) when
 * answered no.
 *
 * **Default is Yes** (mark unrefined): `ask` is `window.confirm` in the app, whose OK button is the
 * default and reads as "yes, mark it unrefined". A refined claim nobody re-read after a body change
 * is the stale claim D-091 exists to stop being dispatched, so the safe default is to drop it.
 *
 * `ask` is injected so the decision is testable without a browser.
 */
export function resolveUnrefineChoice(
  existing: Pick<AgentTicket, 'refined' | 'body'>,
  newBody: string | null,
  ask: (message: string) => boolean,
): boolean | undefined {
  if (!needsUnrefinePrompt(existing, newBody)) return undefined;
  const markUnrefined = ask('Mark this unrefined?');
  return !markUnrefined;
}
