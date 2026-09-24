#!/usr/bin/env bash
# scripts/ruflo-service-up.helpers.sh -- linked-worktree and foreign-project
# guards for scripts/ruflo-service-up.sh (H-3(b)/(c), post-merge governance
# retro on PR #2931). Split into this sibling once ruflo-service-up.sh crossed
# the repo's own 500-line pre-commit gate (scripts/check-file-length.mjs).
#
# Sourced by scripts/ruflo-service-up.sh; not meant to be run standalone.
# Depends on the caller having already defined REPO_ROOT, COMPOSE_FILE,
# CONTAINER_NAME, log() and die().
#
# bash 3.2-safe (macOS default bash), shellcheck -S warning clean, same
# conventions as the caller.
set -euo pipefail

# H-3(b) (post-merge governance retro, PR #2931): refuse when run from a
# LINKED git worktree. This script's own header has always said "run from
# the main checkout, never per worktree" (SS3), but nothing enforced it --
# measured live: skillsmith-ruflo-1 was created from a worktree checkout,
# tying this MACHINE-GLOBAL, `restart: unless-stopped` service's identity
# (working_dir, and until H-3(a), image name too) to a checkout that can be
# torn down independently of the service it started (remove-worktree.sh's
# per-worktree teardown/orphan-prune has no way to know this container
# depends on it).
#
# `git rev-parse --git-dir` resolves to a path under
# `<main-repo>/.git/worktrees/<name>` for a linked worktree, and to `.git`
# (or an absolute equivalent) for the main checkout or a plain clone;
# `--git-common-dir` always resolves to the ONE shared `.git` dir every
# worktree of a repo points at. The two differ ONLY for a linked worktree --
# a plain clone or a git export (no `.git/worktrees/` at all) always has
# git-dir == git-common-dir and passes.
#
# Fails CLOSED: if $REPO_ROOT is not inside a git repository at all (a git
# export/tarball with no .git present), refuse too -- this script's
# volume/authority-file bookkeeping assumes a real checkout, not an
# unversioned tree, and "cannot determine" is not the same as "verified
# safe".
#
# Test seam: RUFLO_UP_SKIP_WORKTREE_GATE=1 bypasses this check. TEST-ONLY --
# scripts/tests/ruflo-service-up.test.sh's own fixture arms run this real
# script at its real on-disk path, which in an interactive dev worktree
# genuinely IS a linked worktree; those arms are not exercising THIS gate
# and set the seam so their pass/fail reflects volume/store logic only.
# Never set this outside a test.
#
# L-B (SMI-6744 A1.8 retro): the git-dir == git-common-dir normalization
# below is the ONE tested, correctness-bearing predicate for "is <dir> a
# linked worktree" -- it used to be duplicated (equivalent, but with no
# shared source and no declared sweep) in
# scripts/ruflo-federation-test.sh's own checkout_shape_ok(), which now
# calls git_dir_equals_common_dir() below instead. If you add a THIRD
# caller, call the shared function too rather than re-deriving this.
#
# git_dir_equals_common_dir <dir>: prints nothing, never dies. Returns 0 if
# <dir>'s git-dir and git-common-dir resolve to the SAME normalized,
# symlink-resolved path (a main checkout, a plain clone, or an
# unversioned tree is NOT distinguished here -- see check_not_linked_worktree()
# below for the fail-closed "cannot determine" handling a caller may want).
# Returns 1 for a linked worktree, OR when either rev-parse is empty
# (fails closed: "cannot determine" is treated as "not equal").
git_dir_equals_common_dir() {
    local dir="$1" gdir cdir
    gdir="$(git -C "$dir" rev-parse --git-dir 2>/dev/null || true)"
    cdir="$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null || true)"
    [[ -n "$gdir" && -n "$cdir" ]] || return 1
    # Normalize to absolute, symlink-resolved paths before comparing: git
    # can print either an absolute path or one relative to <dir> depending
    # on git version, and a bare string compare of a relative ".git"
    # against an absolute linked-worktree path would falsely differ even
    # for the main checkout.
    case "$gdir" in
        /*) : ;;
        *) gdir="$dir/$gdir" ;;
    esac
    case "$cdir" in
        /*) : ;;
        *) cdir="$dir/$cdir" ;;
    esac
    gdir="$(cd "$gdir" 2>/dev/null && pwd -P || printf '%s' "$gdir")"
    cdir="$(cd "$cdir" 2>/dev/null && pwd -P || printf '%s' "$cdir")"
    [[ "$gdir" == "$cdir" ]]
}

check_not_linked_worktree() {
    if [[ "${RUFLO_UP_SKIP_WORKTREE_GATE:-}" == "1" ]]; then
        return 0
    fi
    local git_dir git_common_dir main_checkout
    git_dir="$(git -C "$REPO_ROOT" rev-parse --git-dir 2>/dev/null || true)"
    if [[ -z "$git_dir" ]]; then
        die "$REPO_ROOT is not inside a git repository (git rev-parse --git-dir failed) -- refusing to run outside a real checkout (fail closed; SS3: run from the main checkout, never per worktree)"
    fi
    git_common_dir="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
    if [[ -z "$git_common_dir" ]]; then
        die "$REPO_ROOT: git rev-parse --git-common-dir failed -- cannot determine whether this is a linked worktree; refusing (fail closed)"
    fi
    if ! git_dir_equals_common_dir "$REPO_ROOT"; then
        # The pass/fail DECISION above already came from the shared,
        # singly-sourced predicate. Re-normalize here ONLY to name the two
        # resolved paths and compute main_checkout for the die() message --
        # this is message formatting, not a second copy of the comparison
        # logic itself.
        case "$git_dir" in
            /*) : ;;
            *) git_dir="$REPO_ROOT/$git_dir" ;;
        esac
        case "$git_common_dir" in
            /*) : ;;
            *) git_common_dir="$REPO_ROOT/$git_common_dir" ;;
        esac
        git_dir="$(cd "$git_dir" 2>/dev/null && pwd -P || printf '%s' "$git_dir")"
        git_common_dir="$(cd "$git_common_dir" 2>/dev/null && pwd -P || printf '%s' "$git_common_dir")"
        main_checkout="$(dirname "$git_common_dir")"
        die "$REPO_ROOT is a LINKED git worktree (git-dir $git_dir != git-common-dir $git_common_dir) -- this script's own header requires running it from the main checkout, never per worktree (SS3). Run instead: ( cd \"$main_checkout\" && ./scripts/ruflo-service-up.sh )"
    fi
}

# H-3(c) (post-merge governance retro, PR #2931): before ever attempting
# `up`, refuse if a container already named $CONTAINER_NAME belongs to a
# DIFFERENT Compose project than this checkout. Docker's own container-name
# uniqueness already prevents a silent takeover at the `bring_up_service()`
# step (proven live by scripts/ruflo-federation-test.sh's case A: a foreign
# project's `up` fails with "Conflict ... already in use"), but without this
# check that failure surfaces LATE -- after this checkout's own
# volume/authority-file bookkeeping has already run -- with a bare Docker
# message that names neither the foreign project nor how to resolve it.
# This check fails fast, before any of that work starts.
check_foreign_project() {
    if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
        return 0
    fi
    command -v jq >/dev/null 2>&1 || die "jq is required to check for a foreign-project container collision (docker compose config --format json | jq -r .name) but was not found on PATH"
    local this_project container_project container_workdir
    this_project="$(docker compose -f "$COMPOSE_FILE" config --format json 2>/dev/null | jq -r '.name // empty')"
    [[ -n "$this_project" ]] || die "could not resolve this checkout's Compose project name: docker compose -f $COMPOSE_FILE config --format json | jq -r .name"
    container_project="$(docker inspect "$CONTAINER_NAME" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
    container_workdir="$(docker inspect "$CONTAINER_NAME" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
    if [[ -n "$container_project" ]] && [[ "$container_project" != "$this_project" ]]; then
        if [[ -d "$container_workdir" ]]; then
            die "container $CONTAINER_NAME already exists and belongs to a DIFFERENT Compose project ($container_project, working_dir=$container_workdir) than this checkout's project ($this_project) -- refusing to reconcile silently into a takeover. Remediation: ( cd \"$container_workdir\" && docker compose --profile ruflo down ruflo ) from THAT project first, then re-run this script."
        else
            die "container $CONTAINER_NAME already exists and belongs to a DIFFERENT Compose project ($container_project, working_dir=$container_workdir) than this checkout's project ($this_project) -- refusing to reconcile silently into a takeover. Its own working_dir no longer exists on this machine, so its project can't stop it gracefully -- stop it first (never rm -f a running container), then remove it: docker stop $CONTAINER_NAME && docker rm $CONTAINER_NAME"
        fi
    fi
}
