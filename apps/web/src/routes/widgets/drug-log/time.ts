/** Local-time helpers for the Drug Log's re-time / add forms (`<input type="datetime-local">`). */

const pad = (n: number) => String(n).padStart(2, '0');

/** Unix ms → `YYYY-MM-DDTHH:mm` in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The reverse. Null for an empty or unparseable value. */
export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const ms = new Date(y, mo - 1, d, h, mi).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** "14:05", local. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A sensible default time for adding an event to habit day `day` (`YYYY-MM-DD`): now, if `day` is
 * today; otherwise 21:00 local on that date — an evening, comfortably inside the day.
 */
export function defaultAddTime(day: string, today: string, now: number): number {
  if (day === today) return now;
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 21, 0).getTime();
}
