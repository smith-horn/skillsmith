#!/usr/bin/env bash
#
# verify-worktree-symlinks.sh — Audit worktree node_modules symlinks (SMI-4654)
#
# Iterates `git worktree list`, walks every worktree's node_modules and
# packages/*/node_modules links, and confirms each resolves to a real
# directory (not a dangling symlink pointing outside the repo).
#
# Exits non-zero if any symlink is dangling, missing, or pointing to
# something other than a directory. Used as the post-merge verification
# step for SMI-4654 (replaces ad-hoc spot-check loops in plan archaeology).
#
# Usage: ./scripts/verify-worktree-symlinks.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [[ -z "$REPO_ROOT" ]]; then
    error "Not in a git repository."
fi

# If run from inside a worktree, climb to the main repo for iteration.
MAIN_GIT_DIR="$(get_main_git_dir "$REPO_ROOT")"
if [[ "$MAIN_GIT_DIR" != "$REPO_ROOT/.git" ]] && [[ -n "$MAIN_GIT_DIR" ]]; then
    REPO_ROOT="$(dirname "$MAIN_GIT_DIR")"
    info "Running from worktree; resolved main repo: $REPO_ROOT"
fi

info "Auditing worktree symlinks (SMI-4654)..."

problems=0
audited=0

check_link() {
    local link="$1"
    local label="$2"

    if [[ ! -L "$link" ]]; then
        # Real directory or absent — not our concern, only links are audited.
        return 0
    fi

    audited=$((audited + 1))

    if [[ ! -e "$link" ]]; then
        # Dangling symlink: target does not exist.
        local tgt
        tgt="$(readlink "$link")"
        warn "  DANGLING: $label -> $tgt"
        problems=$((problems + 1))
        return 0
    fi

    if [[ ! -d "$link" ]]; then
        warn "  NOT A DIRECTORY: $label points to non-directory"
        problems=$((problems + 1))
        return 0
    fi
}

while IFS= read -r wt_path; do
    [[ -z "$wt_path" ]] && continue
    [[ "$wt_path" == "$REPO_ROOT" ]] && continue
    [[ ! -d "$wt_path" ]] && continue

    check_link "$wt_path/node_modules" "$wt_path/node_modules"

    if [[ -d "$wt_path/packages" ]]; then
        for pkg_dir in "$wt_path"/packages/*/; do
            [[ -d "$pkg_dir" ]] || continue
            pkg_link="${pkg_dir%/}/node_modules"
            check_link "$pkg_link" "$pkg_link"
        done
    fi
done < <(git -C "$REPO_ROOT" worktree list --porcelain | awk '/^worktree / { print $2 }')

if [[ $problems -gt 0 ]]; then
    error "$problems symlink problem(s) found across worktrees ($audited audited). Run ./scripts/repair-worktrees.sh to fix."
fi

success "All $audited worktree symlink(s) resolve correctly."
