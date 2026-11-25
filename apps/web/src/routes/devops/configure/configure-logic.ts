import type { WorkerConfigEntry, WorkerSettingUnit } from '@dashboard/shared';

// Formatting helpers for /devops/configure (PD-1006). ms settings are entered and shown in human
// units; the API always speaks integer ms.

export type MsInputUnit = 's' | 'min' | 'h';

const UNIT_MS: Record<MsInputUnit, number> = { s: 1_000, min: 60_000, h: 3_600_000 };

/** Trim a number to at most two decimals, dropping trailing zeros: 1.50 → "1.5", 2.00 → "2". */
function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** A duration in the largest unit that reads naturally: "15 s", "3 min", "24 h", "1.5 h". 0 → "0". */
export function formatMs(ms: number): string {
  if (ms === 0) return '0';
  if (ms < UNIT_MS.min) return `${trim(ms / UNIT_MS.s)} s`;
  if (ms < UNIT_MS.h) return `${trim(ms / UNIT_MS.min)} min`;
  return `${trim(ms / UNIT_MS.h)} h`;
}

/** The unit an ms setting's input is typed in, chosen from its code default so one setting always
 *  uses the same unit: hours for windows, minutes for most intervals, seconds for fast polls. */
export function msInputUnit(defaultMs: number): MsInputUnit {
  if (defaultMs >= UNIT_MS.h) return 'h';
  if (defaultMs >= UNIT_MS.min) return 'min';
  return 's';
}

/** A setting's value as the page shows it. */
export function formatSettingValue(value: number | null, unit: WorkerSettingUnit): string {
  if (value === null) return '—';
  if (unit === 'ms') return formatMs(value);
  const n = value.toLocaleString('en-US');
  if (unit === 'turns') return `${n} turns`;
  if (unit === 'tokens') return `${n} tokens`;
  return n;
}

/** The input's initial text for a value, in the entry's input unit. */
export function toInputText(entry: Pick<WorkerConfigEntry, 'unit' | 'default'>, value: number | null): string {
  if (value === null) return '';
  if (entry.unit !== 'ms') return String(value);
  return trim(value / UNIT_MS[msInputUnit(entry.default)]);
}

/**
 * Parse what was typed into the value the API takes (integer ms for durations). Returns null for an
 * empty or non-numeric input; bounds are the server's call, so its reason is what the page shows.
 */
export function parseInputText(entry: Pick<WorkerConfigEntry, 'unit' | 'default'>, text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (entry.unit !== 'ms') return n;
  return Math.round(n * UNIT_MS[msInputUnit(entry.default)]);
}

/** "applies on worker restart" or "live" — the row's badge text. */
export function liveBadge(entry: Pick<WorkerConfigEntry, 'live'>): string {
  return entry.live ? 'live' : 'applies on worker restart';
}

/** Where the boot value came from, for the "env / default" column. */
export function bootLabel(entry: Pick<WorkerConfigEntry, 'boot' | 'bootSource' | 'unit' | 'default'>): string {
  if (entry.boot === null) return `${formatSettingValue(entry.default, entry.unit)} (default; worker not reported yet)`;
  return `${formatSettingValue(entry.boot, entry.unit)} (${entry.bootSource === 'env' ? 'env' : 'default'})`;
}

/** Is the row visibly overridden — an override whose value differs from the env/default value? */
export function isOverridden(entry: Pick<WorkerConfigEntry, 'override' | 'boot' | 'default'>): boolean {
  return entry.override !== null && entry.override !== (entry.boot ?? entry.default);
}
