import type { Cue, Mix, SyncSummary } from '@dashboard/shared';

const BASE = '/api/widgets/id-tracker';

export interface MixesResponse {
  mixes: Mix[];
  syncing: boolean;
  configured: boolean;
}

export interface CueWrite {
  cue: Cue;
  warnings: string[];
}

/** A duplicate `url_key` comes back as a 409 carrying the mix that already holds it — including
 *  an archived one, so the UI can offer to restore rather than showing a dead end. */
export class DuplicateMixError extends Error {
  constructor(readonly mix: Mix) {
    super('A mix with this URL is already tracked.');
  }
}

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; mix?: Mix };
  if (body.code === 'duplicate_mix' && body.mix) throw new DuplicateMixError(body.mix);
  throw new Error(body.error ?? `Request failed (${res.status})`);
}

const POST = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const PATCH = (body: unknown): RequestInit => ({ ...POST(body), method: 'PATCH' });

export async function fetchMixes(includeArchived = false): Promise<MixesResponse> {
  return json<MixesResponse>(await fetch(`${BASE}/mixes${includeArchived ? '?includeArchived=1' : ''}`));
}

export async function createMix(input: { url?: string | null; title: string }): Promise<Mix> {
  return json<Mix>(await fetch(`${BASE}/mixes`, POST(input)));
}

export async function renameMix(id: number, title: string): Promise<Mix> {
  return json<Mix>(await fetch(`${BASE}/mixes/${id}`, PATCH({ title })));
}

export async function resolveRename(id: number, accept: boolean): Promise<Mix> {
  return json<Mix>(await fetch(`${BASE}/mixes/${id}/rename`, POST({ accept })));
}

export async function setArchived(id: number, archived: boolean): Promise<Mix> {
  return json<Mix>(await fetch(`${BASE}/mixes/${id}/archive`, POST({ archived })));
}

export async function createCue(
  mixId: number,
  input: {
    position: string;
    artist?: string;
    title?: string;
    remixer?: string;
    notes?: string;
  },
): Promise<CueWrite> {
  return json<CueWrite>(await fetch(`${BASE}/mixes/${mixId}/cues`, POST(input)));
}

export async function updateCue(
  cueId: number,
  input: Partial<{ position: string; artist: string; title: string; remixer: string; notes: string }>,
): Promise<CueWrite> {
  return json<CueWrite>(await fetch(`${BASE}/cues/${cueId}`, PATCH(input)));
}

export async function deleteCue(cueId: number): Promise<void> {
  await json<{ ok: boolean }>(await fetch(`${BASE}/cues/${cueId}`, { method: 'DELETE' }));
}

export async function syncNow(): Promise<{ summary: SyncSummary; mixes: Mix[] }> {
  return json<{ summary: SyncSummary; mixes: Mix[] }>(await fetch(`${BASE}/sync`, POST({})));
}
