import type {
  BstDraft,
  BstDraftFormat,
  BstImportResult,
  BstIngestResult,
  BstListing,
  BstMatch,
  BstSettings,
  CreateBstListingInput,
  UpdateBstListingInput,
} from '@dashboard/shared';

const BASE = '/api/widgets/buy-sell-trade';

/**
 * A create/update the server wants confirmed rather than refused: Steve already has a listing
 * for this thing, which is legal — he owns two of some items — so the UI asks before adding a
 * second. Carries the existing rows so the prompt can show what they are.
 */
export class BstDuplicateError extends Error {
  constructor(
    message: string,
    readonly existing: BstListing[],
  ) {
    super(message);
    this.name = 'BstDuplicateError';
  }
}

/** Surface the server's error message when it sends one — a write failure that says
 *  "already listed" is far more useful than a generic "failed to save". */
async function fail(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const body = (await res.json()) as {
      error?: string;
      code?: string;
      existing?: BstListing[];
    };
    if (body?.error) message = body.error;
    if (body?.code === 'DUPLICATE_CONFIRM') {
      throw new BstDuplicateError(message, body.existing ?? []);
    }
  } catch (e) {
    if (e instanceof BstDuplicateError) throw e;
    // non-JSON body: keep the fallback
  }
  throw new Error(message);
}

export async function fetchListings(): Promise<BstListing[]> {
  const res = await fetch(`${BASE}/listings`);
  if (!res.ok) await fail(res, 'Failed to load listings');
  return res.json() as Promise<BstListing[]>;
}

/** Throws `BstDuplicateError` when a listing for this thing already exists; re-call with
 *  `confirmDuplicate` to add it anyway. */
export async function createListing(
  input: CreateBstListingInput,
  confirmDuplicate = false,
): Promise<BstListing> {
  const res = await fetch(`${BASE}/listings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(confirmDuplicate ? { ...input, confirmDuplicate: true } : input),
  });
  if (!res.ok) await fail(res, 'Failed to create listing');
  return res.json() as Promise<BstListing>;
}

export async function updateListing(
  id: number,
  input: UpdateBstListingInput,
  confirmDuplicate = false,
): Promise<BstListing> {
  const res = await fetch(`${BASE}/listings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(confirmDuplicate ? { ...input, confirmDuplicate: true } : input),
  });
  if (!res.ok) await fail(res, 'Failed to update listing');
  return res.json() as Promise<BstListing>;
}

export async function deleteListing(id: number): Promise<void> {
  const res = await fetch(`${BASE}/listings/${id}`, { method: 'DELETE' });
  if (!res.ok) await fail(res, 'Failed to delete listing');
}

export async function importCsv(csv: string): Promise<BstImportResult> {
  const res = await fetch(`${BASE}/listings/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  });
  if (!res.ok) await fail(res, 'Failed to import CSV');
  return res.json() as Promise<BstImportResult>;
}

/* ── Matches (PD-438) ───────────────────────────── */

export async function fetchMatches(includeDismissed = false): Promise<BstMatch[]> {
  const q = includeDismissed ? '?includeDismissed=true' : '';
  const res = await fetch(`${BASE}/matches${q}`);
  if (!res.ok) await fail(res, 'Failed to load matches');
  return res.json() as Promise<BstMatch[]>;
}

/** Just the number, for the collapsed card. */
export async function fetchOpenMatchCount(): Promise<number> {
  const res = await fetch(`${BASE}/matches/count`);
  if (!res.ok) await fail(res, 'Failed to load match count');
  const body = (await res.json()) as { open: number };
  return body.open;
}

export async function setMatchDismissed(id: number, dismissed: boolean): Promise<BstMatch> {
  const res = await fetch(`${BASE}/matches/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dismissed }),
  });
  if (!res.ok) await fail(res, 'Failed to update match');
  return res.json() as Promise<BstMatch>;
}

/** The manual fallback while Reddit API access is pending: paste a thread's comments in and
 *  the matcher runs over them exactly as the scheduled job will. */
export async function ingestComments(
  threadId: string,
  comments: { id: string; author: string; body: string; permalink: string }[],
): Promise<BstIngestResult> {
  const res = await fetch(`${BASE}/matches/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, comments }),
  });
  if (!res.ok) await fail(res, 'Failed to ingest comments');
  return res.json() as Promise<BstIngestResult>;
}

export async function fetchSettings(): Promise<BstSettings> {
  const res = await fetch(`${BASE}/settings`);
  if (!res.ok) await fail(res, 'Failed to load settings');
  return res.json() as Promise<BstSettings>;
}

export async function saveTerms(terms: string): Promise<BstSettings> {
  const res = await fetch(`${BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terms }),
  });
  if (!res.ok) await fail(res, 'Failed to save terms');
  return res.json() as Promise<BstSettings>;
}

/* ── Drafted posts (PD-439) ─────────────────────── */

/** Save one format's template. Sent alone so it cannot disturb the terms or the other two. */
export async function saveTemplate(
  format: BstDraftFormat,
  template: string,
): Promise<BstSettings> {
  const res = await fetch(`${BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templates: { [format]: template } }),
  });
  if (!res.ok) await fail(res, 'Failed to save template');
  return res.json() as Promise<BstSettings>;
}

export async function fetchDrafts(): Promise<BstDraft[]> {
  const res = await fetch(`${BASE}/drafts`);
  if (!res.ok) await fail(res, 'Failed to load drafts');
  return res.json() as Promise<BstDraft[]>;
}

/** Generate now — all three formats from the current list and terms. */
export async function generateDrafts(): Promise<BstDraft[]> {
  const res = await fetch(`${BASE}/drafts/generate`, { method: 'POST' });
  if (!res.ok) await fail(res, 'Failed to generate drafts');
  return res.json() as Promise<BstDraft[]>;
}
