#!/usr/bin/env bash
# worktree-lifecycle.sh - worktree liveness derivation and the worktree
# lifecycle lock (SMI-6981). Sourced by prune-orphaned-docker-volumes.sh,
# create-worktree.sh and lib/report-sprawl-containers.sh; defines functions
# only. Requires _lib.sh (error/warn/info/success, sanitize_project_name) to be
# sourced first. Every function takes the main checkout as an explicit
# $main_repo argument: nothing here reads a caller's global.

# The ONE reader of `git worktree list`: every consumer (protected set, control
# name, container report) goes through here, so the status check below cannot be
# skipped by a new caller. Output and status are captured SEPARATELY and the
# listing is emitted only when git exited 0 -- a command that printed some
# records and then failed would otherwise hand back a partial listing (SMI-6981).
# `sed`, never `awk '{print $2}'`: awk stops at the first space, so a worktree
# path containing one truncates and a LIVE worktree reads as unprotected. Tests
# 1e/1f pin this extraction (live-worktree path / main-checkout path).
# `7<&-`: git never inherits the lifecycle lock (fd 7).
enumerate_worktree_paths() {
    local main_repo="$1" raw
    raw="$(git -C "$main_repo" worktree list --porcelain 7<&- 2>/dev/null)" || return 1
    printf '%s\n' "$raw" | sed -n 's/^worktree //p'
}

# derive_protected(): sanitized project names for the captured listing in $1,
# UNIONED with a `.worktrees/*/` scan of the main checkout $2 (names sanitizing
# alike only OVER-protect). sanitize_project_name (_lib.sh) is the single
# sanitizer; its trailing newline keeps consecutive names on separate lines for
# is_protected()'s exact match.
derive_protected() {
    local wt_paths="$1" main_repo="$2" wt_path base
    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        base="$(basename "$wt_path")"
        sanitize_project_name "$base"
    done <<< "$wt_paths"

    if [[ -d "$main_repo/.worktrees" ]]; then
        local d
        for d in "$main_repo"/.worktrees/*/; do
            [[ -d "$d" ]] || continue
            sanitize_project_name "$(basename "${d%/}")"
        done
    fi
}

# The positive control is derived INDEPENDENTLY of the listing it checks, from
# this checkout's own toplevel (`git rev-parse --show-toplevel`): a control from
# the same listing as the set cannot fail. Both queries print the PHYSICAL path
# (measured for a symlinked parent, a final-component symlink and a case-differing
# invocation) and sanitize lowercases, so a healthy run is not refused.
derive_checkout_project() {
    local main_repo="$1" top
    top="$(git -C "$main_repo" rev-parse --show-toplevel 7<&- 2>/dev/null)" || return 1
    [[ -n "$top" ]] || return 1
    sanitize_project_name "$(basename "$top")"
}

# derive_protected() alone fails OPEN: an empty listing makes every candidate
# read as unprotected. This wrapper is its only caller and fails closed via
# error() (exit 1; remove-worktree.sh degrades that to a warning). ONE read per
# derivation feeds both the set and the check. The control is POSITIVE, not an
# emptiness test: a failed enumeration leaves the set non-empty (the
# `.worktrees/*/` scan) but missing this checkout's own name.
#
# error() exits only the command-substitution subshell this is called in, so
# EVERY caller must read the result as `x="$(derive_protected_or_die "$m")" ||
# error ...`: a bare or `local x="$(...)"` assignment continues with whatever
# partial output the failed call printed, and inside a function called from an
# `if`/`||` errexit does not stop it (measured on bash 3.2, SMI-6981).
derive_protected_or_die() {
    local main_repo="$1" out self wt_paths
    if ! wt_paths="$(enumerate_worktree_paths "$main_repo")"; then
        error "\`git worktree list\` failed -- refusing to prune. A listing from a failed command may be missing later worktrees, so no protected set derived from it can be trusted."
    fi
    out="$(derive_protected "$wt_paths" "$main_repo")"

    if [[ -z "$wt_paths" ]]; then
        error "\`git worktree list\` produced no worktree entry for this checkout -- refusing to prune. The canonical enumeration returned nothing, so no protected set can be trusted."
    fi
    if ! self="$(derive_checkout_project "$main_repo")"; then
        error "could not independently identify this checkout (\`git rev-parse --show-toplevel\` failed) -- refusing to prune, because the protected set has no control to be checked against."
    fi
    # A basename made entirely of characters sanitize_project_name strips leaves
    # this empty, and `grep -qxF "" <<< ""` MATCHES (here-strings append a
    # newline), so the guard would pass in the state of maximum danger.
    if [[ -z "$self" ]]; then
        error "this checkout's project name sanitizes to the empty string -- refusing to prune, because an empty pattern would match an empty protected set and pass vacuously."
    fi

    if ! grep -qxF "$self" <<< "$out"; then
        error "the derived protected set does not contain this checkout's own project name ('$self', from \`git rev-parse --show-toplevel\`) -- refusing to prune. \`git worktree list\` always lists this checkout, so this script's recovery of its output failed or the listing is wrong. The set may still be non-empty (a populated .worktrees/ contributes entries), which is why emptiness is not what is checked."
    fi
    printf '%s\n' "$out"
}

is_protected() {
    local project="$1" protected_set="$2"
    grep -qxF "$project" <<< "$protected_set"
}
