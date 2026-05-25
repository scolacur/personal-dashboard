# TODO — Concert Diary Widget

## Backfill: Workflowy Notes

- Parse a Workflowy OPML/JSON export for concert-related notes
- Heuristic: nodes with a date + artist name pattern (may need LLM assist to extract structured fields)
- Create draft entries for user review and confirmation before saving

## Backfill: Google Calendar

- Query Google Calendar for events that look like concerts (venue keywords, artist name patterns)
- Use event date + title to pre-fill entry fields
- Cross-reference with already-existing diary entries to avoid duplicates

## Backfill: Camera Roll (Google Photos)

- Run a one-time job that scans all Google Photos for "concert-like" clusters
- Clusters: bursts of photos at night, taken at unfamiliar locations — likely shows
- Surface as candidate entries for the user to confirm
- High uncertainty; LLM or a simple heuristic (night time, high burst rate) could seed the candidates

## Video Support

- Decide on approach: server-side storage vs. Google Photos link-only
- If server-side: cap file size, generate a thumbnail via ffmpeg for the entry grid view

## Setlist.fm Integration

- Look up the setlist for a given artist + venue + date
- Attach the setlist to the entry (stored as text/JSON)
- Setlist.fm has a free REST API

## Cross-reference with Concert Discovery

- "Mark as attended" action on a Concert Discovery upcoming event → creates a Concert Diary entry pre-filled with artist/venue/date
- After the show date passes, Concert Discovery could prompt: "Did you go to this? Add it to your diary"

## Map View

- Plot all attended concerts on a map (using venue city coordinates)
- Filter by year, artist, city

## Stats View

- Shows per year, top artists (most times seen), top cities, top venues
- "First time I saw [artist]" for each entry
