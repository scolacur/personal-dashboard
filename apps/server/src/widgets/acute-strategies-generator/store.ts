import type Database from 'better-sqlite3';
import type { AcuteStrategyIdea, CreateIdeaInput, IdeaType, UpdateIdeaInput } from '@dashboard/shared';
import { IDEA_TYPES } from '@dashboard/shared';

type IdeaRow = { id: number; text: string; type: string; tags: string; created_at: number; updated_at: number };

function rowToIdea(row: IdeaRow): AcuteStrategyIdea {
  return {
    id: row.id,
    text: row.text,
    type: row.type as IdeaType,
    tags: JSON.parse(row.tags) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function isIdeaType(v: unknown): v is IdeaType {
  return typeof v === 'string' && (IDEA_TYPES as readonly string[]).includes(v);
}

export interface ListIdeasOpts {
  type?: IdeaType;
  tag?: string;
}

export function listIdeas(db: Database.Database, opts?: ListIdeasOpts): AcuteStrategyIdea[] {
  const rows = (
    opts?.type
      ? db.prepare('SELECT * FROM asg_ideas WHERE type = ? ORDER BY id').all(opts.type)
      : db.prepare('SELECT * FROM asg_ideas ORDER BY id').all()
  ) as IdeaRow[];

  const ideas = rows.map(rowToIdea);

  if (opts?.tag) {
    const needle = opts.tag.toLowerCase();
    return ideas.filter((idea) => idea.tags.some((t) => t.toLowerCase() === needle));
  }

  return ideas;
}

export function getIdea(db: Database.Database, id: number): AcuteStrategyIdea | null {
  const row = db.prepare('SELECT * FROM asg_ideas WHERE id = ?').get(id) as IdeaRow | undefined;
  return row ? rowToIdea(row) : null;
}

export function createIdea(db: Database.Database, input: CreateIdeaInput): AcuteStrategyIdea {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO asg_ideas (text, type, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.text, input.type, JSON.stringify(input.tags), now, now);
  return getIdea(db, Number(lastInsertRowid))!;
}

export function updateIdea(
  db: Database.Database,
  id: number,
  input: UpdateIdeaInput,
): AcuteStrategyIdea | null {
  const existing = getIdea(db, id);
  if (!existing) return null;
  const now = Date.now();
  db.prepare('UPDATE asg_ideas SET text = ?, type = ?, tags = ?, updated_at = ? WHERE id = ?').run(
    input.text ?? existing.text,
    input.type ?? existing.type,
    JSON.stringify(input.tags ?? existing.tags),
    now,
    id,
  );
  return getIdea(db, id);
}

export function deleteIdea(db: Database.Database, id: number): boolean {
  const { changes } = db.prepare('DELETE FROM asg_ideas WHERE id = ?').run(id);
  return changes > 0;
}
