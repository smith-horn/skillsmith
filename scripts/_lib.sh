#!/usr/bin/env bash
# audit:host-npm-required — see SMI-4814 (npm install lives in a heredoc warning string shown to users; not executed)
#
# _lib.sh — Shared utilities for worktree management scripts
#
# Sourced by: create-worktree.sh, remove-worktree.sh, rebase-worktree.sh
#
# Provides:
#   Colors:    RED, GREEN, YELLOW, BLUE, NC
#   Logging:   error(), warn(), info(), success()
#   Git:       get_main_git_dir(), is_git_crypt_encrypted()

# Guard against double-sourcing
if [[ -n "${_LIB_SH_LOADED:-}" ]]; then
    return 0
fi
_LIB_SH_LOADED=1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# SMI-5650: native modules that get a writable named volume in worktree
# containers (seeded from the image's /opt/native-seed at boot). Must match
# docker-entrypoint.sh's NATIVE_MODULES array and the Dockerfile's stash list —
# keep all three in sync (a cross-file sync-check test enforces this).
#
# @esbuild IS a scope directory, not a flat module — confirmed live it is
# REQUIRED, not optional: esbuild's own top-level package (bin/esbuild, its
# JS API wrapper) does NOT contain the actual native binary esbuild spawns at
# runtime; that lives in the separate scoped platform package
# (@esbuild/<platform>-<arch>, e.g. @esbuild/linux-arm64). A bare `esbuild`
# entry alone left that scope resolving through the read-only root mount to
# main's real (possibly wrong-platform) host copy, passing tsc/type-checking
# fine but failing at actual esbuild invocation ("Syntax error: ( unexpected"
# — the shell's fallback interpretation of a non-Linux binary it can't
# execve()). Handled at the SCOPE level (mount destination
# /app/node_modules/@esbuild, not a specific platform-arch subpackage) for
# the same reason @skillsmith/@smith-horn are scope-mounted in the alias
# fix above: the image build resolves whichever platform-arch package is
# actually correct for that image, so there's nothing to hardcode.
NATIVE_MODULES_FOR_OVERLAY=("better-sqlite3" "onnxruntime-node" "esbuild" "hnswlib-node" "@esbuild")

#######################################
# Docker volume names cannot contain `@` — sanitize a NATIVE_MODULES_FOR_OVERLAY
# entry into a valid `local` volume name. Flat module names pass through
# unchanged; the sole scope entry (@esbuild) maps to a distinct, readable name
# that can't collide with the flat `esbuild` package's own volume.
#
# Arguments:
#   $1 - Entry from NATIVE_MODULES_FOR_OVERLAY (e.g. "better-sqlite3", "@esbuild")
# Outputs:
#   Sanitized volume-name-safe string to stdout
#######################################
native_module_volume_name() {
    case "$1" in
    @*) printf '%s-scope' "${1#@}" ;;
    *) printf '%s' "$1" ;;
    esac
}

#######################################
# Print error message and exit
#######################################
error() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

#######################################
# Print warning message
#######################################
warn() {
    echo -e "${YELLOW}Warning: $1${NC}" >&2
}

#######################################
# Print info message
#######################################
info() {
    echo -e "${BLUE}$1${NC}"
}

#######################################
# Print success message
#######################################
success() {
    echo -e "${GREEN}$1${NC}"
}

#######################################
# Run a command with a bounded timeout, preferring GNU `timeout` semantics
# (SMI-4700 / SMI-5596).
#
# macOS does not ship GNU `timeout`; Homebrew coreutils provides it as
# `gtimeout`. Probes `gtimeout` first, falls back to `timeout` (present
# natively on Linux, and installable on macOS), and — if neither is usable —
# runs the command UNBOUNDED. The unbounded fallback matches today's reality
# on a machine without either binary: a wedged daemon would already hang the
# caller in that case (the guard never executes), so this is no worse than
# before, not a new hazard.
#
# Extracted from repair-worktrees.sh's inline check_docker_safety_for_rebuild
# probe (SMI-4700) so create-worktree.sh's Step 8 readiness probe (SMI-5596)
# can reuse the identical capability-detection logic instead of duplicating
# it a second time.
#
# Arguments:
#   $1        - timeout in seconds
#   $2        - literal "--" separator (recommended for call-site
#               readability; skipped automatically if present)
#   $2.. / $3.. - command and its arguments to run
#
# Returns:
#   The wrapped command's own exit code. When gtimeout/timeout is available
#   and the command exceeds the bound, returns 124 (GNU timeout convention).
#   When neither binary is usable, runs the command unbounded and returns
#   its real exit code.
#######################################
run_with_timeout() {
    local seconds="$1"
    shift
    if [[ "${1:-}" == "--" ]]; then
        shift
    fi

    local timeout_bin=""
    if command -v gtimeout >/dev/null 2>&1 && gtimeout --kill-after=0 0 true >/dev/null 2>&1; then
        timeout_bin="gtimeout"
    elif command -v timeout >/dev/null 2>&1 && timeout --kill-after=0 0 true >/dev/null 2>&1; then
        timeout_bin="timeout"
    fi

    if [[ -n "$timeout_bin" ]]; then
        "$timeout_bin" "$seconds" "$@"
    else
        # Neither gtimeout nor a working timeout on PATH — run unbounded.
        "$@"
    fi
}

#######################################
# Get the actual .git directory (handles worktrees where .git is a file)
#
# Arguments:
#   $1 - Repository root path
#
# Outputs:
#   Path to the main .git directory, or empty string if not found
#######################################
get_main_git_dir() {
    local repo_root="$1"
    local git_path="$repo_root/.git"

    if [[ -f "$git_path" ]]; then
        # We're in a worktree - .git is a file pointing to the gitdir
        local worktree_gitdir
        worktree_gitdir=$(sed 's/gitdir: //' "$git_path")

        # Handle relative paths
        if [[ ! "$worktree_gitdir" = /* ]]; then
            worktree_gitdir="$repo_root/$worktree_gitdir"
        fi

        # Normalize and find the main .git directory
        # Worktree gitdirs are typically at: main_repo/.git/worktrees/<name>
        # We need to go up to main_repo/.git
        worktree_gitdir=$(cd "$worktree_gitdir" 2>/dev/null && pwd)

        # The main .git dir is the parent of "worktrees" directory
        if [[ "$worktree_gitdir" == */.git/worktrees/* ]]; then
            echo "${worktree_gitdir%/worktrees/*}"
        else
            # Fallback: try to find commondir
            if [[ -f "$worktree_gitdir/commondir" ]]; then
                local commondir
                commondir=$(cat "$worktree_gitdir/commondir")
                if [[ ! "$commondir" = /* ]]; then
                    commondir="$worktree_gitdir/$commondir"
                fi
                cd "$commondir" 2>/dev/null && pwd
            else
                echo "$worktree_gitdir"
            fi
        fi
    elif [[ -d "$git_path" ]]; then
        # Normal repository - .git is a directory
        echo "$git_path"
    else
        echo ""
    fi
}

#######################################
# Check if a file is git-crypt encrypted
# Uses xxd for cross-platform compatibility (macOS + Linux)
#
# Arguments:
#   $1 - File path to check
#
# Returns:
#   0 if encrypted, 1 if not encrypted or xxd unavailable
#######################################
is_git_crypt_encrypted() {
    local file="$1"
    local header

    # Require xxd for reliable cross-platform binary detection
    if ! command -v xxd >/dev/null 2>&1; then
        return 1  # Cannot determine; treat as not encrypted (non-fatal)
    fi

    header=$(head -c 4 "$file" 2>/dev/null | xxd -p 2>/dev/null || echo "")
    # git-crypt binary header: \x00GIT = 00 47 49 54 (4-byte read = exactly 8 hex chars)
    [[ "$header" == "00474954" ]]
}

#######################################
# Compute relative symlink target for a worktree node_modules link (SMI-4654).
#
# Replaces hardcoded "../../node_modules" / "../../../../packages/<pkg>/..." strings.
# Depth is derived from where the symlink lives relative to repo_root, so BOTH
# layouts work:
#
#   <repo>/.worktrees/<name>/node_modules                  -> ../../node_modules
#   <repo>/<name>/node_modules                             -> ../node_modules
#   <repo>/.worktrees/<name>/packages/<pkg>/node_modules   -> ../../../../packages/<pkg>/node_modules
#   <repo>/<name>/packages/<pkg>/node_modules              -> ../../../packages/<pkg>/node_modules
#
# Caller must pass canonical absolute paths (no `..` segments). `git worktree
# list --porcelain` returns canonical paths, so production callers are safe.
#
# Arguments:
#   $1 - symlink_dir   directory that will contain the symlink (the symlink's parent)
#   $2 - target_path   absolute path the symlink should point to (under repo_root)
#   $3 - repo_root     absolute path to main repo root
#
# Outputs:
#   stdout - relative path string
# Returns:
#   0 on success; 1 (with stderr message) if symlink_dir or target_path is
#   not under repo_root. Caller is responsible for handling the failure;
#   the link/repair helpers warn-and-skip rather than aborting the batch.
#######################################
compute_relative_target() {
    local symlink_dir="$1"
    local target_path="$2"
    local repo_root="$3"

    # Normalize: strip trailing slash from repo_root.
    repo_root="${repo_root%/}"

    # Quoted-prefix strip per ShellCheck SC2295. If the strip is a no-op,
    # symlink_dir does not start with "$repo_root/" — i.e. it's not under
    # the repo. Same check for target_path.
    local rel_link_dir="${symlink_dir#"$repo_root/"}"
    if [[ "$rel_link_dir" == "$symlink_dir" ]]; then
        echo "compute_relative_target: '$symlink_dir' is not under repo root '$repo_root'" >&2
        return 1
    fi

    local rel_target="${target_path#"$repo_root/"}"
    if [[ "$rel_target" == "$target_path" ]]; then
        echo "compute_relative_target: '$target_path' is not under repo root '$repo_root'" >&2
        return 1
    fi

    # Slash count in rel_link_dir = depth - 1; ups needed = depth = slashes + 1.
    # Examples:
    #   "wt"                       -> 0 slashes -> 1 up
    #   ".worktrees/wt"            -> 1 slash   -> 2 ups
    #   "wt/packages/foo"          -> 2 slashes -> 3 ups
    #   ".worktrees/wt/packages/x" -> 3 slashes -> 4 ups
    local slashes_only="${rel_link_dir//[!\/]/}"
    local ups=$(( ${#slashes_only} + 1 ))

    local prefix="" i
    for (( i=0; i<ups; i++ )); do
        prefix+="../"
    done

    printf '%s%s\n' "$prefix" "$rel_target"
}

#######################################
# Assert host-visible node_modules resolves lint-staged (SMI-4377)
#
# Pre-commit hooks run lint-staged on host (not Docker; see SMI-2604),
# so host-visible node_modules is required. Docker named-volume installs
# (CLAUDE.md docker-first policy) populate only the container volume.
# Fails loudly per SMI-4374 retro ("silent degradation is the enemy").
#
# Arguments:
#   $1 - Repository root path
#######################################
assert_host_node_modules() {
    local repo_root="$1"
    if [[ ! -x "$repo_root/node_modules/.bin/lint-staged" ]]; then
        error "Main repo's host node_modules is missing or incomplete.

Pre-commit hooks require host-visible node_modules to resolve lint-staged,
eslint, and prettier. Docker named-volume installs (CLAUDE.md docker-first
policy) populate the container volume but not the host path.

Remediation (one-time, per clone):
  (cd $repo_root && npm install --ignore-scripts)

Then re-run this script. Host node_modules need not match the Docker
environment's native modules — it only needs the CLI binaries under
node_modules/.bin."
    fi
}

#######################################
# Symlink node_modules from main repo into a worktree (SMI-4377)
#
# Idempotent: refreshes an existing symlink, skips a real directory,
# creates the symlink if missing.
#
# Arguments:
#   $1 - Worktree path
#   $2 - Repository root path (symlink target)
#
# Returns:
#   0 on success or no-op, 1 if skipped due to unexpected state
#######################################
link_worktree_node_modules() {
    local worktree_path="$1"
    local repo_root="$2"

    # SMI-4381: relative symlink so it resolves both on host (where target is
    # /<repo>/node_modules) and inside Docker (where target is /app/node_modules).
    # An absolute host path symlink is dangling inside the container.
    # SMI-4654: depth computed dynamically; supports both `<repo>/.worktrees/<name>/`
    # (2 ups: ../../node_modules) and nested `<repo>/<name>/` (1 up: ../node_modules).
    local rel_target
    if ! rel_target="$(compute_relative_target "$worktree_path" "$repo_root/node_modules" "$repo_root")"; then
        warn "  Skipping $worktree_path: not under repo root $repo_root"
        return 1
    fi

    if [[ -L "$worktree_path/node_modules" ]]; then
        # SMI-5596: idempotent — skip the unlink+recreate when the existing
        # symlink already resolves to the correct target. A concurrent
        # sibling create-worktree.sh invocation's Step 7 sweep re-visiting an
        # already-settled worktree must be a true no-op, or it gratuitously
        # re-triggers the Docker Desktop macOS file-sharing propagation delay
        # the Step 8 readiness probe is meant to bound.
        if [[ "$(readlink "$worktree_path/node_modules")" == "$rel_target" ]]; then
            return 0
        fi
        ln -sfn "$rel_target" "$worktree_path/node_modules"
        return 0
    fi

    if [[ -e "$worktree_path/node_modules" ]]; then
        warn "  node_modules exists at $worktree_path and is not a symlink — skipping"
        return 1
    fi

    ln -sfn "$rel_target" "$worktree_path/node_modules"
    return 0
}

#######################################
# Idempotent backfill of node_modules symlinks across all worktrees (SMI-4377)
#
# Iterates `git worktree list`, skips the main repo (real node_modules),
# creates the symlink on any worktree missing it. Leaves existing real
# dirs untouched. Safe to run repeatedly.
#
# Arguments:
#   $1 - Repository root path
#######################################
repair_worktrees_node_modules() {
    local repo_root="$1"
    local wt_count=0
    local repaired=0

    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        [[ "$wt_path" == "$repo_root" ]] && continue
        [[ ! -d "$wt_path" ]] && continue

        wt_count=$((wt_count + 1))

        # SMI-4381: relative target works on host AND inside Docker bind-mount.
        # SMI-4654: depth computed dynamically; supports both `<repo>/.worktrees/<name>/`
        # (2 ups) and nested `<repo>/<name>/` (1 up).
        local rel_target
        if ! rel_target="$(compute_relative_target "$wt_path" "$repo_root/node_modules" "$repo_root")"; then
            warn "  Skipping $wt_path (not under repo root)"
            continue
        fi

        if [[ -L "$wt_path/node_modules" ]]; then
            # Refresh in case existing symlink is the absolute host-path form
            # (pre-SMI-4381) or the wrong-depth form (pre-SMI-4654).
            # SMI-5596: idempotent — skip the unlink+recreate entirely when
            # the target already matches, so a redundant sweep across
            # concurrent sibling worktree creations is a true no-op and
            # cannot reopen an already-settled worktree's propagation window.
            if [[ "$(readlink "$wt_path/node_modules")" != "$rel_target" ]]; then
                ln -sfn "$rel_target" "$wt_path/node_modules"
            fi
            continue
        fi
        if [[ -d "$wt_path/node_modules" ]]; then
            continue
        fi

        ln -sfn "$rel_target" "$wt_path/node_modules"
        info "  Repaired: $wt_path"
        repaired=$((repaired + 1))
    done < <(git -C "$repo_root" worktree list --porcelain | awk '/^worktree / { print $2 }')

    if [[ $repaired -gt 0 ]]; then
        success "  Repaired $repaired of $wt_count worktree(s)"
    elif [[ $wt_count -gt 0 ]]; then
        success "  All $wt_count worktree(s) already have node_modules"
    fi
}

#######################################
# Symlink per-package node_modules from main repo into a worktree (SMI-4381).
#
# Why: workspace-pinned deps live under packages/<pkg>/node_modules in the
# main repo. Without per-package symlinks, Node module resolution from the
# worktree's package walks up to the hoisted root node_modules, which can
# carry a DIFFERENT version (e.g. zod@4.x at root vs zod@3.25.76 in
# packages/mcp-server). The wrong version surfaces as type errors when
# pre-commit Phase 2 (typecheck) runs from the worktree.
#
# Idempotent: refreshes an existing symlink, skips a real directory.
# Iterates packages/* discovered in the main repo.
#
# Arguments:
#   $1 - Worktree path
#   $2 - Repository root path (symlink target base)
#######################################
link_worktree_package_node_modules() {
    local worktree_path="$1"
    local repo_root="$2"
    local pkg_dir pkg_name

    [[ ! -d "$repo_root/packages" ]] && return 0

    # SMI-4381: relative symlink resolves on host AND inside Docker.
    # SMI-4654: depth computed dynamically; supports both layouts.
    #   e.g. `.worktrees/<name>/packages/<pkg>` → 4 ups (../../../../packages/<pkg>/node_modules)
    #        nested  `<name>/packages/<pkg>`    → 3 ups (../../../packages/<pkg>/node_modules)
    for pkg_dir in "$repo_root"/packages/*/; do
        [[ -d "$pkg_dir" ]] || continue
        pkg_name="$(basename "$pkg_dir")"
        # Canonical (no trailing/double slashes) for the symlink-target string.
        local main_target="$repo_root/packages/$pkg_name/node_modules"
        local link_parent="$worktree_path/packages/$pkg_name"
        local link="$link_parent/node_modules"

        # Target must exist in main repo for the symlink to be useful.
        [[ -d "$main_target" ]] || continue
        # Worktree may not have this package directory (e.g. branch predates it).
        [[ -d "$link_parent" ]] || continue

        local rel_target
        if ! rel_target="$(compute_relative_target "$link_parent" "$main_target" "$repo_root")"; then
            warn "  Skipping per-package link for $link_parent (not under repo root)"
            continue
        fi

        if [[ -L "$link" ]]; then
            # SMI-5596: idempotent — see link_worktree_node_modules above for
            # the rationale (skip unlink+recreate when already correct).
            if [[ "$(readlink "$link")" != "$rel_target" ]]; then
                ln -sfn "$rel_target" "$link"
            fi
            continue
        fi
        if [[ -e "$link" ]]; then
            # Real dir at worktree — leave it; user's responsibility.
            continue
        fi
        ln -sfn "$rel_target" "$link"
    done
}

#######################################
# Idempotent backfill of per-package node_modules across all worktrees (SMI-4381).
#
# Companion to repair_worktrees_node_modules. Iterates `git worktree list`,
# skips the main repo, applies link_worktree_package_node_modules to each.
#
# Arguments:
#   $1 - Repository root path
#######################################
repair_worktrees_package_node_modules() {
    local repo_root="$1"
    local wt_count=0

    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        [[ "$wt_path" == "$repo_root" ]] && continue
        [[ ! -d "$wt_path" ]] && continue

        wt_count=$((wt_count + 1))
        link_worktree_package_node_modules "$wt_path" "$repo_root"
    done < <(git -C "$repo_root" worktree list --porcelain | awk '/^worktree / { print $2 }')

    if [[ $wt_count -gt 0 ]]; then
        success "  Per-package node_modules synced across $wt_count worktree(s)"
    fi
}

#######################################
# Enumerate compose bind mounts for the worktree override (SMI-4689 / SMI-5560).
#
# Emits PER-PACKAGE node_modules bind mounts, one line per packages/<pkg>/
# whose node_modules dir exists in the main repo:
#
#   <host>/packages/<pkg>/node_modules:/app/packages/<pkg>/node_modules:ro
#
# These give the worktree container access to the main checkout's
# workspace-pinned (non-hoisted) per-package deps + prebuilt native modules,
# which virtiofs cannot serve via the dangling SMI-4381 relative symlinks on
# macOS Docker Desktop.
#
# The `:ro` flag is load-bearing (SMI-5560). Without it, any worktree process
# that writes inside a per-package node_modules — most commonly a `npm install`
# reifying a native module (`rename better-sqlite3 -> .better-sqlite3-<rand>`) —
# writes straight THROUGH the bind mount into the MAIN checkout's real files
# (confirmed leak: a stale `.better-sqlite3-*` temp left in main's
# packages/core/node_modules dated 2026-07-04). Read-only turns that silent
# cross-checkout corruption into a loud EROFS. Each mount is a SINGLE mount of
# a UNIQUE host directory, which on virtiofs marks only its own path read-only
# and does NOT propagate the read-only "host_mark" to unrelated base-mount
# paths — verified end-to-end in the SMI-5560 investigation (core/src,
# website/public and /app all stay writable). The propagation regression seen
# earlier came specifically from a same-host-dir DOUBLE mount (see below), not
# from `:ro` per se.
#
# WORKSPACE-SIBLING whole-package mounts (previously
# <host>/packages/<pkg>:/app/node_modules/<scoped-name>) were REMOVED in
# SMI-5560. Two reasons:
#   1. Corruption/shadowing. The image's `npm ci` seeds a workspace symlink
#      (@scope/<pkg> -> ../../packages/<pkg>) into the per-worktree node_modules
#      volume. Docker resolved the whole-package mount's DESTINATION through
#      that symlink and landed the MAIN checkout's package dir at
#      /app/packages/<pkg>, SHADOWING the worktree's own source: worktree edits
#      became invisible to the container and worktree builds wrote dist/ into
#      main. Dropping the mount un-shadows the worktree; the seeded symlink now
#      resolves the alias to the worktree's OWN /app/packages/<pkg> (its own
#      freshly-built dist, not main's stale copy — strictly more correct).
#   2. virtiofs double-mount. The per-package node_modules mount above is a
#      SUBDIRECTORY of the whole-package mount, so the same host dir
#      (packages/<pkg>/node_modules) was bind-mounted at two container paths.
#      That same-host-dir double-mount is exactly what made a `:ro` retrofit
#      trip the virtiofs host_mark propagation regression. Removing the
#      whole-package mount removes the double-mount, making the `:ro` above safe.
#
# Companion: the worktree's per-package node_modules symlink resolves to
# /packages/<pkg>/node_modules (OUTSIDE /app) inside the container, so Node's
# hoist walk-up needs a /node_modules -> /app/node_modules bridge to reach the
# hoisted root deps (matters for esbuild bundling, e.g. vscode). That bridge
# is NOT actively created by any script — it is an emergent effect of the
# same mount(2) symlink-clamping mechanism documented above: the bind
# destination /app/node_modules is itself a symlink on the worktree host
# side, so the kernel redirects the real mount to land at /node_modules
# (container root) instead. docker-entrypoint.sh's worktree-gated call into
# repair-worktree-container-symlinks.sh is a CONSUMER of this location
# (SMI-5570/SMI-5074), not its creator (SMI-5626 plan-review correction,
# 2026-07-09 — the prior comment wrongly attributed the bridge to
# entrypoint-created code that does not exist).
#
# Output is intended to be appended under a `volumes:` block; caller handles
# indentation context. Each emitted line uses 6-space indent.
#
# Arguments:
#   $1 - Repository root path (main repo, NOT worktree path)
#######################################
enumerate_compose_node_modules_mounts() {
    local repo_root="$1"
    local pkg_dir pkg_name main_target

    [[ ! -d "$repo_root/packages" ]] && return 0

    # SMI-5626: ROOT node_modules bind mount, READ-ONLY. The base compose file
    # mounts a named volume at /app/node_modules; in a worktree project that
    # volume is useless — the worktree's host-side relative symlink
    # (node_modules -> ../../node_modules, sized for HOST nesting depth, SMI-4377) sits
    # under the .:/app bind, and mount(2) follows symlinks when resolving a
    # bind destination (SMI-5570/SMI-5074), so root-hoisted deps (e.g. marked,
    # sanitize-html) are unreachable in the container even though the host tree
    # is correct. Mount the MAIN checkout's real root tree instead, same
    # pattern as the per-package mounts below. Compose merges service `volumes`
    # entries by container target path, so this entry REPLACES the base file's
    # named-volume entry for worktree projects (verify via `docker compose
    # config`). `:ro` is load-bearing twice over: (1) same SMI-5560 rationale —
    # a worktree npm install must not write through into main's real tree; and
    # (2) docker-entrypoint.sh's repair-worktree-container-symlinks.sh mutates
    # hoisted @skillsmith/* alias symlinks under the resolved root — against a
    # writable bind of main's REAL host tree that would corrupt main's own
    # workspace aliases; :ro turns it into that script's existing non-fatal
    # warning path (it always exits 0).
    if [[ -d "$repo_root/node_modules" ]]; then
        printf '      - %s:/app/node_modules:ro\n' "$repo_root/node_modules"
        # Writable cache overlays, mirroring the per-package .vite/.vite-temp
        # pattern below (root-level vitest/vite runs write these under the
        # ROOT node_modules; both exist in main's tree today). Same
        # nested-subdirectory shape already proven safe against the virtiofs
        # host_mark propagation regression.
        local root_cache_dir
        for root_cache_dir in .vite .vite-temp; do
            printf '      - %s/%s:/app/node_modules/%s\n' \
                "$repo_root/node_modules" "$root_cache_dir" "$root_cache_dir"
        done
    fi

    # SMI-5650: writable tmpfs overlays over the read-only root mount, for the
    # workspace-alias SCOPE directories AND the four native-module dirs.
    #
    # (1) ALIAS SCOPES. Main's node_modules/@skillsmith + @smith-horn contain ONLY npm-workspaces
    # alias symlinks whose relative targets (../../packages/<pkg>) clamp to
    # /packages/<pkg> (empty scaffolding) inside the container's shallower
    # nesting — the SMI-5570/SMI-5074 mount(2) mechanism, this time observed at
    # require()-resolution time rather than mount time (SMI-5650). A tmpfs at the
    # SCOPE level shadows those broken links with an empty writable dir that
    # docker-entrypoint.sh's repair-worktree-container-symlinks.sh repopulates at
    # every boot with links to the worktree's OWN /app/packages/<pkg>. The
    # destination's final path component is a REAL DIRECTORY on the host (guarded
    # below), never a symlink — this is what prevents reproducing the leaf-symlink
    # escape that crashed a prior per-alias mount attempt ("too many levels of
    # symlinks", plan §1.4). Same child-inside-read-only-parent shape as the
    # .vite/.vite-temp overlays above.
    #
    # (2) NATIVE MODULE DIRS. better-sqlite3/onnxruntime-node/esbuild/hnswlib-node,
    # plus the @esbuild SCOPE (esbuild's JS API spawns its actual native binary
    # from the separate @esbuild/<platform>-<arch> package, not from anything
    # inside the flat `esbuild` package itself — confirmed live, see
    # native_module_volume_name's comment), need a writable target for the
    # SMI-5351 self-heal rebuild loop in docker-entrypoint.sh, which the :ro
    # root mount broke (SMI-5650). A NAMED VOLUME (not tmpfs — see below) +
    # boot-time seed from the image's /opt/native-seed (built during the
    # image's own Linux npm rebuild) fixes this deterministically and offline.
    # Applied to all five entries uniformly — which flat modules are single-
    # vs multi-platform in a given host checkout is incidental npm-rebuild
    # history, not a stable invariant to special-case on.
    #
    # NAMED VOLUME, NOT tmpfs (this is the key difference from the alias
    # scopes above): Compose's `type: tmpfs` volume hardcodes `noexec` with no
    # override field on the `tmpfs:` sub-object — confirmed live this breaks
    # native module loading (blocks execve() for esbuild's spawned CLI binary,
    # AND blocks dlopen()'s mmap(PROT_EXEC) for some — not all — shared
    # objects, e.g. onnxruntime-node/hnswlib-node but not better-sqlite3). A
    # bare `driver: local` NAMED volume (no driver_opts, no tmpfs annotation
    # at all) sidesteps this entirely — it's the SAME ordinary volume
    # mechanism the base docker-compose.yml already uses for the main
    # checkout's own node_modules (never noexec, native modules load fine
    # there today), not a hardening-default override. Declarations are
    # emitted once by enumerate_native_module_volumes(), referenced here by
    # name via native_module_volume_name() (Docker volume names can't contain
    # `@`, so the @esbuild entry is sanitized to a distinct "esbuild-scope"
    # name). Tradeoff vs tmpfs: disk-backed and persistent across container
    # restarts rather than RAM-backed and self-clearing — see
    # native_module_volume_name's neighboring comment block for why this is
    # safe (docker-entrypoint.sh's VALIDATION_FAILED path already detects and
    # re-seeds a corrupted persisted binary via a real invocation check, not
    # a bare require()).
    #
    # MOUNT ORDER IS LOAD-BEARING (SMI-5650 plan-review M1): the alias-scope
    # loop below MUST stay textually AFTER the root `:ro` mount block above
    # (native-module volume references have no such ordering dependency —
    # they're independent named volumes, not destinations resolved through
    # the root mount's own symlink-clamping). Compose applies a service's
    # `volumes:` entries in list order, and the alias scope-directory tmpfs
    # destinations only resolve correctly (plan §1.4) once the root mount has
    # already landed and exposed @skillsmith/@smith-horn as real directories
    # to mount over. Reordering those two blocks silently reintroduces the
    # crash risk; a generated-YAML line-order test asserts the root mount
    # precedes each alias tmpfs target so a future reorder fails CI instead.
    #
    # The 2 alias scopes and the 5 native-module entries are emitted by TWO
    # SEPARATE loops below (not a single mixed list) because their mount
    # shapes now differ: alias scopes are inline `type: tmpfs` (1MiB, no
    # size distinction needed — see above for why), native-module entries are
    # named-volume references (no size field at the reference site; sizing
    # doesn't apply to a plain `driver: local` volume the way it did to tmpfs).
    # NATIVE MODULES use a plain Docker-managed named volume (NOT the type:
    # tmpfs shorthand used for the alias scopes below): Docker Compose's
    # tmpfs volume type hardcodes noexec (confirmed live: `mount | grep`
    # shows `noexec` with no override field exposed on the `tmpfs:`
    # sub-object). noexec blocks execve() outright (broke esbuild's spawned
    # CLI binary, "Permission denied") AND — contrary to the initial
    # assumption that dlopen()'s mmap(PROT_EXEC) path is unaffected —
    # confirmed live to also block dlopen() for some shared objects
    # (onnxruntime-node and hnswlib-node both failed ERR_DLOPEN_FAILED
    # "failed to map segment from shared object"; only better-sqlite3
    # happened to tolerate it, an artifact of its own binary's internal
    # structure, not something to special-case on).
    #
    # A bare `driver: local` named volume with NO tmpfs annotation sidesteps
    # this cleanly: it is a completely standard Docker-managed volume, the
    # SAME mechanism the base docker-compose.yml already uses for the main
    # checkout's own `node_modules` (which has never had noexec and loads
    # native modules fine today) — this isn't disabling a hardening default,
    # it's using the ordinary volume type that was never restricted, rather
    # than the tmpfs type's own hardcoded default. Tradeoff vs. tmpfs:
    # disk-backed (Docker's storage driver) and persistent across container
    # restarts rather than RAM-backed and self-clearing — a corrupted binary
    # is no longer wiped by a plain restart, but docker-entrypoint.sh's
    # existing native-module VALIDATION_FAILED path already detects a broken
    # binary via require() and unconditionally re-seeds on that path, so
    # correctness is unaffected, only which of the two already-implemented
    # code paths performs the fix. Volume declarations are emitted once by
    # enumerate_native_module_volumes(), referenced here by name.
    #
    # SMI-5650 follow-up filed to reconsider tmpfs+explicit-exec (discarded
    # here in favor of shipping the lower-risk fix first) if the persistence
    # tradeoff ever proves to matter in practice.
    local overlay_dir
    for overlay_dir in @skillsmith @smith-horn; do
        # Real-directory guard: the leaf must exist AND must NOT be a symlink (a
        # symlink leaf would escape via mount(2) — see the notes above and plan
        # §1.4). Missing (fresh clone, pre-install) or unexpectedly-a-symlink →
        # skip: fail toward today's known breakage, never toward a
        # container-create failure. noexec (Compose's tmpfs default) is fine
        # here — these scopes hold only symlinks, never executable content.
        if [[ -d "$repo_root/node_modules/$overlay_dir" && ! -L "$repo_root/node_modules/$overlay_dir" ]]; then
            printf '      - type: tmpfs\n'
            printf '        target: /app/node_modules/%s\n' "$overlay_dir"
            printf '        tmpfs:\n'
            printf '          size: 1048576\n'
        fi
    done
    local native_module
    for native_module in "${NATIVE_MODULES_FOR_OVERLAY[@]}"; do
        if [[ -d "$repo_root/node_modules/$native_module" && ! -L "$repo_root/node_modules/$native_module" ]]; then
            printf '      - native-seed-%s:/app/node_modules/%s\n' \
                "$(native_module_volume_name "$native_module")" "$native_module"
        fi
    done

    # Per-package node_modules mounts, READ-ONLY (SMI-5560). Same gate as
    # link_worktree_package_node_modules:358.
    for pkg_dir in "$repo_root"/packages/*/; do
        [[ -d "$pkg_dir" ]] || continue
        pkg_name="$(basename "$pkg_dir")"
        main_target="$repo_root/packages/$pkg_name/node_modules"
        [[ -d "$main_target" ]] || continue
        printf '      - %s:/app/packages/%s/node_modules:ro\n' "$main_target" "$pkg_name"

        # SMI-5560 follow-up: vite/vitest write their own dependency
        # pre-bundle cache (.vite/) and config-bundling temp files
        # (.vite-temp/) directly inside node_modules — confirmed via a live
        # repro: `cd packages/<pkg> && vitest run` (the exact invocation
        # scripts/pre-push-coverage-check.sh uses per-package) failed with
        # EROFS writing node_modules/.vite-temp/vitest.config.ts.timestamp-*.mjs
        # once node_modules went read-only above. Both dirs are gitignored
        # (covered by the blanket `node_modules` rule) — layering a writable
        # overlay here is the same nested-subdirectory pattern already proven
        # safe against the virtiofs host_mark propagation regression (a
        # SUBDIRECTORY mount under this package's own single node_modules
        # mount, not a second mount of an overlapping-but-distinct host path
        # — the double-mount shape that caused that regression no longer
        # exists at all now that the workspace-sibling mount is gone).
        local vite_cache_dir
        for vite_cache_dir in .vite .vite-temp; do
            printf '      - %s/%s:/app/packages/%s/node_modules/%s\n' \
                "$main_target" "$vite_cache_dir" "$pkg_name" "$vite_cache_dir"
        done
    done
}

#######################################
# Emit the top-level `volumes:` section declaring the exec-capable named
# volumes native modules mount into (SMI-5650). Called ONCE per generated
# override (not per-service, unlike enumerate_compose_node_modules_mounts's
# per-service volume-list lines) — Compose merges top-level `volumes:` keys
# by name, so this is additive alongside the base compose file's own
# `node_modules:` named volume, not a replacement.
#
# Bare `driver: local`, no driver_opts: an ordinary Docker-managed volume,
# same mechanism as the base compose file's own `node_modules:` volume — see
# the emission-loop comment above in enumerate_compose_node_modules_mounts
# for why this (not tmpfs) is the fix for the noexec dlopen()/execve()
# failures discovered live.
#
# Emission is gated identically to the per-service native-module mount lines
# above (same real-directory guard) so a volume is never declared with no
# service referencing it.
#
# Arguments:
#   $1 - Repository root path (main repo, NOT worktree path)
#######################################
enumerate_native_module_volumes() {
    local repo_root="$1"
    local native_module

    for native_module in "${NATIVE_MODULES_FOR_OVERLAY[@]}"; do
        if [[ -d "$repo_root/node_modules/$native_module" && ! -L "$repo_root/node_modules/$native_module" ]]; then
            printf '  native-seed-%s:\n' "$(native_module_volume_name "$native_module")"
            printf '    driver: local\n'
        fi
    done
}

#######################################
# Worktree port-bucket collision resolution (SMI-5661).
#
# Problem: generate_docker_override_to_stdout previously derived a worktree's
# port bucket (1-99, mapped to host ports 3000+offset*10 .. +3) purely from a
# `cksum` hash of the worktree name. Two independent worktree names can hash
# to the SAME bucket (verified live: "smi-5641-remove-dead-dep-helpers" and
# "smi-5651-registry-catchup" both hash to bucket 79), and a bucket can also
# collide with a port some OTHER process already has bound on the host (e.g.
# a lingering container, or an unrelated dev server). Either collision made
# `docker compose up` fail with a host-level EADDRINUSE for one of the two
# worktrees, with no retry or reassignment.
#
# Fix: probe candidate buckets in order (deterministic hash first, so the
# common case is unchanged), skipping any bucket whose 4 ports collide with
# a SIBLING worktree's override file or with a port already LISTENing on the
# host, wrapping around the full 1-99 space before giving up.
#######################################

#######################################
# Parse the HOST-side ports out of a generated docker-compose.override.yml.
#
# Override port lines have the fixed shape (quoted "HOST:CONTAINER"):
#   - "37910:3000"   # Main app
#
# Arguments:
#   $1 - Path to a docker-compose.override.yml (may not exist)
# Outputs:
#   stdout - one host port per line; empty if the file is absent or has none
#######################################
_parse_override_host_ports() {
    local file="$1"
    [ -f "$file" ] || return 0
    grep -oE '"[0-9]+:[0-9]+"' "$file" 2>/dev/null | tr -d '"' | cut -d: -f1
}

#######################################
# Enumerate host ports already claimed by SIBLING worktrees' override files,
# excluding the main repo and the worktree being resolved itself (half of the
# self-collision-avoidance fix — see _resolve_worktree_port_offset for the
# other half).
#
# Arguments:
#   $1 - repo_root    Main repository root (for `git worktree list`)
#   $2 - self_path    Worktree path currently being resolved (excluded)
# Outputs:
#   stdout - one host port per line, across all other worktrees
#######################################
_worktree_sibling_taken_ports() {
    local repo_root="$1" self_path="$2" wt
    while IFS= read -r wt; do
        [ -z "$wt" ] && continue
        [ "$wt" = "$repo_root" ] && continue
        [ "$wt" = "$self_path" ] && continue
        _parse_override_host_ports "$wt/docker-compose.override.yml"
    done < <(git -C "$repo_root" worktree list --porcelain 2>/dev/null \
                 | sed -n 's/^worktree //p')
}

#######################################
# Check whether a port is already bound (LISTENing) on the host.
#
# `lsof -nP -iTCP:<port> -sTCP:LISTEN` reads the kernel socket table for
# LISTEN-state sockets, ships on both macOS and Linux, and generates no
# network traffic. `nc -z` opens a real connection (flaky, and flag syntax
# diverges between BSD and GNU `nc`); `ss` is Linux-only; `netstat` is
# deprecated on macOS. Known limitation: this only sees sockets owned by
# processes the current user can enumerate — Docker's own EADDRINUSE at
# `up` time remains the final backstop.
#
# Arguments:
#   $1 - port number to check
# Returns:
#   0 if bound (or check skipped/unavailable — fails toward "assume bound"
#     only when a real check ran and found a LISTENer); 1 if free or lsof
#     is unavailable / the check is disabled.
#######################################
_worktree_host_port_bound() {
    local port="$1"
    [ "${SKILLSMITH_WORKTREE_PORT_SKIP_HOST_CHECK:-}" = "1" ] && return 1
    command -v lsof >/dev/null 2>&1 || return 1
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

#######################################
# Resolve a collision-free port bucket (1-99) for a worktree.
#
# Two mechanisms cooperate to avoid a worktree reprobing itself away from its
# OWN currently-assigned bucket (self-collision avoidance):
#   1. _worktree_sibling_taken_ports (above) excludes self_path from the
#      sibling scan.
#   2. This function's "sticky" start-offset: if the worktree already has an
#      override file, the probe STARTS from the bucket already recorded
#      there (recovered from its own host ports) rather than from the
#      deterministic hash, and treats the worktree's OWN 4 ports as never a
#      collision. Without this, repair_worktrees_compose_override
#      regenerating a worktree whose container is live on a probed
#      (non-deterministic) bucket would reprobe it back toward the
#      deterministic hash and desync the override from the running
#      container.
#
# Loop invariant: `offset=$(( (offset % 99) + 1 ))` cycles through the full
# 1..99 space exactly once before repeating — no infinite loop, no silent
# reuse; after 99 failed attempts this returns failure instead.
#
# Arguments:
#   $1 - worktree_path   Absolute path to the worktree being resolved
#   $2 - worktree_name   Sanitized worktree name (input to the cksum hash)
#   $3 - repo_root       Main repository root
# Outputs:
#   stdout - the resolved offset (1-99) on success
#   stderr - a NOTE when reassigned away from the deterministic hash, or an
#            ERROR when no free bucket was found
# Returns:
#   0 on success, 1 if no free bucket was found after a full cycle
#######################################
_resolve_worktree_port_offset() {
    local worktree_path="$1" worktree_name="$2" repo_root="$3"

    local deterministic_offset
    deterministic_offset=$(printf '%s' "$worktree_name" | cksum | awk '{print ($1 % 99) + 1}')

    local own_ports start_offset own_base cand
    own_ports="$(_parse_override_host_ports "$worktree_path/docker-compose.override.yml" | tr '\n' ' ')"
    start_offset="$deterministic_offset"
    if [ -n "${own_ports// /}" ]; then
        own_base=$(printf '%s\n' $own_ports | sort -n | head -1)
        if [ -n "$own_base" ] && [ $(( (own_base - 3000) % 10 )) -eq 0 ]; then
            cand=$(( (own_base - 3000) / 10 ))
            [ "$cand" -ge 1 ] && [ "$cand" -le 99 ] && start_offset="$cand"
        fi
    fi

    local sibling_ports
    sibling_ports="$(_worktree_sibling_taken_ports "$repo_root" "$worktree_path" | tr '\n' ' ')"

    [ -n "${SKILLSMITH_WORKTREE_PORT_TEST_DELAY:-}" ] && sleep "$SKILLSMITH_WORKTREE_PORT_TEST_DELAY"

    local offset="$start_offset" attempt=0 p base free
    while [ "$attempt" -lt 99 ]; do
        base=$(( 3000 + offset * 10 ))
        free=1
        for p in "$base" $((base+1)) $((base+2)) $((base+3)); do
            case " $own_ports " in *" $p "*) continue ;; esac
            case " $sibling_ports " in *" $p "*) free=0; break ;; esac
            if _worktree_host_port_bound "$p"; then free=0; break; fi
        done
        if [ "$free" -eq 1 ]; then
            if [ "$offset" != "$deterministic_offset" ]; then
                printf 'NOTE: worktree port bucket %s (deterministic) unavailable — reassigned to bucket %s (SMI-5661)\n' \
                    "$deterministic_offset" "$offset" >&2
            fi
            printf '%s\n' "$offset"
            return 0
        fi
        offset=$(( (offset % 99) + 1 ))
        attempt=$(( attempt + 1 ))
    done

    printf 'ERROR: no free worktree port bucket found after 99 attempts — free up host ports or remove stale worktrees (SMI-5661)\n' >&2
    return 1
}

#######################################
# Concurrency lock guarding worktree port-bucket resolution + override write
# (SMI-5661). Adapted from retrieval-autoheal.sh's acquire_lock/release_lock
# (scripts/retrieval-autoheal.sh:108-198): flock when available (fd 8, held
# for the caller's life — the kernel releases it on any exit including a
# crash), else a non-evicting atomic `mkdir` lock for stock macOS bash 3.2
# (no `flock`, no `exec {var}>` fd auto-allocation, so the fd is hardcoded).
#
# One lock per MAIN-REPO checkout (key = `cksum` of repo_root, so all
# worktrees of the same repo — which all read/write each other's override
# files — serialize against each other; different repos never contend).
# Test-isolated via SKILLSMITH_WORKTREE_PORT_LOCK_HOME (mirrors
# SKILLSMITH_AUTOHEAL_HOME in retrieval-autoheal.sh).
#
# Best-effort: on timeout (busy flock, or a live mkdir-lock holder), WARN and
# return non-zero; the caller proceeds UNLOCKED rather than refusing to
# create/repair a worktree over lock contention — Docker's own EADDRINUSE at
# `up` time is the final backstop, same as the host-port-bound check above.
#######################################
WORKTREE_PORT_LOCK_MODE=""
WORKTREE_PORT_LOCK_DIR=""
WORKTREE_PORT_LOCK_PID_FILE=""
_WORKTREE_PORT_LOCK_FD=8
WORKTREE_PORT_LOCK_WAIT="${SKILLSMITH_WORKTREE_PORT_LOCK_WAIT:-10}"
WORKTREE_PORT_LOCK_TMAX="${SKILLSMITH_WORKTREE_PORT_LOCK_TMAX:-60}"

#######################################
# Acquire the worktree port-bucket lock. See the block comment above.
#
# Arguments:
#   $1 - repo_root   Main repository root (used to derive the lock key)
# Returns:
#   0 if the lock was acquired (or locking is disabled); 1 if acquisition
#   timed out (caller proceeds unlocked; a warning has already been printed)
#######################################
acquire_worktree_port_lock() {
    local repo_root="$1"
    [ "${SKILLSMITH_WORKTREE_PORT_LOCK_DISABLE:-}" = "1" ] && { WORKTREE_PORT_LOCK_MODE="disabled"; return 0; }

    local home key state_dir flock_file
    home="${SKILLSMITH_WORKTREE_PORT_LOCK_HOME:-$HOME}"
    key="$(printf '%s' "$repo_root" | cksum | awk '{print $1}')"
    state_dir="$home/.skillsmith"
    mkdir -p "$state_dir" 2>/dev/null || true
    WORKTREE_PORT_LOCK_DIR="$state_dir/worktree-ports-$key.lock"
    WORKTREE_PORT_LOCK_PID_FILE="$WORKTREE_PORT_LOCK_DIR/pid"
    flock_file="$state_dir/worktree-ports-$key.flock"

    local force_mkdir=""
    [ "${SKILLSMITH_WORKTREE_PORT_FORCE_MKDIR_LOCK:-}" = "1" ] && force_mkdir="1"

    if [ -z "$force_mkdir" ] && command -v flock >/dev/null 2>&1; then
        if eval "exec ${_WORKTREE_PORT_LOCK_FD}>\"$flock_file\""; then
            if flock -w "$WORKTREE_PORT_LOCK_WAIT" "$_WORKTREE_PORT_LOCK_FD"; then
                WORKTREE_PORT_LOCK_MODE="flock"
                return 0
            fi
            eval "exec ${_WORKTREE_PORT_LOCK_FD}>&-" 2>/dev/null || true
            warn "  Worktree port lock busy after ${WORKTREE_PORT_LOCK_WAIT}s — proceeding best-effort (SMI-5661)"
            return 1
        fi
    fi

    local deadline hpid hstart age
    deadline=$(( $(date +%s) + WORKTREE_PORT_LOCK_WAIT ))
    while :; do
        if mkdir "$WORKTREE_PORT_LOCK_DIR" 2>/dev/null; then
            printf '%s %s\n' "$$" "$(date +%s)" > "$WORKTREE_PORT_LOCK_PID_FILE" 2>/dev/null || true
            if [ "$(awk '{print $1}' "$WORKTREE_PORT_LOCK_PID_FILE" 2>/dev/null)" != "$$" ]; then
                continue
            fi
            trap 'release_worktree_port_lock' EXIT
            trap 'release_worktree_port_lock; exit 130' INT
            trap 'release_worktree_port_lock; exit 143' TERM
            WORKTREE_PORT_LOCK_MODE="mkdir"
            return 0
        fi
        hpid="$(awk '{print $1}' "$WORKTREE_PORT_LOCK_PID_FILE" 2>/dev/null)"
        hstart="$(awk '{print $2}' "$WORKTREE_PORT_LOCK_PID_FILE" 2>/dev/null)"
        if [ -n "$hpid" ] && ! kill -0 "$hpid" 2>/dev/null; then
            rm -rf "$WORKTREE_PORT_LOCK_DIR" 2>/dev/null || true; continue
        fi
        age=0; [ -n "$hstart" ] && age=$(( $(date +%s) - hstart ))
        if [ "$age" -gt "$WORKTREE_PORT_LOCK_TMAX" ]; then
            rm -rf "$WORKTREE_PORT_LOCK_DIR" 2>/dev/null || true; continue
        fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
            warn "  Worktree port lock held by live pid ${hpid:-?} after ${WORKTREE_PORT_LOCK_WAIT}s — proceeding best-effort (SMI-5661)"
            return 1
        fi
        sleep 0.2
    done
}

#######################################
# Release the worktree port-bucket lock acquired by acquire_worktree_port_lock.
# Ownership-checked in mkdir mode: only removes the lock dir if THIS process
# still owns it (a stale/reclaimed lock's original holder must not delete a
# reclaimer's live lock).
#######################################
release_worktree_port_lock() {
    case "$WORKTREE_PORT_LOCK_MODE" in
        flock)
            eval "exec ${_WORKTREE_PORT_LOCK_FD}>&-" 2>/dev/null || true
            ;;
        mkdir)
            local owner
            owner="$(awk '{print $1}' "$WORKTREE_PORT_LOCK_PID_FILE" 2>/dev/null)"
            [ "$owner" = "$$" ] && rm -rf "$WORKTREE_PORT_LOCK_DIR" 2>/dev/null || true
            ;;
    esac
    WORKTREE_PORT_LOCK_MODE=""
}

#######################################
# Emit worktree docker-compose.override.yml content to stdout (SMI-4738 split).
#
# Pure-output form of generate_docker_override: produces the same YAML body
# the wrapper would write to disk, but to stdout. Lets callers diff generated
# content against an existing override (content-compare idempotency, replacing
# the static marker grep) before deciding whether to overwrite.
#
# Note on `Generated:` timestamp: the body embeds `$(date -u …)`. The wrapper
# `repair_worktrees_compose_override` strips this single header line before
# `cmp -s` so back-to-back regens of semantically-identical content count as
# byte-equal. If the line stayed in the diff window, every postinstall run
# would rewrite every override even with no drift.
#
# Idempotency marker: the `# SMI-4689 bind mounts v2` comment line still ships
# in output as a human-readable label, but is no longer the idempotency
# primitive (replaced by content-compare in repair_worktrees_compose_override).
#
# Arguments:
#   $1 - Worktree path (used only for `# Worktree:` header / never written to)
#   $2 - Branch name
#   $3 - Repository root path (for resolving per-package node_modules; main repo)
#######################################
generate_docker_override_to_stdout() {
    local worktree_path="$1"
    local branch_name="$2"
    local repo_root="$3"

    # Extract a short name from branch (e.g., feature/jwt-rollout -> jwt-rollout)
    local worktree_name
    worktree_name=$(basename "$branch_name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')

    # Resolve a collision-free port bucket (SMI-5661). Deterministic cksum hash is
    # the first candidate (common case unchanged); probes the next bucket on a
    # sibling-override or host-bound collision; sticky to this worktree's own
    # existing override so a live container is not reprobed away from its ports.
    # CALLER holds acquire_worktree_port_lock across this + the override write.
    local port_offset
    if ! port_offset="$(_resolve_worktree_port_offset "$worktree_path" "$worktree_name" "$repo_root")"; then
        return 1
    fi

    # Base ports: dev=3001, test=3002, orchestrator=3003
    local dev_app_port=$((3000 + port_offset * 10))
    local dev_mcp_port=$((3000 + port_offset * 10 + 1))
    local test_port=$((3000 + port_offset * 10 + 2))
    local orchestrator_port=$((3000 + port_offset * 10 + 3))

    # SMI-4689: per-package bind mounts only on macOS Docker Desktop.
    local volumes_block=""
    local volumes_marker=""
    if [[ "$(uname)" == "Darwin" ]]; then
        local mounts
        mounts="$(enumerate_compose_node_modules_mounts "$repo_root")"
        if [[ -n "$mounts" ]]; then
            volumes_marker="    volumes:
      # SMI-4689/SMI-5560/SMI-5626/SMI-5650 bind mounts v5 (root + per-package node_modules read-only + alias-scope tmpfs overlays):
      # the ROOT node_modules and each package's node_modules are bind-mounted
      # READ-ONLY from the main repo so workspace-pinned + prebuilt-native +
      # root-hoisted deps resolve inside the container (replaces the SMI-4381
      # relative symlinks virtiofs cannot traverse; the root mount replaces the
      # base compose named volume, SMI-5626). The :ro flag stops a worktree npm
      # install from writing through the mount into main's real checkout
      # (SMI-5560). The former workspace-sibling whole-package mounts were
      # removed: they shadowed the worktree's own source with main's and created
      # the same-host-dir double-mount that made :ro trip the virtiofs host_mark
      # regression. Alias resolution now flows through npm's own seeded workspace
      # symlink to the worktree's OWN /app/packages/<pkg>. SMI-5650 additionally
      # layers small writable tmpfs overlays at the @skillsmith/@smith-horn scope
      # dirs on top of the :ro root mount so the entrypoint can (re)create those
      # workspace aliases pointing at the worktree's own packages. See
      # enumerate_compose_node_modules_mounts for the root/per-package mounts and
      # the mount(2) symlink-clamping notes there.
"
            volumes_block="${volumes_marker}${mounts}"
        fi
    fi

    # SMI-5650: top-level named-volume declarations for the exec-capable
    # native-module tmpfs volumes referenced by name in ${volumes_block}
    # above. Emitted ONCE (not per-service) — see
    # enumerate_native_module_volumes for why this can't be the same
    # `type: tmpfs` inline shape the alias scopes use.
    local top_level_volumes=""
    if [[ "$(uname)" == "Darwin" ]]; then
        local native_volumes
        native_volumes="$(enumerate_native_module_volumes "$repo_root")"
        if [[ -n "$native_volumes" ]]; then
            top_level_volumes="
volumes:
${native_volumes}"
        fi
    fi

    cat << EOF
# Worktree-specific overrides (auto-generated by create-worktree.sh / repair-worktrees.sh)
# Container names and ports must be unique per worktree
# Worktree: $branch_name
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Platform: $(uname)

services:
  dev:
    container_name: ${worktree_name}-dev-1
    ports:
      - "${dev_app_port}:3000"   # Main app
      - "${dev_mcp_port}:3001"   # MCP server
${volumes_block}
  test:
    container_name: ${worktree_name}-test-1
    ports:
      - "${test_port}:3000"      # Test app
${volumes_block}
  orchestrator:
    container_name: ${worktree_name}-orchestrator-1
    ports:
      - "${orchestrator_port}:3000"  # Orchestrator
${volumes_block}
${top_level_volumes}
EOF
}

#######################################
# Generate worktree docker-compose.override.yml (SMI-4377/SMI-4381/SMI-4689).
#
# Thin wrapper around generate_docker_override_to_stdout that writes the body
# to <worktree_path>/docker-compose.override.yml. Preserves the existing API
# used by create-worktree.sh and repair-worktrees.sh callers.
#
# SMI-5661: the port-bucket resolution + write are guarded by the worktree
# port-bucket lock so two concurrent create-worktree.sh invocations can't both
# read the same "free" bucket before either has written its override (a
# TOCTOU race the resolver's own probe cannot close by itself). Best-effort —
# see acquire_worktree_port_lock's own doc comment for the unlocked fallback.
#
# Arguments:
#   $1 - Worktree path
#   $2 - Branch name (used for unique container names + port hash)
#   $3 - Repository root path (for resolving per-package node_modules; main repo)
# Returns:
#   0 on success; 1 if generate_docker_override_to_stdout failed (e.g. no
#   free port bucket found)
#######################################
generate_docker_override() {
    local worktree_path="$1"
    local branch_name="$2"
    local repo_root="$3"
    local rc=0

    acquire_worktree_port_lock "$repo_root" || true
    generate_docker_override_to_stdout "$worktree_path" "$branch_name" "$repo_root" \
        > "$worktree_path/docker-compose.override.yml" || rc=$?
    release_worktree_port_lock

    return $rc
}

#######################################
# Idempotent regen of docker-compose.override.yml across all in-tree worktrees
# on macOS (SMI-4689 / SMI-4738). On Linux, no-op (bind mounts not needed).
#
# Companion to repair_worktrees_node_modules / repair_worktrees_package_node_modules.
# Iterates `git worktree list`, skips the main repo, off-tree worktrees, and
# worktrees missing docker-compose.yml.
#
# Idempotency primitive (SMI-4738 / plan-review C1+H1): generates the new
# override body to a temp file via generate_docker_override_to_stdout, then
# `diff` against the existing override with the `Generated:` timestamp line
# excluded. If the meaningful content matches, skip the move and count as
# `skipped`; otherwise atomically `mv` the temp into place. This replaces
# the previous static `# SMI-4689 bind mounts v2` marker check, which could
# not detect drift caused by adding a new package — the marker stayed
# present even though the bind-mount list was stale.
#
# The `Generated:` line is excluded from the comparison via `grep -v` so
# postinstall (which runs frequently) doesn't rewrite every override on
# every `npm install` purely due to timestamp drift.
#
# Branch name is recovered from the worktree's HEAD (`git -C $wt branch --show-current`)
# so the regenerated override is byte-equivalent to a fresh create-worktree run.
#
# Arguments:
#   $1 - Repository root path
#######################################
repair_worktrees_compose_override() {
    local repo_root="$1"
    local wt_path branch_name override tmp modified=0 skipped=0

    if [[ "$(uname)" != "Darwin" ]]; then
        info "  macOS-only — skipping per-package bind-mount regen on $(uname)"
        return 0
    fi

    # SMI-5661: acquire the port-bucket lock ONCE for the whole regen pass
    # (not per-iteration) since the loop below calls
    # generate_docker_override_to_stdout directly — not through the
    # generate_docker_override wrapper — so there is no nested acquire and
    # thus no self-deadlock risk. Released once after the loop, before the
    # summary. Best-effort: acquire_worktree_port_lock warns and returns
    # non-zero on contention; the regen proceeds unlocked rather than
    # skipping worktrees outright.
    acquire_worktree_port_lock "$repo_root" || true

    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        [[ "$wt_path" == "$repo_root" ]] && continue
        [[ ! -d "$wt_path" ]] && continue
        # Off-tree worktree gate (SMI-4689 plan-review): if no compose.yml
        # in the worktree, no override is consumable. Skip silently.
        [[ -f "$wt_path/docker-compose.yml" ]] || continue

        branch_name="$(git -C "$wt_path" branch --show-current 2>/dev/null)"
        if [[ -z "$branch_name" ]]; then
            warn "  Could not determine branch for $wt_path; skipping"
            continue
        fi

        override="$wt_path/docker-compose.override.yml"
        # Generate to temp file in the worktree dir so the final `mv` is
        # atomic (same filesystem). On any error, clean up the temp.
        tmp="$(mktemp "$wt_path/.docker-compose.override.yml.XXXXXX")" || {
            warn "  Could not create temp file in $wt_path; skipping"
            continue
        }

        if ! generate_docker_override_to_stdout "$wt_path" "$branch_name" "$repo_root" > "$tmp"; then
            warn "  Failed to generate override body for $wt_path; skipping"
            rm -f "$tmp"
            continue
        fi

        # Compare with the volatile `Generated:` timestamp line excluded so
        # postinstall doesn't rewrite every override on every `npm install`
        # purely due to timestamp drift. `diff -q` returns 0 on match, 1 on
        # differ; both are non-fatal here.
        if [[ -f "$override" ]] \
            && diff -q \
                <(grep -v '^# Generated: ' "$tmp") \
                <(grep -v '^# Generated: ' "$override") \
                >/dev/null 2>&1; then
            rm -f "$tmp"
            skipped=$((skipped + 1))
            continue
        fi

        mv "$tmp" "$override"
        modified=$((modified + 1))
    done < <(git -C "$repo_root" worktree list --porcelain | awk '/^worktree / { print $2 }')

    release_worktree_port_lock

    if [[ $modified -gt 0 ]]; then
        success "  Regenerated docker-compose.override.yml for $modified worktree(s) (SMI-4689)"
    fi
    if [[ $skipped -gt 0 ]]; then
        info "  Skipped $skipped worktree(s) — override content already current"
    fi
}

#######################################
# Enumerate submodule paths declared in a repo's .gitmodules (SMI-4829).
#
# Replaces hardcoded "docs/internal" references in worktree tooling. With only
# docs/internal declared (current pre-cutover state) this returns a single
# line; post-cutover (Wave 3 adds the strategy submodule mounts) it returns N.
#
# Arguments:
#   $1 - repo_root   absolute path to the repo whose .gitmodules to read
#
# Outputs:
#   stdout - one submodule path per line (in declaration order); empty if
#            .gitmodules is absent or has no submodule.<name>.path entries
# Returns:
#   0 always (missing .gitmodules is not an error — pre-cutover state)
#######################################
enumerate_submodules() {
    local repo_root="$1"
    local gitmodules="$repo_root/.gitmodules"
    if [[ ! -f "$gitmodules" ]]; then
        return 0
    fi
    # `git config --get-regexp` lines look like:
    #   submodule.docs/internal.path docs/internal
    # The trailing field is the path. awk extracts column 2; if a path ever
    # contains whitespace (rare but legal), git stores it quoted/escaped and
    # this helper would need updating — flag at that time.
    #
    # SMI-4829 footgun: `git config --file <abs-path>` STILL performs repo
    # discovery from cwd to evaluate `[includeIf "gitdir:..."]` directives,
    # and a stale `.git` file (e.g. a worktree imported from another host
    # whose gitdir pointer is now invalid) makes git exit 128 — silently
    # turning the result into "no submodules". Subshell into `/` to break
    # discovery before invoking. `--no-includes` does NOT suffice.
    (cd / && git config --file "$gitmodules" --get-regexp 'submodule\..*\.path' 2>/dev/null) \
        | awk '{print $2}' || true
}
