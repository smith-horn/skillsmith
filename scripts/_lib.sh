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
    local rel_target="../../node_modules"

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
        local rel_target="../../node_modules"

        if [[ -L "$wt_path/node_modules" ]]; then
            # Refresh in case existing symlink is the absolute host-path form
            # (pre-SMI-4381). Idempotent.
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
    # From <wt>/packages/<pkg>/node_modules → ../../../../packages/<pkg>/node_modules
    # (4 ups: node_modules-parent → packages → wt-name → .worktrees → repo-root)
    for pkg_dir in "$repo_root"/packages/*/; do
        [[ -d "$pkg_dir" ]] || continue
        pkg_name="$(basename "$pkg_dir")"
        local main_target="$pkg_dir/node_modules"
        local link="$worktree_path/packages/$pkg_name/node_modules"
        local rel_target="../../../../packages/$pkg_name/node_modules"

        # Target must exist in main repo for the symlink to be useful.
        [[ -d "$main_target" ]] || continue
        # Worktree may not have this package directory (e.g. branch predates it).
        [[ -d "$worktree_path/packages/$pkg_name" ]] || continue

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
