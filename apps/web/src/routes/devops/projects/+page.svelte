<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { AgentProject } from '@dashboard/shared';
  import Button from '$lib/Button.svelte';
  import Modal from '$lib/Modal.svelte';
  import { toast } from '$lib/toast-store.svelte';
  import { fetchProjects, createProject, updateProject } from '../api';
  import {
    buildCreateProjectInput,
    emptyProjectForm,
    projectFormError,
    type ProjectFormState,
  } from './projects-form';

  /**
   * Dev Ops › Projects (PD-284, slice 3). Lists every project with name / prefix / repo and an
   * "Include in Audit" checkbox bound to `auditEnabled` (the recurring Ticket Audit's per-project
   * pause). A New Project form adds one with a chosen display-id prefix and a linked GitHub repo.
   */

  let projects = $state<AgentProject[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // IDs of projects whose audit toggle is mid-flight, so the checkbox can be disabled during the PATCH.
  const saving = new SvelteSet<number>();

  let formOpen = $state(false);
  let form = $state<ProjectFormState>(emptyProjectForm());
  let creating = $state(false);

  const formError = $derived(projectFormError(form));

  async function load() {
    loading = true;
    try {
      projects = await fetchProjects();
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function toggleAudit(project: AgentProject) {
    const next = !project.auditEnabled;
    // Optimistic: flip locally, roll back + toast on failure (matches the board's `api` pattern).
    projects = projects.map((p) => (p.id === project.id ? { ...p, auditEnabled: next } : p));
    saving.add(project.id);
    try {
      const updated = await updateProject(project.id, { auditEnabled: next });
      projects = projects.map((p) => (p.id === updated.id ? updated : p));
    } catch (e) {
      projects = projects.map((p) => (p.id === project.id ? { ...p, auditEnabled: !next } : p));
      toast.show(`Could not update ${project.name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      saving.delete(project.id);
    }
  }

  function openForm() {
    form = emptyProjectForm();
    formOpen = true;
  }

  async function submitForm() {
    if (formError) return;
    creating = true;
    try {
      await createProject(buildCreateProjectInput(form));
      formOpen = false;
      await load();
      toast.show('Project created');
    } catch (e) {
      toast.show(`Could not create project: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      creating = false;
    }
  }
</script>

<section class="projects-page">
  <header class="projects-head">
    <h1 class="projects-title">Projects</h1>
    <a class="projects-back" href="/devops/task-tracker">← Task Tracker</a>
  </header>
  <p class="projects-sub">
    Every project the board tracks. The <strong>Include in Audit</strong> checkbox controls whether
    the recurring Ticket Audit fans out over that project.
  </p>

  <div class="projects-actions">
    <Button variant="primary" onclick={openForm}>+ New project</Button>
  </div>

  {#if loading}
    <p class="projects-empty">Loading…</p>
  {:else if error}
    <p class="projects-error" role="alert">Could not load projects: {error}</p>
  {:else if projects.length === 0}
    <p class="projects-empty">No projects yet. Create one to get started.</p>
  {:else}
    <table class="projects-table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Prefix</th>
          <th scope="col">GitHub repo</th>
          <th scope="col" class="audit-col">Include in Audit</th>
        </tr>
      </thead>
      <tbody>
        {#each projects as project (project.id)}
          <tr>
            <td class="name-cell">{project.name}</td>
            <td class="prefix-cell"><code>{project.key ?? '—'}</code></td>
            <td class="repo-cell">
              {#if project.githubRepo}
                <code>{project.githubRepo}</code>
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
            <td class="audit-col">
              <label class="audit-toggle">
                <input
                  type="checkbox"
                  checked={project.auditEnabled}
                  disabled={saving.has(project.id)}
                  onchange={() => toggleAudit(project)}
                />
                <span class="sr-label">Include {project.name} in Audit</span>
              </label>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<Modal open={formOpen} title="New project" onClose={() => (formOpen = false)}>
  <form
    class="project-form"
    onsubmit={(e) => {
      e.preventDefault();
      void submitForm();
    }}
  >
    <label class="field">
      <span class="field-label">Name</span>
      <input type="text" bind:value={form.name} placeholder="Personal Dashboard" required />
    </label>
    <label class="field">
      <span class="field-label">Display-id prefix</span>
      <input type="text" bind:value={form.key} placeholder="PD" required />
      <span class="field-hint">Tickets become <code>{(form.key.trim() || 'PD').toUpperCase()}-1</code>, …</span>
    </label>
    <label class="field">
      <span class="field-label">GitHub repo</span>
      <input type="text" bind:value={form.githubRepo} placeholder="owner/repo" required />
    </label>
    {#if formError}
      <p class="form-error" role="alert">{formError}</p>
    {/if}
    <div class="form-actions">
      <Button variant="ghost" onclick={() => (formOpen = false)}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={!!formError || creating}>
        {creating ? 'Creating…' : 'Create project'}
      </Button>
    </div>
  </form>
</Modal>

<style lang="scss" src="./+page.scss"></style>
