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

# SMI-6520 Wave 1 Step 4: distinguish "dangling because the literal is the
# CONTAINER-ONLY absolute path" from every other dangling cause.
#
# WHY THIS SPECIFIC BRANCH EXISTS. The container-side repair
# (scripts/lib/repair-worktree-container-symlinks.sh) rewrites each per-package
# symlink to its absolute RESOLVED form -- e.g. /packages/core/node_modules --
# and prints "[repair] Repaired N ..." without asserting anything. That literal
# is valid only inside the container: /app IS the worktree there, so a
# host-correct ../../../../ clamps at / and resolves outside /app. But the file
# it writes is NOT container-local: the symlink itself lives on the writable
# .:/app bind, i.e. the HOST worktree's own file. A host-side census found 96 of
# 189 audited links in this absolute form, all dangling on the host, and one
# sample's mtime matched its container's StartedAt to the second.
#
# The host consumers this breaks (pre-commit lint-staged, host-fallback
# pre-push, host `tsc --build`) fail with errors that name none of the above,
# which is why the cause is spelled out rather than reported as plain DANGLING.
#
# Read-only and advisory: this only changes the MESSAGE, never the exit status.
classify_dangling() {
    local link="$1" tgt="$2" expected="$3"

    case "$tgt" in
        /app | /app/*)
            # B2(i): an absolute /app/... literal is ALSO meaningless on the
            # host. An earlier draft would have accepted it; it must not.
            printf 'container-only absolute path (/app-rooted)'
            return 0
            ;;
        /*)
            # Absolute and not under the host repo root => the container-only
            # resolved form the container-side repair writes.
            if [[ "$tgt" != "$REPO_ROOT"/* ]]; then
                printf 'container-only absolute path (resolved-in-container form)'
                return 0
            fi
            printf 'absolute path under the repo root, but the target does not exist'
            return 0
            ;;
    esac

    if [[ -n "$expected" && "$tgt" == "$expected" ]]; then
        printf 'literal is the canonical relative form, but its target is missing'
        return 0
    fi
    printf 'relative literal that does not match the canonical form'
}

check_link() {
    local link="$1"
    local label="$2"
    # Expected literal, COMPUTED by the same function that writes it
    # (compute_relative_target), never pattern-matched. Empty if it could not
    # be computed, in which case the canonical form is simply not asserted.
    local expected="${3:-}"

    if [[ ! -L "$link" ]]; then
        # Real directory or absent — not our concern, only links are audited.
        return 0
    fi

    audited=$((audited + 1))

    if [[ ! -e "$link" ]]; then
        # Dangling symlink: target does not exist.
        local tgt cause
        tgt="$(readlink "$link")"
        cause="$(classify_dangling "$link" "$tgt" "$expected")"
        warn "  DANGLING: $label -> $tgt"
        warn "            cause: $cause"
        if [[ -n "$expected" ]]; then
            warn "            canonical literal: $expected"
        fi
        warn "            remedy: ./scripts/repair-worktrees.sh (run from the main checkout)"
        problems=$((problems + 1))
        return 0
    fi

    # A link can resolve correctly on the host and STILL carry a non-canonical
    # literal -- reported, but not counted as a problem, so exit semantics are
    # unchanged from before this branch was added.
    if [[ -n "$expected" && "$(readlink "$link")" != "$expected" ]]; then
        info "  NON-CANONICAL (resolves, not counted): $label -> $(readlink "$link")"
        info "            canonical literal: $expected"
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

    # Canonical literals are computed with the SAME helper that writes them, so
    # the assertion cannot drift from the writer (plan §2: "computed, not
    # pattern-matched"). compute_relative_target returns non-zero for a path
    # outside the repo root; in that case the canonical form is left empty and
    # simply not asserted, rather than guessed.
    root_expected="$(compute_relative_target "$wt_path" "$REPO_ROOT/node_modules" "$REPO_ROOT" 2>/dev/null || echo "")"
    check_link "$wt_path/node_modules" "$wt_path/node_modules" "$root_expected"

    if [[ -d "$wt_path/packages" ]]; then
        for pkg_dir in "$wt_path"/packages/*/; do
            [[ -d "$pkg_dir" ]] || continue
            pkg_link="${pkg_dir%/}/node_modules"
            pkg_name="$(basename "${pkg_dir%/}")"
            pkg_expected="$(compute_relative_target "${pkg_dir%/}" \
                "$REPO_ROOT/packages/$pkg_name/node_modules" "$REPO_ROOT" 2>/dev/null || echo "")"
            check_link "$pkg_link" "$pkg_link" "$pkg_expected"
        done
    fi
done < <(git -C "$REPO_ROOT" worktree list --porcelain | awk '/^worktree / { print $2 }')

if [[ $problems -gt 0 ]]; then
    error "$problems symlink problem(s) found across worktrees ($audited audited). Run ./scripts/repair-worktrees.sh to fix."
fi

success "All $audited worktree symlink(s) resolve correctly."
