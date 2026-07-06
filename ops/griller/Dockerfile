# Griller worker image (DECISIONS D-044, PD-266).
#
# A dashboard-owned interactive triage agent (Claude Agent SDK / Opus). Runs as a
# SEPARATE container from the web app — it holds ANTHROPIC_API_KEY and does long LLM
# turns, so it must be isolated from the user-facing Fastify process. Deployed on the
# egress-hardened network (see ops/griller/docker-compose.egress.yml): its only route
# out is the shared squid proxy.
#
# node:24-slim (not the app's node:20): the Agent SDK wants Node 22.15+ for the OS
# cert store, and NODE_USE_ENV_PROXY (which makes Node's fetch honor the proxy env) is
# Node 24+. Mirrors the multi-stage build of docker/Dockerfile.
#
# Build (from the repo root):
#   docker build -f ops/griller/Dockerfile -t griller-dashboard .

# ── Build stage ───────────────────────────────────────────────────────────────
# glibc (not alpine): the compiled better-sqlite3 binary must match the runtime.
FROM node:24-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps (layer-cached until package files change). npm ci tolerates the
# other workspace folders being absent, so we copy only what the griller build
# needs: the root manifest/lock, shared (inlined from source), and griller itself.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/griller/package.json ./apps/griller/
RUN npm ci

# Source. shared is consumed from SOURCE (esbuild inlines it — DECISIONS D-024).
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY apps/griller/ ./apps/griller/

RUN npm run build -w apps/griller

# Strip dev deps, keeping the compiled better-sqlite3 binary + the Agent SDK.
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app

# git + ca-certificates: the worker clones/pulls the read-only grounding checkout.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/griller/package.json ./apps/griller/

# Both node_modules trees: most deps hoist to the root, but any that can't (e.g. pino,
# whose version conflicts with another package's) stay in the workspace's own node_modules.
# Node resolves from apps/griller/dist upward, so it needs BOTH present at runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/griller/node_modules ./apps/griller/node_modules
COPY --from=build /app/apps/griller/dist ./apps/griller/dist

# uid 1002 — node base uses 1000, Sortie uses 1001; avoid collisions. Must be able
# to write the mounted /data (checkout + SQLite WAL); host data dir is world-writable.
RUN useradd --create-home --uid 1002 griller
USER griller

ENV NODE_ENV=production
# Make Node's global fetch honor HTTP(S)_PROXY (Node 24+); the compose sets the proxy.
ENV NODE_USE_ENV_PROXY=1

CMD ["node", "apps/griller/dist/index.js"]
