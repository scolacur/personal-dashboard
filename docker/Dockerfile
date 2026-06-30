# ── Build stage ───────────────────────────────────────────────────────────────
# Debian-slim (glibc), NOT alpine (musl): better-sqlite3 ships prebuilt glibc
# binaries, so `npm ci` fetches them via prebuild-install with no node-gyp/Python
# compile. On alpine there is no musl prebuild -> it falls back to compiling and
# fails (no Python/build-tools). glibc here also matches the glibc runtime below.
FROM node:20-slim AS build
WORKDIR /app

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
RUN npm run build -w packages/shared
RUN npm run build -w apps/web
RUN npm run build -w apps/server

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
# Scripts ON (no --ignore-scripts): better-sqlite3's install script must run so
# its prebuilt native binary is fetched into the prod node_modules. The web
# `prepare` (svelte-kit sync) is guarded with `|| true` in apps/web/package.json,
# so it safely no-ops here where svelte-kit (a devDependency) is absent.
RUN npm ci --omit=dev

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/build ./apps/web/build

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
