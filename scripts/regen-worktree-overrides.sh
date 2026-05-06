#!/usr/bin/env bash
#
# regen-worktree-overrides.sh — postinstall shim (SMI-4738).
#
# Calls repair_worktrees_compose_override only. Side-effect-free:
# never writes binaries, never asserts host node_modules state, never
# probes Docker. Safe to invoke from npm postinstall, where install-
# transaction state is fragile and a hard exit must never block the
# install.
#
# macOS-only (mirrors SMI-4689 emission gate). Linux: silent no-op.
#
# Reference: SMI-4738 (parent: SMI-4689).
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

if [[ "$(uname)" != "Darwin" ]]; then
    exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [[ -z "$REPO_ROOT" ]]; then
    exit 0
fi

# When invoked from a worktree's npm install, `git rev-parse --show-toplevel`
# returns the worktree path. Resolve to the main repo root via the worktree's
# .git file so `git -C $repo_root worktree list` enumerates all sibling
# worktrees (not just the current one).
MAIN_GIT_DIR="$(get_main_git_dir "$REPO_ROOT")"
if [[ -n "$MAIN_GIT_DIR" ]] && [[ "$MAIN_GIT_DIR" != "$REPO_ROOT/.git" ]]; then
    REPO_ROOT="$(dirname "$MAIN_GIT_DIR")"
fi

if ! repair_worktrees_compose_override "$REPO_ROOT"; then
    rc=$?
    echo "skillsmith: regen-worktree-overrides.sh: repair_worktrees_compose_override failed (rc=$rc); see scripts/_lib.sh." >&2
fi
exit 0
