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

Examples:
  $(basename "$0") .worktrees/my-feature
  $(basename "$0") --dry-run .worktrees/my-feature
  $(basename "$0") --no-submodule .worktrees/my-feature origin/main
  $(basename "$0") --allow-submodule-ahead=docs/internal .worktrees/my-feature
EOF
}

# SMI-4829: returns 0 (true) if --allow-submodule-ahead applies to $1 (global form, or a matching scoped form).
is_allow_ahead_for() {
    [ "$ALLOW_SUBMODULE_AHEAD_GLOBAL" = true ] && return 0
    local p; for p in "${ALLOW_SUBMODULE_AHEAD_PATHS[@]:-}"; do [ "$p" = "$1" ] && return 0; done
    return 1
}

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
restore_filters() {
    [ "$FILTERS_DISABLED" = true ] || return 0
    info "Restoring git-crypt filters..."
    _restore_filter_kind smudge "$ORIG_SMUDGE"
    _restore_filter_kind clean  "$ORIG_CLEAN"
    FILTERS_DISABLED=false
    # Re-checkout encrypted paths to restore plaintext via smudge filter
    local encrypted_paths; encrypted_paths=$(get_encrypted_paths)
    if [ -n "$encrypted_paths" ]; then
        # shellcheck disable=SC2086
        git -C "$WORKTREE_PATH" checkout HEAD -- $encrypted_paths 2>/dev/null || true
    fi
    success "  Git-crypt filters restored"
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
    FILTERS_DISABLED=true; trap restore_filters EXIT
    success "  Git-crypt filters disabled (trap registered)"
}

# Step 8: Rebase submodule (directional guard via merge-base --is-ancestor).
# SMI-4829: iterates over every submodule; --allow-submodule-ahead is
# evaluated per-path so an allowance for one does not permit drift for another.
step_rebase_submodule() {
    if [ "$SKIP_SUBMODULE" = true ]; then
        info "Step 8: Skipping submodule rebase (--no-submodule)"; return 0
    fi
    if [ "${#SUBMODULES[@]}" -eq 0 ]; then
        info "Step 8: Skipping submodule rebase (no submodules declared)"; return 0
    fi
    info "Step 8: Checking submodule alignment..."
    local i sub_path expected_sha wt_sub target_sub_sha
    for i in "${!SUBMODULES[@]}"; do
        sub_path="${SUBMODULES[$i]}"
        expected_sha="${EXPECTED_SUBMODULE_SHAS[$i]:-}"
        wt_sub="${WT_SUB_PATHS[$i]:-$WORKTREE_PATH/$sub_path}"
        if [ -z "$expected_sha" ]; then info "  ($sub_path) not initialized — skipping"; continue; fi
        target_sub_sha=$(git -C "$WORKTREE_PATH" ls-tree "$TARGET_REF" -- "$sub_path" 2>/dev/null | awk '{print $3}')
        if [ -z "$target_sub_sha" ]; then info "  ($sub_path) target has no entry — skipping"; continue; fi
        if [ "$target_sub_sha" = "$expected_sha" ]; then info "  ($sub_path) already at target pointer"; continue; fi
        # Directional guard: worktree's submodule must not be ahead of target
        if ! git -C "$wt_sub" merge-base --is-ancestor "$expected_sha" "$target_sub_sha" 2>/dev/null; then
            if git -C "$wt_sub" merge-base --is-ancestor "$target_sub_sha" "$expected_sha" 2>/dev/null; then
                # SMI-4773/SMI-4829: when allowed for this submodule keep the descendant SHA; divergence errors below.
                if is_allow_ahead_for "$sub_path"; then
                    info "  ($sub_path) worktree submodule is ahead of target (strict descendant) — keeping worktree SHA"
                    info "    Worktree: ${expected_sha:0:12} / Target: ${target_sub_sha:0:12}"
                    continue
                fi
                error "Worktree submodule ($sub_path) is AHEAD of target's pointer.
  Worktree: $expected_sha
  Target:   $target_sub_sha
Push and merge your submodule changes first, then retry.
(Pass --allow-submodule-ahead or --allow-submodule-ahead=$sub_path to keep the worktree's strict-descendant pointer.)"
            else
                error "Worktree submodule ($sub_path) has diverged from target.
  Worktree: $expected_sha
  Target:   $target_sub_sha
The submodule has local commits not in the target. Push and merge first, then retry."
            fi
        fi
        if [ "$DRY_RUN" = true ]; then info "  ($sub_path) [dry-run] Would update submodule to ${target_sub_sha:0:12}"; continue; fi
        git -C "$wt_sub" checkout "$target_sub_sha" 2>/dev/null
        git -C "$WORKTREE_PATH" add "$sub_path"
        success "  ($sub_path) updated to ${target_sub_sha:0:12}"
    done
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
                trap restore_filters EXIT
                error "Rebase --continue failed after submodule auto-resolve."
            }
            trap restore_filters EXIT
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
                echo "  git -C $WORKTREE_PATH checkout HEAD -- $enc_paths"
            fi
            echo ""
            echo "To abort: git -C $WORKTREE_PATH rebase --abort"
            exit 2
        fi
    else
        trap restore_filters EXIT
        success "  Rebase completed"
    fi
}

# Step 10: Restore git-crypt filters (explicit call; trap is backup)
step_restore_filters() {
    if [ "$DRY_RUN" = true ]; then
        [ "$HAS_GIT_CRYPT" = true ] && info "Step 10: [dry-run] Would restore git-crypt filters" \
                                  || info "Step 10: Skipping filter restore (no git-crypt)"
        return 0
    fi
    if [ "$FILTERS_DISABLED" = true ]; then
        info "Step 10: Restoring git-crypt filters..."
        trap - EXIT; restore_filters
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
            --allow-submodule-ahead) ALLOW_SUBMODULE_AHEAD_GLOBAL=true ;;
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
    step_report
}

main "$@"
