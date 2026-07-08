import type { AuditRunStatus, TicketStatus } from '@dashboard/shared';

// Display metadata for the Ticket Audit surface (PD-286): bucket + run-status labels/colours.
// Kept separate from audit-logic (which is behaviour) so the pure logic stays UI-free.

interface BucketMeta {
  label: string;
  /** A CSS colour token (var(--…)) for the recommendation pill. */
  color: string;
}

// Recommendation buckets the engine emits (D-045): archive/complete/reprioritize/update/keep.
// Anything unmapped falls back to a neutral pill with a title-cased label.
const BUCKETS: Record<string, BucketMeta> = {
  archive: { label: 'Archive', color: 'var(--status-stuck)' },
  complete: { label: 'Complete', color: 'var(--status-done)' },
  reprioritize: { label: 'Reprioritize', color: 'var(--status-queued)' },
  update: { label: 'Update', color: 'var(--status-in-review)' },
  keep: { label: 'Keep', color: 'var(--muted)' },
};

export function bucketLabel(type: string): string {
  return BUCKETS[type]?.label ?? type.charAt(0).toUpperCase() + type.slice(1);
}

export function bucketColor(type: string): string {
  return BUCKETS[type]?.color ?? 'var(--muted)';
}

const RUN_STATUS_LABELS: Record<AuditRunStatus, string> = {
  requested: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Error',
};

export function runStatusLabel(status: AuditRunStatus): string {
  return RUN_STATUS_LABELS[status];
}

const RUN_STATUS_COLORS: Record<AuditRunStatus, string> = {
  requested: 'var(--status-queued)',
  running: 'var(--status-working)',
  done: 'var(--status-done)',
  error: 'var(--status-stuck)',
};

export function runStatusColor(status: AuditRunStatus): string {
  return RUN_STATUS_COLORS[status];
}

/** Unix-ms → local wall-clock string, matching the ticket thread / notifications pages. */
export function formatTs(ts: number | null): string {
  return ts === null ? '—' : new Date(ts).toLocaleString();
}

// Lane labels for the per-finding ticket-status pill (mirrors the board's COLUMNS labels).
const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  prioritized: 'Prioritized',
  robot_queue: "Robot's Queue",
  steve_queue: "Steve's Queue",
  completed: 'Completed',
  closed: 'Closed',
};

export function ticketStatusLabel(status: TicketStatus): string {
  return TICKET_STATUS_LABELS[status];
}
