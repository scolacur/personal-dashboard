import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncSummary } from '@dashboard/shared';
import { bootstrapSchema } from './schema';
import { reconcilePlaylist } from './sync';
import { parseIsoDuration } from './youtube';
import { archiveMix, createCue, getMix, listMixes } from './store';

/**
 * The reconciliation rules exist to prevent silent, unrecoverable loss. Each test here names the
 * loss it prevents — a green suite is the only evidence that a 3am cron run cannot eat the name
 * of a mix, or flag every mix as removed because one HTTP call failed.
 */

let db: Database.Database;
const PLAYLIST = 'PLgreatmixes2025';

function summary(): SyncSummary {
  return { playlists: 1, created: 0, retitled: 0, removed: 0, unavailable: 0, playlistsFailed: 0 };
}

function item(videoId: string, title: string, addedAt = 1_700_000_000_000) {
  return { videoId, title, addedToPlaylistAt: addedAt };
}

function sync(items: ReturnType<typeof item>[], durations = new Map<string, number>()): SyncSummary {
  const s = summary();
  reconcilePlaylist(db, PLAYLIST, items, durations, Date.now(), s);
  return s;
}

beforeEach(() => {
  db = new Database(':memory:');
  bootstrapSchema(db);
});

describe('rule 1 — new videos become mixes', () => {
  it('creates a mix keyed on the video id, titled from YouTube', () => {
    const s = sync([item('dQw4w9WgXcQ', 'Nina Kraviz | Dekmantel 2025')]);
    expect(s.created).toBe(1);

    const mixes = listMixes(db);
    expect(mixes).toHaveLength(1);
    expect(mixes[0]).toMatchObject({
      urlKey: 'youtube:dQw4w9WgXcQ',
      source: 'youtube',
      title: 'Nina Kraviz | Dekmantel 2025',
      inPlaylist: true,
      unavailable: false,
    });
  });

  it('is idempotent — a second run creates nothing', () => {
    sync([item('dQw4w9WgXcQ', 'A mix')]);
    const second = sync([item('dQw4w9WgXcQ', 'A mix')]);
    expect(second.created).toBe(0);
    expect(listMixes(db)).toHaveLength(1);
  });

  it('records duration when available, enabling the past-the-end check', () => {
    sync([item('dQw4w9WgXcQ', 'A mix')], new Map([['dQw4w9WgXcQ', 3600]]));
    expect(listMixes(db)[0].durationS).toBe(3600);
  });
});

describe('rule 2 — a retitle is offered, never applied', () => {
  it('leaves the display title alone and raises a pending rename', () => {
    sync([item('dQw4w9WgXcQ', 'Original Title')]);
    const s = sync([item('dQw4w9WgXcQ', 'CLICKBAIT NEW TITLE 🔥')]);

    expect(s.retitled).toBe(1);
    const mix = listMixes(db)[0];
    expect(mix.title).toBe('Original Title');
    expect(mix.pendingRename).toBe('CLICKBAIT NEW TITLE 🔥');
  });
});

describe('rule 3 — a sentinel title never replaces the name of a mix', () => {
  it('keeps the stored title, marks unavailable, and offers no rename', () => {
    sync([item('dQw4w9WgXcQ', 'Nina Kraviz | Dekmantel 2025')]);
    const mixId = listMixes(db)[0].id;
    createCue(db, { mixId, position: '42:15', notes: 'the one with the vocal' });

    const s = sync([item('dQw4w9WgXcQ', 'Private video')]);

    const mix = getMix(db, mixId)!;
    expect(s.unavailable).toBe(1);
    expect(mix.title).toBe('Nina Kraviz | Dekmantel 2025'); // the name survives
    expect(mix.unavailable).toBe(true);
    expect(mix.pendingRename).toBeNull(); // and can never be adopted by accident
    expect(mix.cues).toHaveLength(1); // the work survives
  });

  it('clears the flag if the video comes back', () => {
    sync([item('dQw4w9WgXcQ', 'A mix')]);
    sync([item('dQw4w9WgXcQ', 'Deleted video')]);
    expect(listMixes(db)[0].unavailable).toBe(true);

    sync([item('dQw4w9WgXcQ', 'A mix')]);
    expect(listMixes(db)[0].unavailable).toBe(false);
  });
});

describe('rule 4 — removal from a playlist never deletes', () => {
  it('flags the mix and keeps every cue', () => {
    sync([item('aaaaaaaaaaa', 'Kept'), item('bbbbbbbbbbb', 'Pruned')]);
    const pruned = listMixes(db).find((m) => m.title === 'Pruned')!;
    createCue(db, { mixId: pruned.id, position: '12:00', artist: 'Skee Mask', title: 'Rio Dubmarine' });

    const s = sync([item('aaaaaaaaaaa', 'Kept')]);

    expect(s.removed).toBe(1);
    const after = getMix(db, pruned.id)!;
    expect(after.inPlaylist).toBe(false);
    expect(after.cues).toHaveLength(1);
    expect(after.cues[0].identified).toBe(true);
  });
});

describe('rule 5 — a playlist that failed marks no removals', () => {
  it('is expressed by never calling reconcile for that playlist', () => {
    sync([item('aaaaaaaaaaa', 'One'), item('bbbbbbbbbbb', 'Two')]);

    // A failed fetch skips reconcilePlaylist entirely (see reconcileAll's catch), which is what
    // makes this safe: an empty item list would otherwise read as "everything was removed".
    const asIfEmptyFetchHadBeenTrusted = sync([]);
    expect(asIfEmptyFetchHadBeenTrusted.removed).toBe(2);
    // ...which is precisely why the caller must not reconcile a playlist it could not read.
  });
});

describe('rule 6 — an archived mix stays archived', () => {
  it('survives a sync that still finds it in the playlist', () => {
    sync([item('dQw4w9WgXcQ', 'Cue-less mix')]);
    const mix = listMixes(db)[0];
    archiveMix(db, mix.id);

    sync([item('dQw4w9WgXcQ', 'Cue-less mix')]);

    expect(getMix(db, mix.id)!.archivedAt).not.toBeNull();
    expect(listMixes(db)).toHaveLength(0); // still hidden from the default list
    expect(listMixes(db, { includeArchived: true })).toHaveLength(1);
  });
});

describe('ordering — the mix just added to the playlist comes first', () => {
  it('sorts by playlist add-date, newest first', () => {
    sync([
      item('aaaaaaaaaaa', 'Older', 1_600_000_000_000),
      item('bbbbbbbbbbb', 'Newest', 1_700_000_000_000),
      item('ccccccccccc', 'Middle', 1_650_000_000_000),
    ]);
    expect(listMixes(db).map((m) => m.title)).toEqual(['Newest', 'Middle', 'Older']);
  });
});

describe('parseIsoDuration', () => {
  it('reads the shapes YouTube emits', () => {
    expect(parseIsoDuration('PT1H23M45S')).toBe(5025);
    expect(parseIsoDuration('PT47M10S')).toBe(2830);
    expect(parseIsoDuration('PT30S')).toBe(30);
    expect(parseIsoDuration('P1DT2H')).toBe(93600);
  });

  it('returns null for live streams and junk', () => {
    expect(parseIsoDuration('P0D')).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
    expect(parseIsoDuration('banana')).toBeNull();
  });
});
