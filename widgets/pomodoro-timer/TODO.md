# TODO — Pomodoro Timer Widget

## Session Logging

- Persist completed pomodoros to SQLite so there's a history of focus sessions by day
- Simple stats: pomodoros completed today, this week

## Configurable Intervals

- Settings panel: adjust work duration, short break, long break
- Persist settings to the DB (or localStorage as a simpler option)

## Desktop Notifications

- Browser `Notification` API alert when an interval ends (useful when in another tab)

## Task Label

- Optional: attach a label to the current session ("what are you working on?")
- Shown in session history
