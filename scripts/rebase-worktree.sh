#!/usr/bin/env bash
# rebase-worktree.sh — Safe worktree rebasing with git-crypt and submodule support.
# Automates a 13-step sequence: git-crypt filter management, submodule object fetch,
# stash/pop, branch verification.
#
# SMI-4829: parameterized over SUBMODULES=() (from .gitmodules) — handles N
# submodules; pre-cutover behavior unchanged; post-cutover each gets its own
# SHA capture, cross-fetch, directional guard, conflict auto-resolve.
#
# Usage: ./scripts/rebase-worktree.sh <worktree-path> [target-branch]
# SMI-3102, SMI-4829

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"
# SMI-5773: git-crypt filter management (get_encrypted_paths, restore_filter_config,
# force_resmudge, scan_ciphertext, check_resmudge_scan_result) split out per
# CLAUDE.md's 500-line file-length convention.
# shellcheck source=_rebase-git-crypt.sh
source "$SCRIPT_DIR/_rebase-git-crypt.sh"
# SMI-5773: submodule directional-guard alignment (is_allow_ahead_for,
# step_rebase_submodule) split out per CLAUDE.md's 500-line file-length
# convention.
# shellcheck source=_rebase-submodule.sh
source "$SCRIPT_DIR/_rebase-submodule.sh"

# Flags
DRY_RUN=false
SKIP_SUBMODULE=false
ALLOW_SUBMODULE_AHEAD_GLOBAL=false
# SMI-4829: per-submodule allow-ahead — entries are submodule paths.
ALLOW_SUBMODULE_AHEAD_PATHS=()

# State (set during execution)
WORKTREE_PATH="" TARGET_BRANCH="" TARGET_REF=""
EXPECTED_BRANCH=""
MAIN_REPO_ROOT=""
STASH_REF="" ORIG_SMUDGE="" ORIG_CLEAN=""
HAS_GIT_CRYPT=false FILTERS_DISABLED=false
# SMI-5773: post-resmudge ciphertext-scan result, consumed in main() after
# Step 11 (stash pop) so a detected residue never strands the user's stash.
# shellcheck disable=SC2034 # read by check_resmudge_scan_result() in the sourced _rebase-git-crypt.sh (shellcheck's unused-var check doesn't follow cross-file usage even via source=)
RESMUDGE_SCAN_FAILED=false
# shellcheck disable=SC2034 # read by check_resmudge_scan_result() in _rebase-git-crypt.sh; written by scan_ciphertext() there too
SCAN_RESULT_BAD=()
# shellcheck disable=SC2034 # read by check_resmudge_scan_result() in _rebase-git-crypt.sh; written by scan_ciphertext() there too
SCAN_RESULT_MISSING=()

# SMI-4829: parallel arrays indexed by position (macOS bash 3.2 lacks assoc arrays).
SUBMODULES=()
EXPECTED_SUBMODULE_SHAS=()
WT_SUB_PATHS=()

usage() {
    cat << EOF
Usage: $(basename "$0") [options] <worktree-path> [target-branch]

Rebase a git worktree onto a target branch, handling git-crypt filters,
submodule cross-fetching, and branch verification automatically.

Arguments:
  worktree-path   Path to the worktree to rebase
  target-branch   Branch to rebase onto (default: origin/main)

Options:
  --dry-run                       Print steps without mutations (fetch still runs)
  --no-submodule                  Skip submodule cross-fetch + rebase
  --allow-submodule-ahead         Permit ANY submodule worktree pointer to be a
                                  strict descendant of target (SMI-4773); divergence
                                  still errors.
  --allow-submodule-ahead=<path>  Scoped form (SMI-4829) — only the named submodule
                                  may be ahead. Repeat for multiple paths.
  -h, --help                      Show this help and exit

Exit Codes:
  0  Success or already up-to-date
  1  Validation failure (not a worktree, staged changes, etc.)
  2  Rebase conflict — manual resolution required
  3  Stash pop conflict — rebase succeeded but stash needs manual resolution
  4  Rebase (and stash pop) succeeded, but a post-rebase ciphertext scan found
     encrypted-path files still needing re-smudge — see printed remediation

Examples:
  $(basename "$0") .worktrees/my-feature
  $(basename "$0") --dry-run .worktrees/my-feature
  $(basename "$0") --no-submodule .worktrees/my-feature origin/main
  $(basename "$0") --allow-submodule-ahead=docs/internal .worktrees/my-feature
EOF
}

# Step 1: Validate worktree
step_validate() {
    info "Step 1: Validating worktree..."
    [ -d "$WORKTREE_PATH" ] || error "Worktree path does not exist: $WORKTREE_PATH"
    git -C "$WORKTREE_PATH" rev-parse --git-dir >/dev/null 2>&1 \
        || error "Path is not a git repository: $WORKTREE_PATH"
    local common_dir git_dir
    common_dir=$(git -C "$WORKTREE_PATH" rev-parse --git-common-dir)
    git_dir=$(git -C "$WORKTREE_PATH" rev-parse --git-dir)
    if [ "$common_dir" = "$git_dir" ]; then
        error "Path is not a worktree (it's the main repo or a regular clone): $WORKTREE_PATH"
    fi
    git -C "$WORKTREE_PATH" diff --cached --quiet \
        || error "You have staged changes. Commit or reset before rebasing."
    success "  Worktree validated: $WORKTREE_PATH"
}

# Step 2: Record expected state (branch + per-submodule SHAs). SMI-4829:
# discovers submodules from the worktree's .gitmodules.
step_record_state() {
    info "Step 2: Recording expected state..."
    EXPECTED_BRANCH=$(git -C "$WORKTREE_PATH" branch --show-current)
    if [ -z "$EXPECTED_BRANCH" ]; then
        error "Worktree is in detached HEAD state. Check out a branch first."
    fi
    # Populate SUBMODULES from .gitmodules (empty array if no submodules).
    SUBMODULES=()
    while IFS= read -r sub_path; do
        [ -n "$sub_path" ] && SUBMODULES+=("$sub_path")
    done < <(enumerate_submodules "$WORKTREE_PATH")
    success "  Branch: $EXPECTED_BRANCH"
    if [ "${#SUBMODULES[@]}" -eq 0 ]; then info "  Submodules: none declared in .gitmodules"; return 0; fi
    # Capture each submodule's current pointer SHA.
    EXPECTED_SUBMODULE_SHAS=()
    local i sub_path sha
    for i in "${!SUBMODULES[@]}"; do
        sub_path="${SUBMODULES[$i]}"
        sha=$(git -C "$WORKTREE_PATH/$sub_path" rev-parse HEAD 2>/dev/null || echo "")
        EXPECTED_SUBMODULE_SHAS[$i]="$sha"
        [ -n "$sha" ] && info "  Submodule ($sub_path): ${sha:0:12}" \
                     || info "  Submodule ($sub_path): not initialized"
    done
}

# Step 3: Fetch target (normalizes "main" -> "origin/main")
step_fetch() {
    info "Step 3: Fetching target..."
    local fetch_ref
    if [[ "$TARGET_BRANCH" == origin/* ]]; then
        fetch_ref="${TARGET_BRANCH#origin/}"
        TARGET_REF="$TARGET_BRANCH"
    else
        fetch_ref="$TARGET_BRANCH"
        TARGET_REF="origin/$TARGET_BRANCH"
    fi
    if ! git -C "$WORKTREE_PATH" fetch origin "$fetch_ref" 2>/dev/null; then
        error "Could not fetch target branch '$fetch_ref'. Does it exist on origin?"
    fi
    success "  Fetched origin/$fetch_ref"
}

# Step 4: Check if already up-to-date
step_check_uptodate() {
    info "Step 4: Checking if already up-to-date..."
    local merge_base target_sha
    merge_base=$(git -C "$WORKTREE_PATH" merge-base HEAD "$TARGET_REF")
    target_sha=$(git -C "$WORKTREE_PATH" rev-parse "$TARGET_REF")
    if [ "$merge_base" = "$target_sha" ]; then
        success "Already up-to-date with $TARGET_REF"
        exit 0
    fi
    info "  Worktree is behind $TARGET_REF — rebase needed"
}

# Step 5: Cross-fetch submodule objects (worktree submodule lacks main repo's
# objects). SMI-4829: iterates over every initialized submodule.
step_crossfetch_submodule() {
    if [ "$SKIP_SUBMODULE" = true ]; then
        info "Step 5: Skipping submodule cross-fetch (--no-submodule)"; return 0
    fi
    if [ "${#SUBMODULES[@]}" -eq 0 ]; then
        info "Step 5: Skipping submodule cross-fetch (no submodules declared)"; return 0
    fi
    info "Step 5: Cross-fetching submodule objects..."
    local common_dir
    common_dir=$(cd "$(git -C "$WORKTREE_PATH" rev-parse --git-common-dir)" && pwd)
    MAIN_REPO_ROOT=$(cd "$common_dir/.." && pwd)

    WT_SUB_PATHS=()
    local i sub_path sha wt_sub main_sub fetched_any=false
    for i in "${!SUBMODULES[@]}"; do
        sub_path="${SUBMODULES[$i]}"
        sha="${EXPECTED_SUBMODULE_SHAS[$i]:-}"
        wt_sub="$WORKTREE_PATH/$sub_path"
        main_sub="$MAIN_REPO_ROOT/$sub_path"
        WT_SUB_PATHS[$i]="$wt_sub"
        if [ -z "$sha" ]; then info "  ($sub_path) not initialized — skipping"; continue; fi
        if [ ! -d "$wt_sub/.git" ] && [ ! -f "$wt_sub/.git" ]; then
            info "  ($sub_path) submodule .git not found — skipping cross-fetch"; continue
        fi
        if [ ! -d "$main_sub/.git" ] && [ ! -f "$main_sub/.git" ]; then
            warn "Main repo submodule not found at $main_sub — skipping cross-fetch"; continue
        fi
        if [ "$DRY_RUN" = true ]; then
            info "  [dry-run] Would cross-fetch: git -C \"$wt_sub\" fetch \"$main_sub\""
            fetched_any=true; continue
        fi
        git -C "$wt_sub" fetch "$main_sub" 2>/dev/null || true
        fetched_any=true
    done
    [ "$fetched_any" = true ] && success "  Submodule objects cross-fetched"
}

# Step 6: Stash unstaged changes (captures specific ref for safe pop)
step_stash() {
    info "Step 6: Stashing unstaged changes..."
    if git -C "$WORKTREE_PATH" diff --quiet; then info "  No unstaged changes to stash"; return 0; fi
    if [ "$DRY_RUN" = true ]; then info "  [dry-run] Would stash unstaged changes"; return 0; fi
    git -C "$WORKTREE_PATH" stash push -m "rebase-worktree: auto-stash before rebase"
    STASH_REF=$(git -C "$WORKTREE_PATH" stash list | head -1 | cut -d: -f1)
    success "  Stashed as $STASH_REF"
}

# Step 7: Disable git-crypt filters (with EXIT trap for restore)
step_disable_filters() {
    ORIG_SMUDGE=$(git -C "$WORKTREE_PATH" config --local --get filter.git-crypt.smudge 2>/dev/null || echo "")
    ORIG_CLEAN=$(git -C "$WORKTREE_PATH" config --local --get filter.git-crypt.clean 2>/dev/null || echo "")
    if [ -z "$ORIG_SMUDGE" ] && [ -z "$ORIG_CLEAN" ]; then
        info "Step 7: Skipping filter disable (no git-crypt filters configured)"
        HAS_GIT_CRYPT=false; return 0
    fi
    HAS_GIT_CRYPT=true
    info "Step 7: Disabling git-crypt filters..."
    if [ "$DRY_RUN" = true ]; then info "  [dry-run] Would disable git-crypt smudge/clean filters"; return 0; fi
    git -C "$WORKTREE_PATH" config --local filter.git-crypt.smudge "cat"
    git -C "$WORKTREE_PATH" config --local filter.git-crypt.clean "cat"
    FILTERS_DISABLED=true; trap restore_filter_config EXIT
    success "  Git-crypt filters disabled (trap registered)"
}

# Step 9: Rebase parent (trap cleared before rebase, re-registered on success).
# SMI-4829: submodule-only conflict auto-resolve recognizes any declared submodule.
step_rebase_parent() {
    info "Step 9: Rebasing onto $TARGET_REF..."
    if [ "$DRY_RUN" = true ]; then
        info "  [dry-run] Would run: GIT_SEQUENCE_EDITOR=true GIT_EDITOR=true git rebase $TARGET_REF"
        return 0
    fi
    # Clear trap — if non-submodule conflict, user needs filters disabled for resolution
    trap - EXIT
    local rebase_failed=false
    GIT_SEQUENCE_EDITOR=true GIT_EDITOR=true git -C "$WORKTREE_PATH" rebase "$TARGET_REF" || rebase_failed=true
    if [ "$rebase_failed" = true ]; then
        local conflicted
        conflicted=$(git -C "$WORKTREE_PATH" diff --name-only --diff-filter=U 2>/dev/null || echo "")
        # SMI-4829: submodule-only iff every non-blank conflicted entry is a declared submodule path.
        local all_submodule=false conflict_line non_sub_count=0 conflict_count=0
        while IFS= read -r conflict_line; do
            [ -z "$conflict_line" ] && continue
            conflict_count=$((conflict_count + 1))
            local matched=false sub
            for sub in "${SUBMODULES[@]:-}"; do
                [ "$conflict_line" = "$sub" ] && { matched=true; break; }
            done
            [ "$matched" = false ] && non_sub_count=$((non_sub_count + 1))
        done <<< "$conflicted"
        [ "$conflict_count" -gt 0 ] && [ "$non_sub_count" -eq 0 ] && all_submodule=true

        if [ "$all_submodule" = true ]; then
            info "  Auto-resolving submodule-only conflict..."
            while IFS= read -r conflict_line; do
                [ -z "$conflict_line" ] && continue
                git -C "$WORKTREE_PATH" add "$conflict_line"
            done <<< "$conflicted"
            GIT_SEQUENCE_EDITOR=true GIT_EDITOR=true git -C "$WORKTREE_PATH" rebase --continue || {
                trap restore_filter_config EXIT
                error "Rebase --continue failed after submodule auto-resolve."
            }
            trap restore_filter_config EXIT
            success "  Rebase completed (submodule conflict auto-resolved)"
        else
            echo ""
            warn "REBASE CONFLICT — manual resolution required:"
            echo "  cd $WORKTREE_PATH"
            if [ -n "$conflicted" ]; then
                echo "  # resolve conflicts in:"
                echo "$conflicted" | while IFS= read -r f; do echo "    $f"; done
            fi
            echo "  git add <resolved-files>"
            echo "  GIT_SEQUENCE_EDITOR=true GIT_EDITOR=true git rebase --continue"
            if [ "$HAS_GIT_CRYPT" = true ]; then
                echo ""
                echo "After resolving, restore git-crypt filters:"
                echo "  git -C $WORKTREE_PATH config --local --unset filter.git-crypt.smudge"
                echo "  git -C $WORKTREE_PATH config --local --unset filter.git-crypt.clean"
                local enc_paths
                enc_paths=$(get_encrypted_paths | tr '\n' ' ')
                # SMI-5773: NUL-safe ls-files -z + while-loop, same form as
                # force_resmudge() — a bare `checkout HEAD -- <paths>` is a
                # no-op on files git already considers stat-clean (the exact
                # files that carry ciphertext after this filter window), and
                # `ls-files | xargs rm` is unsafe on macOS (xargs lacks -r).
                echo "  git -C $WORKTREE_PATH ls-files -z -- $enc_paths | while IFS= read -r -d '' f; do rm -f -- \"$WORKTREE_PATH/\$f\"; done"
                echo "  git -C $WORKTREE_PATH checkout HEAD -- $enc_paths"
            fi
            echo ""
            echo "To abort: git -C $WORKTREE_PATH rebase --abort"
            exit 2
        fi
    else
        trap restore_filter_config EXIT
        success "  Rebase completed"
    fi
}

# Step 10: Restore git-crypt filters (explicit call; trap is backup), then
# force a re-smudge of any files the rebase rewrote under smudge=cat and
# scan for surviving ciphertext (SMI-5773). RESMUDGE_SCAN_FAILED is consumed
# by main() AFTER Step 11 (stash pop) so a detected residue never strands
# the user's stash.
step_restore_filters() {
    if [ "$DRY_RUN" = true ]; then
        [ "$HAS_GIT_CRYPT" = true ] && info "Step 10: [dry-run] Would restore git-crypt filters" \
                                  || info "Step 10: Skipping filter restore (no git-crypt)"
        return 0
    fi
    if [ "$FILTERS_DISABLED" = true ]; then
        info "Step 10: Restoring git-crypt filters..."
        # SMI-5773: capture $FILTERS_DISABLED's pre-call value BEFORE calling
        # restore_filter_config() — that function sets FILTERS_DISABLED=false
        # as its own side effect, so checking the flag AFTER the call would
        # always read the post-call value and this guard would never gate
        # correctly (it would always see "false" and skip force_resmudge).
        local was_disabled="$FILTERS_DISABLED"
        trap - EXIT; restore_filter_config
        if [ "$was_disabled" = true ] && [ "$HAS_GIT_CRYPT" = true ]; then
            force_resmudge
            if scan_ciphertext; then
                RESMUDGE_SCAN_FAILED=false
            else
                # shellcheck disable=SC2034 # read by check_resmudge_scan_result() in the sourced _rebase-git-crypt.sh
                RESMUDGE_SCAN_FAILED=true
            fi
        fi
    else
        info "Step 10: Skipping filter restore (not disabled)"
    fi
}

# Step 11: Pop stash (by specific ref, not implicit)
step_pop_stash() {
    if [ -z "$STASH_REF" ]; then info "Step 11: No stash to pop"; return 0; fi
    info "Step 11: Popping stash ($STASH_REF)..."
    if [ "$DRY_RUN" = true ]; then info "  [dry-run] Would pop stash $STASH_REF"; return 0; fi
    if ! git -C "$WORKTREE_PATH" stash pop "$STASH_REF" 2>/dev/null; then
        echo ""
        warn "Stash pop had conflicts. Rebase succeeded but stashed changes need manual resolution."
        echo "  cd $WORKTREE_PATH"
        echo "  git stash show"
        echo "  git checkout --theirs -- .mcp.json docker-compose.override.yml"
        echo "  git stash drop"
        exit 3
    fi
    success "  Stash popped"
}

# Step 12: Verify branch (detect smudge-filter branch switch)
step_verify_branch() {
    info "Step 12: Verifying branch..."
    local actual_branch
    actual_branch=$(git -C "$WORKTREE_PATH" branch --show-current)
    if [ "$actual_branch" != "$EXPECTED_BRANCH" ]; then
        echo ""
        warn "BRANCH SWITCHED during rebase! Expected '$EXPECTED_BRANCH', got '$actual_branch'"
        echo "Recovery: git -C $WORKTREE_PATH checkout $EXPECTED_BRANCH"
        exit 1
    fi
    success "  Branch verified: $actual_branch"
}

# Step 13: Report success. SMI-4829: per-submodule summary.
step_report() {
    if [ "$DRY_RUN" = true ]; then
        echo ""; success "Dry run complete — no mutations performed (except fetch)"; return 0
    fi
    local new_head; new_head=$(git -C "$WORKTREE_PATH" log --oneline -1)
    echo ""
    success "Rebase complete!"
    echo "  Branch: $EXPECTED_BRANCH"
    echo "  HEAD:   $new_head"
    echo "  Target: $TARGET_REF"
    if [ "$SKIP_SUBMODULE" = false ] && [ "${#SUBMODULES[@]}" -gt 0 ]; then
        local i sub_path expected_sha wt_sub sub_head
        for i in "${!SUBMODULES[@]}"; do
            sub_path="${SUBMODULES[$i]}"; expected_sha="${EXPECTED_SUBMODULE_SHAS[$i]:-}"
            [ -z "$expected_sha" ] && continue
            wt_sub="${WT_SUB_PATHS[$i]:-$WORKTREE_PATH/$sub_path}"
            sub_head=$(git -C "$wt_sub" rev-parse --short HEAD 2>/dev/null || echo "unknown")
            echo "  Submodule: $sub_path -> $sub_head"
        done
    fi
}

main() {
    # SMI-4766: collect positionals while still scanning for flags. Previous parser
    # used `case … *) break ;;` which silently dropped flags after a positional.
    ARGS=()
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help) usage; exit 0 ;;
            --dry-run) DRY_RUN=true ;;
            --no-submodule) SKIP_SUBMODULE=true ;;
            --allow-submodule-ahead)
                # shellcheck disable=SC2034 # read by is_allow_ahead_for() in the sourced _rebase-submodule.sh
                ALLOW_SUBMODULE_AHEAD_GLOBAL=true
                ;;
            --allow-submodule-ahead=*)
                # SMI-4829: scoped form applies only to the named submodule.
                ALLOW_SUBMODULE_AHEAD_PATHS+=("${1#--allow-submodule-ahead=}")
                ;;
            -*) error "Unknown option: $1

Run '$(basename "$0") --help' for usage information." ;;
            *) ARGS+=("$1") ;;
        esac
        shift
    done
    set -- "${ARGS[@]}"

    WORKTREE_PATH="${1:-}"
    TARGET_BRANCH="${2:-origin/main}"

    if [ -z "$WORKTREE_PATH" ]; then
        error "Missing required argument: worktree-path

Run '$(basename "$0") --help' for usage information."
    fi

    # Convert to absolute path if relative
    if [[ ! "$WORKTREE_PATH" = /* ]]; then
        WORKTREE_PATH="$(cd "$WORKTREE_PATH" 2>/dev/null && pwd)" || \
            error "Worktree path does not exist: ${1:-}"
    fi

    echo ""
    info "Rebasing worktree: $WORKTREE_PATH"
    info "Target: $TARGET_BRANCH"
    if [ "$DRY_RUN" = true ]; then warn "DRY RUN — mutations will be echoed, not executed"; fi
    echo ""

    step_validate
    step_record_state
    step_fetch
    step_check_uptodate
    step_crossfetch_submodule
    step_stash
    step_disable_filters
    step_rebase_submodule
    step_rebase_parent
    step_restore_filters
    step_pop_stash
    step_verify_branch
    check_resmudge_scan_result
    step_report
}

# SMI-5773: allow this script to be `source`d (scripts/tests/rebase-worktree.helpers.ts
# calls restore_filter_config/force_resmudge/scan_ciphertext directly for unit-style
# coverage) without auto-running main(). Behavior when executed directly
# (`./scripts/rebase-worktree.sh ...` or `bash scripts/rebase-worktree.sh ...`) is
# unchanged — BASH_SOURCE[0] equals $0 in that case.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
