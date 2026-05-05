#!/bin/bash
#
# Docker Entrypoint Script
#
# Validates native modules before starting the application.
# This prevents confusing runtime errors from NODE_MODULE_VERSION mismatches.
#
# Also rebuilds dist/ on first container start in git worktrees, where the
# .:/app bind mount erases image-layer dist/ (dist/ is gitignored on host).
#
# Usage: Set as ENTRYPOINT in Dockerfile or docker-compose.yml
#
# Reference: ADR-012 (Native Module Version Management)
# Reference: SMI-2621 (Worktree Docker dist/ fix)
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ---------------------------------------------------------------------------
# Dist check: rebuild if dist/ is missing (common on first container start
# in a git worktree, where .:/app bind mount erases image-layer dist/).
#
# In fresh worktrees the host has no dist/ (gitignored). The .:/app bind
# mount overlays /app at container start, leaving packages/*/dist/ absent.
#
# Two sentinels (core + mcp-server) catch both fresh-worktree (all dist/
# absent) and partial-build scenarios (only core was previously built).
# Turbo builds core first (dependsOn: ["^build"]), so a successful build
# guarantees all packages are compiled.
#
# Note: set -e + explicit exit 1 below is intentional belt-and-suspenders —
# set -e handles unexpected failures; exit 1 here provides a human-readable
# message before aborting.
# ---------------------------------------------------------------------------
CORE_DIST_ENTRY="/app/packages/core/dist/src/index.js"
MCP_DIST_ENTRY="/app/packages/mcp-server/dist/src/index.js"

echo -e "${YELLOW}[entrypoint] Checking dist/ outputs...${NC}"

# Pre-check: node_modules must be initialised before build can succeed
if [ ! -f "/app/node_modules/.package-lock.json" ]; then
    echo -e "${RED}  ✗ node_modules not initialised — run: npm install inside this container${NC}"
    exit 1
fi

if [ ! -f "$CORE_DIST_ENTRY" ] || [ ! -f "$MCP_DIST_ENTRY" ]; then
    echo -e "${YELLOW}  ✗ dist/ not found (first container start) — building packages...${NC}"
    echo -e "${YELLOW}  This is a one-time cost per worktree (until dist/ is manually removed).${NC}"

    # SMI-4689: in worktree containers, filter @skillsmith/website out of the
    # entrypoint build. The Astro/Vite plugin canonicalizes paths in a way
    # that virtiofs cannot round-trip ("/node_modules/astro/components/..."
    # vs "/app/packages/website/node_modules/astro/..."), causing the build
    # to fail with "No cached compile metadata found". Website is NOT in
    # SMI-4689's explicit acceptance criteria; build it inside the main-repo
    # container (skillsmith-dev-1) where the issue does not manifest.
    # Tracked separately as SMI-4739.
    BUILD_FILTER=""
    if [ -f "/app/.git" ]; then
        BUILD_FILTER='--filter=!@skillsmith/website'
    fi

    if npm run build --prefix /app -- $BUILD_FILTER; then
        echo -e "${GREEN}  ✓ Build complete.${NC}"
    else
        echo -e "${RED}  ✗ Build failed — run npm run build inside this container to see details.${NC}"
        # SMI-4689: worktree-aware hint. /app/.git as a regular file (not dir)
        # is git's worktree marker. If the build failed inside a worktree
        # container, the most likely cause is a stale or missing per-package
        # node_modules bind-mount block in docker-compose.override.yml.
        if [ -f "/app/.git" ]; then
            echo -e "${YELLOW}  Worktree detected. If the failure looks like 'Could not resolve <dep>' or${NC}"
            echo -e "${YELLOW}  'Cannot find module <pkg>', the per-package node_modules bind mounts may${NC}"
            echo -e "${YELLOW}  be missing or stale. From the host main repo, run:${NC}"
            echo -e "${YELLOW}    ./scripts/repair-worktrees.sh${NC}"
            echo -e "${YELLOW}  Then restart this container: docker compose --profile dev down && up -d${NC}"
            echo -e "${YELLOW}  See CLAUDE.md § Worktrees and SMI-4689 for context.${NC}"
        fi
        exit 1
    fi
else
    echo -e "${GREEN}  ✓ dist/ found — skipping build.${NC}"
fi

echo -e "${GREEN}[entrypoint] dist/ outputs ready.${NC}"

echo -e "${YELLOW}[entrypoint] Validating native modules...${NC}"

# List of native modules to validate.
# Must match Dockerfile:73 `npm rebuild` list. With .npmrc ignore-scripts=true
# (SMI-4672), this loop is the only runtime rebuild path on cache miss / ABI
# mismatch — missing a module silently fails open (mock embedding fallback per
# ADR-009, brute-force vector search per SMI-4577, esbuild platform-binary
# breakage). Keep this array in sync with Dockerfile:73.
NATIVE_MODULES=("better-sqlite3" "onnxruntime-node" "esbuild" "hnswlib-node")

# Track validation status
VALIDATION_FAILED=0

for module in "${NATIVE_MODULES[@]}"; do
    if node -e "require('${module}')" 2>/dev/null; then
        echo -e "${GREEN}  ✓ ${module}${NC}"
    else
        echo -e "${RED}  ✗ ${module} - validation failed${NC}"
        VALIDATION_FAILED=1
    fi
done

# If validation failed, attempt rebuild
if [ $VALIDATION_FAILED -eq 1 ]; then
    echo -e "${YELLOW}[entrypoint] Native module mismatch detected. Attempting rebuild...${NC}"

    for module in "${NATIVE_MODULES[@]}"; do
        echo -e "${YELLOW}  Rebuilding ${module}...${NC}"
        npm rebuild "${module}" 2>/dev/null || true
    done

    # Re-validate after rebuild
    REBUILD_FAILED=0
    for module in "${NATIVE_MODULES[@]}"; do
        if ! node -e "require('${module}')" 2>/dev/null; then
            echo -e "${RED}  ✗ ${module} - still failing after rebuild${NC}"
            REBUILD_FAILED=1
        fi
    done

    if [ $REBUILD_FAILED -eq 1 ]; then
        echo -e "${RED}[entrypoint] Native module validation failed after rebuild.${NC}"
        echo -e "${YELLOW}Try: docker compose down && docker compose build --no-cache${NC}"
        exit 1
    fi

    echo -e "${GREEN}[entrypoint] Native modules rebuilt successfully.${NC}"
fi

echo -e "${GREEN}[entrypoint] All native modules validated.${NC}"

# Execute the main command
exec "$@"
