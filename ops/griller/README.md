# Griller worker — deploy checklist

The **griller** is the dashboard-owned interactive triage agent (DECISIONS **D-044**): a
Claude Agent SDK / Opus worker that grills a ticket with Steve, then proposes a commit
(refine-in-place or decompose) for approval. It runs as a **separate, egress-hardened
container** from the web app — it holds `ANTHROPIC_API_KEY` and does long LLM turns, so it is
deliberately **NOT** part of the web app's CI/CD. Deploy it by hand with the steps below.

Transport between the web app and the griller is the **shared SQLite DB** (`dashboard.db`),
not HTTP — so the griller's `/data` mount MUST be the same host directory the web app mounts
as `/data`, or it opens a different DB and never sees your tickets.

## Prerequisites

- Prod host = the **NAS** (`192.168.68.50`), Synology `/volume1/...` layout. (On the Mac Mini /
  Colima, adjust the host paths per DECISIONS **D-035**.)
- The repo is checked out on the host at
  `/volume1/docker/personal-dashboard/personal-dashboard/`.
- Two secrets (see [Secrets & tokens](#secrets--tokens)): an Anthropic API key and a GitHub
  token with **Contents: Read** on `scolacur/personal-dashboard`.
- `docker` on the host needs `sudo` (interactive — the NAS sudo is password-gated).

## Deploy

Run on the NAS over SSH:

```bash
# 1. Get main onto the host checkout (the dir the compose's squid.conf path points at)
cd /volume1/docker/personal-dashboard/personal-dashboard
git checkout main && git pull --ff-only

# 2. Create the griller's OWN env file — NOT the web app's .env
cp ops/griller/griller.env.example /volume1/docker/personal-dashboard/griller.env
#    edit it and fill in ANTHROPIC_API_KEY and GITHUB_READ_TOKEN

# 3. Build the image (build context = repo root)
sudo docker build -f ops/griller/Dockerfile -t griller-dashboard .

# 4. Bring it up on the egress-hardened network (proxy sidecar + internal net)
sudo docker compose -f ops/griller/docker-compose.egress.yml up -d

# 5. Watch it boot and take a turn
sudo docker logs -f griller
```

## Verify

Healthy boot logs, in order:

- `griller worker starting`
- `cloning grounding checkout` (first run only; later runs `git pull` the existing checkout)
- `griller ready — polling for Refine turns`

Then click **Refine** on a prod ticket. When the agent replies you should see:

- `refine: posted turn` with `warm:false` on the first turn, then `warm:true` +
  a non-zero `cacheReadTokens` on your next reply (that's the warm-session cache hit).
- If the agent proposes a commit, a `refine_proposal` row appears and the **Proposed changes**
  panel shows on the ticket-detail page.

## Secrets & tokens

Both live ONLY in `griller.env` (mounted as the container's `env_file`) — never in the web
app's `.env`. The `ANTHROPIC_API_KEY` must never reach the user-facing web process.

- **`ANTHROPIC_API_KEY`** — any valid key works; a dedicated key gives separate cost tracking,
  its own rate-limit budget, and a revocation blast-radius limited to the griller.
- **`GITHUB_READ_TOKEN`** — used only to clone/pull the grounding checkout, so it needs
  **Contents: Read** on `scolacur/personal-dashboard`. Note the dashboard's _existing_ read
  token (PD-165) is scoped for **Issues: Read** — a fine-grained Issues-only PAT **cannot
  clone**. Use a classic `repo`/`public_repo` PAT, or a fine-grained PAT with Contents: Read.

## Redeploy after a code change

The griller image is a build artifact — merging griller changes to `main` does **not** update
the running container. Rebuild and recreate:

```bash
cd /volume1/docker/personal-dashboard/personal-dashboard && git pull --ff-only
sudo docker build -f ops/griller/Dockerfile -t griller-dashboard .
sudo docker compose -f ops/griller/docker-compose.egress.yml up -d   # recreates from the new image
```

## Troubleshooting

- **Turns hang / API errors** — the griller reaches `api.anthropic.com` only through the squid
  sidecar (reuses Sortie's `ops/sortie/squid.conf`, which allowlists `.anthropic.com` +
  `.github.com`). Check the proxy env vars in the compose and the squid allowlist.
- **Griller sees no tickets** — the `/data` mount isn't the web app's DB dir; confirm both
  containers mount `/volume1/docker/personal-dashboard/data` as `/data`.
- **Clone fails** — the `GITHUB_READ_TOKEN` lacks Contents: Read (see above).
- **Container can't write `/data`** — the griller runs as uid 1002; the host `data` dir must be
  writable by it (it's world-writable in the standard layout).
