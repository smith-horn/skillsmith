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

# SMI-5784: per-package native-module seeding/validation split out per
# CLAUDE.md's 500-line file-length convention (this file grew from 310 to
# 510 lines adding that logic — new debt from this PR, not pre-existing).
# Sourced early (mirrors scripts/rebase-worktree.sh's own
# source-its-helpers-near-the-top convention) so validate_native_module() —
# SHARED with the root-only NATIVE_MODULES validation loop below, not just
# the per-package call sites — is available wherever either needs it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docker-entrypoint-native-per-package.sh
source "$SCRIPT_DIR/docker-entrypoint-native-per-package.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ---------------------------------------------------------------------------
# SMI-5570/SMI-5074: container-side symlink correction for worktree containers.
#
# Worktree-gated via /app/.git being a FILE (git's worktree marker): the
# main-repo container has REAL per-package node_modules and a REAL
# node_modules directory under /app (populated by `npm install` against the
# actual checkout, before any mount lands there), so none of this applies —
# confirmed via direct inspection (no symlink, no escape) on skillsmith-dev-1.
# See scripts/lib/repair-worktree-container-symlinks.sh for the mechanism.
#
# SMI-5685: the second arg names the Compose-declared mount target
# (/app/node_modules — see docker-compose.yml and the worktree override's
# tmpfs targets) directly, rather than relying on the bare /node_modules
# path a healthy worktree's symlinked host node_modules happens to clamp a
# bind mount onto (a real but underdocumented mount(2) side effect,
# scripts/_lib.sh's enumerate_compose_node_modules_mounts header). On a
# State-B worktree (host node_modules is a real, non-symlink directory —
# SMI-5689 fixes that) the clamp never fires, so the old /node_modules arg
# looked in the wrong, unpopulated place and the @skillsmith/@smith-horn
# alias repair silently no-op'd on every boot. /app/node_modules resolves
# identically on a healthy worktree and is the only target Compose itself
# ever declares.
# ---------------------------------------------------------------------------
if [ -f "/app/.git" ]; then
    bash /app/scripts/lib/repair-worktree-container-symlinks.sh /app/packages /app/node_modules
else
    echo -e "${GREEN}[entrypoint] Main checkout — no worktree symlink repair needed (SMI-5570/SMI-5074 no-op)${NC}"
fi

# ---------------------------------------------------------------------------
# SMI-5650: seed writable native-module named volumes (worktree only).
# The worktree container's /app/node_modules is a read-only view of the
# (possibly macOS) host tree, so the SMI-5351 rebuild loop below cannot write
# a rebuilt .node binary. scripts/_lib.sh emits a writable Docker-managed
# named volume (NOT tmpfs — see _lib.sh's enumerate_compose_node_modules_mounts
# comment for why: Compose's tmpfs volume type hardcodes noexec, which broke
# native module loading) at /app/node_modules/<module> for each of these; seed it from the image's
# /opt/native-seed stash (built during the image's own Linux npm rebuild) so a
# `docker compose restart dev` self-heal is deterministic and offline.
# This module list is referenced inline (rather than from NATIVE_MODULES,
# which is declared later, below the dist check) — keep it in sync with that
# array, scripts/_lib.sh's NATIVE_MODULES_FOR_OVERLAY, and the Dockerfile stash
# (a cross-file sync-check test enforces this).
#
# @esbuild is a SCOPE, not a flat module — confirmed live it is REQUIRED
# alongside the flat `esbuild` entry: esbuild's own JS API does not contain
# the native binary it spawns at runtime; that lives in the separate
# platform-arch package (@esbuild/<platform>-<arch>) inside this scope. It
# has no package.json of its own (only its children do), so "already seeded"
# is checked via "non-empty directory" instead of the flat entries'
# "package.json present" check.
#
# Disable: SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE=1 (registered in
# docs/internal/process/guards-and-opt-outs.md).
# ---------------------------------------------------------------------------
if [ -f "/app/.git" ] && [ "${SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE:-}" != "1" ]; then
    for module in better-sqlite3 onnxruntime-node esbuild hnswlib-node @esbuild; do
        seed="/opt/native-seed/${module}"
        target="/app/node_modules/${module}"
        already_seeded=1
        case "$module" in
        @*) [ -n "$(ls -A "$target" 2>/dev/null)" ] && already_seeded=0 ;;
        *) [ -f "$target/package.json" ] && already_seeded=0 ;;
        esac
        if [ ! -d "$seed" ]; then
            echo -e "${YELLOW}[entrypoint] No native seed for ${module} — image predates SMI-5650; falling back to npm rebuild if validation fails. Rebuild the image (docker compose build) to pick up the seed.${NC}"
        elif [ "$already_seeded" -eq 1 ]; then
            if cp -a "$seed/." "$target/" 2>/dev/null; then
                echo -e "${GREEN}  ✓ Seeded ${module} into writable overlay (SMI-5650)${NC}"
            else
                echo -e "${YELLOW}[entrypoint] Could not seed ${module} — the named volume mount is likely missing (stale override, pre-SMI-5650). Run scripts/repair-worktrees.sh on host, recreate container.${NC}"
            fi
        fi
    done
fi

# SMI-5784: per-package boot-time seed step — split out per CLAUDE.md's
# 500-line file-length convention. See
# docker-entrypoint-native-per-package.sh's
# seed_per_package_native_modules_boot() for the full block + rationale
# (companion to the root-only loop above; same disable-var gate).
seed_per_package_native_modules_boot

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

    # SMI-5957: scope this build to what CORE_DIST_ENTRY/MCP_DIST_ENTRY
    # actually check, plus the one package with a currently-live cold-start
    # consumer (scripts/mcp-doc-retrieval-launcher.sh hard-requires
    # packages/doc-retrieval-mcp/dist/src/server.js; .husky/post-commit
    # silently skips the reindex hook when its dist/cli.js is absent).
    # Applied unconditionally (worktree AND full checkout) — @skillsmith/website
    # is excluded in both because neither this gate nor either live consumer
    # needs it fresh, and (fresh-checkout case) its `astro` dependency is
    # installed non-hoisted to packages/website/node_modules, which has no
    # named-volume protection against docker-compose.yml's `.:/app` bind
    # mount on a cold `docker compose up` — a website build failure there is
    # FATAL to this script (see the exit 1 below), and combined with
    # `restart: unless-stopped` produces an unrecoverable crash-restart loop
    # (confirmed via live repro, SMI-5957).
    #
    # MUST invoke `turbo` directly, not route the filter through
    # `npm run build --`: npm appends `--`-args to the END of the whole
    # `&&`-chained root build script ("turbo run build && bash
    # scripts/lib/check-dist-fresh.sh --write-sentinel", package.json), not
    # to `turbo` specifically — the filter previously used here (worktree-only,
    # `--filter=!@skillsmith/website`) was silently landing on
    # check-dist-fresh.sh instead and has been dead code since the `&&` chain
    # was introduced (commit 3c8655c18, SMI-5548). Worktree containers' actual
    # immunity to a website-build failure has never come from that filter — it
    # comes from docker-compose.override.yml separately bind-mounting the main
    # checkout's already-populated packages/website/node_modules read-only.
    # SMI-4739 (the virtiofs/Astro cache-path issue this filter was originally
    # written for) remains genuinely untested, not superseded by this change.
    BUILD_FILTER='--filter=@skillsmith/core --filter=@skillsmith/mcp-server --filter=@skillsmith/doc-retrieval-mcp'

    if npx turbo run build $BUILD_FILTER && bash scripts/lib/check-dist-fresh.sh --write-sentinel; then
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

# validate_native_module() — including its SMI-5784 path-aware extension for
# per-package targets — now lives in docker-entrypoint-native-per-package.sh
# (sourced near the top of this file), split out per CLAUDE.md's 500-line
# file-length convention. SHARED: called both by the root-only loop
# immediately below and by the per-package validate/rebuild function called
# later in this file.

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
NATIVE_MODULES=("better-sqlite3" "onnxruntime-node" "esbuild" "hnswlib-node" "@esbuild")

# Track validation status
VALIDATION_FAILED=0

for module in "${NATIVE_MODULES[@]}"; do
    if validate_native_module "$module"; then
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
        # SMI-5650 (worktree): re-seed from the image stash first —
        # deterministic and offline, vs npm rebuild's registry dependency.
        # Falls through to npm rebuild if the seed is missing/stale/absent OR if
        # SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE=1 (the SAME guard as the
        # boot-time seed step above — both call-sites must honor it identically,
        # else the disable var would silently no-op half of this behavior and the
        # offline-path verification would not actually exercise the offline path).
        if [ -f "/app/.git" ] && [ "${SKILLSMITH_WORKTREE_NATIVE_SEED_DISABLE:-}" != "1" ] && [ -d "/opt/native-seed/${module}" ]; then
            rm -rf "/app/node_modules/${module:?}"/* 2>/dev/null || true
            cp -a "/opt/native-seed/${module}/." "/app/node_modules/${module}/" 2>/dev/null || true
            if validate_native_module "$module"; then
                echo -e "${GREEN}  ✓ ${module} restored from image seed (SMI-5650)${NC}"
                continue
            fi
        fi
        npm rebuild "${module}" --ignore-scripts=false || echo -e "${YELLOW}  ↳ npm rebuild exited non-zero for ${module} (see output above)${NC}"
    done

    # Re-validate after rebuild
    REBUILD_FAILED=0
    FAILED_MODULES=""
    for module in "${NATIVE_MODULES[@]}"; do
        if ! validate_native_module "$module"; then
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

# SMI-5784: validate + self-heal PER-PACKAGE native-module overlays — split
# out per CLAUDE.md's 500-line file-length convention. See
# docker-entrypoint-native-per-package.sh's
# validate_and_rebuild_per_package_native_modules() for the full block +
# rationale. Deliberately a SIBLING call to the VALIDATION_FAILED block
# above, not nested inside it: nesting inside `if [ $VALIDATION_FAILED -eq 1
# ]` would skip per-package validation entirely whenever every ROOT module
# happens to validate cleanly, which is exactly the failure mode this
# section exists to catch.
validate_and_rebuild_per_package_native_modules

echo -e "${GREEN}[entrypoint] All native modules validated.${NC}"

# Execute the main command
exec "$@"
