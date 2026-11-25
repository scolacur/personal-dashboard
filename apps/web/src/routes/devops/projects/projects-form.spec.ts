import { describe, it, expect } from 'vitest';
import { buildCreateProjectInput, emptyProjectForm, projectFormError } from './projects-form';

describe('projectFormError', () => {
  it('requires a name', () => {
    expect(projectFormError({ name: '', key: 'PD', githubRepo: 'o/r' })).toBe('Name is required');
  });

  it('rejects a name that slugifies to empty', () => {
    expect(projectFormError({ name: '!!!', key: 'PD', githubRepo: 'o/r' })).toBe(
      'Name must contain a letter or number',
    );
  });

  it('requires a prefix', () => {
    expect(projectFormError({ name: 'Foo', key: '', githubRepo: 'o/r' })).toBe('Prefix is required');
  });

  it('requires a github repo', () => {
    expect(projectFormError({ name: 'Foo', key: 'F', githubRepo: '' })).toBe('GitHub repo is required');
  });

  it('is null for a complete form', () => {
    expect(projectFormError({ name: 'Foo', key: 'F', githubRepo: 'o/r' })).toBeNull();
  });
});

describe('buildCreateProjectInput', () => {
  it('derives the slug and uppercases the prefix', () => {
    const input = buildCreateProjectInput({ name: 'Widget Foo', key: 'wf', githubRepo: ' steve/foo ' });
    expect(input).toEqual({
      slug: 'widget-foo',
      name: 'Widget Foo',
      key: 'WF',
      githubRepo: 'steve/foo',
    });
  });
});

describe('emptyProjectForm', () => {
  it('starts blank', () => {
    expect(emptyProjectForm()).toEqual({ name: '', key: '', githubRepo: '' });
  });
});
