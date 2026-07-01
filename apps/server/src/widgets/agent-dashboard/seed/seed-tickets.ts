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
    });
    created++;
  }

  return { created, skipped, missingProjects: [...missingProjects] };
}
