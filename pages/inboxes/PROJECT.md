# Inboxes — PROJECT.md

A page for long-running, one-at-a-time organizational jobs that require human input. The user dips in and chips away over time. Each job surfaces an item, prompts for a decision, and moves on. Think of it as an inbox for decisions that can't be fully automated, with an almost Tinder-like interface (though there may be more than Yes/No options)

Jobs planned (from shell/TODO.md):

- **Ableton Project Org** — after bouncing old projects to audio, surface one at a time to rate & tag
- **Jam Vid Org** — surface a random jam video to rate and tag
- **DJ Library Org** — surface a track missing genre or star rating; let user listen and fill it in
- **Google maps locations Org** - surface a location from my google maps saved locations so i can change which lists it belongs to and add a label.
- **Google Photos org** - Surface a photo from my photo library so i can add it to albums or star it

Full automation of some of these tasks may not be possible due to varying degrees of permissions/access needed and API limitations. Worst case, they help me keep track of where I am in longer-running manual processes.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

This page requires filesystem access beyond what most widgets need, so it's deferred until after other widgets exist. See shell/TODO.md ("build some other widgets first").

When built, MVP is:

- Page route at `/inboxes`
- One job implemented end-to-end: **determine what the easiest one to start with is when beginning work on this page**
- Each job as a tab at the top of the modal with its own "surface next item" flow
- Jobs are manual-trigger only (user visits the page and acts)
- Items are surfaced in a groups of 5 per job. Can click a button to load 10 more for a given job.

### Explicitly NOT in MVP

- Ableton Project Org (requires new filesystem access to project/audio folders)
- Jam Vid Org (requires video playback in the browser — complex)
- Control over chunk size per job (right now its 5 for all, with button to load 10 more)
- Messages from agents - this should be on the Agent Dashboard page, but maybe also here?
- New Tracks Scraped - tracks scraped from sources I'm tracking, with a link to listen (prioritize youtube embed first, then bandcamp, then soundcloud, then spotify) and an option to add to tracker or ignore. Ignoring removes it from the queue. this should probably be on the music discovery page, but maybe also here?
- New Tracks Downloaded - downloaded tracks to listen to to determine if they can be added to music lib / dj lib. Also probably on music discovery page, but maybe also here?
- Diary Entries - calendar events to be put in my diaries
- Concert Diary Entries - concerts to be put in my concert diary
- Automation or scheduling of job surfacing
- Any AI/LLM involvement (pure human decision loop for now)

---

## 3. Open Questions

- Write genre/rating back to ID3 tags, or to a sidecar SQLite table? Sidecar is safer for MVP.
- How does "DJ Library Org" know which genres are valid? Does it need to read from the DJ app (Rekordbox, Traktor, Serato)? Ideally, yes. It's Rekordbox btw.
- Should jobs share a common "review item" data model, or is each job entirely bespoke? I think we should start with a common one, and separate it if review processes get sufficiently different. Each modal will share commonalities like an ordered list of items, pending actions, approval / rejection / modification functions, and probably a similar UI.
- Should jobs be plugin-style (each job registers itself like a widget) or hardcoded routes?

---
