/** Time helpers for the Tinnitus Tracker. All local-time, because "when did it ring" is a wall-clock question. */

const pad = (n: number) => String(n).padStart(2, '0');

/** Unix ms → the `YYYY-MM-DDTHH:mm` a `<input type="datetime-local">` takes, in local time. */
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

/** "14:05" today, "Yesterday 14:05", otherwise "Mon 3 Nov 14:05". */
export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (ms >= startOfToday.getTime()) return time;
  if (ms >= startOfToday.getTime() - dayMs) return `Yesterday ${time}`;
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day} ${time}`;
}
