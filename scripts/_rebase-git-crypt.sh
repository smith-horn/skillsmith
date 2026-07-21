#!/usr/bin/env bash
# _rebase-git-crypt.sh — git-crypt filter management for rebase-worktree.sh.
#
# Split out of rebase-worktree.sh per CLAUDE.md's 500-line file-length
# convention (SMI-5773). Sourced only, never run standalone — relies on
# rebase-worktree.sh's globals (WORKTREE_PATH, ORIG_SMUDGE, ORIG_CLEAN,
# FILTERS_DISABLED, RESMUDGE_SCAN_FAILED, SCAN_RESULT_BAD, SCAN_RESULT_MISSING)
# and _lib.sh's info/warn/success/error, all already in scope via bash's
# shared-process sourcing model regardless of which file defines them.
#
# SMI-5773: `git checkout HEAD -- <paths>` skips stat-clean files (Git's
# checkout_entry_ca()/ie_match_stat() short-circuit) — files a rebase
# rewrites under a disabled (smudge=cat) git-crypt filter land on disk as
# ciphertext but get recorded stat-clean, so a plain re-checkout after
# restoring filters silently no-ops on exactly the files needing re-smudge.
# See docs/internal/implementation/smi-5773-rebase-git-crypt-desync.md for
# the full root-cause writeup and design rationale.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Extract encrypted path prefixes from .gitattributes (strips trailing /**)
# Falls back to empty string if .gitattributes is missing or has no git-crypt entries
get_encrypted_paths() {
    grep 'filter=git-crypt' "$WORKTREE_PATH/.gitattributes" 2>/dev/null \
        | awk '{print $1}' \
        | sed 's|/\*\*$||' \
        || echo ""
}

# Restore git-crypt filters to their original values
_restore_filter_kind() {
    local kind="$1" orig="$2"
    if [ -n "$orig" ]; then
        git -C "$WORKTREE_PATH" config --local "filter.git-crypt.$kind" "$orig"
    else
        git -C "$WORKTREE_PATH" config --local --unset "filter.git-crypt.$kind" 2>/dev/null || true
    fi
}

# SMI-5773: trap-safe config restore only. Safe to call from the EXIT trap on
# ANY failure path (partial rebase, failed --continue) — never touches the
# working tree, so it cannot destroy in-progress conflict-resolution state.
restore_filter_config() {
    [ "$FILTERS_DISABLED" = true ] || return 0
    info "Restoring git-crypt filters..."
    _restore_filter_kind smudge "$ORIG_SMUDGE"
    _restore_filter_kind clean  "$ORIG_CLEAN"
    FILTERS_DISABLED=false
    success "  Git-crypt filters restored"
}

# SMI-5773: success-path only — NEVER called from the EXIT trap. Caller
# (step_restore_filters) only invokes this once the parent rebase has been
# confirmed to have completed without an active conflict, so the tree is
# clean relative to HEAD (staged changes blocked at Step 1, unstaged changes
# stashed at Step 6 / popped at Step 11).
#
# `git checkout HEAD -- <paths>` alone skips stat-clean files (Git's
# checkout_entry()/ie_match_stat() short-circuit) — files the rebase rewrote
# under smudge=cat are stat-clean-WITH-CIPHERTEXT, exactly the ones needing
# re-smudge. Delete tracked copies first so the checkout MUST rewrite each
# through the restored smudge filter (unconditional write_entry, fresh inode).
force_resmudge() {
    local encrypted_paths; encrypted_paths=$(get_encrypted_paths)
    [ -n "$encrypted_paths" ] || return 0
    # NUL-delimited while-loop, not xargs: macOS xargs lacks -r (empty input
    # would run `rm` with no args), and paths may contain spaces. Unquoted
    # expansion of $encrypted_paths below is intentional — get_encrypted_paths()
    # output is derived from .gitattributes glob prefixes, which contain no
    # spaces today (see Surface Grounding in the SMI-5773 plan doc).
    # shellcheck disable=SC2086
    while IFS= read -r -d '' f; do
        rm -f -- "$WORKTREE_PATH/$f"
    done < <(git -C "$WORKTREE_PATH" ls-files -z -- $encrypted_paths)
    # No 2>/dev/null, no || true — a failed re-smudge must be loud.
    # shellcheck disable=SC2086
    if ! git -C "$WORKTREE_PATH" checkout HEAD -- $encrypted_paths; then
        warn "Re-smudge checkout reported errors — ciphertext scan will verify"
    fi
}

# SMI-5773: detect git-crypt magic header in working-tree files that should
# be plaintext. Mirrors gitCryptLocked() (vitest.config.root-tests.ts) but
# scans ALL tracked encrypted files, not one hardcoded sentinel. Returns
# status only — never exits — so the caller controls sequencing relative to
# stash pop (a scan failure must never strand the user's stash).
scan_ciphertext() {
    local encrypted_paths f head9
    encrypted_paths=$(get_encrypted_paths)
    [ -n "$encrypted_paths" ] || return 0
    SCAN_RESULT_BAD=()
    SCAN_RESULT_MISSING=()
    # shellcheck disable=SC2086
    while IFS= read -r -d '' f; do
        if [ ! -f "$WORKTREE_PATH/$f" ]; then
            SCAN_RESULT_MISSING+=("$f")   # a missing tracked file is itself a failure, not a skip
            continue
        fi
        head9=$(head -c 9 "$WORKTREE_PATH/$f" | LC_ALL=C tr -d '\0')
        [ "$head9" = "GITCRYPT" ] && SCAN_RESULT_BAD+=("$f")
    done < <(git -C "$WORKTREE_PATH" ls-files -z -- $encrypted_paths)
    if [ "${#SCAN_RESULT_BAD[@]}" -gt 0 ] || [ "${#SCAN_RESULT_MISSING[@]}" -gt 0 ]; then
        return 1
    fi
    # shellcheck disable=SC2086
    success "  Ciphertext scan clean ($(git -C "$WORKTREE_PATH" ls-files -- $encrypted_paths | wc -l | tr -d ' ') files)"
    return 0
}

# SMI-5773: post-Step-11 check — acts on the RESMUDGE_SCAN_FAILED result
# recorded by step_restore_filters()/scan_ciphertext(). Deliberately run
# AFTER step_pop_stash (so a detected residue never strands the user's
# stash) AND AFTER step_verify_branch (code review, bf-1a2): a hard exit
# here must not skip the branch-switch safety check — git-crypt smudge
# filters silently switching branches during stash/pop is a known incident
# class (SMI-2536), and this is precisely the failure mode most correlated
# with unusual git-crypt filter behavior, so it's the last check that should
# ever be skipped. step_report is still skipped on a residue exit — the
# printed remediation below carries the necessary context on its own.
check_resmudge_scan_result() {
    [ "$RESMUDGE_SCAN_FAILED" = true ] || return 0
    echo ""
    warn "POST-REBASE CIPHERTEXT RESIDUE — working tree needs re-smudge:"
    printf '    %s\n' "${SCAN_RESULT_BAD[@]:-}" "${SCAN_RESULT_MISSING[@]:-}"
    local enc_paths; enc_paths=$(get_encrypted_paths | tr '\n' ' ')
    echo "  Remediation (forces re-smudge):"
    echo "    git -C $WORKTREE_PATH ls-files -z -- $enc_paths | while IFS= read -r -d '' f; do rm -f -- \"$WORKTREE_PATH/\$f\"; done"
    echo "    git -C $WORKTREE_PATH checkout HEAD -- $enc_paths"
    exit 4   # new exit code: rebase (and stash pop) succeeded, but working tree needs re-smudge
}
