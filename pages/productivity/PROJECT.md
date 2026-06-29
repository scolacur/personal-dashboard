# Productivity — PROJECT.md

A page grouping personal productivity widgets: habits, morning routine, focus timer, and journaling.

See also: [TODO.md](TODO.md)

---

## 1. Widgets on this page

| Widget          | Folder                                                              |
| --------------- | ------------------------------------------------------------------- |
| Morning Routine | [widgets/morning-routine](../../widgets/morning-routine/PROJECT.md) |
| Reminders       | [widgets/reminders](../../widgets/reminders/PROJECT.md)             |
| Habit Log       | [widgets/habit-log](../../widgets/habit-log/PROJECT.md)             |
| Pomodoro Timer  | [widgets/pomodoro-timer](../../widgets/pomodoro-timer/PROJECT.md)   |
| Diary           | [widgets/diary](../../widgets/diary/PROJECT.md)                     |
| Vision Board    | [widgets/vision-board](../../widgets/vision-board/PROJECT.md)       |

---

## 2. MVP Scope

- Page route at `/productivity`
- Renders the above widget tiles in a sensible layout
- No page-level configuration or logic — each widget is self-contained

## 3. Not in MVP

- Trello board or Linear integration (either direct embed or use API)

---

## 3. Open Questions

- Should the Pomodoro Timer appear here as a full tile, or only as the persistent floating element defined in the shell? A: Lets show it here as a full tile. Maybe it can be a sort of "advanced" version with more features.
- Does Workout Log belong here or on Health / Fitness? A: Put workout log in health / fitness.
- Worth moving all tasks from Trello to linear if i'm going to integrate them here?
