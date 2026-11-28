import { slugify, type CreateProjectInput } from '@dashboard/shared';

/**
 * Pure logic for the New Project form (PD-284, slice 3). Kept out of the `.svelte` file so it can
 * be unit-tested without a component harness, matching the board's `ticket-form.ts` split.
 */

export interface ProjectFormState {
  name: string;
  /** Display-id prefix, e.g. 'PD'. Uppercased on build. */
  key: string;
  /** 'owner/repo'. */
  githubRepo: string;
}

export function emptyProjectForm(): ProjectFormState {
  return { name: '', key: '', githubRepo: '' };
}

/**
 * The slug is a required, unique column; the form derives it from the name via the shared
 * {@link slugify} helper rather than asking for it, so a human types one less field. A collision
 * surfaces as the server's 409 DUPLICATE_SLUG.
 */

/** The first validation error for the form, or null when it is ready to submit. */
export function projectFormError(form: ProjectFormState): string | null {
  if (form.name.trim() === '') return 'Name is required';
  if (slugify(form.name) === '') return 'Name must contain a letter or number';
  if (form.key.trim() === '') return 'Prefix is required';
  if (form.githubRepo.trim() === '') return 'GitHub repo is required';
  return null;
}

/** Build the API input from a valid form. Call only when `projectFormError` returns null. */
export function buildCreateProjectInput(form: ProjectFormState): CreateProjectInput {
  return {
    slug: slugify(form.name),
    name: form.name.trim(),
    key: form.key.trim().toUpperCase(),
    githubRepo: form.githubRepo.trim(),
  };
}
