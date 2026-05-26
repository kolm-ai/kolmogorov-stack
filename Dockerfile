# syntax=docker/dockerfile:1.7
#
# kolm server runtime image (Node 22 alpine, multi-stage).
#
# Stage 1 (builder): installs production deps deterministically from the
# lockfile under /app/node_modules.
# Stage 2 (runtime): minimal alpine + non-root `node` user, tini PID 1 for
# clean SIGTERM forwarding + zombie reaping, wget-based HEALTHCHECK probe.
#
# Build:   docker build -t kolm/server:latest .
# Run:     docker run --rm -p 8787:8787 -e ANTHROPIC_API_KEY=... kolm/server:latest

# -----------------------------------------------------------------------------
# Stage 1 - builder
# -----------------------------------------------------------------------------
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS builder
WORKDIR /app

# Native build tools for any optional binary deps (better-sqlite3, etc.).
# Stripped before the runtime stage so they never ship.
RUN apk add --no-cache --virtual .build-deps python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev

COPY . .

RUN apk del .build-deps

# -----------------------------------------------------------------------------
# Stage 2 - runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS runtime

# wget for HEALTHCHECK; tini for clean PID 1 signal forwarding so SIGTERM
# reaches the node process and graceful-shutdown hooks fire.
RUN apk add --no-cache wget tini

WORKDIR /app

# Persisted directories owned by the unprivileged `node` user shipped with
# the base image (uid 1000).
RUN mkdir -p /etc/kolm/keys /var/lib/kolm \
 && chown -R node:node /etc/kolm /var/lib/kolm /app

COPY --from=builder --chown=node:node /app /app

ENV NODE_ENV=production \
    PORT=8787 \
    KOLM_DATA_DIR=/var/lib/kolm

USER node

EXPOSE 8787

# Detailed /health is asserted by the W890-13 lock-ins; the probe checks
# that the listener is up and the response is well-formed JSON.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://localhost:8787/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
