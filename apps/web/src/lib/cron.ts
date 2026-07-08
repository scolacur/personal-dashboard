// Minimal 5-field cron support for the Recurring Jobs surface (PD-286): compute the next
// fire time and a human label. Covers the fields our schedules use — `*`, single ints,
// comma lists, ranges (a-b), and steps (*/n) — with cron's standard dom/dow OR semantics.
// Not a full parser (no `L`/`#`/named months); enough for the dashboard's crons.

const FIELD_BOUNDS: Record<number, [number, number]> = {
  0: [0, 59], // minute
  1: [0, 23], // hour
  2: [1, 31], // day-of-month
  3: [1, 12], // month
  4: [0, 6], // day-of-week (0 = Sunday)
};

function parseField(field: string, index: number): Set<number> {
  const [min, max] = FIELD_BOUNDS[index];
  const out = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) out.add(i);
    } else if (part.startsWith('*/')) {
      const step = Number(part.slice(2));
      if (step > 0) for (let i = min; i <= max; i += step) out.add(i);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const n = Number(part);
      if (!Number.isNaN(n)) out.add(n);
    }
  }
  return out;
}

/**
 * The next time (unix ms, local time) the cron expression fires strictly after `fromMs`, or
 * null if the expression is malformed / nothing matches within a year. Iterates day-by-day
 * (bounded to 366 days), then checks the hour/minute sets on matching days.
 */
export function nextCronRun(expr: string, fromMs: number): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const mins = parseField(parts[0], 0);
  const hours = parseField(parts[1], 1);
  const doms = parseField(parts[2], 2);
  const mons = parseField(parts[3], 3);
  const dows = parseField(parts[4], 4);
  const domRestricted = parts[2] !== '*';
  const dowRestricted = parts[4] !== '*';

  const cursor = new Date(fromMs);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let day = 0; day <= 366; day++) {
    const monthOk = mons.has(cursor.getMonth() + 1);
    const domOk = doms.has(cursor.getDate());
    const dowOk = dows.has(cursor.getDay());
    // Cron OR-semantics: when both dom and dow are restricted, either matching is enough.
    const dayMatch =
      monthOk &&
      (domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk);

    if (dayMatch) {
      for (let h = day === 0 ? cursor.getHours() : 0; h <= 23; h++) {
        if (!hours.has(h)) continue;
        const startMin = day === 0 && h === cursor.getHours() ? cursor.getMinutes() : 0;
        for (let m = startMin; m <= 59; m++) {
          if (mins.has(m)) {
            const hit = new Date(cursor);
            hit.setHours(h, m, 0, 0);
            return hit.getTime();
          }
        }
      }
    }
    // Advance to the start of the next day.
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return null;
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A short human label for the common schedule shapes we register (weekly/daily). Falls back
 *  to the raw expression for anything it doesn't recognise. */
export function scheduleLabel(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, , dow] = parts;
  const time =
    /^\d+$/.test(hour) && /^\d+$/.test(min)
      ? `${((Number(hour) + 11) % 12) + 1}:${min.padStart(2, '0')} ${Number(hour) < 12 ? 'AM' : 'PM'}`
      : null;
  if (dom === '*' && dow === '*' && time) return `Daily · ${time}`;
  if (dom === '*' && /^\d+$/.test(dow) && time) return `Weekly · ${DOW_NAMES[Number(dow)]} ${time}`;
  return expr;
}
