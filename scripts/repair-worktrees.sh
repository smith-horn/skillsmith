#!/usr/bin/env bash
#
# repair-worktrees.sh - Idempotent repair for stale worktrees (SMI-4377)
#
# Ensures every existing worktree has the node_modules symlink required
# for host-side pre-commit hooks (lint-staged, check-file-length, etc.).
# Layer 1 (hook discovery) is handled by the committed .husky/_/ tree —
# any worktree that checks out a branch containing the fix will have
# hooks working automatically.
#
# Safe to run repeatedly. Skips worktrees that already have node_modules
# (symlink or real directory). Never touches the main repository.
#
# Usage: ./scripts/repair-worktrees.sh
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
# get_main_git_dir returns the main .git path; parent is the main repo root.
MAIN_GIT_DIR="$(get_main_git_dir "$REPO_ROOT")"
if [[ "$MAIN_GIT_DIR" != "$REPO_ROOT/.git" ]] && [[ -n "$MAIN_GIT_DIR" ]]; then
    REPO_ROOT="$(dirname "$MAIN_GIT_DIR")"
    info "Running from worktree; resolved main repo: $REPO_ROOT"
fi

assert_host_node_modules "$REPO_ROOT"

info "Repairing worktrees missing node_modules symlink..."
repair_worktrees_node_modules "$REPO_ROOT"
