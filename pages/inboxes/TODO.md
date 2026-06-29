# TODO — Inboxes Page

## Ableton Project Org Job

- Scan Ableton User Library for bounced audio files. Criteria: Any audio file inside any subfolder named "bounces" or "Bounces".
- Surface one at a time: play audio in browser, prompt for rating & tags (when building, revisit to see what else i should be prompted for. user should use MAKID for a reference.)
- Write to sidecar table (project name, rating, tags, notes)

## Spotify liked song filing pipeline
- First, Add all liked songs not in at least one playlist to a queue i can review from most-least and decide which playlist(s) it belongs to. If agent knows my playlists, maybe it can recommend where it should go.

- Then, set up this job: Whenever i like a song in Spotify, add it to the appropriate existing playlists of mine.

- Build with the concept that spotify might not always be my preferred streaming app make it easy to swap out


## Shazam Filing Pipeline

- Similar to liked song filing pipeline
- First, look at shazams playlist, mark everything initially as "not filed"
- Then look at DJ ideas playlist and DJ library, mark the stuff thats in either of those ("in dj ideas playlist", "downloaded", "in dj library")
- Everything else, add to a queue i can review. most recent first. 
- When i review a track, i want the ability to:
1. add to appropriate spotify playlists, 
2. add to download queue
3. Add to download queue and mark for adding to DJ library
4. ignore
- new shazams get added to the list

- think about how to handle songs when i shazam songs that i didnt necessarily want to put in a dj mix

- in a sense this is the same job as the liked song pipeline, just operating on a different playlist, and with the extra step of also checking for a songs presence in the dj ideas playlist Maybe options look like "also add to dj ideas playlist?" "also add to download queue?"



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
