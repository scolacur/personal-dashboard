import type {
  BstImportResult,
  BstListing,
  BstSettings,
  CreateBstListingInput,
  UpdateBstListingInput,
} from '@dashboard/shared';

const BASE = '/api/widgets/buy-sell-trade';

/** Surface the server's error message when it sends one — a write failure that says
 *  "already listed" is far more useful than a generic "failed to save". */
async function fail(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // non-JSON body: keep the fallback
  }
  throw new Error(message);
}

export async function fetchListings(): Promise<BstListing[]> {
  const res = await fetch(`${BASE}/listings`);
  if (!res.ok) await fail(res, 'Failed to load listings');
  return res.json() as Promise<BstListing[]>;
}

export async function createListing(input: CreateBstListingInput): Promise<BstListing> {
  const res = await fetch(`${BASE}/listings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await fail(res, 'Failed to create listing');
  return res.json() as Promise<BstListing>;
}

export async function updateListing(id: number, input: UpdateBstListingInput): Promise<BstListing> {
  const res = await fetch(`${BASE}/listings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
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
