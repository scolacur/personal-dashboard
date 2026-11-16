import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { createIdea, recordDraw } from './store';

function freshSetup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  const app = Fastify({ logger: false });
  registerRoutes(app, db);
  return { app, db };
}

describe('GET /api/widgets/acute-strategies-generator/ideas', () => {
  it('returns all ideas', async () => {
    const { app } = freshSetup();
    const res = await app.inject({ method: 'GET', url: '/api/widgets/acute-strategies-generator/ideas' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as unknown[];
    expect(body.length).toBeGreaterThan(0);
  });

  it('filters by type', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/widgets/acute-strategies-generator/ideas?type=Inspiration',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { type: string }[];
    expect(body.every((i) => i.type === 'Inspiration')).toBe(true);
  });

  it('ignores invalid type filter', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/widgets/acute-strategies-generator/ideas?type=nope',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as unknown[];
    expect(body.length).toBeGreaterThan(0);
  });
});

describe('GET /api/widgets/acute-strategies-generator/ideas/:id', () => {
  it('returns the idea by id', async () => {
    const { app, db } = freshSetup();
    const idea = createIdea(db, { text: 'Find me', type: 'Acute', tags: [] });
    const res = await app.inject({
      method: 'GET',
      url: `/api/widgets/acute-strategies-generator/ideas/${idea.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ text: string }>().text).toBe('Find me');
  });

  it('returns 404 for unknown id', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/widgets/acute-strategies-generator/ideas/99999',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for non-numeric id', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/widgets/acute-strategies-generator/ideas/abc',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/widgets/acute-strategies-generator/ideas', () => {
  it('creates an idea and returns 201', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/acute-strategies-generator/ideas',
      payload: { text: 'New idea', type: 'Oblique', tags: ['synth'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ text: string; type: string; tags: string[] }>();
    expect(body.text).toBe('New idea');
    expect(body.type).toBe('Oblique');
    expect(body.tags).toEqual(['synth']);
  });

  it('returns 400 when text is missing', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/acute-strategies-generator/ideas',
      payload: { type: 'Acute', tags: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when type is invalid', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/acute-strategies-generator/ideas',
      payload: { text: 'Test', type: 'Bad', tags: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('defaults tags to empty array when omitted', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/acute-strategies-generator/ideas',
      payload: { text: 'No tags', type: 'Acute' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ tags: unknown[] }>().tags).toEqual([]);
  });
});

describe('POST /api/widgets/acute-strategies-generator/ideas/import', () => {
  const URL = '/api/widgets/acute-strategies-generator/ideas/import';

  it('imports new lines and returns created + skipped', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: URL,
      payload: { lines: ['Brand new idea', 'Another fresh one'], type: 'Oblique', tags: ['batch'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ created: { text: string; type: string; tags: string[] }[]; skipped: number }>();
    expect(body.created).toHaveLength(2);
    expect(body.skipped).toBe(0);
    expect(body.created.every((i) => i.type === 'Oblique')).toBe(true);
    expect(body.created[0].tags).toEqual(['batch']);
  });

  it('dedupes against existing ideas and within the batch', async () => {
    const { app, db } = freshSetup();
    createIdea(db, { text: 'Already here', type: 'Acute', tags: [] });
    const res = await app.inject({
      method: 'POST',
      url: URL,
      payload: { lines: [' already here ', 'fresh', 'FRESH'], type: 'Acute', tags: [] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ created: unknown[]; skipped: number }>();
    expect(body.created).toHaveLength(1);
    expect(body.skipped).toBe(2);
  });

  it('returns 400 when lines is not an array', async () => {
    const { app } = freshSetup();
    const res = await app.inject({ method: 'POST', url: URL, payload: { lines: 'nope', type: 'Acute' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when a line is not a string', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: URL,
      payload: { lines: ['ok', 42], type: 'Acute' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when type is invalid', async () => {
    const { app } = freshSetup();
    const res = await app.inject({ method: 'POST', url: URL, payload: { lines: ['a'], type: 'Bad' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when there are more than 1000 lines', async () => {
    const { app } = freshSetup();
    const lines = Array.from({ length: 1001 }, (_, i) => `idea ${i}`);
    const res = await app.inject({ method: 'POST', url: URL, payload: { lines, type: 'Acute' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('PUT /api/widgets/acute-strategies-generator/ideas/:id', () => {
  it('updates an idea', async () => {
    const { app, db } = freshSetup();
    const idea = createIdea(db, { text: 'Before', type: 'Acute', tags: [] });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/widgets/acute-strategies-generator/ideas/${idea.id}`,
      payload: { text: 'After' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ text: string }>().text).toBe('After');
  });

  it('returns 404 for unknown id', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/widgets/acute-strategies-generator/ideas/99999',
      payload: { text: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for invalid type', async () => {
    const { app, db } = freshSetup();
    const idea = createIdea(db, { text: 'Test', type: 'Acute', tags: [] });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/widgets/acute-strategies-generator/ideas/${idea.id}`,
      payload: { type: 'Bad' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/widgets/acute-strategies-generator/ideas/:id', () => {
  it('deletes and returns 204', async () => {
    const { app, db } = freshSetup();
    const idea = createIdea(db, { text: 'Bye', type: 'Acute', tags: [] });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/widgets/acute-strategies-generator/ideas/${idea.id}`,
    });
    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for unknown id', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/widgets/acute-strategies-generator/ideas/99999',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/widgets/acute-strategies-generator/draws', () => {
  const URL = '/api/widgets/acute-strategies-generator/draws';

  it('records a draw and returns 201 with the snapshot', async () => {
    const { app, db } = freshSetup();
    const idea = createIdea(db, { text: 'Reverse something', type: 'Oblique', tags: [] });
    const res = await app.inject({ method: 'POST', url: URL, payload: { ideaId: idea.id } });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ idea_id: number; idea_text: string; idea_type: string }>();
    expect(body.idea_id).toBe(idea.id);
    expect(body.idea_text).toBe('Reverse something');
    expect(body.idea_type).toBe('Oblique');
  });

  it('returns 404 when the idea does not exist', async () => {
    const { app } = freshSetup();
    const res = await app.inject({ method: 'POST', url: URL, payload: { ideaId: 99999 } });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when ideaId is missing or not a number', async () => {
    const { app } = freshSetup();
    expect((await app.inject({ method: 'POST', url: URL, payload: {} })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: URL, payload: { ideaId: 'x' } })).statusCode,
    ).toBe(400);
  });
});

describe('GET /api/widgets/acute-strategies-generator/draws', () => {
  const URL = '/api/widgets/acute-strategies-generator/draws';

  it('returns draws newest first', async () => {
    const { app, db } = freshSetup();
    const idea = createIdea(db, { text: 'Idea', type: 'Acute', tags: [] });
    db.prepare('INSERT INTO asg_draws (idea_id, idea_text, idea_type, drawn_at) VALUES (?, ?, ?, ?)').run(
      idea.id,
      'older',
      'Acute',
      1000,
    );
    db.prepare('INSERT INTO asg_draws (idea_id, idea_text, idea_type, drawn_at) VALUES (?, ?, ?, ?)').run(
      idea.id,
      'newer',
      'Acute',
      2000,
    );
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ idea_text: string }[]>().map((d) => d.idea_text)).toEqual(['newer', 'older']);
  });

  it('defaults to 20 draws', async () => {
    const { app, db } = freshSetup();
    const idea = createIdea(db, { text: 'Idea', type: 'Acute', tags: [] });
    for (let i = 0; i < 25; i++) recordDraw(db, idea.id);
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.json<unknown[]>()).toHaveLength(20);
  });

  it('honours an explicit limit', async () => {
    const { app, db } = freshSetup();
    const idea = createIdea(db, { text: 'Idea', type: 'Acute', tags: [] });
    for (let i = 0; i < 10; i++) recordDraw(db, idea.id);
    const res = await app.inject({ method: 'GET', url: `${URL}?limit=3` });
    expect(res.json<unknown[]>()).toHaveLength(3);
  });

  it('clamps the limit to a maximum of 200', async () => {
    const { app, db } = freshSetup();
    const idea = createIdea(db, { text: 'Idea', type: 'Acute', tags: [] });
    for (let i = 0; i < 205; i++) recordDraw(db, idea.id);
    const res = await app.inject({ method: 'GET', url: `${URL}?limit=500` });
    expect(res.json<unknown[]>()).toHaveLength(200);
  });

  it('falls back to the default for a non-numeric limit', async () => {
    const { app, db } = freshSetup();
    const idea = createIdea(db, { text: 'Idea', type: 'Acute', tags: [] });
    for (let i = 0; i < 25; i++) recordDraw(db, idea.id);
    const res = await app.inject({ method: 'GET', url: `${URL}?limit=abc` });
    expect(res.json<unknown[]>()).toHaveLength(20);
  });
});
