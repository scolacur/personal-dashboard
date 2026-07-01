<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentProject, AgentTodo, TodoPriority, TodoStatus } from '@dashboard/shared';
  import { TODO_STATUSES } from '@dashboard/shared';
  import Modal from '$lib/Modal.svelte';
  import * as api from './api';

  const COLUMNS: { status: TodoStatus; label: string }[] = [
    { status: 'backlog', label: 'Backlog' },
    { status: 'ready', label: 'Ready' },
    { status: 'in_progress', label: 'In progress' },
    { status: 'in_review', label: 'In review' },
    { status: 'completed', label: 'Completed' },
  ];
  const PRIORITIES: TodoPriority[] = ['low', 'medium', 'high'];

  let todos = $state<AgentTodo[]>([]);
  let projects = $state<AgentProject[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // null = "All projects"
  let filterProjectId = $state<number | null>(null);

  // Add / edit form state. `editingId === null` while adding.
  let formOpen = $state(false);
  let editingId = $state<number | null>(null);
  let formTitle = $state('');
  let formBody = $state('');
  let formPriority = $state<TodoPriority>('medium');
  let formProjectId = $state<number | null>(null);

  const projectsById = $derived(new Map(projects.map((p) => [p.id, p])));

  function visibleTodos(): AgentTodo[] {
    return filterProjectId === null ? todos : todos.filter((t) => t.projectId === filterProjectId);
  }

  function byStatus(status: TodoStatus): AgentTodo[] {
    return visibleTodos().filter((t) => t.status === status);
  }

  async function load() {
    loading = true;
    error = null;
    try {
      [projects, todos] = await Promise.all([api.fetchProjects(), api.fetchTodos()]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function openAdd() {
    editingId = null;
    formTitle = '';
    formBody = '';
    formPriority = 'medium';
    // Default to the active filter, else the first project.
    formProjectId = filterProjectId ?? projects[0]?.id ?? null;
    formOpen = true;
  }

  function openEdit(todo: AgentTodo) {
    editingId = todo.id;
    formTitle = todo.title;
    formBody = todo.body ?? '';
    formPriority = todo.priority;
    formProjectId = todo.projectId ?? projects[0]?.id ?? null;
    formOpen = true;
  }

  function closeForm() {
    formOpen = false;
  }

  async function submitForm() {
    const title = formTitle.trim();
    if (!title || formProjectId === null) return;
    error = null;
    try {
      if (editingId === null) {
        await api.createTodo({
          title,
          projectId: formProjectId,
          body: formBody.trim() || null,
          priority: formPriority,
        });
      } else {
        await api.updateTodo(editingId, {
          title,
          body: formBody.trim() || null,
          priority: formPriority,
          projectId: formProjectId,
        });
      }
      formOpen = false;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function move(todo: AgentTodo, delta: number) {
    const idx = TODO_STATUSES.indexOf(todo.status);
    const next = TODO_STATUSES[idx + delta];
    if (!next) return;
    error = null;
    try {
      // Append to the end of the destination column.
      await api.updateTodo(todo.id, { status: next, sortOrder: Date.now() });
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function remove(todo: AgentTodo) {
    if (!confirm(`Delete "${todo.title}"?`)) return;
    error = null;
    try {
      await api.deleteTodo(todo.id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function canMoveLeft(todo: AgentTodo): boolean {
    return TODO_STATUSES.indexOf(todo.status) > 0;
  }
  function canMoveRight(todo: AgentTodo): boolean {
    return TODO_STATUSES.indexOf(todo.status) < TODO_STATUSES.length - 1;
  }
</script>

<header class="page-head">
  <h1>Mission Control</h1>
  <div class="head-controls">
    <label class="project-filter">
      <span class="sr-label">Project</span>
      <select
        value={filterProjectId === null ? 'all' : String(filterProjectId)}
        onchange={(e) => {
          const v = e.currentTarget.value;
          filterProjectId = v === 'all' ? null : Number(v);
        }}
      >
        <option value="all">All projects</option>
        {#each projects as p (p.id)}
          <option value={String(p.id)}>{p.name}</option>
        {/each}
      </select>
    </label>
    <button class="add-btn" type="button" onclick={openAdd} disabled={projects.length === 0}>
      + Add TODO
    </button>
  </div>
</header>

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

<Modal open={formOpen} title={editingId === null ? 'New TODO' : 'Edit TODO'} onClose={closeForm}>
  <div class="todo-form">
    <label>
      <span>Project</span>
      <select bind:value={formProjectId}>
        {#each projects as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Title</span>
      <input type="text" bind:value={formTitle} placeholder="What needs doing?" />
    </label>
    <label>
      <span>Details</span>
      <textarea bind:value={formBody} rows="4" placeholder="Plain-English description (optional)"
      ></textarea>
    </label>
    <label>
      <span>Priority</span>
      <select bind:value={formPriority}>
        {#each PRIORITIES as p (p)}
          <option value={p}>{p}</option>
        {/each}
      </select>
    </label>
    <div class="form-actions">
      <button type="button" class="ghost" onclick={closeForm}>Cancel</button>
      <button
        type="button"
        class="primary"
        onclick={submitForm}
        disabled={!formTitle.trim() || formProjectId === null}
      >
        {editingId === null ? 'Add' : 'Save'}
      </button>
    </div>
  </div>
</Modal>

{#if loading}
  <p class="muted">Loading…</p>
{:else}
  <div class="board">
    {#each COLUMNS as col (col.status)}
      {@const items = byStatus(col.status)}
      <section class="column">
        <h2 class="column-head">
          {col.label}<span class="count">{items.length}</span>
        </h2>
        <div class="column-body">
          {#each items as todo (todo.id)}
            {@const project = todo.projectId !== null ? projectsById.get(todo.projectId) : undefined}
            <article class="card" class:done={todo.status === 'completed'}>
              <div class="card-top">
                <span class="priority priority-{todo.priority}">{todo.priority}</span>
                {#if todo.githubIssueUrl}
                  <a class="issue-link" href={todo.githubIssueUrl} target="_blank" rel="noreferrer">
                    #{todo.githubIssueNumber}
                  </a>
                {/if}
              </div>
              <p class="card-title">{todo.title}</p>
              {#if todo.body}
                <p class="card-body">{todo.body}</p>
              {/if}
              {#if project}
                <span
                  class="project-chip"
                  style="--chip: {project.color ?? 'var(--muted)'}"
                  title={project.name}>{project.name}</span
                >
              {/if}
              <div class="card-actions">
                <button
                  type="button"
                  title="Move left"
                  aria-label="Move left"
                  disabled={!canMoveLeft(todo)}
                  onclick={() => move(todo, -1)}>◀</button
                >
                <button
                  type="button"
                  title="Move right"
                  aria-label="Move right"
                  disabled={!canMoveRight(todo)}
                  onclick={() => move(todo, 1)}>▶</button
                >
                <span class="spacer"></span>
                <button type="button" title="Edit" aria-label="Edit" onclick={() => openEdit(todo)}
                  >✎</button
                >
                <button
                  type="button"
                  title="Delete"
                  aria-label="Delete"
                  onclick={() => remove(todo)}>🗑</button
                >
              </div>
            </article>
          {/each}
          {#if items.length === 0}
            <p class="empty">—</p>
          {/if}
        </div>
      </section>
    {/each}
  </div>
{/if}

<style lang="scss" src="./+page.scss"></style>
