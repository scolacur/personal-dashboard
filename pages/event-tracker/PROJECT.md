# Event Tracker — PROJECT.md

A page for monitoring and discovering live events, and keeping a personal log of shows attended.

See also: [TODO.md](TODO.md)

---

## 1. Widgets on this page

| Widget            | Folder                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| Concert Discovery | [widgets/concert-discovery](../../widgets/concert-discovery/PROJECT.md) |
| Festival Follower | [widgets/festival-follower](../../widgets/festival-follower/PROJECT.md) |
| Concert Diary     | [widgets/concert-diary](../../widgets/concert-diary/PROJECT.md)         |

Concert Discovery and Festival Follower are forward-looking (what's coming up). Concert Diary is backward-looking (shows I've attended, with photos and notes).

---

## 2. MVP Scope

- Page route at `/event-tracker`
- Both widgets rendered on the page
- No page-level logic — each widget is self-contained

---

## 3. Open Questions

- Should this page also show a unified "upcoming events" view merging individual shows (Concert Discovery) and festival dates (Festival Follower) into one calendar-style feed?
