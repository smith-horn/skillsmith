#!/usr/bin/env bash
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
            # (pre-SMI-4381) or the wrong-depth form (pre-SMI-4654). Idempotent.
            ln -sfn "$rel_target" "$wt_path/node_modules"
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
            ln -sfn "$rel_target" "$link"
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
