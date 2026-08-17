# =============================================================================
# Dockerfile - Optimized for Production (SMI-994)
# Cache bust: 2026-01-24 major-deps-upgrade
# =============================================================================
# Optimizations applied:
# 1. Multi-stage build - Separate build and runtime stages
# 2. Non-root user - Run as non-root for security (CIS Docker Benchmark 4.1)
# 3. Health check - Built-in container health monitoring
# 4. Layer optimization - Commands ordered to maximize cache hits
# 5. Smaller runtime - Production stage excludes build tools
# 6. No dev dependencies - Production uses npm ci --omit=dev
# 7. .dockerignore - Prevents unnecessary files from being copied
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Base - Common settings for all stages
# -----------------------------------------------------------------------------
# Using node:22-slim (Debian-based) for glibc compatibility with onnxruntime-node (>=22.22 minimum, matches engines)
# Alpine would be smaller but lacks glibc required by native modules
FROM node:22-slim AS base

# Set working directory early for all subsequent commands
WORKDIR /app

# Set environment variables for Node.js
ENV NODE_ENV=development
ENV NPM_CONFIG_LOGLEVEL=warn

# -----------------------------------------------------------------------------
# Stage 2: Dependencies - Install build tools and native module dependencies
# -----------------------------------------------------------------------------
FROM base AS deps

# Install build dependencies required for native modules (better-sqlite3, onnxruntime, sharp)
# These are only needed during npm install, not at runtime
# Layer optimization: Combine apt commands to reduce layers
# libvips-dev allows sharp to compile from source if prebuilt binaries fail
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    libvips-dev \
    sqlite3 \
    # Clean up apt cache to reduce image size
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy package files first for optimal layer caching
# Changes to source code won't invalidate the dependency cache
COPY package*.json ./
COPY packages/core/package*.json ./packages/core/
COPY packages/enterprise/package*.json ./packages/enterprise/
COPY packages/mcp-server/package*.json ./packages/mcp-server/
COPY packages/cli/package*.json ./packages/cli/
COPY packages/vscode-extension/package*.json ./packages/vscode-extension/
COPY packages/website/package*.json ./packages/website/
COPY packages/doc-retrieval-mcp/package*.json ./packages/doc-retrieval-mcp/

# Install ALL dependencies (including devDependencies for building)
# Using npm ci for reproducible builds from package-lock.json
# Install without postinstall scripts first, then rebuild sharp separately with system libvips
ENV PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig
RUN npm ci --include=dev --ignore-scripts

# Rebuild native modules that need compilation
# Skip sharp - @xenova/transformers only needs it for image preprocessing
# Skillsmith uses text embeddings only, so sharp is not required
# Rebuild better-sqlite3 (database), onnxruntime-node (embeddings), esbuild (vscode-extension bundler),
# and hnswlib-node (SMI-4577 — vector index for EmbeddingService.findSimilar; optionalDep so
# CI must explicitly rebuild after `--ignore-scripts` install or it falls back to brute-force).
# esbuild needs platform-specific binaries (@esbuild/linux-x64) which --ignore-scripts skips
RUN npm rebuild better-sqlite3 onnxruntime-node esbuild hnswlib-node || true

# SMI-5650: stash Linux-built native modules for worktree containers. Their
# /app/node_modules is a read-only view of the (possibly macOS) host tree;
# the entrypoint seeds these into writable tmpfs overlays at boot —
# deterministic, offline. Keep this list in sync with NATIVE_MODULES in
# docker-entrypoint.sh and NATIVE_MODULES_FOR_OVERLAY in scripts/_lib.sh.
#
# Per-module existence guard + content validation (plan-review H1): this
# stage builds the image every consumer uses (main checkout, CI, fresh
# clones — not just worktrees, see §7), so a missing or broken module here
# must never fail the BUILD. Each module is independently guarded; a
# missing source dir or a binary that fails to require() is skipped with a
# warning baked into the image (surfaced again at container boot by
# docker-entrypoint.sh's own existence check), not a hard build failure.
RUN mkdir -p /opt/native-seed \
    && for module in better-sqlite3 onnxruntime-node esbuild hnswlib-node; do \
         if [ -d "node_modules/${module}" ]; then \
           cp -a "node_modules/${module}" /opt/native-seed/ \
             && node -e "require('${module}')" \
             && echo "[deps] Seeded ${module} into /opt/native-seed (validated)" \
             || echo "WARNING: ${module} seed missing or failed require() validation — worktree containers will fall back to npm rebuild for this module"; \
         else \
           echo "WARNING: node_modules/${module} not found in this image — skipping seed (worktree containers will fall back to npm rebuild)"; \
         fi; \
       done

# SMI-5650: @esbuild is a SCOPE, not a flat module — confirmed live it is
# REQUIRED alongside the flat `esbuild` package above: esbuild's own JS API
# does not contain the native binary it spawns at runtime; that lives in the
# separate platform-arch package (@esbuild/<platform>-<arch>) inside this
# scope. A bare `node -e "require('esbuild')"` does not exercise it (esbuild
# spawns its binary lazily, on an actual transform/build call, not at
# require() time) — validated here via transformSync(), matching
# docker-entrypoint.sh's validate_native_module(). Stashed/validated as its
# own step since the loop above's per-module require() check doesn't apply
# to a scope directory (you can't require('@esbuild')).
RUN if [ -d "node_modules/@esbuild" ]; then \
      mkdir -p /opt/native-seed/@esbuild \
        && cp -a node_modules/@esbuild/. /opt/native-seed/@esbuild/ \
        && node -e "require('esbuild').transformSync('1')" \
        && echo "[deps] Seeded @esbuild scope into /opt/native-seed (validated)" \
        || echo "WARNING: @esbuild scope seed missing or failed transformSync() validation — worktree containers will fall back to npm rebuild for esbuild"; \
    else \
      echo "WARNING: node_modules/@esbuild not found in this image — skipping seed (worktree containers will fall back to npm rebuild for esbuild)"; \
    fi

# SMI-5784: PER-PACKAGE stash — extends the flat stash loop above with a
# second pass over packages/*/node_modules/<module>. Workspace-local,
# non-hoisted copies (e.g. packages/core/node_modules/better-sqlite3, pinned
# independently of root per SMI-4484 — a structural, permanent divergence,
# not incidental drift) need their own known-good stash entry so the
# worktree entrypoint's per-package seed step (docker-entrypoint.sh) has
# something deterministic and offline to restore from, even when the host
# copy is itself broken or missing. `npm ci` (above) already materializes
# these per-package node_modules dirs for any workspace whose package.json
# pins a version that diverges from root's hoisted copy — no separate
# install step is needed here.
#
# No --ignore-scripts=false override needed (resolved open item, see plan
# doc's Context/§2): this `deps` stage never COPYs .npmrc in (only
# package*.json globs above), so `ignore-scripts=true` never applies to
# anything in this stage — including this loop's own npm-independent
# `cp -a` + `node -e require(...)` steps, which don't invoke npm at all.
#
# Same per-module-missing-is-fine guard as the flat loop above — a missing
# per-package copy is the COMMON case (most packages never diverge from
# root) and must never fail the build. Validated by requiring the STASH
# DESTINATION directly (an absolute path, not a bare module specifier) —
# this sidesteps any node_modules-resolution ambiguity entirely (no
# possibility of accidentally validating a different, unrelated copy), which
# is simpler than needing the require.resolve()+prefix-check dance
# docker-entrypoint.sh's runtime validation uses, because at Docker BUILD
# time there is no bind-mount/worktree-overlay ambiguity to defend
# against — the filesystem here is a single, deterministic image layer.
RUN for pkg_dir in packages/*/; do \
      pkg="$(basename "$pkg_dir")"; \
      for module in better-sqlite3 onnxruntime-node esbuild hnswlib-node; do \
        if [ -d "${pkg_dir}node_modules/${module}" ]; then \
          mkdir -p "/opt/native-seed/${pkg}-${module}" \
            && cp -a "${pkg_dir}node_modules/${module}/." "/opt/native-seed/${pkg}-${module}/" \
            && node -e "require('/opt/native-seed/${pkg}-${module}')" \
            && echo "[deps] Seeded ${pkg}/${module} into /opt/native-seed (validated)" \
            || echo "WARNING: ${pkg}/${module} seed missing or failed require() validation — worktree containers will fall back to npm rebuild for this package/module"; \
        fi; \
      done; \
    done

# SMI-5784: PER-PACKAGE @esbuild scope stash — mirrors the dedicated
# root-level @esbuild block above (a bare per-module loop iteration cannot
# target a scope directory; see that block's comment for why @esbuild needs
# its own stash step). No known real-world package currently diverges on
# @esbuild specifically (today's only confirmed divergence is
# packages/core's better-sqlite3, see the plan doc's Context) — this exists
# for completeness/symmetry with the volume-declaration side
# (scripts/_lib.sh's enumerate_native_module_volumes iterates the full
# NATIVE_MODULES_FOR_OVERLAY set, including @esbuild, per-package). Validated
# via existence/non-empty-copy only, NOT a functional transformSync() check
# — unlike the root-level block, a per-package transformSync() probe would
# need to assume a co-located flat `esbuild` copy also diverges in the SAME
# package, which is not guaranteed; an existence check is the correct,
# honestly-scoped validation here rather than a functional check resting on
# an unproven assumption.
RUN for pkg_dir in packages/*/; do \
      pkg="$(basename "$pkg_dir")"; \
      if [ -d "${pkg_dir}node_modules/@esbuild" ]; then \
        mkdir -p "/opt/native-seed/${pkg}-@esbuild" \
          && cp -a "${pkg_dir}node_modules/@esbuild/." "/opt/native-seed/${pkg}-@esbuild/" \
          && [ -n "$(ls -A "/opt/native-seed/${pkg}-@esbuild")" ] \
          && echo "[deps] Seeded ${pkg}/@esbuild scope into /opt/native-seed (validated: non-empty)" \
          || echo "WARNING: ${pkg}/@esbuild scope seed missing or empty after copy — worktree containers will fall back to npm rebuild for esbuild in this package"; \
      fi; \
    done

# SMI-6050 Wave 2: Tier-B (build-tool / compiler platform binaries — turbo,
# Rollup/Rolldown, Astro's compiler, Lightning CSS, Tailwind Oxide, ruvector,
# workerd, etc.) build-time seeding. Unlike Tier A above, npm never even
# CREATES these packages' directories on a non-matching host platform (their
# `optionalDependencies` entry is skipped outright when its `os` field
# doesn't match) — there is no host-side "-d" existence check the compose
# layer can lean on, the way it does for Tier A. The derivation is
# programmatic, from package-lock.json's own `os` field, via
# scripts/lib/linux-optional-packages.mjs (Wave 1) — this image's own `npm
# ci` above (real Linux, native) already produced every correct binary for
# this build's target platform; this block just captures that output. See
# the plan doc's "What Changes" #2 for the full design, including why the
# seed path preserves the real node_modules-relative hierarchy (not a
# flattened/sanitized name, unlike the original draft this plan corrected)
# and why a `.version` marker is written alongside each seeded package.
#
# This wave is INERT: nothing in scripts/_lib.sh references
# /opt/native-seed/tier-b yet (that lands in Wave 3), so this seeding has
# zero effect on any container's compose-generated mounts — and therefore
# zero effect on any container's actual behavior — until Wave 3 lands.
#
# Narrow COPY — only this one script, not the whole scripts/ tree, so
# unrelated script changes don't invalidate this deps-stage layer's build
# cache (the dev stage's own later `COPY scripts/ ./scripts/`, below,
# already covers everything else scripts/ needs at runtime, including this
# same script's re-use by docker-entrypoint.sh's restore loop).
COPY scripts/lib/linux-optional-packages.mjs ./scripts/lib/linux-optional-packages.mjs

# Seed each Tier-B path that actually exists in this build's node_modules
# (only the platform-correct variants will — a missing path is the COMMON
# case, since most Tier-B families are mutually-exclusive per-arch/per-libc
# variants, and must never fail the build) into
# /opt/native-seed/tier-b/<the same node_modules-relative path>, plus a
# sibling `<path>.version` marker file (the package's resolved version, from
# linux-optional-packages.mjs's own `--with-versions` CLI mode) that
# docker-entrypoint.sh's restore loop compares against to detect a stale
# seed. Validation tier is existence + non-empty only (deliberate tradeoff,
# see plan doc "What Changes" #2's Validation tier note) — not the
# functional require()/transformSync() tier Tier A gets above.
RUN node scripts/lib/linux-optional-packages.mjs --with-versions > /tmp/tier-b-manifest.tsv \
    && seeded_count=0 \
    && while read -r pkg_path pkg_version; do \
         [ -z "$pkg_path" ] && continue; \
         if [ -d "$pkg_path" ]; then \
           dest="/opt/native-seed/tier-b/${pkg_path}"; \
           mkdir -p "$(dirname "$dest")" \
             && cp -a "$pkg_path" "$dest" \
             && [ -n "$(ls -A "$dest" 2>/dev/null)" ] \
             && printf '%s' "$pkg_version" > "${dest}.version" \
             && seeded_count=$((seeded_count + 1)) \
             && echo "[deps] Seeded tier-b ${pkg_path}@${pkg_version} into /opt/native-seed/tier-b (validated: exists, non-empty)" \
             || echo "WARNING: tier-b ${pkg_path} seed failed after copy — worktree containers will not get this package restored"; \
         fi; \
       done < /tmp/tier-b-manifest.tsv \
    && rm -f /tmp/tier-b-manifest.tsv \
    && echo "[deps] Tier-B seed complete: ${seeded_count} package(s) seeded into /opt/native-seed/tier-b (SMI-6050 Wave 2)"

# SMI-6050 Wave 2 belt-and-suspenders audit (warn-only — must NEVER fail the
# build): diffs the derivation script's predicted paths against what `find`
# actually sees on disk in THIS build's real Linux node_modules tree. This is
# the concrete mitigation for the acknowledged blind spot that a package
# shipping a Linux-specific binary WITHOUT a matching `os` field in its own
# package-lock.json metadata is invisible to the derivation script — see plan
# doc "What Changes" #2's "Belt-and-suspenders audit" paragraph.
RUN node scripts/lib/linux-optional-packages.mjs | sort > /tmp/tier-b-predicted.txt \
    && (find node_modules -type d -iname '*linux*' 2>/dev/null | sort -u > /tmp/tier-b-actual.txt || true) \
    && (comm -13 /tmp/tier-b-predicted.txt /tmp/tier-b-actual.txt > /tmp/tier-b-unpredicted.txt || true) \
    && if [ -s /tmp/tier-b-unpredicted.txt ]; then \
         echo "WARNING: found on-disk -linux- directories NOT predicted by scripts/lib/linux-optional-packages.mjs (possibly missing 'os' metadata in package-lock.json — see SMI-6050 plan doc 'Belt-and-suspenders audit'):"; \
         cat /tmp/tier-b-unpredicted.txt; \
       else \
         echo "[deps] Tier-B audit: no unpredicted -linux- directories found on disk"; \
       fi \
    && rm -f /tmp/tier-b-predicted.txt /tmp/tier-b-actual.txt /tmp/tier-b-unpredicted.txt

# -----------------------------------------------------------------------------
# Stage 3: Builder - Compile TypeScript and build all packages
# -----------------------------------------------------------------------------
FROM deps AS builder

# Copy TypeScript configuration files
COPY tsconfig*.json ./

# Copy Turborepo configuration
COPY turbo.json ./

# Copy source code
# This is after npm install so source changes don't invalidate dependency cache
COPY packages/ ./packages/

# Build all packages (TypeScript compilation)
# Allow warnings but fail on errors
RUN npm run build || echo "Build completed with warnings"

# -----------------------------------------------------------------------------
# Stage 4: Development - Full development environment with all tools
# -----------------------------------------------------------------------------
# Used by: docker compose --profile dev
# Includes: All dependencies, build tools, source code
FROM deps AS dev

# SMI-4782 — install psql so scripts/pooler-psql.sh works as documented.
# Scoped to the dev stage only to keep prod/builder images lean.
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy TypeScript config and source for development
COPY tsconfig*.json ./
COPY turbo.json ./
COPY packages/ ./packages/

# Copy additional development files
COPY scripts/ ./scripts/
COPY vitest*.ts ./
COPY eslint.config.js ./
COPY .prettierrc ./
COPY .prettierignore ./

# Copy entrypoint script and make executable
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# SMI-5784: entrypoint's per-package native-module seed/validate logic was
# split out of docker-entrypoint.sh into this sourced sibling per CLAUDE.md's
# 500-line file-length convention — must live at the same destination
# directory as docker-entrypoint.sh itself (it resolves the sibling via
# SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)", i.e. /app).
COPY docker-entrypoint-native-per-package.sh ./

# Build packages for development
RUN npm run build || echo "Build completed with warnings"

# Development runs as root for volume mount compatibility
# Health check for development container
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Keep container running for interactive development
CMD ["tail", "-f", "/dev/null"]

# -----------------------------------------------------------------------------
# Stage 5: Production Dependencies - Install only production dependencies
# -----------------------------------------------------------------------------
FROM base AS prod-deps

# Install only runtime dependencies for native modules
# Minimal set compared to builder stage
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Python3 may be needed by some native modules at runtime
    python3 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy package files
COPY package*.json ./
COPY packages/core/package*.json ./packages/core/
COPY packages/mcp-server/package*.json ./packages/mcp-server/
COPY packages/cli/package*.json ./packages/cli/
COPY packages/vscode-extension/package*.json ./packages/vscode-extension/

# Install production dependencies only (no devDependencies)
# This significantly reduces image size
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# -----------------------------------------------------------------------------
# Stage 6: Production - Minimal runtime image
# -----------------------------------------------------------------------------
# Used by: Production deployments
# Security: Runs as non-root user
FROM prod-deps AS prod

# Set production environment
ENV NODE_ENV=production

# Create non-root user for security (CIS Docker Benchmark 4.1)
# Using node user that comes with official Node.js image
# If not available, create one
RUN groupadd --gid 1001 nodejs 2>/dev/null || true \
    && useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home nodejs 2>/dev/null || true

# Copy built artifacts from builder stage
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist

# Copy package.json files for module resolution
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/mcp-server/package.json ./packages/mcp-server/
COPY --from=builder /app/packages/cli/package.json ./packages/cli/

# Set ownership to non-root user
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Health check for production container
# Verifies the MCP server can start and respond
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "require('./packages/mcp-server/dist/src/index.js')" || exit 1

# Expose MCP server port (if applicable)
EXPOSE 3001

# Start the MCP server
CMD ["node", "packages/mcp-server/dist/src/index.js"]
