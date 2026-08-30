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

# SMI-6286: root-cause fix, corrected during implementation from the plan's
# original theory. The plan assumed the npm Arborist null-deref
# ("Cannot read properties of null (reading 'edgesOut')") was a transient
# same-day-publish registry-propagation race, and "explicitly rejected"
# pinning a global npm version as a workaround for an "unfixed upstream
# bug." Live reproduction during implementation disproved that theory: the
# bare `npm install --omit=dev --ignore-scripts` against this package.json
# crashes 100% of the time on the node:22-slim image's bundled npm (10.9.8)
# — not intermittently — and installing npm@12.0.2 first makes the exact
# same install succeed every time. This is a real npm-CLI Arborist bug in
# the bundled version, not a registry-timing artifact, so upgrading npm is
# the actual fix rather than a maintenance-burden workaround. Pinned (not
# `npm install -g npm@latest`) for build reproducibility.
RUN npm install -g npm@12.0.2

# --ignore-scripts denies arbitrary postinstall scripts from the full transitive
# tree (no lockfile in this build context, so resolution is unpinned) — matches
# the root Dockerfile's own pattern (Dockerfile:64) rather than letting a
# compromised transitive dep auto-execute as root on Docker's signed-build infra.
#
# SMI-6286: retry loop kept as defense-in-depth against genuine transient
# registry issues (unrelated to the Arborist bug above, now fixed by the npm
# upgrade) — deliberately deviates from this repo's [1000,2000,4000]ms API-
# retry convention (linear-client.mjs:39) since a plain sleep-and-retry
# doesn't clear npm's cache between attempts. No guard/opt-out is added for
# this retry (unconditional, knob-free by design); if plan-review wants it
# disableable, it needs a --build-arg and a guards-and-opt-outs.md row.
RUN for i in 1 2 3; do \
      echo "[deps-retry] npm install attempt $i/3" && \
      npm install --omit=dev --ignore-scripts && break || { \
        [ $i -eq 3 ] && exit 1; \
        echo "[deps-retry] attempt $i/3 failed; clearing cache and retrying"; \
        npm cache clean --force; \
        rm -rf node_modules; \
        sleep $((i*30)); \
      }; \
    done

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
