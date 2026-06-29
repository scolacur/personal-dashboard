# TODO — Dashboard Shell

## Scaffold Overall UI Layout

- Nav with Links to All Pages
- Pages:
  - Home
  - Productivity
  - Health / Fitness
  - Music Production
  - DJing
  - Music Discovery
  - Event Tracker
  - Inboxes

## Additional widgets (in roughly the order I want them)

- Acute Strategies Generator
- Agent Dashboard / Mission Control (in pages/agent-dashboard)
- Pomodoro timer
- Music Picker (in widgets/music-picker)
- Music Tracker
- Habit log
- Morning routine todo-list
- Concert Diary (in widgets/concert-diary)
- Concert Discovery (in widgets/concert-discovery)
- Vision Board (in widgets/vision-board)
- Festival Follower (in widgets/festival-follower)
- Reminders (in widgets/reminders)
- ---Below this line, not sure if i will build:----
- Diary
- Workout log
- Chat (in widgets/chat)

## UI improvements

- Widgets should be able to be re-sized and re-arranged in the page on an invisible grid system, similar to how Datadog works. When dragging, the gridlines become visible. Widget position should be remembered on page refresh.
- Widgets should all have a wrench icon in the bottom right corner that, when clicked, opens up that widget's settings view. There should be an animation that makes it look like the widget is a card flipping over, and the settings appear on the back of the card. Settings will be widget-specific.

## Shell improvements (defer until at least 3 widgets exist)

- Per-widget configuration UI (instead of editing `.env`)
- Dashboard customization (tile order, hide/show widgets)
- Dark mode toggle (just pick one for MVP)

## Auth

- Only if/when the dashboard is exposed beyond LAN.
- Simple single-user password or a reverse proxy with auth in front (Authelia, Tailscale, etc.).
