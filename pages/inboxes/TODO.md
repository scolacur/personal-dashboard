# TODO — Inboxes Page

## Ableton Project Org Job

- Scan Ableton User Library for bounced audio files. Criteria: Any audio file inside any subfolder named "bounces" or "Bounces".
- Surface one at a time: play audio in browser, prompt for rating & tags (when building, revisit to see what else i should be prompted for. user should use MAKID for a reference.)
- Write to sidecar table (project name, rating, tags, notes)

## Jam Vid Org Job

- Scan a configured folder of video files
- In-browser playback (direct file URL or transcoded stream via ffmpeg)
- Prompt for rating, tag.
- Rename / move file into a more organized folder structure based on tags (optional, deferred)

  - Surface a random track from `music_tracker_library_files` missing genre or star rating
  - Let user assign genre and star rating in-page
  - Write values to a sidecar table (avoid mutating files directly in MVP)

## Shared Review Item Model

- If Ableton + Jam Vid + DJ Library jobs all follow the same "surface → review → record" pattern, consider a shared `inbox_review_items` table with a `library` discriminator
- Would enable a single unified "items remaining" count across all jobs


## DJ Library Org Job

- Initially, every song is marked as "not tagged" in the db.
- Surfaces a random song from my DJ library marked "not tagged". Lets me listen to it and add the genre, star rating, and tags right there.
- It would need to know the genres and tags in the DJ app
- This may not be possible given Rekordbox limitations, we will need to think through the design carefully and may need to incoroporate some manual steps. 


## Progress Tracking

- Show per-job stats: items reviewed, items remaining (estimated)
