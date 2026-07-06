import type Database from 'better-sqlite3';
import type { TicketPriority, TicketStatus } from '@dashboard/shared';
import { createTicket, getProjectBySlug, ticketExistsBySource } from '../store';

export interface SeedTicket {
  project: string;
  title: string;
  body: string | null;
  /** P0–P5, or null for unset. */
  priority: TicketPriority | null;
  status: TicketStatus;
  source: string;
  /** Preserve the original display-id (e.g. 'PD-42') on restore; null → auto-allocate. */
  displayId: string | null;
}

export interface SeedResult {
  created: number;
  skipped: number;
  missingProjects: string[];
}

/**
 * Idempotent: creates each seed ticket unless one with the same source+title
 * already exists. Shared by the CLI importer (seed/import.ts) and the
 * seed-if-empty-on-boot guard (seed/seed-if-empty.ts).
 *
 * ⚠️  tickets.seed.json is a POINT-IN-TIME SNAPSHOT of the board, and this
 * importer is a RESTORE-ONTO-AN-EMPTY-DB tool — NOT a sync/merge. Do not treat
 * the seed file as a source of truth to "apply" over a live board:
 *   - It reflects the board only as of when it was last regenerated; anything
 *     created/edited on the DB since is absent and would be lost on a rebuild.
 *   - It now carries display-ids, so replaying it against a populated DB will
 *     re-insert already-present tickets under fresh rows and can collide on the
 *     unique display-id index. The source+title skip below prevents dupes only
 *     for rows that match exactly.
 * Safe use: seed a genuinely empty/fresh DB (that's what seed-if-empty enforces).
 * To capture the current board, REGENERATE the file from the live DB — never
 * hand-edit it and re-import expecting a merge.
 */
export function seedTickets(db: Database.Database, seeds: SeedTicket[]): SeedResult {
  let created = 0;
  let skipped = 0;
  const missingProjects = new Set<string>();

  for (const s of seeds) {
    const project = getProjectBySlug(db, s.project);
    if (!project) {
      missingProjects.add(s.project);
      continue;
    }
    if (ticketExistsBySource(db, s.source, s.title)) {
      skipped++;
      continue;
    }
    createTicket(db, {
      title: s.title,
      projectId: project.id,
      body: s.body,
      priority: s.priority,
      status: s.status,
      source: s.source,
      displayId: s.displayId,
    });
    created++;
  }

  return { created, skipped, missingProjects: [...missingProjects] };
}
