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
if [ ! -f "/app/node_modules/.package-lock.json" ] || [ ! -x "/app/node_modules/.bin/turbo" ]; then
    echo -e "${RED}  ✗ node_modules not initialised (or partial install) — run: npm install inside this container${NC}"
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

# ---------------------------------------------------------------------------
# SMI-5144: worktree git-discovery advisory (non-fatal).
# A worktree's /app/.git is a pointer FILE targeting a HOST absolute path
# (<host>/.git/worktrees/<name>) that does not exist in this container — only
# the worktree subtree is bind-mounted at /app, so the main repo's .git is
# absent. `git` run from /app therefore cannot discover the repo (exit 128,
# "not a git repository"). This is expected and unsupported: run git on the
# host, and keep tests hermetic (a self-created fixture repo, never
# process.cwd()) — see SMI-5140 (the hermetic-test fix) and SMI-5144. The
# main-repo container is unaffected: there /app/.git is a directory, so the
# `-f` test is false and this block is skipped entirely.
# ---------------------------------------------------------------------------
if [ -f "/app/.git" ] && ! git -C /app rev-parse --git-dir >/dev/null 2>&1; then
    echo -e "${YELLOW}[entrypoint] In-container git discovery from this worktree is unavailable (expected for worktree containers; non-fatal). Run git on the host; keep tests hermetic — see SMI-5144.${NC}"
fi

echo -e "${YELLOW}[entrypoint] Validating native modules...${NC}"

# List of native modules to validate.
# Must match the `RUN npm rebuild …` line in the Dockerfile (the NATIVE_MODULES
# array is the canonical source; keep both in sync). With .npmrc ignore-scripts=true
# (SMI-4672), plain `npm rebuild` is a verified no-op — it exits 0 but leaves
# the binary byte-identical (SMI-5351 ground-truth investigation). ALL four
# modules therefore require --ignore-scripts=false in the rebuild loop, not just
# hnswlib-node. This includes prebuilt-binary packages (better-sqlite3,
# onnxruntime-node, esbuild): their CDN download hooks (prebuild-install) ARE
# install scripts and are blocked by ignore-scripts=true exactly as node-gyp is.
# On the already-failed path, re-downloading the prebuilt IS the intended
# self-heal. Source-only packages (hnswlib-node) have always needed the override
# so node-gyp runs (SMI-5200); this change extends that to all four modules.
# The override is scoped to the rebuild loop only (inside the
# VALIDATION_FAILED guard) so healthy restarts pay nothing.
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
        # All four modules require --ignore-scripts=false: plain `npm rebuild` is a
        # no-op under .npmrc ignore-scripts=true, verified SMI-5351 (exits 0 but
        # leaves the binary byte-identical). This applies to prebuilt-binary packages
        # (better-sqlite3, onnxruntime-node, esbuild) just as much as to the
        # source-only package (hnswlib-node, SMI-5200) — CDN download hooks
        # (prebuild-install) are install scripts and are blocked by ignore-scripts=true.
        # Re-downloading a prebuilt only happens on this already-failed path and IS
        # the intended self-heal. The --ignore-scripts=false override is scoped here,
        # inside the VALIDATION_FAILED guard, so healthy restarts pay nothing.
        echo -e "${YELLOW}  Rebuilding ${module} (first run may fetch a prebuilt)...${NC}"
        npm rebuild "${module}" --ignore-scripts=false || echo -e "${YELLOW}  ↳ npm rebuild exited non-zero for ${module} (see output above)${NC}"
    done

    # Re-validate after rebuild
    REBUILD_FAILED=0
    FAILED_MODULES=""
    for module in "${NATIVE_MODULES[@]}"; do
        if ! node -e "require('${module}')" 2>/dev/null; then
            echo -e "${RED}  ✗ ${module} - still failing after rebuild${NC}"
            REBUILD_FAILED=1
            FAILED_MODULES="${FAILED_MODULES:+$FAILED_MODULES }${module}"
        fi
    done

    if [ $REBUILD_FAILED -eq 1 ]; then
        echo -e "${RED}[entrypoint] Native module validation failed after rebuild.${NC}"
        echo -e "${YELLOW}For verbose rebuild output (run on host): docker exec skillsmith-dev-1 npm rebuild ${FAILED_MODULES} --ignore-scripts=false${NC}"
        # Probe CDN reachability before recommending a network-dependent recovery path.
        # --max-time 5 is mandatory: a CDN hang must not stall container start (M11/F2).
        if curl -fsS --max-time 5 https://registry.npmjs.org/ >/dev/null 2>&1; then
            echo -e "${YELLOW}Try: docker compose down && docker compose build --no-cache${NC}"
        else
            echo -e "${YELLOW}Network unreachable — reconnect to the internet, then: docker compose restart dev${NC}"
        fi
        exit 1
    fi

    echo -e "${GREEN}[entrypoint] Native modules rebuilt successfully.${NC}"
fi

echo -e "${GREEN}[entrypoint] All native modules validated.${NC}"

# Execute the main command
exec "$@"
