import { CODER_AREAS, DEFAULT_CODER_AREA, effectiveCoderArea, type CoderArea } from '@dashboard/shared';

/**
 * Pure label logic for the Coder code-area subtypes (PD-880 / PD-955). Kept out of the Svelte
 * components so it can be unit-tested — apps/web has a vitest runner (`*.spec.ts`) but no DOM, and
 * packages/shared has no runner of its own.
 */

/**
 * The Coder's default nickname. PD-879 (the `agent_type_settings` nickname store) is NOT merged
 * yet, so there is nothing live to read; "Smith" is the documented default (the agent's *type* is
 * Coder, its default *nickname* Smith). When PD-879 lands, the live nickname replaces this
 * constant at the call sites — the shape "<nickname>-<area> #<runId>" does not change.
 */
export const DEFAULT_CODER_NICKNAME = 'Smith';

const AREA_LABEL = new Map<CoderArea, string>(CODER_AREAS.map((a) => [a.id, a.label]));

/** The human label for an area id (e.g. `board` → "Board"). Unknown ids fall back to the raw id. */
export function coderAreaLabel(area: CoderArea): string {
  return AREA_LABEL.get(area) ?? area;
}

/** What a ticket/Epic card needs to draw its area chip. */
export interface CoderAreaChip {
  /** The resolved area (never null — `effectiveCoderArea` falls back to `general`). */
  area: CoderArea;
  label: string;
  /** True when the area is inherited from the Epic rather than set on the ticket itself. An Epic is
   *  never "inherited" (it has no parent), and a ticket with its own override is not either. */
  inherited: boolean;
}

/**
 * The area chip for a ticket, given its Epic (or null/undefined for an Epic itself or an
 * Epic-less ticket). `inherited` is true only when the ticket has no own area but its Epic supplies
 * one — exactly the case the card marks "(from Epic)".
 */
export function coderAreaChip(
  ticket: { coderArea?: CoderArea | null; isEpic?: boolean },
  epic: { coderArea?: CoderArea | null } | null | undefined,
): CoderAreaChip {
  const area = effectiveCoderArea(ticket, epic ?? null);
  const inherited = !ticket.isEpic && ticket.coderArea == null && (epic?.coderArea ?? null) != null;
  return { area, label: coderAreaLabel(area), inherited };
}

/**
 * A running Coder's display name — `"Smith-board #212"` (PD-955). The area is the raw id (not the
 * label), the number is the `agent_runs` id, and the nickname defaults to {@link DEFAULT_CODER_NICKNAME}.
 * A null/undefined area resolves to the `general` fallback, so the name is always well-formed.
 */
export function coderAgentName(
  area: CoderArea | null | undefined,
  runId: number,
  nickname: string = DEFAULT_CODER_NICKNAME,
): string {
  return `${nickname}-${area ?? DEFAULT_CODER_AREA} #${runId}`;
}
