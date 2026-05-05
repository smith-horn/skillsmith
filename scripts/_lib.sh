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

#######################################
# Enumerate compose bind mounts for the worktree override (SMI-4689).
#
# Emits two kinds of YAML list-item lines:
#
#   1. PER-PACKAGE node_modules bind mounts:
#      <host>/packages/<pkg>/node_modules:/app/packages/<pkg>/node_modules
#
#      One line per packages/<pkg>/ whose node_modules dir exists in the main
#      repo. Replaces the dangling SMI-4381 relative symlinks that virtiofs
#      cannot traverse on macOS Docker Desktop.
#
#   2. WORKSPACE-SIBLING bind mounts:
#      <host>/packages/<pkg>:/app/node_modules/<scoped-name>
#
#      One line per package whose package.json `name` matches a symlink
#      under <host>/node_modules/(@<scope>/<n>|<n>). Replaces the
#      relative `node_modules/@skillsmith/<sibling> -> ../../packages/<sibling>`
#      symlinks in the Docker named volume — virtiofs cannot resolve them
#      either (proven empirically: `readlink -f` returns `/packages/core`
#      instead of `/app/packages/core`). The bind mount provides a real
#      directory at the symlink's path so Node module resolution succeeds.
#
# Output is intended to be appended under a `volumes:` block; caller handles
# indentation context. Each emitted line uses 6-space indent.
#
# Arguments:
#   $1 - Repository root path (main repo, NOT worktree path)
#######################################
enumerate_compose_node_modules_mounts() {
    local repo_root="$1"
    local pkg_dir pkg_name main_target ws_name

    [[ ! -d "$repo_root/packages" ]] && return 0

    # Pass 1: per-package node_modules mounts (same gate as
    # link_worktree_package_node_modules:358)
    for pkg_dir in "$repo_root"/packages/*/; do
        [[ -d "$pkg_dir" ]] || continue
        pkg_name="$(basename "$pkg_dir")"
        main_target="$repo_root/packages/$pkg_name/node_modules"
        [[ -d "$main_target" ]] || continue
        printf '      - %s:/app/packages/%s/node_modules\n' "$main_target" "$pkg_name"
    done

    # Pass 2: workspace-sibling mounts. The package.json `name` field is the
    # canonical workspace identifier; npm hoists workspace siblings to
    # <root>/node_modules/<name> as relative symlinks. We bind directly to
    # the package source dir to make Node resolution work inside virtiofs.
    for pkg_dir in "$repo_root"/packages/*/; do
        [[ -d "$pkg_dir" ]] || continue
        [[ -f "$pkg_dir/package.json" ]] || continue
        # node -p is portable across Node versions and survives spaces in path.
        ws_name="$(node -p "require('$pkg_dir/package.json').name" 2>/dev/null)"
        [[ -n "$ws_name" ]] || continue
        # Verify the host has the workspace symlink at the expected path.
        # If npm hasn't created it (rare — should always exist after `npm install`),
        # skip rather than emit a bind mount whose source doesn't exist.
        [[ -e "$repo_root/node_modules/$ws_name" ]] || continue
        # Trim trailing slash from pkg_dir for cleaner YAML output.
        local pkg_dir_trim="${pkg_dir%/}"
        printf '      - %s:/app/node_modules/%s\n' "$pkg_dir_trim" "$ws_name"
    done
}

#######################################
# Generate worktree docker-compose.override.yml (SMI-4377/SMI-4381/SMI-4689).
#
# Emits container_name + port overrides per profile (always), plus per-package
# node_modules bind mounts on macOS only (SMI-4689 — virtiofs cannot traverse
# the SMI-4381 relative symlinks). Linux Docker hosts handle the symlinks
# correctly via overlayfs, so the bind mounts are not emitted there.
#
# Idempotency marker: when bind mounts are emitted, the volumes block is
# headed by `# SMI-4689 bind mounts` so repair_worktrees_compose_override
# can detect already-regenerated overrides.
#
# Arguments:
#   $1 - Worktree path
#   $2 - Branch name (used for unique container names + port hash)
#   $3 - Repository root path (for resolving per-package node_modules; main repo)
#######################################
generate_docker_override() {
    local worktree_path="$1"
    local branch_name="$2"
    local repo_root="$3"

    # Extract a short name from branch (e.g., feature/jwt-rollout -> jwt-rollout)
    local worktree_name
    worktree_name=$(basename "$branch_name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')

    # Calculate port offset based on hash of worktree name (1-99)
    local port_offset
    port_offset=$(echo -n "$worktree_name" | cksum | awk '{print ($1 % 99) + 1}')

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
      # SMI-4689 bind mounts v2 (per-pkg + workspace-sibling): per-package
      # node_modules AND workspace siblings (@skillsmith/*, @smith-horn/*,
      # skillsmith-cli, skillsmith-vscode) bind-mounted from the main repo
      # so workspace-pinned AND workspace-internal deps resolve inside the
      # container. Replaces the SMI-4381 relative symlinks that virtiofs
      # cannot traverse (proven empirically: readlink -f returns wrong path).
"
            volumes_block="${volumes_marker}${mounts}"
        fi
    fi

    cat > "$worktree_path/docker-compose.override.yml" << EOF
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
EOF
}

#######################################
# Idempotent regen of docker-compose.override.yml across all in-tree worktrees
# on macOS (SMI-4689). On Linux, no-op (bind mounts not needed).
#
# Companion to repair_worktrees_node_modules / repair_worktrees_package_node_modules.
# Iterates `git worktree list`, skips the main repo, off-tree worktrees, and
# worktrees missing docker-compose.yml. Skips worktrees whose existing override
# already contains the SMI-4689 marker (idempotent — second run is a no-op).
#
# Branch name is recovered from the worktree's HEAD (`git -C $wt branch --show-current`)
# so the regenerated override is byte-equivalent to a fresh create-worktree run.
#
# Arguments:
#   $1 - Repository root path
#######################################
repair_worktrees_compose_override() {
    local repo_root="$1"
    local wt_path branch_name override modified=0 skipped=0

    if [[ "$(uname)" != "Darwin" ]]; then
        info "  macOS-only — skipping per-package bind-mount regen on $(uname)"
        return 0
    fi

    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        [[ "$wt_path" == "$repo_root" ]] && continue
        [[ ! -d "$wt_path" ]] && continue
        # Off-tree worktree gate (SMI-4689 plan-review): if no compose.yml
        # in the worktree, no override is consumable. Skip silently.
        [[ -f "$wt_path/docker-compose.yml" ]] || continue

        override="$wt_path/docker-compose.override.yml"
        # Idempotent marker check. The "v2" suffix forces re-generation of
        # any override that was created with the v1 format (pre-merge, no
        # workspace-sibling mounts). Future format bumps should follow the
        # same pattern (v3, v4...) so contributors auto-upgrade by re-running
        # repair-worktrees.sh after pulling.
        if [[ -f "$override" ]] && grep -q "# SMI-4689 bind mounts v2" "$override" 2>/dev/null; then
            skipped=$((skipped + 1))
            continue
        fi

        branch_name="$(git -C "$wt_path" branch --show-current 2>/dev/null)"
        if [[ -z "$branch_name" ]]; then
            warn "  Could not determine branch for $wt_path; skipping"
            continue
        fi

        generate_docker_override "$wt_path" "$branch_name" "$repo_root"
        modified=$((modified + 1))
    done < <(git -C "$repo_root" worktree list --porcelain | awk '/^worktree / { print $2 }')

    if [[ $modified -gt 0 ]]; then
        success "  Regenerated docker-compose.override.yml for $modified worktree(s) (SMI-4689)"
    fi
    if [[ $skipped -gt 0 ]]; then
        info "  Skipped $skipped worktree(s) — already have SMI-4689 marker"
    fi
}
