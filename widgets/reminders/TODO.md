# TODO — Reminders Widget

## Voice Input

- Use the Web Speech API (`SpeechRecognition`) to capture voice input for the note field
- Parse the spoken text for a date/time using `chrono-node` (handles "tomorrow at 3pm", "next Tuesday morning", etc.) — extract it as the `remindAt` value and the remainder as the note
- Fallback: if no date is detected in the speech, pre-fill the note field and let the user pick a time manually
- "Hey remind me at 5pm to take out the trash" should produce remindAt=today 17:00, note="take out the trash"

## Natural Language Date Input (Text)

- Add a free-text "when" field alongside or instead of the datetime picker
- Wire to `chrono-node` on submit to parse the natural language into a unix ms timestamp
- Show the parsed result ("interpreted as: Thursday, May 29 at 5:00 PM") before confirming

## Recurring Reminders

- Repeat options: daily, weekly, custom interval
- Each recurrence creates a new `pending` row when the current one is cleared

## Web Push Notifications (Service Worker)

- For use when the dashboard tab is not open — full Web Push with VAPID keys
- Required if the user wants reminders to fire on mobile while not actively viewing the dashboard

## Notification Sound

- Play a short audio cue (via `AudioContext`) when an alert fires, in addition to the visual takeover
- Configurable: on/off in widget settings

## Reminder Templates / Quick-Add

- Pre-defined common reminders ("Take medication", "Stand up", etc.) accessible with one tap
