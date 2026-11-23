/** The canary's health panel (PD-937): what a health check's result means, as a label and tone. */
export type HealthTone = 'neutral' | 'ok' | 'bad';

export interface HealthView {
  label: string;
  tone: HealthTone;
}

/** A health check that has not answered yet. */
export const CHECKING: HealthView = { label: 'Checking…', tone: 'neutral' };

/**
 * Map a `GET /health` outcome to the panel. `body` is the parsed JSON on a 2xx response, or
 * `undefined` when the request failed (network error, non-2xx, unparseable). Only `{ ok: true }`
 * is healthy.
 */
export function healthView(body: unknown): HealthView {
  const ok = typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
  return ok ? { label: 'Healthy', tone: 'ok' } : { label: 'Unreachable', tone: 'bad' };
}
