# Pomodoro Timer — PROJECT.md

A persistent floating Pomodoro timer that sits in the bottom corner of the dashboard. Stays visible regardless of which widget page the user is on.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- Start / pause / reset controls
- Set to a certain interval length, set # intervals, set break length, and add a label. 
- Visual countdown display
- Audible alert when interval ends (browser `AudioContext` beep or a sound file)
- State lives entirely in the frontend — no backend or DB needed for MVP
- Floats persistently in the corner via the dashboard shell layout (not a widget card, more of a shell-level component)

### Explicitly NOT in MVP

- Maybe a few options for alarm sounds too.
- Session logging / history
- optional longer break after x intervals
- Configurable interval lengths
- Desktop notifications
- Integration with Habit Log or other widgets

---

## 2. Implementation Notes

- Pure frontend component; no server routes required
- State managed in a Svelte store so it survives navigation between widget pages
- Shell layout (`+layout.svelte`) renders it outside the main content area

---

## 3. Open Questions

- Corner position: bottom-right conflicts with widget settings wrench icon — pick bottom-left, or make it draggable?
- Sound: a simple `AudioContext` tone is simplest; a short chime file is nicer but adds an asset to manage.
