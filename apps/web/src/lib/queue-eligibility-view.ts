// View model for the auto-queue eligibility checklist (D-103, PD-809).
//
// The checklist is rendered on every ticket and Epic detail page, and reused by the board's criteria
// modal. All the derivation that the component would otherwise do in-markup lives here as one pure
// function, so every verdict, every row and every muted-mode note is reachable from a plain vitest
// spec (apps/web has no DOM test runner). The verdict taxonomy and wording come from
// `@dashboard/shared`, so this and the predicate can never drift.

import type {
  AgentTicket,
  AutoQueueCapacity,
  AutoQueueCriterion,
  AutoQueueEligibility,
  AutoQueueEpicEligibility,
  AutoQueueMode,
  AutoQueueVerdict,
  TicketAssignee,
} from '@dashboard/shared';
import {
  AUTO_QUEUE_VERDICT_SHORT,
  autoQueueEpicVerdictLine,
  autoQueueMemberRollup,
  autoQueueModeNote,
  autoQueueVerdictLine,
} from '@dashboard/shared';

export interface CriterionRow {
  id: string;
  met: boolean;
  mark: '✓' | '✗';
  label: string;
  /** Present only when unmet. */
  reason?: string;
  /** Present when unmet and the remedy resolves to a page (the Epic or the blocker). */
  href?: string;
}

export interface CapacityRow {
  id: string;
  met: boolean;
  mark: '✓' | '✗';
  label: string;
  reason?: string;
}

export interface MemberRow {
  ticketId: number;
  mark: '✓' | '✗' | '–';
  displayId: string | null;
  title: string;
  verdictShort: string;
  href?: string;
}

export interface ChecklistView {
  isEpic: boolean;
  verdictLine: string;
  /** Suffix for a `verdict-*` style hook, e.g. `eligible`, `not-eligible`. */
  verdictTone: AutoQueueVerdict;
  modeNote: string | null;
  criteria: CriterionRow[];
  showCapacity: boolean;
  capacity: CapacityRow[];
  /** Present on an Epic: `4 of 7 members eligible`. */
  rollup?: string;
  /** Present on an Epic: one row per member, in board order. */
  members?: MemberRow[];
}

function mark(met: boolean): '✓' | '✗' {
  return met ? '✓' : '✗';
}

function criterionRow(c: AutoQueueCriterion, href: (ticketId: number) => string | null): CriterionRow {
  const link = !c.met && c.remedy?.ticketId != null ? href(c.remedy.ticketId) : null;
  return {
    id: c.id,
    met: c.met,
    mark: mark(c.met),
    label: c.label,
    ...(c.met ? {} : { reason: c.reason }),
    ...(link ? { href: link } : {}),
  };
}

function capacityRows(capacity: AutoQueueCapacity): CapacityRow[] {
  return capacity.rows.map((r) => ({
    id: r.id,
    met: r.met,
    mark: mark(r.met),
    // The count limbs read "Queue depth 1 / 2"; the composite health limb has no meaningful count.
    label: r.id === 'worker-healthy' ? r.label : `${r.label} ${r.current} / ${r.limit}`,
    ...(r.met ? {} : { reason: r.reason }),
  }));
}

/** The mark for a member's roll-up row: a tick once it has made it into the Queue, a cross when it
 *  is a robot ticket that is not yet eligible, and a neutral dash for work the promoter never touches
 *  (terminal or human-assigned). */
function memberMark(verdict: AutoQueueVerdict): '✓' | '✗' | '–' {
  if (verdict === 'eligible' || verdict === 'in-queue') return '✓';
  if (verdict === 'not-eligible') return '✗';
  return '–';
}

export function buildChecklistView(input: {
  isEpic: boolean;
  assignee: TicketAssignee | null;
  mode: AutoQueueMode;
  eligibility?: AutoQueueEligibility;
  epicEligibility?: AutoQueueEpicEligibility;
  capacity: AutoQueueCapacity;
  /** The Epic's member Tickets (empty for a member Ticket), to label and link the roll-up rows. */
  members?: readonly AgentTicket[];
  /** Resolve a ticket id to its detail-page href, or null when it should not link (e.g. self). */
  ticketHref: (ticketId: number) => string | null;
}): ChecklistView {
  const { isEpic, assignee, mode, eligibility, epicEligibility, capacity, members, ticketHref } = input;
  const modeNote = autoQueueModeNote(mode);

  if (isEpic && epicEligibility) {
    const criteria = epicEligibility.criteria.map((c) => criterionRow(c, ticketHref));
    const allMet = epicEligibility.criteria.every((c) => c.met);
    const { eligible, total } = autoQueueMemberRollup(epicEligibility.members);
    const byId = new Map((members ?? []).map((m) => [m.id, m] as const));
    const memberRows: MemberRow[] = epicEligibility.members.map((mv) => {
      const t = byId.get(mv.ticketId);
      const href = ticketHref(mv.ticketId);
      return {
        ticketId: mv.ticketId,
        mark: memberMark(mv.verdict),
        displayId: t?.displayId ?? null,
        title: t?.title ?? `#${mv.ticketId}`,
        verdictShort: AUTO_QUEUE_VERDICT_SHORT[mv.verdict],
        ...(href ? { href } : {}),
      };
    });
    return {
      isEpic: true,
      verdictLine: autoQueueEpicVerdictLine(epicEligibility),
      verdictTone: allMet ? 'eligible' : 'not-eligible',
      modeNote,
      criteria,
      showCapacity: true,
      capacity: capacityRows(capacity),
      rollup: `${eligible} of ${total} member${total === 1 ? '' : 's'} eligible`,
      members: memberRows,
    };
  }

  // A member Ticket (or an Epic with no eligibility payload — defensive).
  const elig = eligibility ?? { verdict: 'not-eligible' as AutoQueueVerdict, criteria: [] };
  const unmet = elig.criteria.filter((c) => !c.met).length;
  // Capacity gates promotion only when the ticket is actually a candidate; it is moot for queued,
  // terminal and human work, where the example layout omits it.
  const showCapacity = elig.verdict === 'eligible' || elig.verdict === 'not-eligible';
  return {
    isEpic: false,
    verdictLine: autoQueueVerdictLine(elig.verdict, assignee, unmet),
    verdictTone: elig.verdict,
    modeNote,
    criteria: elig.criteria.map((c) => criterionRow(c, ticketHref)),
    showCapacity,
    capacity: showCapacity ? capacityRows(capacity) : [],
  };
}
