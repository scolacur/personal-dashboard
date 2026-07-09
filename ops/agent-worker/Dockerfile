# agent-worker image (DECISIONS D-044, PD-266; generalized D-045, PD-282).
#
# A dashboard-owned interactive triage agent (Claude Agent SDK / Opus). Runs as a
# SEPARATE container from the web app — it holds ANTHROPIC_API_KEY and does long LLM
# turns, so it must be isolated from the user-facing Fastify process. Deployed on the
# egress-hardened network (see ops/agent-worker/docker-compose.egress.yml): its only route
# out is the shared squid proxy.
#
# node:24-slim (not the app's node:20): the Agent SDK wants Node 22.15+ for the OS
# cert store, and NODE_USE_ENV_PROXY (which makes Node's fetch honor the proxy env) is
# Node 24+. Mirrors the multi-stage build of docker/Dockerfile.
#
# Build (from the repo root):
#   docker build -f ops/agent-worker/Dockerfile -t agent-worker-dashboard .

# ── Build stage ───────────────────────────────────────────────────────────────
# glibc (not alpine): the compiled better-sqlite3 binary must match the runtime.
FROM node:24-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps (layer-cached until package files change). npm ci tolerates the
# other workspace folders being absent, so we copy only what the agent-worker build
# needs: the root manifest/lock, shared (inlined from source), and agent-worker itself.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/agent-worker/package.json ./apps/agent-worker/
RUN npm ci

# Source. shared is consumed from SOURCE (esbuild inlines it — DECISIONS D-024).
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY apps/agent-worker/ ./apps/agent-worker/

RUN npm run build -w apps/agent-worker

# Strip dev deps, keeping the compiled better-sqlite3 binary + the Agent SDK.
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app

# git + ca-certificates: the worker clones/pulls the read-only grounding checkout.
# gh + curl: the Robot loop's coding session (D-055/PD-342) pushes + opens PRs with `gh`.
# gh isn't in Debian's default repos, so add the official GitHub CLI apt source (the build
# stage has internet — the egress restriction is a RUNTIME network, not build-time).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# The Robot coding uid (D-055 privilege-split, PD-342). The loop process runs as root (it owns
# dashboard.db); the coding session is spawned DROPPED to this uid — its home is writable to it
# (git/gh/npm config + cache) but it has NO read access to the root-600 dashboard.db. Used only
# when ROBOT_CODING_UID/GID point at it (1500); otherwise the coding session inherits root (dev).
# nologin: the account is a spawn target, never a login shell.
RUN groupadd -g 1500 robot \
  && useradd -u 1500 -g 1500 -m -d /home/robot -s /usr/sbin/nologin robot

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/agent-worker/package.json ./apps/agent-worker/

# Both node_modules trees: most deps hoist to the root, but any that can't (e.g. pino,
# whose version conflicts with another package's) stay in the workspace's own node_modules.
# Node resolves from apps/agent-worker/dist upward, so it needs BOTH present at runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/agent-worker/node_modules ./apps/agent-worker/node_modules
COPY --from=build /app/apps/agent-worker/dist ./apps/agent-worker/dist

# The LOOP process runs as root (the node base default — no USER drop). The agent-worker shares
# dashboard.db with the web app, which runs as root and OWNS that file plus its WAL/-shm sidecars;
# it also creates the grounding checkout under the mounted /data. The loop must match the web
# app's uid to share the DB read+write. The security boundary for the container as a whole is the
# egress-hardened network (squid allowlist), not the in-container uid.
#
# The Robot coding session is the ONE exception: it is spawned DROPPED to the `robot` uid above
# (D-055), so it structurally cannot read the root-600 dashboard.db — enforcing D-039 by the
# kernel. That drop happens only when ROBOT_CODING_UID/GID are set; the loop itself stays root.

ENV NODE_ENV=production
# Make Node's global fetch honor HTTP(S)_PROXY (Node 24+); the compose sets the proxy.
ENV NODE_USE_ENV_PROXY=1

CMD ["node", "apps/agent-worker/dist/index.js"]
