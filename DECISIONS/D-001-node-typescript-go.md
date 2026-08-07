# D-001: Node + TypeScript, not Go

**Decision:** Backend is Node.js + TypeScript with Fastify. Go is parked for a future widget.

**Reasoning:**

- I'm learning the language _and_ gluing together many external APIs (Spotify, eventually Lidarr, YouTube, SoundCloud, Bandcamp). The Node ecosystem for this domain is dramatically better: `@spotify/web-api-ts-sdk`, `music-metadata`, `node-cron`, and SDKs for everything else.
- I already know TypeScript — shared types and tooling with the Svelte frontend is a real win, especially for a dashboard hosting many small apps.
- Go's strengths (CPU-bound work, concurrency, deployment as a single binary) don't apply here. The workload is I/O-bound API glue.

**Revisit if:** A future widget is CPU-bound or concurrency-heavy (audio processing, real-time data, scraping at scale). Good candidate to introduce Go as a sidecar service.
