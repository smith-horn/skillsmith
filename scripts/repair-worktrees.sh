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
# Docker until a container-side `npm rebuild` runs. The guard below
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
        files; you must run \`docker exec -w /app <container> sh -c "sh scripts/lib/node-modules-mount-gate.sh && npm rebuild better-sqlite3 onnxruntime-node"\`
        afterward to restore them (SMI-6614: non-zero exit, no rebuild
        output -> a node_modules mount is detached or not a volume -- recreate first).
        See SMI-4698.
EOF
            exit 0
            ;;
        *)
            error "Unknown option: $1 (try --help)"
            ;;
    esac
done

# Classifies container $1 by its Compose
# `com.docker.compose.project.working_dir` label against $REPO_ROOT — a
# `docker ps` match can be the MAIN checkout's container, a WORKTREE's own
# container, or (rare) something whose label can't be read at all. Each
# needs DIFFERENT recovery advice: the main checkout's container is the one
# this repair script's own host-side native-rebuild step corrupts and can
# safely gated-rebuild in place; a worktree's container never gets an
# npm-mutating command at all (CLAUDE.md: never npm-mutate a worktree
# container — `docker compose restart dev` self-heals native bindings
# instead, SMI-5351).
#
# Prints "main <label>" / "worktree <label>" / "unknown" to stdout.
#
# Compared with `-ef` (same-file test), NOT a string compare — measured
# live 2026-09-14: `skillsmith-dev-1`'s label reports
# `/Users/williamsmith/documents/github/smith-horn/skillsmith` (lower-case
# — APFS is case-insensitive, Compose recorded it that way) while
# $REPO_ROOT keeps the real-case spelling; `-ef` is TRUE for that exact
# pair (same file, different spelling) in both sh and bash, and FALSE for a
# worktree's container label vs $REPO_ROOT — confirmed with both real
# containers before writing this.
_gate_classify_container() {
    local name="$1" label
    label="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$name" 2>/dev/null || true)"
    # Measured 2026-09-14: this Docker CLI prints an empty string for a
    # missing label; older Go-template renderings print `<no value>`. A label
    # naming a directory that doesn't exist on this host can't be a checkout
    # we can cd into, so it's unknown too, never "worktree".
    case "$label" in
        '' | '<no value>')
            printf 'unknown\n'
            return
            ;;
    esac
    if [ ! -d "$label" ]; then
        printf 'unknown\n'
        return
    fi
    if [ "$label" -ef "$REPO_ROOT" ] 2>/dev/null; then
        printf 'main %s\n' "$label"
    else
        printf 'worktree %s\n' "$label"
    fi
}

# Prints the recovery advice for ONE container ($1 = name, $2 = this
# container's own `_gate_classify_container` output) — never interpolates
# more than one container name into a single command line.
_gate_container_advice() {
    local name="$1" classification="$2" dir
    case "$classification" in
        main\ *)
            printf '  %s (main checkout): docker exec -w /app %s sh -c '\''sh scripts/lib/node-modules-mount-gate.sh && npm rebuild better-sqlite3 onnxruntime-node'\''\n' "$name" "$name"
            printf '    (SMI-6614: non-zero exit, no rebuild output -> a node_modules mount problem, recreate first)\n'
            ;;
        worktree\ *)
            dir="${classification#worktree }"
            # %q shell-quotes the directory, so a path with spaces or shell
            # metacharacters still prints a command that runs as written.
            printf '  %s (worktree checkout at %s): ( cd %q && docker compose --profile dev restart dev )\n' "$name" "$dir" "$dir"
            printf '    (self-heals native bindings, SMI-5351 — never run an npm-mutating command against a worktree container, CLAUDE.md)\n'
            ;;
        *)
            printf "  %s: this container's checkout could not be identified (its Compose\n" "$name"
            printf "    working_dir label is missing, unreadable, or names a directory that doesn't exist here) — both options:\n"
            printf "      IF %s is the MAIN checkout's container:\n" "$name"
            printf '        docker exec -w /app %s sh -c '\''sh scripts/lib/node-modules-mount-gate.sh && npm rebuild better-sqlite3 onnxruntime-node'\''\n' "$name"
            printf "      IF %s is a WORKTREE's container:\n" "$name"
            printf '        ( cd <that worktree'\''s path> && docker compose --profile dev restart dev )\n'
            ;;
    esac
}

# SMI-4698: gate the native-rebuild step (repair-host-native-deps.sh) when
# a running Docker container shares the symlinked node_modules. Symlink
# repair is safe with active Docker — only this step writes binaries.
check_docker_safety_for_rebuild() {
    if ! command -v docker >/dev/null 2>&1; then
        return 0  # No docker CLI — no risk
    fi
    # S-3: bound the daemon-query at 5s so a wedged Docker socket can't
    # hang the script forever. `timeout` returns 124 on expiry; we treat
    # any non-zero exit as "couldn't determine state" and proceed without
    # the guard rather than blocking legitimate repair.
    #
    # SMI-4700: macOS does not ship GNU `timeout`. Calling `timeout 5 …`
    # without the binary on PATH yields rc=127, which the rc handler
    # below would treat as "couldn't determine state" — silently skipping
    # the guard on the primary dev platform. The shared run_with_timeout
    # helper (SMI-5596, _lib.sh) probes `gtimeout` (Homebrew coreutils)
    # first, then `timeout`, and falls through to running `docker ps`
    # unbounded if neither is available. The unbounded path matches
    # today's macOS reality (a wedged daemon would have hung the script
    # anyway since the guard never executed) but at least lets the guard
    # fire when Docker is responsive. Pattern mirrors
    # scripts/session-start-priming.sh's own capability probe, with the addition of
    # validating `gtimeout` (priming-script only validates `timeout`) so a
    # broken Homebrew coreutils install can't trip the same trap. Extracted
    # into run_with_timeout so create-worktree.sh's Step 8 readiness probe
    # can reuse the identical capability-detection logic.
    local active rc=0
    active="$(run_with_timeout 5 -- docker ps --format '{{.Names}}' 2>/dev/null)" || rc=$?
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

    # Classify EACH matched container individually and build one advice
    # block with exactly one `docker exec`/`docker compose` line per
    # container — never a single command interpolating several names at
    # once: `$match` can be multiple lines, and a naive `docker exec …
    # $match …` would splice all of them into one argv.
    local advice="" name classification
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        classification="$(_gate_classify_container "$name")"
        advice="${advice}$(_gate_container_advice "$name" "$classification")
"
    done <<< "$match"

    if [ "$FORCE_WITH_ACTIVE_DOCKER" = true ]; then
        warn "  --force-with-active-docker set — proceeding despite active container(s)."
        warn "  After this script completes, restore each affected container:"
        echo "$advice" >&2
        return 0
    fi

    error "Active Docker container detected: $match

repair-worktrees.sh would rebuild host-arch native bindings (better-sqlite3,
onnxruntime-node) into the symlinked node_modules. This corrupts each
affected container's ELF binary and breaks all tests inside Docker.

Choose one:
  1. Stop the container(s) first:  docker compose --profile dev down (from each affected checkout)
  2. Recover each container individually:
$advice
  3. Force (then recover as above):  ./scripts/repair-worktrees.sh --force-with-active-docker"
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

# SMI-5702: because filter.git-crypt.{smudge,clean,required} and
# diff.git-crypt.textconv are repo-shared state, this single call retroactively
# repairs an ALREADY-corrupted repo (main checkout + every worktree at once) --
# not just the worktree this script happens to be iterating. Runs before the
# symlink-repair phases below since a broken filter registration is the more
# severe failure mode (silent plaintext/ciphertext, not just a missing dev
# convenience symlink).
info "Verifying git-crypt filter registration (SMI-5702)..."
ensure_git_crypt_filter_registered "$REPO_ROOT"

# SMI-6334: core.hooksPath is repo-shared state exactly like the git-crypt
# filter registration above -- a single call here (against the main repo
# root) retroactively repairs an already-drifted-to-absolute value for the
# main checkout AND every worktree at once, not just whichever tree this
# script happens to be iterating.
#
# `|| true` is required under `set -e` (this script's own top-of-file
# `set -euo pipefail`): ensure_hooks_path_relative() legitimately `return 1`s
# in its refuse-to-write case (target tree's .husky/_/h missing) -- a
# non-fatal, already-logged WARN, not a reason to abort the rest of this
# script's OTHER repair steps (node_modules symlinks, docker override
# regen, the Docker-safety guard below). An unguarded call here would let
# that one sub-repair's refusal kill every later step under set -e --
# confirmed live via scripts/tests/repair-worktrees-docker-guard.test.ts's
# synthetic fixtures (no .husky/_/h present), which stopped reaching the
# Docker-active guard entirely before this fix.
info "Verifying core.hooksPath is relative (SMI-6334)..."
ensure_hooks_path_relative "$REPO_ROOT" || true

info "Repairing worktrees missing node_modules symlink (SMI-4377)..."
repair_worktrees_node_modules "$REPO_ROOT"

info "Backfilling per-package node_modules symlinks (SMI-4381)..."
repair_worktrees_package_node_modules "$REPO_ROOT"

# SMI-4689: regenerate docker-compose.override.yml on macOS so existing
# worktrees pick up the per-package node_modules bind mounts. No-op on
# Linux. Runs BEFORE check_docker_safety_for_rebuild — the override
# regen never writes binaries, so it's safe with an active container.
info "Regenerating docker-compose.override.yml (SMI-4689 macOS bind mounts)..."
repair_worktrees_compose_override "$REPO_ROOT"

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
