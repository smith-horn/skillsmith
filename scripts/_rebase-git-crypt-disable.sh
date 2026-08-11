#!/usr/bin/env bash
# _rebase-git-crypt-disable.sh — Step 7's disable-filters sequence, split
# out of _rebase-git-crypt.sh (SMI-5983) once that file plus this addition
# together exceeded CLAUDE.md's 500-line file-length guidance. Sourced
# only, never run standalone — relies on rebase-worktree.sh's globals
# (WORKTREE_PATH, ORIG_SMUDGE, ORIG_CLEAN, HAS_GIT_CRYPT, DRY_RUN) and
# _lib.sh's info/warn/error/git-crypt-lock/marker functions, already in
# scope via bash's shared-process sourcing model.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# SMI-5983: Step 7's lock+classify+capture+write sequence -- called from
# rebase-worktree.sh's step_disable_filters() (a thin wrapper there, to stay
# under that file's 500-line cap). Classifies under the lock BEFORE
# capturing anything; DISABLED hard-fails (error(), never returns) instead
# of self-healing inline -- capturing cat/cat as "the original" is the
# concurrent-rebase corruption bug this closes. Resolve via
# `worktree-crypt.sh fix` (auto-heals via _lib.sh's two-signal check) then
# retry. Every other classification behaves exactly as pre-SMI-5983.
# Returns 0 (filters disabled, caller registers the restore trap) or 1
# (nothing to do -- MISSING or --dry-run, already logged); never returns on
# DISABLED.
disable_git_crypt_filters_or_fail() {
    acquire_git_crypt_filter_lock "$WORKTREE_PATH"
    classify_git_crypt_filter_state "$WORKTREE_PATH"

    if [ "$GIT_CRYPT_FILTER_STATE" = "DISABLED" ]; then
        release_git_crypt_filter_lock
        read_git_crypt_disabled_marker "$WORKTREE_PATH"
        echo ""
        warn "Step 7: git-crypt filters are already disabled -- refusing to proceed."
        if [ "$GIT_CRYPT_MARKER_VALID" = "true" ]; then
            echo "  Disabled by PID $GIT_CRYPT_MARKER_PID in worktree $GIT_CRYPT_MARKER_WORKTREE."
        else
            echo "  No marker found (a pre-SMI-5983 disable, or an unparseable/hand-set state)."
        fi
        echo "  If you believe this is stale, run:"
        print_git_crypt_filter_remediation "$WORKTREE_PATH"
        echo "  which auto-heals it if the disabling process is confirmed dead and no rebase"
        echo "  is active there -- then retry this command."
        error "Refusing to capture original filter values from an already-disabled state (SMI-5983 -- this used to silently corrupt the eventual restore)."
    fi

    if [ "$GIT_CRYPT_FILTER_STATE" = "MISSING" ]; then
        release_git_crypt_filter_lock
        info "Step 7: Skipping filter disable (no git-crypt filters configured)"
        HAS_GIT_CRYPT=false
        return 1
    fi

    ORIG_SMUDGE="$GIT_CRYPT_FILTER_SMUDGE"
    ORIG_CLEAN="$GIT_CRYPT_FILTER_CLEAN"
    HAS_GIT_CRYPT=true
    info "Step 7: Disabling git-crypt filters..."
    if [ "$DRY_RUN" = true ]; then
        release_git_crypt_filter_lock
        info "  [dry-run] Would disable git-crypt smudge/clean filters"
        return 1
    fi
    git -C "$WORKTREE_PATH" config --local filter.git-crypt.smudge "cat"
    git -C "$WORKTREE_PATH" config --local filter.git-crypt.clean "cat"
    # Written LAST, strictly after both filter values -- see the plan doc's
    # §1 for why this ordering makes every partial-write crash point safe
    # without needing a transaction log.
    write_git_crypt_disabled_marker "$WORKTREE_PATH" "$WORKTREE_PATH"
    release_git_crypt_filter_lock
    return 0
}
