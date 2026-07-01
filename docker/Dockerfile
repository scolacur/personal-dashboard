# ── Build stage ───────────────────────────────────────────────────────────────
# Debian-slim (glibc), NOT alpine (musl): the compiled better-sqlite3 binary must
# match the glibc runtime stage below. A build toolchain (python3/make/g++) is
# installed here because no prebuilt better-sqlite3 binary matched this Node ABI,
# so node-gyp compiles it from source. The toolchain stays in THIS stage only —
# it never reaches the runtime image.
FROM node:20-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies (layer-cached until package files change)
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm ci

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY apps/server/ ./apps/server/
COPY apps/web/ ./apps/web/

# Build in dependency order
# No separate `shared` build step: @dashboard/shared is consumed from source —
# Vite bundles it into the web output, esbuild inlines it into the server
# bundle (see DECISIONS D-024).
RUN npm run build -w apps/web
RUN npm run build -w apps/server

# Strip dev dependencies in place, keeping the already-compiled better-sqlite3
# native binary. The pruned node_modules is copied into the runtime stage as-is,
# so the runtime never installs or compiles anything.
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
# Same base (node:20-slim / glibc) so the compiled native binary matches. No
# toolchain, no npm install — just the pruned node_modules + built artifacts.
FROM node:20-slim AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/build ./apps/web/build

# Build-time version stamp (git short SHA, passed by deploy.yml). Placed last so a
# new SHA only invalidates this tiny final layer — and changes the image digest,
# which is what triggers Watchtower to pull on the NAS.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
