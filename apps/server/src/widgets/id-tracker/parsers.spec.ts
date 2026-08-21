import { describe, expect, it } from 'vitest';
import {
  formatPosition,
  isIdentified,
  isSentinelTitle,
  mixMatchesQuery,
  mixUrlKey,
  parsePosition,
  parseYouTubeUrl,
  pendingRename,
} from '@dashboard/shared';

/**
 * The two parsers are the only places in this widget where a bug is silent: a wrong video-id
 * extraction produces duplicate mixes with no error, and a wrong timestamp parse writes a cue
 * that points at the wrong moment. Everything else fails loudly.
 *
 * These live in apps/server rather than beside the source in packages/shared because
 * `npm run test` does not cover packages/shared (PD-2) — a spec there would never run.
 */

describe('parsePosition — the rightmost field is always seconds', () => {
  it('reads a bare number as seconds', () => {
    expect(parsePosition('42')).toEqual({ ok: true, seconds: 42 });
  });

  it('reads MM:SS', () => {
    expect(parsePosition('47:10')).toEqual({ ok: true, seconds: 47 * 60 + 10 });
  });

  it('reads HH:MM:SS', () => {
    expect(parsePosition('1:23:45')).toEqual({ ok: true, seconds: 3600 + 23 * 60 + 45 });
  });

  it('pads sloppy single digits', () => {
    expect(parsePosition('1:2:3')).toEqual({ ok: true, seconds: 3600 + 2 * 60 + 3 });
  });

  it('accepts 0:00 — something can be playing as the mix opens', () => {
    expect(parsePosition('0:00')).toEqual({ ok: true, seconds: 0 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePosition('  47:10  ')).toEqual({ ok: true, seconds: 2830 });
  });

  it('rejects >59 in a non-leading field rather than normalising it', () => {
    const r = parsePosition('1:75');
    expect(r.ok).toBe(false);
  });

  it('allows a leading field over 59 — a 90-minute mark is 90:00', () => {
    expect(parsePosition('90:00')).toEqual({ ok: true, seconds: 5400 });
  });

  it('rejects four parts, letters, and empty input', () => {
    expect(parsePosition('1:2:3:4').ok).toBe(false);
    expect(parsePosition('twelve').ok).toBe(false);
    expect(parsePosition('   ').ok).toBe(false);
    expect(parsePosition('1:-5').ok).toBe(false);
  });

  it('takes the timestamp out of a pasted YouTube URL', () => {
    expect(parsePosition('https://youtu.be/dQw4w9WgXcQ?t=2535')).toEqual({ ok: true, seconds: 2535 });
    expect(parsePosition('https://youtu.be/dQw4w9WgXcQ?t=2535s')).toEqual({ ok: true, seconds: 2535 });
    expect(parsePosition('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h30m15s')).toEqual({
      ok: true,
      seconds: 5415,
    });
  });

  it('rejects a YouTube URL with no timestamp, with a message that says so', () => {
    const r = parsePosition('https://youtu.be/dQw4w9WgXcQ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no timestamp/i);
  });
});

describe('formatPosition', () => {
  it('omits hours when there are none', () => {
    expect(formatPosition(2830)).toBe('47:10');
    expect(formatPosition(0)).toBe('0:00');
  });

  it('shows hours when there are', () => {
    expect(formatPosition(5025)).toBe('1:23:45');
  });

  it('round-trips with parsePosition', () => {
    for (const s of [0, 7, 59, 60, 2830, 5025, 35999]) {
      expect(parsePosition(formatPosition(s))).toEqual({ ok: true, seconds: s });
    }
  });
});

describe('parseYouTubeUrl', () => {
  it('extracts the id from every spelling that reaches the clipboard', () => {
    const urls = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
    ];
    for (const u of urls) expect(parseYouTubeUrl(u)?.videoId).toBe('dQw4w9WgXcQ');
  });

  it('ignores the playlist parameter that copying out of a playlist adds', () => {
    const r = parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123&index=4');
    expect(r?.videoId).toBe('dQw4w9WgXcQ');
  });

  it('returns null for non-YouTube hosts and malformed ids', () => {
    expect(parseYouTubeUrl('https://soundcloud.com/user/set')).toBeNull();
    expect(parseYouTubeUrl('https://youtu.be/tooshort')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=waaaaaaaaaaaytoolong')).toBeNull();
    expect(parseYouTubeUrl('not a url')).toBeNull();
  });
});

describe('mixUrlKey — identity, never the title', () => {
  it('collapses every YouTube spelling of one video to one key', () => {
    const keys = new Set(
      [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtu.be/dQw4w9WgXcQ',
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2535s',
      ].map((url) => mixUrlKey({ url, title: 'whatever' })),
    );
    expect(keys).toEqual(new Set(['youtube:dQw4w9WgXcQ']));
  });

  it('does not let the title affect a URL-keyed mix', () => {
    const a = mixUrlKey({ url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Dekmantel 2025' });
    const b = mixUrlKey({ url: 'https://youtu.be/dQw4w9WgXcQ', title: 'totally different name' });
    expect(a).toBe(b);
  });

  it('normalises other hosts down to host + path', () => {
    expect(mixUrlKey({ url: 'https://www.soundcloud.com/User/Set-Name/', title: 'x' })).toBe(
      'soundcloud.com/user/set-name',
    );
  });

  it('keys a URL-less mix off its title, so a USB-stick set is a real mix', () => {
    expect(mixUrlKey({ title: 'Friend b2b @ the loft' })).toBe('manual:friend-b2b-the-loft');
    expect(mixUrlKey({ url: '', title: 'Friend b2b @ the loft' })).toBe('manual:friend-b2b-the-loft');
  });

  it('treats unparseable junk as a name rather than losing the mix', () => {
    expect(mixUrlKey({ url: ':::', title: 'Some Mix' })).toBe('manual:some-mix');
  });
});

describe('mixMatchesQuery — finding the mix you already have', () => {
  const REAL = 'Nina Kraviz | Dekmantel Festival 2025 | Full Set HD';

  it('catches the near-miss spelling a substring match would miss', () => {
    // The whole reason this is token containment: "25" is not a substring of the title in
    // sequence with "dekmantel", but both tokens are present.
    expect(mixMatchesQuery(REAL, 'dekmantel 25')).toBe(true);
    expect(REAL.toLowerCase().includes('dekmantel 25')).toBe(false);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(mixMatchesQuery(REAL, '  NINA kraviz  ')).toBe(true);
  });

  it('requires every token, so an unrelated word rules a mix out', () => {
    expect(mixMatchesQuery(REAL, 'dekmantel moodymann')).toBe(false);
  });

  it('matches nothing on a query too short to be a search', () => {
    expect(mixMatchesQuery(REAL, 'n')).toBe(false);
    expect(mixMatchesQuery(REAL, ' ')).toBe(false);
    expect(mixMatchesQuery(REAL, '')).toBe(false);
  });

  it('does not match an unrelated mix', () => {
    expect(mixMatchesQuery('Moodymann - Moodymann Collection', 'dekmantel')).toBe(false);
  });
});

describe('identified — derived, never hand-set', () => {
  it('is true only when both artist and title carry content', () => {
    expect(isIdentified('Skee Mask', 'Rio Dubmarine')).toBe(true);
    expect(isIdentified('Skee Mask', null)).toBe(false);
    expect(isIdentified(null, 'Rio Dubmarine')).toBe(false);
    expect(isIdentified('  ', ' ')).toBe(false);
    expect(isIdentified(null, null)).toBe(false);
  });
});

describe('pendingRename — and the sentinel guard that protects the mix name', () => {
  const base = { title: 'Dekmantel 2025', youtubeTitle: null, dismissedTitle: null };

  it('is null when YouTube agrees with us', () => {
    expect(pendingRename({ ...base, youtubeTitle: 'Dekmantel 2025' })).toBeNull();
  });

  it('offers a genuine retitle', () => {
    expect(pendingRename({ ...base, youtubeTitle: 'Nina Kraviz | Dekmantel 2025 | Full Set' })).toBe(
      'Nina Kraviz | Dekmantel 2025 | Full Set',
    );
  });

  it('stays quiet about a title already dismissed', () => {
    expect(
      pendingRename({ ...base, youtubeTitle: 'Clickbait Retitle', dismissedTitle: 'Clickbait Retitle' }),
    ).toBeNull();
  });

  it('raises again when YouTube picks a NEW title after a dismissal', () => {
    expect(
      pendingRename({ ...base, youtubeTitle: 'Another Retitle', dismissedTitle: 'Clickbait Retitle' }),
    ).toBe('Another Retitle');
  });

  it('never offers a sentinel — adopting it would destroy the mix name', () => {
    expect(pendingRename({ ...base, youtubeTitle: 'Private video' })).toBeNull();
    expect(pendingRename({ ...base, youtubeTitle: 'Deleted video' })).toBeNull();
    expect(isSentinelTitle('Private video')).toBe(true);
    expect(isSentinelTitle('Private video essay')).toBe(false);
  });
});
