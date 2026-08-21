import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from './schema';
import {
  acceptRename,
  archiveMix,
  createCue,
  createMix,
  deleteCue,
  DuplicateMixError,
  getMix,
  listMixes,
  rejectRename,
  renameMix,
  restoreMix,
  updateCue,
  ValidationError,
} from './store';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  bootstrapSchema(db);
});

function mixWithDuration(seconds: number): number {
  const mix = createMix(db, { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'A mix' });
  db.prepare(`UPDATE id_tracker_mixes SET duration_s = ? WHERE id = ?`).run(seconds, mix.id);
  return mix.id;
}

describe('createMix', () => {
  it('accepts a mix with no URL at all — a set off a USB stick is a real mix', () => {
    const mix = createMix(db, { title: 'Friend b2b @ the loft' });
    expect(mix.urlKey).toBe('manual:friend-b2b-the-loft');
    expect(mix.source).toBe('manual');
    expect(mix.url).toBeNull();
  });

  it('recognises a YouTube URL and stores the video id', () => {
    const mix = createMix(db, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90', title: 'Mix' });
    expect(mix.source).toBe('youtube');
    expect(mix.youtubeVideoId).toBe('dQw4w9WgXcQ');
  });

  it('refuses a duplicate and hands back the existing mix', () => {
    const first = createMix(db, { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Mix' });
    try {
      createMix(db, { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx', title: 'Same mix, retyped' });
      expect.unreachable('expected a duplicate to be refused');
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateMixError);
      expect((e as DuplicateMixError).existing.id).toBe(first.id);
    }
  });

  it('surfaces an archived duplicate rather than failing opaquely', () => {
    const first = createMix(db, { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Mix' });
    archiveMix(db, first.id);
    try {
      createMix(db, { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Mix' });
      expect.unreachable('expected a duplicate to be refused');
    } catch (e) {
      expect((e as DuplicateMixError).existing.archivedAt).not.toBeNull();
    }
  });

  it('rejects a nameless mix', () => {
    expect(() => createMix(db, { title: '   ' })).toThrow(ValidationError);
  });
});

describe('renameMix', () => {
  it('re-keys a URL-less mix, since its identity is its name', () => {
    const mix = createMix(db, { title: 'Old name' });
    const renamed = renameMix(db, mix.id, 'New name');
    expect(renamed.urlKey).toBe('manual:new-name');
  });

  it('leaves a URL-keyed mix on its key', () => {
    const mix = createMix(db, { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Old name' });
    const renamed = renameMix(db, mix.id, 'New name');
    expect(renamed.urlKey).toBe('youtube:dQw4w9WgXcQ');
    expect(renamed.title).toBe('New name');
  });
});

describe('the rename prompt', () => {
  function withYoutubeTitle(youtubeTitle: string): number {
    const mix = createMix(db, { url: 'https://youtu.be/dQw4w9WgXcQ', title: 'My name for it' });
    db.prepare(`UPDATE id_tracker_mixes SET youtube_title = ? WHERE id = ?`).run(youtubeTitle, mix.id);
    return mix.id;
  }

  it('accept adopts YouTube’s title', () => {
    const id = withYoutubeTitle('The Real Title');
    expect(acceptRename(db, id).title).toBe('The Real Title');
    expect(getMix(db, id)!.pendingRename).toBeNull();
  });

  it('reject keeps ours and stops the nagging for that title only', () => {
    const id = withYoutubeTitle('Clickbait');
    const after = rejectRename(db, id);
    expect(after.title).toBe('My name for it');
    expect(after.pendingRename).toBeNull();

    db.prepare(`UPDATE id_tracker_mixes SET youtube_title = ? WHERE id = ?`).run('A different retitle', id);
    expect(getMix(db, id)!.pendingRename).toBe('A different retitle');
  });
});

describe('archive is the only removal concept', () => {
  it('hides by default, reveals on request, and restores', () => {
    const mix = createMix(db, { title: 'A mix' });
    createCue(db, { mixId: mix.id, position: '10:00' });

    archiveMix(db, mix.id);
    expect(listMixes(db)).toHaveLength(0);
    expect(listMixes(db, { includeArchived: true })).toHaveLength(1);

    const restored = restoreMix(db, mix.id);
    expect(restored.archivedAt).toBeNull();
    expect(restored.cues).toHaveLength(1); // the cues were never at risk
  });
});

describe('cue timestamps', () => {
  it('stores seconds, whatever format was typed', () => {
    const mix = createMix(db, { title: 'A mix' });
    expect(createCue(db, { mixId: mix.id, position: '47:10' }).cue.positionS).toBe(2830);
    expect(createCue(db, { mixId: mix.id, position: '1:23:45' }).cue.positionS).toBe(5025);
    expect(createCue(db, { mixId: mix.id, position: '42' }).cue.positionS).toBe(42);
  });

  it('takes the timestamp out of a pasted YouTube link', () => {
    const mix = createMix(db, { title: 'A mix' });
    const { cue } = createCue(db, { mixId: mix.id, position: 'https://youtu.be/dQw4w9WgXcQ?t=2535' });
    expect(cue.positionS).toBe(2535);
  });

  it('rejects a timestamp past a known duration', () => {
    const mixId = mixWithDuration(62 * 60);
    expect(() => createCue(db, { mixId, position: '1:47:30' })).toThrow(/past the end/i);
  });

  it('accepts anything when the duration is unknown', () => {
    const mix = createMix(db, { title: 'USB stick set' });
    expect(createCue(db, { mixId: mix.id, position: '3:00:00' }).cue.positionS).toBe(10800);
  });

  it('rejects an end timestamp that precedes the start', () => {
    const mix = createMix(db, { title: 'A mix' });
    expect(() => createCue(db, { mixId: mix.id, position: '10:00', endPosition: '9:00' })).toThrow(
      ValidationError,
    );
  });

  it('warns — but does not refuse — an exact duplicate position', () => {
    const mix = createMix(db, { title: 'A mix' });
    expect(createCue(db, { mixId: mix.id, position: '42:15' }).warnings).toEqual([]);

    const second = createCue(db, { mixId: mix.id, position: '42:15' });
    expect(second.cue.id).toBeGreaterThan(0);
    expect(second.warnings[0]).toMatch(/already an ID at 42:15/);
  });

  it('says nothing about a near-but-different position — that is a normal blend', () => {
    const mix = createMix(db, { title: 'A mix' });
    createCue(db, { mixId: mix.id, position: '42:15' });
    expect(createCue(db, { mixId: mix.id, position: '42:18' }).warnings).toEqual([]);
  });
});

describe('identified is derived, never set', () => {
  it('turns true only when both artist and title land', () => {
    const mix = createMix(db, { title: 'A mix' });
    const { cue } = createCue(db, { mixId: mix.id, position: '42:15', notes: 'vocal, maybe Four Tet' });
    expect(cue.identified).toBe(false);

    const half = updateCue(db, cue.id, { artist: 'Skee Mask' });
    expect(half.cue.identified).toBe(false);

    const full = updateCue(db, cue.id, { title: 'Rio Dubmarine' });
    expect(full.cue.identified).toBe(true);
  });

  it('goes back to false if an identification is cleared', () => {
    const mix = createMix(db, { title: 'A mix' });
    const { cue } = createCue(db, { mixId: mix.id, position: '1:00', artist: 'A', title: 'B' });
    expect(cue.identified).toBe(true);
    expect(updateCue(db, cue.id, { title: '' }).cue.identified).toBe(false);
  });

  it('keeps untouched fields on a partial update', () => {
    const mix = createMix(db, { title: 'A mix' });
    const { cue } = createCue(db, { mixId: mix.id, position: '1:00', notes: 'keep me' });
    const updated = updateCue(db, cue.id, { artist: 'Skee Mask' });
    expect(updated.cue.notes).toBe('keep me');
    expect(updated.cue.positionS).toBe(60);
  });
});

describe('cues are ordered by position and cascade with their mix', () => {
  it('lists in playback order regardless of entry order', () => {
    const mix = createMix(db, { title: 'A mix' });
    createCue(db, { mixId: mix.id, position: '1:00:00' });
    createCue(db, { mixId: mix.id, position: '5:00' });
    createCue(db, { mixId: mix.id, position: '30:00' });
    expect(getMix(db, mix.id)!.cues.map((c) => c.positionS)).toEqual([300, 1800, 3600]);
  });

  it('deletes one cue without touching the rest', () => {
    const mix = createMix(db, { title: 'A mix' });
    const { cue } = createCue(db, { mixId: mix.id, position: '5:00' });
    createCue(db, { mixId: mix.id, position: '10:00' });
    deleteCue(db, cue.id);
    expect(getMix(db, mix.id)!.cues).toHaveLength(1);
  });
});
