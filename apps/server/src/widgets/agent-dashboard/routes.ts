import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  TODO_PRIORITIES,
  TODO_STATUSES,
  type CreateTodoInput,
  type TodoPriority,
  type TodoStatus,
  type UpdateTodoInput,
} from '@dashboard/shared';
import {
  archiveTodo,
  createProject,
  createTodo,
  getProjectBySlug,
  listProjects,
  listTodos,
  projectExists,
  updateTodo,
} from './store';

function isPriority(v: unknown): v is TodoPriority {
  return typeof v === 'string' && (TODO_PRIORITIES as readonly string[]).includes(v);
}

function isStatus(v: unknown): v is TodoStatus {
  return typeof v === 'string' && (TODO_STATUSES as readonly string[]).includes(v);
}

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  const base = '/api/widgets/agent-dashboard';

  /* ── Projects ─────────────────────────────── */

  app.get(`${base}/projects`, async () => listProjects(db));

  app.post(`${base}/projects`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.slug !== 'string' || body.slug.trim() === '') {
      return reply.status(400).send({ error: 'slug is required', code: 'INVALID_SLUG' });
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return reply.status(400).send({ error: 'name is required', code: 'INVALID_NAME' });
    }
    if (getProjectBySlug(db, body.slug.trim())) {
      return reply.status(409).send({ error: 'project slug already exists', code: 'DUPLICATE_SLUG' });
    }
    return reply.status(201).send(
      createProject(db, {
        slug: body.slug.trim(),
        name: body.name.trim(),
        githubRepo: typeof body.githubRepo === 'string' ? body.githubRepo : null,
        sortieEnabled: body.sortieEnabled === true,
        color: typeof body.color === 'string' ? body.color : null,
      }),
    );
  });

  /* ── Todos ────────────────────────────────── */

  app.get(`${base}/todos`, async () => listTodos(db));

  app.post(`${base}/todos`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return reply.status(400).send({ error: 'title is required', code: 'INVALID_TITLE' });
    }
    if (typeof body.projectId !== 'number' || !Number.isInteger(body.projectId)) {
      return reply.status(400).send({ error: 'projectId is required', code: 'INVALID_PROJECT' });
    }
    if (!projectExists(db, body.projectId)) {
      return reply.status(400).send({ error: 'unknown projectId', code: 'UNKNOWN_PROJECT' });
    }
    if (body.priority !== undefined && !isPriority(body.priority)) {
      return reply.status(400).send({ error: 'invalid priority', code: 'INVALID_PRIORITY' });
    }
    if (body.body !== undefined && body.body !== null && typeof body.body !== 'string') {
      return reply.status(400).send({ error: 'body must be a string', code: 'INVALID_BODY' });
    }

    const input: CreateTodoInput = {
      title: body.title.trim(),
      projectId: body.projectId,
      body: (body.body as string | null | undefined) ?? null,
      priority: isPriority(body.priority) ? body.priority : undefined,
    };
    return reply.status(201).send(createTodo(db, input));
  });

  app.patch(`${base}/todos/:id`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: UpdateTodoInput = {};

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim() === '') {
        return reply.status(400).send({ error: 'invalid title', code: 'INVALID_TITLE' });
      }
      patch.title = body.title.trim();
    }
    if (body.body !== undefined) {
      if (body.body !== null && typeof body.body !== 'string') {
        return reply.status(400).send({ error: 'body must be a string', code: 'INVALID_BODY' });
      }
      patch.body = body.body as string | null;
    }
    if (body.status !== undefined) {
      if (!isStatus(body.status)) {
        return reply.status(400).send({ error: 'invalid status', code: 'INVALID_STATUS' });
      }
      patch.status = body.status;
    }
    if (body.priority !== undefined) {
      if (!isPriority(body.priority)) {
        return reply.status(400).send({ error: 'invalid priority', code: 'INVALID_PRIORITY' });
      }
      patch.priority = body.priority;
    }
    if (body.projectId !== undefined) {
      if (typeof body.projectId !== 'number' || !projectExists(db, body.projectId)) {
        return reply.status(400).send({ error: 'unknown projectId', code: 'UNKNOWN_PROJECT' });
      }
      patch.projectId = body.projectId;
    }
    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== 'number' || !Number.isFinite(body.sortOrder)) {
        return reply
          .status(400)
          .send({ error: 'sortOrder must be a number', code: 'INVALID_SORT_ORDER' });
      }
      patch.sortOrder = body.sortOrder;
    }

    const updated = updateTodo(db, id, patch);
    if (!updated) {
      return reply.status(404).send({ error: 'todo not found', code: 'NOT_FOUND' });
    }
    return updated;
  });

  // Soft-delete: archives the todo (recoverable), hidden from the board.
  app.delete(`${base}/todos/:id`, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    if (!archiveTodo(db, id)) {
      return reply.status(404).send({ error: 'todo not found', code: 'NOT_FOUND' });
    }
    return reply.status(204).send();
  });
}
