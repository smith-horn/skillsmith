# Standalone build context for the Docker MCP registry (docker/mcp-registry,
# source.directory: packages/mcp-server) — separate from the repo-root Dockerfile.
# `dist/` must be pre-built (repo-root `npm run build`) before `docker build` runs;
# see docs/internal/implementation/docker-mcp-registry-publish.md item 1 (open question).

# -----------------------------------------------------------------------------
# Stage 1: deps - install dependencies with native-module build tools present
# -----------------------------------------------------------------------------
FROM node:22-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

WORKDIR /app

COPY package.json ./

# --ignore-scripts denies arbitrary postinstall scripts from the full transitive
# tree (no lockfile in this build context, so resolution is unpinned) — matches
# the root Dockerfile's own pattern (Dockerfile:64) rather than letting a
# compromised transitive dep auto-execute as root on Docker's signed-build infra.
RUN npm install --omit=dev --ignore-scripts

# Explicit rebuild of the native optionalDependencies that --ignore-scripts skipped
# (better-sqlite3, onnxruntime-node, hnswlib-node), matching Dockerfile:73.
RUN npm rebuild better-sqlite3 onnxruntime-node hnswlib-node || true

COPY dist/ ./dist/

# -----------------------------------------------------------------------------
# Stage 2: runtime - lean image, no build tools, non-root user
# -----------------------------------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /app

RUN groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home nodejs

COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=nodejs:nodejs /app/dist ./dist
COPY --chown=nodejs:nodejs package.json ./

USER nodejs

ENV NODE_ENV=production

CMD ["node", "dist/src/index.js"]
