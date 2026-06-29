export interface NormResult {
  normArtist: string;
  normTitle: string;
  normRemixer: string | null;
}

const SEP = ' & ';

export function normalize(input: { artist: string; title: string }): NormResult {
  let artist = input.artist;
  let title = input.title;

  // Strip filename noise (safe no-op on clean metadata tags)
  title = title
    .replace(/\.[a-z0-9]{2,4}$/i, '')         // file extension
    .replace(/^\d{1,3}[\s\-_.]+(?=\D)/, '')    // leading "01 - " (not "1999")
    .replace(/\s*\[[A-Z0-9]{3,}\]\s*$/i, '');  // trailing catalog "[CAT001]"

  // Lowercase + fold diacritics
  artist = fold(artist.toLowerCase());
  title = fold(title.toLowerCase());

  // Extract feat. from title → append to artist
  const featMatch = title.match(/\s*[[(]?(?:feat\.?|featuring|ft\.?)\s+([^\])[]+)[\])]?/i);
  if (featMatch) {
    artist = artist + SEP + featMatch[1].replace(/[[\]()]/g, '').trim();
    title = title.replace(featMatch[0], '');
  }

  // Extract remix/mix/edit/version/dub/vip/bootleg → normRemixer
  let normRemixer: string | null = null;
  const remixMatch = title.match(/\(([^)]*(?:remix|mix|edit|version|dub|vip|bootleg|rework)[^)]*)\)/i);
  if (remixMatch) {
    normRemixer = squeeze(remixMatch[1]);
    title = title.replace(remixMatch[0], '');
  }

  // Normalise collaboration separators → SEP
  artist = artist
    .replace(/\s+x\s+/gi, SEP)
    .replace(/\s+vs\.?\s+/gi, SEP)
    .replace(/\s+with\s+/gi, SEP)
    .replace(/\s*,\s*/g, SEP)
    .replace(/\s*&\s*/g, SEP);

  // Sort artist list alphabetically
  const normArtist = artist
    .split(SEP)
    .map(squeeze)
    .filter(Boolean)
    .sort()
    .join(SEP);

  return {
    normArtist: squeeze(normArtist),
    normTitle: squeeze(title),
    normRemixer: normRemixer ? squeeze(normRemixer) : null,
  };
}

function fold(str: string): string {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function squeeze(str: string): string {
  return str.replace(/\s+/g, ' ').trim();
}
