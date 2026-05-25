# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
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
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/build ./apps/web/build

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
