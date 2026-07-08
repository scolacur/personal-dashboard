import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { createIdea, deleteIdea, getIdea, isIdeaType, listIdeas, updateIdea } from './store';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

describe('isIdeaType', () => {
  it('accepts valid types', () => {
    expect(isIdeaType('Acute')).toBe(true);
    expect(isIdeaType('Oblique')).toBe(true);
    expect(isIdeaType('Inspiration')).toBe(true);
  });

  it('rejects invalid values', () => {
    expect(isIdeaType('acute')).toBe(false);
    expect(isIdeaType('random')).toBe(false);
    expect(isIdeaType(null)).toBe(false);
  });
});

describe('bootstrapSchema seed', () => {
  it('seeds ideas on first boot', () => {
    const db = freshDb();
    const ideas = listIdeas(db);
    expect(ideas.length).toBeGreaterThan(0);
  });

  it('does not re-seed on repeated bootstrap', () => {
    const db = freshDb();
    const count1 = listIdeas(db).length;
    bootstrapSchema(db);
    const count2 = listIdeas(db).length;
    expect(count1).toBe(count2);
  });

  it('seeds both Acute and Inspiration types', () => {
    const db = freshDb();
    const acute = listIdeas(db, { type: 'Acute' });
    const inspiration = listIdeas(db, { type: 'Inspiration' });
    expect(acute.length).toBeGreaterThan(0);
    expect(inspiration.length).toBeGreaterThan(0);
  });
});

describe('createIdea', () => {
  it('creates an idea with the given fields', () => {
    const db = freshDb();
    const idea = createIdea(db, { text: 'Test idea', type: 'Oblique', tags: ['tag1', 'tag2'] });
    expect(idea.text).toBe('Test idea');
    expect(idea.type).toBe('Oblique');
    expect(idea.tags).toEqual(['tag1', 'tag2']);
    expect(idea.created_at).toBeGreaterThan(0);
  });

  it('creates an idea with empty tags', () => {
    const db = freshDb();
    const idea = createIdea(db, { text: 'No tags', type: 'Acute', tags: [] });
    expect(idea.tags).toEqual([]);
  });
});

describe('getIdea', () => {
  it('returns null for unknown id', () => {
    const db = freshDb();
    expect(getIdea(db, 99999)).toBeNull();
  });

  it('returns the idea by id', () => {
    const db = freshDb();
    const created = createIdea(db, { text: 'Find me', type: 'Acute', tags: [] });
    const found = getIdea(db, created.id);
    expect(found).not.toBeNull();
    expect(found!.text).toBe('Find me');
  });
});

describe('listIdeas', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // Bootstrap schema without seed for controlled test data
    db.exec(`
      CREATE TABLE IF NOT EXISTS asg_ideas (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    `);
    createIdea(db, { text: 'Acute 1', type: 'Acute', tags: ['drums'] });
    createIdea(db, { text: 'Acute 2', type: 'Acute', tags: ['synth'] });
    createIdea(db, { text: 'Inspiration 1', type: 'Inspiration', tags: [] });
    createIdea(db, { text: 'Oblique 1', type: 'Oblique', tags: ['drums'] });
  });

  it('returns all ideas when no filter', () => {
    expect(listIdeas(db).length).toBe(4);
  });

  it('filters by type', () => {
    const acute = listIdeas(db, { type: 'Acute' });
    expect(acute.length).toBe(2);
    expect(acute.every((i) => i.type === 'Acute')).toBe(true);
  });

  it('filters by tag (case-insensitive)', () => {
    const withDrums = listIdeas(db, { tag: 'DRUMS' });
    expect(withDrums.length).toBe(2);
    expect(withDrums.every((i) => i.tags.map((t) => t.toLowerCase()).includes('drums'))).toBe(true);
  });

  it('filters by type and tag together', () => {
    const result = listIdeas(db, { type: 'Acute', tag: 'drums' });
    expect(result.length).toBe(1);
    expect(result[0].text).toBe('Acute 1');
  });

  it('returns empty array when no match', () => {
    expect(listIdeas(db, { tag: 'nonexistent' })).toEqual([]);
  });
});

describe('updateIdea', () => {
  it('returns null for unknown id', () => {
    const db = freshDb();
    expect(updateIdea(db, 99999, { text: 'x' })).toBeNull();
  });

  it('updates only the provided fields', () => {
    const db = freshDb();
    const created = createIdea(db, { text: 'Original', type: 'Acute', tags: ['a'] });
    const updated = updateIdea(db, created.id, { text: 'Updated' });
    expect(updated!.text).toBe('Updated');
    expect(updated!.type).toBe('Acute');
    expect(updated!.tags).toEqual(['a']);
  });

  it('updates tags', () => {
    const db = freshDb();
    const created = createIdea(db, { text: 'T', type: 'Acute', tags: [] });
    const updated = updateIdea(db, created.id, { tags: ['jazz', 'ambient'] });
    expect(updated!.tags).toEqual(['jazz', 'ambient']);
  });
});

describe('deleteIdea', () => {
  it('returns false for unknown id', () => {
    const db = freshDb();
    expect(deleteIdea(db, 99999)).toBe(false);
  });

  it('deletes the idea and returns true', () => {
    const db = freshDb();
    const created = createIdea(db, { text: 'Delete me', type: 'Acute', tags: [] });
    expect(deleteIdea(db, created.id)).toBe(true);
    expect(getIdea(db, created.id)).toBeNull();
  });
});
