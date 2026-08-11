#!/usr/bin/env bash
# _rebase-git-crypt.sh — git-crypt filter management for rebase-worktree.sh.
#
# Split out of rebase-worktree.sh per CLAUDE.md's 500-line file-length
# convention (SMI-5773). Sourced only, never run standalone — relies on
# rebase-worktree.sh's globals (WORKTREE_PATH, ORIG_SMUDGE, ORIG_CLEAN,
# FILTERS_DISABLED, RESMUDGE_SCAN_FAILED, SCAN_RESULT_BAD, SCAN_RESULT_MISSING,
# STASH_REF, DRY_RUN) and _lib.sh's info/warn/success/error, all already in
# scope via bash's shared-process sourcing model regardless of which file
# defines them. step_stash() (Step 6) also lives here (moved from
# rebase-worktree.sh when it again crossed the 500-line cap) — thematically
# it belongs with the rest of this file's stash/index-timestamp-stability
# logic, which it calls directly.
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
#
# SMI-5702: optional first arg, defaulting to $WORKTREE_PATH -- preserves
# every existing zero-arg caller in this file (force_resmudge,
# check_resmudge_scan_result, rebase-worktree.sh's own conflict-remediation
# text) while letting create-worktree.sh (which has no WORKTREE_PATH global)
# pass its own worktree path explicitly.
get_encrypted_paths() {
    local dir="${1:-$WORKTREE_PATH}"
    grep 'filter=git-crypt' "$dir/.gitattributes" 2>/dev/null \
        | awk '{print $1}' \
        | sed 's|/\*\*$||' \
        || echo ""
}

# Restore git-crypt filters to their original values.
#
# SMI-5702: the empty-pre-image branch used to `git config --local --unset`
# -- Step 6.5 (rebase-worktree.sh's step_ensure_filter_registered, which
# runs before Step 7 captures ORIG_SMUDGE/ORIG_CLEAN) now guarantees a
# classified, non-empty pre-image in practice (CANONICAL or a deliberate
# DISABLED "cat"), so this branch should be effectively unreachable going
# forward. Kept defensive rather than assuming that invariant always holds:
# an empty pre-image now heals to canonical registration instead of
# reproducing "missing" via --unset, which is what caused two repo-wide
# corruption incidents when this exact command was printed/run literally
# elsewhere (SMI-5702, recurrence SMI-5861).
_restore_filter_kind() {
    local kind="$1" orig="$2"
    if [ -n "$orig" ]; then
        git -C "$WORKTREE_PATH" config --local "filter.git-crypt.$kind" "$orig"
    else
        local canonical
        case "$kind" in
            smudge) canonical="$GIT_CRYPT_CANONICAL_SMUDGE" ;;
            clean)  canonical="$GIT_CRYPT_CANONICAL_CLEAN" ;;
        esac
        git -C "$WORKTREE_PATH" config --local "filter.git-crypt.$kind" "$canonical"
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

# SMI-5979: called from step_rebase_parent() right after it computes
# conflict_count (unmerged-file count from `git diff --diff-filter=U`) for a
# failed `git rebase`. conflict_count==0 alone is NOT proof the rebase never
# started -- a sequencer failure mid-rebase (distinct from a merge conflict)
# can leave zero unmerged files with rebase-merge/rebase-apply state still
# on disk (NEEDLE plan review finding). Only treat this as "nothing to
# resolve" when BOTH hold: no conflicted files AND no active rebase state
# for this worktree (git-path resolution is worktree-scoped, so this stays
# correct under concurrent rebases in other worktrees). When both hold,
# restores filters and exits (via error(), exit 1) instead of falling
# through to the caller's all_submodule/manual-conflict classification,
# which previously misclassified this case and left filters disabled with
# nothing to justify it (the SMI-5979 incident). Otherwise, a no-op —
# the caller's existing logic runs unchanged.
check_rebase_nothing_to_resolve() {
    local conflict_count="$1"
    [ "$conflict_count" -eq 0 ] || return 0

    if [ -d "$(git -C "$WORKTREE_PATH" rev-parse --git-path rebase-merge 2>/dev/null || echo /nonexistent)" ] || \
       [ -d "$(git -C "$WORKTREE_PATH" rev-parse --git-path rebase-apply 2>/dev/null || echo /nonexistent)" ]; then
        return 0
    fi

    trap restore_filter_config EXIT
    echo ""
    warn "Rebase pre-flight rejected before starting (no conflicted files, no active rebase state)."
    echo "  This usually means git's clean-tree check saw a residual difference"
    echo "  despite Step 6's stash -- possibly the racy-mtime window described in"
    echo "  docs/internal/implementation/smi-5781-rebase-worktree-stash-racy-mtime.md."
    echo "  Git-crypt filters have been restored; re-run this script to retry."
    error "Rebase did not start -- nothing to resolve, retry the command."
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
#
# SMI-5702: optional first arg, defaulting to $WORKTREE_PATH (preserves
# rebase-worktree.sh:363's zero-arg call and every existing test). Also:
# zero enumerated encrypted paths is now a FAILURE, not a silent pass — a
# real git-crypt repo (this one: supabase/functions/**,
# supabase/migrations/**) should always have at least one declared path;
# finding none guards against a `.gitattributes` regression silently
# defeating this whole scan. Uses has_git_crypt_magic_header() (scripts/
# _lib.sh) rather than duplicating the head+tr check inline.
scan_ciphertext() {
    local scan_path="${1:-$WORKTREE_PATH}"
    local encrypted_paths f
    encrypted_paths=$(get_encrypted_paths "$scan_path")
    if [ -z "$encrypted_paths" ]; then
        warn "  Ciphertext scan: no git-crypt-encrypted path declared in $scan_path/.gitattributes — expected at least one (supabase/functions/**, supabase/migrations/**). Treating as a failure, not a silent pass."
        return 1
    fi
    SCAN_RESULT_BAD=()
    SCAN_RESULT_MISSING=()
    # shellcheck disable=SC2086
    while IFS= read -r -d '' f; do
        if [ ! -f "$scan_path/$f" ]; then
            SCAN_RESULT_MISSING+=("$f")   # a missing tracked file is itself a failure, not a skip
            continue
        fi
        has_git_crypt_magic_header "$scan_path/$f" && SCAN_RESULT_BAD+=("$f")
    done < <(git -C "$scan_path" ls-files -z -- $encrypted_paths)
    if [ "${#SCAN_RESULT_BAD[@]}" -gt 0 ] || [ "${#SCAN_RESULT_MISSING[@]}" -gt 0 ]; then
        return 1
    fi
    # shellcheck disable=SC2086
    success "  Ciphertext scan clean ($(git -C "$scan_path" ls-files -- $encrypted_paths | wc -l | tr -d ' ') files)"
    return 0
}

# SMI-5781: portable ~1-hour-ago timestamp in `touch -t` form
# ([[CC]YY]MMDDhhmm[.ss]) -- this form behaves identically on BSD/macOS and
# GNU touch (unlike `touch -d`, which is GNU-only), so only the *timestamp
# computation* below needs to branch, not the touch invocation itself.
# Branches on `uname` rather than probing `date -r`/`date -d` support at
# runtime, matching this codebase's existing macOS/Linux divergence-handling
# convention (see scripts/_lib.sh, scripts/cleanup-orphans.sh,
# scripts/create-worktree.sh: `[[ "$(uname)" == "Darwin" ]]`).
#
# Computed entirely in UTC (TZ=UTC0), not local wall-clock time: `touch -t`
# interprets its [[CC]YY]MMDDhhmm[.ss] argument in whichever timezone is
# active when `touch` itself runs, so if this function emitted LOCAL
# wall-clock text, a fall DST transition could make "1 hour ago" and "now"
# share the identical wall-clock representation (clocks fall back by the
# same amount subtracted here), turning the backdate into a no-op exactly
# when the racy-mtime bug this function exists to fix is most likely to
# occur. UTC has no DST transitions, so the epoch->text conversion here and
# the text->mtime conversion at the `touch -t` call site (which also sets
# TZ=UTC0 -- see stabilize_encrypted_index_stats() below) always agree.
_past_touch_timestamp() {
    local epoch=$(( $(date +%s) - 3600 ))
    if [[ "$(uname)" == "Darwin" ]]; then
        TZ=UTC0 date -r "$epoch" +%Y%m%d%H%M.%S
    else
        TZ=UTC0 date -d "@$epoch" +%Y%m%d%H%M.%S
    fi
}

# SMI-5781: stabilize the git index's cached stat info for every currently
# tracked git-crypt-encrypted path. `git stash push` (step_stash(),
# rebase-worktree.sh) re-checks-out every previously-unstaged path back to
# HEAD's content, leaving each a RACY mtime (the file's mtime equals or is
# too close to the index file's own last-write time for git to trust the
# cached stat). If Step 7 then swaps filter.git-crypt.clean to the identity
# `cat` filter before that raciness is resolved, Step 9's `git rebase`
# pre-flight clean-tree check re-verifies the racy entry's content under the
# WRONG (identity) clean filter instead of git-crypt's real encrypting
# filter -- producing a spurious "You have unstaged changes" rejection on a
# file that is genuinely clean. See
# docs/internal/implementation/smi-5781-rebase-worktree-stash-racy-mtime.md
# for the full root-cause writeup.
#
# Enumeration deliberately does NOT reuse get_encrypted_paths() -- that
# function's grep/awk/sed .gitattributes parsing doesn't implement Git's
# real attribute-resolution semantics (misses nested .gitattributes,
# quoting/escaping, later overrides). `git check-attr -z filter --stdin` is
# Git's own canonical attribute resolution instead: correct by
# construction, with no custom parsing to get wrong. Output is NUL-delimited
# <path>\0<attr-name>\0<attr-value>\0 triples (verified against this repo's
# real .gitattributes -- see the plan doc's Surface Grounding table).
#
# Both enumeration pipelines (`ls-files -z | check-attr -z filter --stdin`
# and `ls-files -s -z -- <paths>`) are captured to a temp file and checked
# with `if ! ... > "$tmp"` rather than consumed directly via process
# substitution (`< <(...)`). Process substitution runs the pipeline in a
# detached background subshell whose exit status the parent shell never
# observes (not even under `set -e`/`pipefail`) -- a real git failure there
# would silently look identical to "no encrypted paths" and this function
# would no-op with no diagnostic. Routing through a temp file makes the
# failure observable: `if !` reflects the pipeline's real exit status (the
# rightmost failing command, via the caller's `set -o pipefail` --
# rebase-worktree.sh sets this unconditionally before sourcing this file,
# and the test harness's sourceAndRun() does too), and a NUL-safe `while
# read -d ''` loop over the temp file parses identically to the
# process-substitution form (this file stays bash-3.2-safe for macOS's
# default /bin/bash, which lacks `mapfile -d ''`).
#
# Excludes non-regular-file entries (symlinks, gitlinks/submodules): a
# portable `touch` follows a symlink by default, so touching a tracked
# symlink's path could mutate an mtime entirely outside the worktree, which
# is both surprising and unrelated to this bug. Only index mode
# 100644/100755 (regular files) are touched.
#
# Non-fatal, best-effort throughout: an enumeration-pipeline failure, a
# touch failure, or an index-refresh failure each log a warn() naming the
# exact downstream symptom this could cause, but none of them ever abort or
# introduce a new exit code -- the point of the sharper messages is
# diagnosability, not a new failure classification. The "Stabilized N ..."
# success line is only ever printed when every touch AND the index refresh
# all succeeded -- a partial failure prints the failure warn()s but never
# ALSO claims success.
stabilize_encrypted_index_stats() {
    local path attr_name attr_value
    local encrypted_paths=()

    local attr_tmp
    attr_tmp=$(mktemp) || {
        warn "could not create a temp file while enumerating encrypted paths; skipping encrypted-path index-stat stabilization -- if Step 9 reports 'You have unstaged changes' on an encrypted path, this is why -- it is a stat-cache race, not a real conflict, and reflects no unmerged paths"
        return 0
    }
    if ! git -C "$WORKTREE_PATH" ls-files -z | git -C "$WORKTREE_PATH" check-attr -z filter --stdin > "$attr_tmp"; then
        rm -f "$attr_tmp"
        warn "could not enumerate git-crypt-encrypted paths (ls-files/check-attr failed); skipping encrypted-path index-stat stabilization -- if Step 9 reports 'You have unstaged changes' on an encrypted path, this is why -- it is a stat-cache race, not a real conflict, and reflects no unmerged paths"
        return 0
    fi
    # attr_name is always the literal "filter" (we asked check-attr for only
    # that one attribute) -- read and discarded solely to stay in lockstep
    # with the NUL-delimited <path>\0<attr-name>\0<attr-value>\0 triples.
    # shellcheck disable=SC2034
    while IFS= read -r -d '' path && IFS= read -r -d '' attr_name && IFS= read -r -d '' attr_value; do
        [ "$attr_value" = "git-crypt" ] || continue
        encrypted_paths+=("$path")
    done < "$attr_tmp"
    rm -f "$attr_tmp"
    [ "${#encrypted_paths[@]}" -gt 0 ] || return 0

    # Regular-file filter: index mode 100644/100755 only -- excludes
    # symlinks (120000) and gitlinks/submodules (160000). Passed as a proper
    # bash array (not the unquoted-glob-prefix style used by
    # get_encrypted_paths() callers elsewhere in this file) because these
    # are exact resolved paths, not patterns.
    local regular_paths=()
    local entry mode path_part
    local ls_tmp
    ls_tmp=$(mktemp) || {
        warn "could not create a temp file while resolving encrypted-path index entries; skipping encrypted-path index-stat stabilization -- if Step 9 reports 'You have unstaged changes' on an encrypted path, this is why -- it is a stat-cache race, not a real conflict, and reflects no unmerged paths"
        return 0
    }
    if ! git -C "$WORKTREE_PATH" ls-files -s -z -- "${encrypted_paths[@]}" > "$ls_tmp"; then
        rm -f "$ls_tmp"
        warn "could not resolve encrypted-path index entries (ls-files -s failed); skipping encrypted-path index-stat stabilization -- if Step 9 reports 'You have unstaged changes' on an encrypted path, this is why -- it is a stat-cache race, not a real conflict, and reflects no unmerged paths"
        return 0
    fi
    while IFS= read -r -d '' entry; do
        mode="${entry%% *}"
        path_part="${entry#*$'\t'}"
        case "$mode" in
            100644|100755) regular_paths+=("$path_part") ;;
        esac
    done < "$ls_tmp"
    rm -f "$ls_tmp"
    [ "${#regular_paths[@]}" -gt 0 ] || return 0

    local ts; ts=$(_past_touch_timestamp)
    local f touch_failed=0
    for f in "${regular_paths[@]}"; do
        if ! TZ=UTC0 touch -t "$ts" -- "$WORKTREE_PATH/$f" 2>/dev/null; then
            touch_failed=1
            warn "could not stabilize index stats for $f; if Step 9 reports 'You have unstaged changes' on this file, this is why -- it is a stat-cache race, not a real conflict, and reflects no unmerged paths"
        fi
    done

    local refresh_failed=0
    if ! git -C "$WORKTREE_PATH" update-index -q --refresh >/dev/null 2>&1; then
        refresh_failed=1
        warn "git update-index --refresh failed while stabilizing encrypted-path index stats; if Step 9 reports 'You have unstaged changes' on an encrypted path, this is why -- it is a stat-cache race, not a real conflict, and reflects no unmerged paths"
    fi

    if [ "$touch_failed" -eq 0 ] && [ "$refresh_failed" -eq 0 ]; then
        success "    Stabilized ${#regular_paths[@]} encrypted-path index timestamp(s)"
    fi
    return 0
}

# SMI-5781 test-only determinism seam -- see
# scripts/tests/rebase-worktree.git-crypt-resmudge.test.ts's end-to-end
# regression test ("full runScript() on the same encrypted-WIP-stash
# scenario succeeds"). `git stash push`'s own internal re-checkout
# naturally leaves the just-restored file's cached index stat racy, but
# whether a fast synthetic test run actually lands in that ambiguous window
# is incidental filesystem timing (see that test file's header comment for
# the full mechanism) -- sometimes it reproduces the bug's precondition,
# sometimes it doesn't. This forces the same class of stat-cache mismatch
# deterministically: backdating the just-restored encrypted path(s) WITHOUT
# refreshing the index leaves the index's cached entry pointing at the
# original near-now mtime while the file itself now reads an hour old -- an
# unambiguous mismatch git can never treat as trustworthy-clean until
# something refreshes it, which is exactly what
# stabilize_encrypted_index_stats() (called immediately afterward in
# step_stash()) exists to do. Inert unless
# SKILLSMITH_REBASE_FORCE_RACY_TEST=1 -- never runs outside that harness.
force_racy_stash_restore_for_test() {
    [ "${SKILLSMITH_REBASE_FORCE_RACY_TEST:-}" = "1" ] || return 0
    local encrypted_paths; encrypted_paths=$(get_encrypted_paths)
    [ -n "$encrypted_paths" ] || return 0
    local ts; ts=$(_past_touch_timestamp)
    local f
    # shellcheck disable=SC2086
    while IFS= read -r -d '' f; do
        TZ=UTC0 touch -t "$ts" -- "$WORKTREE_PATH/$f" 2>/dev/null || true
    done < <(git -C "$WORKTREE_PATH" ls-files -z -- $encrypted_paths)
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

# Step 6: Stash unstaged changes (captures specific ref for safe pop)
step_stash() {
    info "Step 6: Stashing unstaged changes..."
    if git -C "$WORKTREE_PATH" diff --quiet; then info "  No unstaged changes to stash"; return 0; fi
    if [ "$DRY_RUN" = true ]; then info "  [dry-run] Would stash unstaged changes"; return 0; fi
    # `git diff --quiet` above can report "dirty" purely from a dirty
    # submodule (e.g. untracked content sitting inside docs/internal's own
    # working tree), which `git stash push` cannot capture -- it then prints
    # "No local changes to save" and creates no new stash entry. Capturing
    # refs/stash before/after (instead of blindly reading `stash list | head
    # -1`) detects that case: previously, a no-op push here would (a) grab
    # whatever UNRELATED stash another session/branch had left at stash@{0},
    # which Step 11 would then `stash pop` onto this worktree, and (b)
    # SIGPIPE-crash under `pipefail` once the shared stash list (refs/stash
    # is repo-wide, not per-worktree) grew past a couple of entries -- `head
    # -1` closes its read end while `git stash list` is still writing.
    local before_stash after_stash
    before_stash=$(git -C "$WORKTREE_PATH" rev-parse -q --verify refs/stash 2>/dev/null || echo "")
    git -C "$WORKTREE_PATH" stash push -m "rebase-worktree: auto-stash before rebase"
    after_stash=$(git -C "$WORKTREE_PATH" rev-parse -q --verify refs/stash 2>/dev/null || echo "")
    if [ "$before_stash" = "$after_stash" ]; then
        info "  Nothing actually stashed (dirty state was submodule-only, not a real diff)"
        STASH_REF=""
        return 0
    fi
    STASH_REF="stash@{0}"
    # SMI-5781: `git stash push` above re-checks-out every previously-unstaged
    # path back to HEAD's content, leaving a racy mtime on each -- if left
    # unresolved, Step 9's rebase pre-flight can spuriously reject an
    # encrypted path as dirty once Step 7 swaps in the identity clean filter.
    # Must run here: after the stash exists, before Step 7's filter swap.
    # force_racy_stash_restore_for_test is a test-only, inert-by-default
    # determinism seam (SKILLSMITH_REBASE_FORCE_RACY_TEST=1) -- see its
    # doc comment above.
    force_racy_stash_restore_for_test
    info "  Stabilizing encrypted-file index timestamps..."
    stabilize_encrypted_index_stats
    success "  Stashed as $STASH_REF"
}

# Step 6.5 (SMI-5702): heal git-crypt filter registration BEFORE Step 7
# (below, in rebase-worktree.sh) captures ORIG_SMUDGE/ORIG_CLEAN. Without
# this, capturing a HALF state round-trips HALF right back at Step 10's
# restore (_restore_filter_kind just replays whatever Step 7 captured,
# broken or not) instead of ever reaching canonical, and a genuinely-stuck
# (not live) DISABLED state perpetuates silently forever with no
# diagnostic -- ensure_git_crypt_filter_registered() prints the warn +
# one-line remediation that makes that visible instead. A live DISABLED
# window (another session's own conflict-resolution) is left untouched
# either way -- Half 1's design never heals over that. Defined here (not
# rebase-worktree.sh, which sources this file) purely to stay under that
# file's line limit -- same reason step_stash above lives here.
step_ensure_filter_registered() {
    info "Step 6.5: Verifying git-crypt filter registration..."
    if [ "$DRY_RUN" = true ]; then
        info "  [dry-run] Would verify/repair git-crypt filter registration"
        return 0
    fi
    ensure_git_crypt_filter_registered "$WORKTREE_PATH"
}
