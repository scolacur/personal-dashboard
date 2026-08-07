# D-041: Cmd+K shortcut uses metaKey-only (no Ctrl+K fallback) and toggles search focus (PD-126)

**Decision:** The `⌘K` keyboard shortcut on the Task Monitor board only checks `e.metaKey` (Mac Command key), not `e.ctrlKey`. Focus is toggled: pressing again while the search is focused blurs it.

**Reasoning:** The issue specifies "Mac(Command)+K". Ctrl+K is used by browsers on some platforms to focus the URL/search bar, so adding a Ctrl+K fallback could interfere. The toggle behavior (focus → blur on second press) is standard command-palette UX and avoids a second shortcut to dismiss.

**Alternative:** Support `metaKey || ctrlKey` to cover Linux/Windows. Rejected for now since this is a personal Mac-only dashboard.
