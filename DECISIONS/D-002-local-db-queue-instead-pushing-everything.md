# D-002: Local DB queue instead of pushing everything to Lidarr automatically

**Decision:** Detected tracks land in a local SQLite database with a review/approval step. Lidarr API integration is deferred entirely; for MVP there's just a link out to the Lidarr UI.

**Reasoning:**

- Lidarr is album/artist-oriented and uses MusicBrainz for metadata. Mixes, bootlegs, white labels, and a lot of the rare electronic music I track are not in MusicBrainz, so Lidarr can't find them.
- "Point Lidarr at a custom DB as a source" isn't actually a thing Lidarr supports — its sources are MusicBrainz (metadata) and indexers (downloads). So the originally-considered "Option B" wasn't real.
- A local queue with manual review fits the actual content type better, and matches my stated preference for confirming replacements anyway.
- Keeps the architecture flexible for the future "swap Lidarr for direct mp3 site queries" feature, since the acquisition mechanism is decoupled from detection.

**Implications:** I am not building "a Lidarr alternative." I'm only replacing Lidarr's catalog-of-wants function (and only for tracks). Indexer search, quality decisioning, and download client integration stay out of scope.

**Revisit if:** The bulk of what I track turns out to be in MusicBrainz after all, and the manual review step feels redundant. Then it's worth adding the "auto-push to Lidarr" path as a per-source option.
