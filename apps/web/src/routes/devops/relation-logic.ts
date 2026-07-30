import type {
  RelationOrigin,
  RelationType,
  ResolvedRelation,
  TicketRelation,
  TicketStatus,
} from '@dashboard/shared';

/** A blocker stops gating once it's "done or gone" (D-051). Archived tickets never appear in the
 *  board's ticket list, so an unknown id is treated as resolved. */
const RESOLVED_STATUSES = new Set<TicketStatus>(['completed', 'closed']);

export function isResolvedStatus(status: TicketStatus | undefined): boolean {
  return status === undefined || RESOLVED_STATUSES.has(status);
}

/** The five "Mark as →" kebab actions (D-051). `build` maps the source ticket + the picked ticket
 *  to the relation's directed endpoints: for `blocks`, `from` is the blocker and `to` the blocked. */
export interface RelationAction {
  key: string;
  label: string;
  type: RelationType;
  /** Given the card's ticket id and the picked ticket id, the directed (from, to) pair. */
  build: (sourceId: number, pickedId: number) => { fromId: number; toId: number };
  /** Prompt shown in the picker's search field. */
  pickerTitle: string;
}

export const RELATION_ACTIONS: RelationAction[] = [
  {
    key: 'blocked-by',
    label: 'Blocked by…',
    type: 'blocks',
    build: (sourceId, pickedId) => ({ fromId: pickedId, toId: sourceId }),
    pickerTitle: 'Blocked by which ticket?',
  },
  {
    key: 'blocking',
    label: 'Blocking…',
    type: 'blocks',
    build: (sourceId, pickedId) => ({ fromId: sourceId, toId: pickedId }),
    pickerTitle: 'Blocking which ticket?',
  },
  {
    key: 'relates',
    label: 'Relates to…',
    type: 'relates',
    build: (sourceId, pickedId) => ({ fromId: sourceId, toId: pickedId }),
    pickerTitle: 'Relates to which ticket?',
  },
  {
    key: 'duplicates',
    label: 'Duplicate of…',
    type: 'duplicates',
    build: (sourceId, pickedId) => ({ fromId: sourceId, toId: pickedId }),
    pickerTitle: 'Duplicate of which ticket?',
  },
  {
    key: 'split',
    label: 'Split into…',
    type: 'split',
    build: (sourceId, pickedId) => ({ fromId: sourceId, toId: pickedId }),
    pickerTitle: 'Split into which ticket?',
  },
];

/** Human label for a resolved relation from the perspective of the ticket it's shown on.
 *  `origin` distinguishes a hand-drawn split from an auto-split (D-051). */
export function relationLabel(rel: ResolvedRelation): string {
  const auto = rel.origin === 'agent';
  switch (rel.type) {
    case 'blocks':
      return rel.direction === 'to' ? 'Blocked by' : 'Blocking';
    case 'split':
      if (auto) return rel.direction === 'from' ? 'Auto-split into 🤖' : 'Auto-split from 🤖';
      return rel.direction === 'from' ? 'Split into' : 'Split from';
    case 'relates':
      return 'Relates to';
    case 'duplicates':
      return rel.direction === 'from' ? 'Duplicate of' : 'Duplicated by';
  }
}

/** Card badge counts derived from all board relations + a status lookup (PD-322). `blockedBy`
 *  and `blocking` count only *unresolved* endpoints; `split`/`splitOrigin` drive the split chip. */
export interface RelationBadges {
  blockedBy: number;
  blocking: number;
  split: boolean;
  splitOrigin: RelationOrigin | null;
}

export function computeBadges(
  ticketId: number,
  relations: TicketRelation[],
  statusById: Map<number, TicketStatus>,
): RelationBadges {
  let blockedBy = 0;
  let blocking = 0;
  let split = false;
  let splitOrigin: RelationOrigin | null = null;
  for (const r of relations) {
    const touchesFrom = r.fromTicketId === ticketId;
    const touchesTo = r.toTicketId === ticketId;
    if (!touchesFrom && !touchesTo) continue;
    if (r.type === 'blocks') {
      if (touchesTo && !isResolvedStatus(statusById.get(r.fromTicketId))) blockedBy++;
      if (touchesFrom && !isResolvedStatus(statusById.get(r.toTicketId))) blocking++;
    } else if (r.type === 'split') {
      split = true;
      // A human-drawn split anywhere on the ticket wins the label over an auto-split.
      if (splitOrigin !== 'human') splitOrigin = r.origin;
    }
  }
  return { blockedBy, blocking, split, splitOrigin };
}
