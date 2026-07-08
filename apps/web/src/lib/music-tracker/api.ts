import type { CreateManualTrackInput, Track } from '@dashboard/shared';

const BASE = '/api/widgets/music-tracker';

export async function fetchTracks(): Promise<Track[]> {
  const res = await fetch(`${BASE}/tracks`);
  if (!res.ok) throw new Error('Failed to load tracks');
  return res.json() as Promise<Track[]>;
}

export async function createTrack(input: CreateManualTrackInput): Promise<Track> {
  const res = await fetch(`${BASE}/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to add track');
  return res.json() as Promise<Track>;
}
