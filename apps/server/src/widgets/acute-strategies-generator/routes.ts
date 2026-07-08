import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { CreateIdeaInput, UpdateIdeaInput } from '@dashboard/shared';
import { createIdea, deleteIdea, getIdea, isIdeaType, listIdeas, updateIdea } from './store';

const BASE = '/api/widgets/acute-strategies-generator';

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get(`${BASE}/ideas`, async (request) => {
    const { type, tag } = request.query as { type?: string; tag?: string };
    const opts = {
      type: isIdeaType(type) ? type : undefined,
      tag: tag || undefined,
    };
    return listIdeas(db, opts);
  });

  app.get<{ Params: { id: string } }>(`${BASE}/ideas/:id`, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });
    const idea = getIdea(db, id);
    if (!idea) return reply.status(404).send({ error: 'Not found' });
    return idea;
  });

  app.post(`${BASE}/ideas`, async (request, reply) => {
    const body = request.body as Partial<CreateIdeaInput>;
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return reply.status(400).send({ error: 'text is required' });
    }
    if (!isIdeaType(body.type)) {
      return reply.status(400).send({ error: 'type must be Acute, Oblique, or Inspiration' });
    }
    const tags = Array.isArray(body.tags) ? (body.tags as string[]).filter((t) => typeof t === 'string') : [];
    return reply.status(201).send(createIdea(db, { text: body.text.trim(), type: body.type, tags }));
  });

  app.put<{ Params: { id: string } }>(`${BASE}/ideas/:id`, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });
    const body = request.body as Partial<UpdateIdeaInput>;
    const input: UpdateIdeaInput = {};
    if (body.text !== undefined) {
      if (typeof body.text !== 'string' || !body.text.trim()) {
        return reply.status(400).send({ error: 'text must be a non-empty string' });
      }
      input.text = body.text.trim();
    }
    if (body.type !== undefined) {
      if (!isIdeaType(body.type)) {
        return reply.status(400).send({ error: 'type must be Acute, Oblique, or Inspiration' });
      }
      input.type = body.type;
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags)) return reply.status(400).send({ error: 'tags must be an array' });
      input.tags = (body.tags as string[]).filter((t) => typeof t === 'string');
    }
    const updated = updateIdea(db, id, input);
    if (!updated) return reply.status(404).send({ error: 'Not found' });
    return updated;
  });

  app.delete<{ Params: { id: string } }>(`${BASE}/ideas/:id`, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });
    const deleted = deleteIdea(db, id);
    if (!deleted) return reply.status(404).send({ error: 'Not found' });
    return reply.status(204).send();
  });
}
