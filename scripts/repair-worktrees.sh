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
# SMI-4698: the native-rebuild step (repair-host-native-deps.sh) writes
# host-arch (Mach-O on macOS) `*.node` binaries into the symlinked
# node_modules. Because per-package node_modules are symlinked between
# the host and the running Docker dev container, that rebuild overwrites
# the container's ELF (linux-x64) binary, breaking every test inside
# Docker until `docker exec ... npm rebuild` runs. The guard below
# refuses to run the native-rebuild step when a `skillsmith*-dev-N`
# container is detected, unless --force-with-active-docker is set.
# Symlink-repair phases run unconditionally (no binary writes).
#
# Usage: ./scripts/repair-worktrees.sh [--force-with-active-docker]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# SMI-4698: --force-with-active-docker bypasses the running-container guard
# on the native-rebuild step. CLI flag (matches remove-worktree.sh /
# rebase-worktree.sh convention), not env var.
FORCE_WITH_ACTIVE_DOCKER=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --force-with-active-docker)
            FORCE_WITH_ACTIVE_DOCKER=true
            shift
            ;;
        -h|--help)
            cat <<EOF
Usage: $(basename "$0") [--force-with-active-docker]

Repairs node_modules symlinks (SMI-4377/SMI-4381) and host native bindings
(SMI-4549) across every git worktree. Safe to run repeatedly.

Options:
    --force-with-active-docker
        Run the native-rebuild step even when a skillsmith dev container
        is detected. The rebuild writes host-arch binaries into the
        symlinked node_modules and clobbers the container's ELF *.node
        files; you must run \`docker exec -w /app <container> npm rebuild
        better-sqlite3 onnxruntime-node\` afterward to restore them.
        See SMI-4698.
EOF
            exit 0
            ;;
        *)
            error "Unknown option: $1 (try --help)"
            ;;
    esac
done

# SMI-4698: gate the native-rebuild step (repair-host-native-deps.sh) when
# a running Docker container shares the symlinked node_modules. Symlink
# repair is safe with active Docker — only this step writes binaries.
check_docker_safety_for_rebuild() {
    if [ "$FORCE_WITH_ACTIVE_DOCKER" = true ]; then
        warn "  --force-with-active-docker set — proceeding despite active container."
        warn "  After this script completes, run:"
        warn "    docker exec -w /app <container-name> npm rebuild better-sqlite3 onnxruntime-node"
        warn "  to restore the container's ELF native bindings."
        return 0
    fi
    if ! command -v docker >/dev/null 2>&1; then
        return 0  # No docker CLI — no risk
    fi
    # S-3: bound the daemon-query at 5s so a wedged Docker socket can't
    # hang the script forever. `timeout` returns 124 on expiry; we treat
    # any non-zero exit as "couldn't determine state" and proceed without
    # the guard rather than blocking legitimate repair.
    local active rc=0
    active="$(timeout 5 docker ps --format '{{.Names}}' 2>/dev/null)" || rc=$?
    if [ "$rc" -ne 0 ]; then
        warn "  docker ps failed or timed out (rc=$rc); proceeding without guard."
        return 0
    fi
    # S-1: container regex matches default `skillsmith-dev-1` plus
    # COMPOSE_PROJECT_NAME variants like `skillsmith-prod-dev-1` or
    # `skillsmith-feat-dev-2`. The `-dev-N` suffix anchor avoids
    # false-positives on unrelated `skillsmith-cli` / `skillsmith-web`
    # containers.
    local match
    match="$(echo "$active" | grep -E '^skillsmith.*-dev-[0-9]+$' || true)"
    if [ -z "$match" ]; then
        return 0
    fi
    error "Active Docker container detected: $match

repair-worktrees.sh would rebuild host-arch native bindings (better-sqlite3,
onnxruntime-node) into the symlinked node_modules. This corrupts the
container's ELF binary and breaks all tests inside Docker.

Choose one:
  1. Stop the container first:  docker compose --profile dev down
  2. Rebuild on Docker side:     docker exec -w /app $match npm rebuild better-sqlite3 onnxruntime-node
  3. Force (then rebuild Docker side):  ./scripts/repair-worktrees.sh --force-with-active-docker"
}

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

info "Repairing worktrees missing node_modules symlink (SMI-4377)..."
repair_worktrees_node_modules "$REPO_ROOT"

info "Backfilling per-package node_modules symlinks (SMI-4381)..."
repair_worktrees_package_node_modules "$REPO_ROOT"

# SMI-4698: gate the native-rebuild step on active-Docker detection.
# Symlink-repair phases above run unconditionally — they don't touch
# binary contents. Only the rebuild step below would clobber the
# container's ELF *.node files.
check_docker_safety_for_rebuild

# SMI-4549: rebuild host-side native bindings skipped by `npm install
# --ignore-scripts`. Cheap (sub-second `[skip]`) on a healthy host; rebuilds
# better-sqlite3 from source if the binding is missing or the require()
# fails to instantiate. Single-source-of-truth host-setup pass.
info "Verifying host native bindings (SMI-4549)..."
"$SCRIPT_DIR/repair-host-native-deps.sh"
