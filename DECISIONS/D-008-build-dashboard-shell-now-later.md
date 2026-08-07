# D-008: Build dashboard shell now, not later

**Decision:** PROJECT.md scopes both the shell and the first widget as MVP, not just the music tracker.

**Reasoning:** Conventions (widget registry, shared types, backend module boundaries) are much easier to establish before there's existing widget code to retrofit. The shell itself is cheap — a tile grid, a widget registry on each side, and a routing convention. The investment pays off the second widget.

**Revisit if:** I lose interest in building additional widgets after the music tracker. In that case the shell adds no value over a standalone app, but the cost was small enough that it's not worth tearing out.
