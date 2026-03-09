#!/usr/bin/env bash
#
# rebase-worktree.sh — Safe worktree rebasing with git-crypt and submodule support
#
# Automates the 13-step rebase sequence: git-crypt filter management,
# submodule object fetching, stash/pop, and branch verification.
#
# Usage: ./scripts/rebase-worktree.sh <worktree-path> [target-branch]
# SMI-3102

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Flags
DRY_RUN=false
SKIP_SUBMODULE=false

# State (set during execution)
WORKTREE_PATH="" TARGET_BRANCH="" TARGET_REF=""
EXPECTED_BRANCH="" EXPECTED_SUBMODULE_SHA=""
MAIN_REPO_ROOT="" WT_SUB="" MAIN_SUB=""
STASH_REF="" ORIG_SMUDGE="" ORIG_CLEAN=""
HAS_GIT_CRYPT=false FILTERS_DISABLED=false

usage() {
    cat << EOF
Usage: $(basename "$0") [options] <worktree-path> [target-branch]

Rebase a git worktree onto a target branch, handling git-crypt filters,
submodule cross-fetching, and branch verification automatically.

Arguments:
  worktree-path   Path to the worktree to rebase
  target-branch   Branch to rebase onto (default: origin/main)

Options:
  --dry-run       Print steps without executing mutations (fetch still runs)
  --no-submodule  Skip submodule cross-fetch and rebase even if initialized
  -h, --help      Show this help message and exit

Exit Codes:
  0  Success or already up-to-date
  1  Validation failure (not a worktree, staged changes, etc.)
  2  Rebase conflict — manual resolution required
  3  Stash pop conflict — rebase succeeded but stash needs manual resolution

Examples:
  $(basename "$0") .worktrees/my-feature
  $(basename "$0") --dry-run .worktrees/my-feature
  $(basename "$0") --no-submodule .worktrees/my-feature origin/main
EOF
}

# Restore git-crypt filters to their original values
restore_filters() {
    if [ "$FILTERS_DISABLED" != true ]; then return 0; fi
    info "Restoring git-crypt filters..."
    if [ -n "$ORIG_SMUDGE" ]; then
        git -C "$WORKTREE_PATH" config --local filter.git-crypt.smudge "$ORIG_SMUDGE"
    else
        git -C "$WORKTREE_PATH" config --local --unset filter.git-crypt.smudge 2>/dev/null || true
    fi
    if [ -n "$ORIG_CLEAN" ]; then
        git -C "$WORKTREE_PATH" config --local filter.git-crypt.clean "$ORIG_CLEAN"
    else
        git -C "$WORKTREE_PATH" config --local --unset filter.git-crypt.clean 2>/dev/null || true
    fi
    FILTERS_DISABLED=false
    # Re-checkout encrypted paths to restore plaintext via smudge filter
    # All 5 encrypted prefixes per .gitattributes (CLAUDE.md § Git-Crypt)
    git -C "$WORKTREE_PATH" checkout HEAD -- \
        .claude/skills/ .claude/plans/ .claude/hive-mind/ \
        supabase/functions/ supabase/migrations/ 2>/dev/null || true
    success "  Git-crypt filters restored"
}

# Step 1: Validate worktree
step_validate() {
    info "Step 1: Validating worktree..."
    if [ ! -d "$WORKTREE_PATH" ]; then
        error "Worktree path does not exist: $WORKTREE_PATH"
    fi
    if ! git -C "$WORKTREE_PATH" rev-parse --git-dir >/dev/null 2>&1; then
        error "Path is not a git repository: $WORKTREE_PATH"
    fi
    local common_dir git_dir
    common_dir=$(git -C "$WORKTREE_PATH" rev-parse --git-common-dir)
    git_dir=$(git -C "$WORKTREE_PATH" rev-parse --git-dir)
    if [ "$common_dir" = "$git_dir" ]; then
        error "Path is not a worktree (it's the main repo or a regular clone): $WORKTREE_PATH"
    fi
    if ! git -C "$WORKTREE_PATH" diff --cached --quiet; then
        error "You have staged changes. Commit or reset before rebasing."
    fi
    success "  Worktree validated: $WORKTREE_PATH"
}

# Step 2: Record expected state (branch + submodule SHA)
step_record_state() {
    info "Step 2: Recording expected state..."
    EXPECTED_BRANCH=$(git -C "$WORKTREE_PATH" branch --show-current)
    if [ -z "$EXPECTED_BRANCH" ]; then
        error "Worktree is in detached HEAD state. Check out a branch first."
    fi
    EXPECTED_SUBMODULE_SHA=$(git -C "$WORKTREE_PATH/docs/internal" rev-parse HEAD 2>/dev/null || echo "")
    success "  Branch: $EXPECTED_BRANCH"
    if [ -n "$EXPECTED_SUBMODULE_SHA" ]; then
        info "  Submodule (docs/internal): ${EXPECTED_SUBMODULE_SHA:0:12}"
    else
        info "  Submodule: not initialized"
    fi
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

# Step 5: Cross-fetch submodule objects (worktree submodule lacks main repo's objects)
step_crossfetch_submodule() {
    if [ "$SKIP_SUBMODULE" = true ]; then
        info "Step 5: Skipping submodule cross-fetch (--no-submodule)"; return 0
    fi
    if [ -z "$EXPECTED_SUBMODULE_SHA" ]; then
        info "Step 5: Skipping submodule cross-fetch (not initialized)"; return 0
    fi
    info "Step 5: Cross-fetching submodule objects..."
    local common_dir
    common_dir=$(cd "$(git -C "$WORKTREE_PATH" rev-parse --git-common-dir)" && pwd)
    MAIN_REPO_ROOT=$(cd "$common_dir/.." && pwd)
    WT_SUB="$WORKTREE_PATH/docs/internal"
    MAIN_SUB="$MAIN_REPO_ROOT/docs/internal"
    if [ ! -d "$WT_SUB/.git" ] && [ ! -f "$WT_SUB/.git" ]; then
        info "  Submodule .git not found — skipping cross-fetch"; return 0
    fi
    if [ ! -d "$MAIN_SUB/.git" ] && [ ! -f "$MAIN_SUB/.git" ]; then
        warn "Main repo submodule not found at $MAIN_SUB — skipping cross-fetch"; return 0
    fi
    if [ "$DRY_RUN" = true ]; then
        info "  [dry-run] Would cross-fetch: git -C \"$WT_SUB\" fetch \"$MAIN_SUB\""; return 0
    fi
    git -C "$WT_SUB" fetch "$MAIN_SUB" 2>/dev/null || true
    success "  Submodule objects cross-fetched"
}

# Step 6: Stash unstaged changes (captures specific ref for safe pop)
step_stash() {
    info "Step 6: Stashing unstaged changes..."
    if git -C "$WORKTREE_PATH" diff --quiet; then
        info "  No unstaged changes to stash"; return 0
    fi
    if [ "$DRY_RUN" = true ]; then
        info "  [dry-run] Would stash unstaged changes"; return 0
    fi
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
    if [ "$DRY_RUN" = true ]; then
        info "  [dry-run] Would disable git-crypt smudge/clean filters"; return 0
    fi
    git -C "$WORKTREE_PATH" config --local filter.git-crypt.smudge "cat"
    git -C "$WORKTREE_PATH" config --local filter.git-crypt.clean "cat"
    FILTERS_DISABLED=true
    trap restore_filters EXIT
    success "  Git-crypt filters disabled (trap registered)"
}

# Step 8: Rebase submodule (directional guard via merge-base --is-ancestor)
step_rebase_submodule() {
    if [ "$SKIP_SUBMODULE" = true ]; then
        info "Step 8: Skipping submodule rebase (--no-submodule)"; return 0
    fi
    if [ -z "$EXPECTED_SUBMODULE_SHA" ]; then
        info "Step 8: Skipping submodule rebase (not initialized)"; return 0
    fi
    info "Step 8: Checking submodule alignment..."
    local target_sub_sha
    target_sub_sha=$(git -C "$WORKTREE_PATH" ls-tree "$TARGET_REF" -- docs/internal 2>/dev/null | awk '{print $3}')
    if [ -z "$target_sub_sha" ]; then
        info "  Target has no docs/internal entry — skipping"; return 0
    fi
    if [ "$target_sub_sha" = "$EXPECTED_SUBMODULE_SHA" ]; then
        info "  Submodule already at target pointer"; return 0
    fi
    # Directional guard: worktree's submodule must not be ahead of target
    if ! git -C "$WT_SUB" merge-base --is-ancestor "$EXPECTED_SUBMODULE_SHA" "$target_sub_sha" 2>/dev/null; then
        if git -C "$WT_SUB" merge-base --is-ancestor "$target_sub_sha" "$EXPECTED_SUBMODULE_SHA" 2>/dev/null; then
            error "Worktree submodule (docs/internal) is AHEAD of target's pointer.
  Worktree: $EXPECTED_SUBMODULE_SHA
  Target:   $target_sub_sha
Push and merge your submodule changes first, then retry."
        else
            error "Worktree submodule (docs/internal) has diverged from target.
  Worktree: $EXPECTED_SUBMODULE_SHA
  Target:   $target_sub_sha
The submodule has local commits not in the target. Push and merge first, then retry."
        fi
    fi
    if [ "$DRY_RUN" = true ]; then
        info "  [dry-run] Would update submodule to $target_sub_sha"; return 0
    fi
    git -C "$WT_SUB" checkout "$target_sub_sha" 2>/dev/null
    git -C "$WORKTREE_PATH" add docs/internal
    success "  Submodule updated to ${target_sub_sha:0:12}"
}

# Step 9: Rebase parent (trap cleared before rebase, re-registered on success)
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
        if [ "$conflicted" = "docs/internal" ]; then
            info "  Auto-resolving submodule-only conflict..."
            git -C "$WORKTREE_PATH" add docs/internal
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
                echo "  git -C $WORKTREE_PATH checkout HEAD -- .claude/skills/ .claude/plans/ .claude/hive-mind/ supabase/functions/ supabase/migrations/"
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
        if [ "$HAS_GIT_CRYPT" = true ]; then
            info "Step 10: [dry-run] Would restore git-crypt filters"
        else
            info "Step 10: Skipping filter restore (no git-crypt)"
        fi
        return 0
    fi
    if [ "$FILTERS_DISABLED" = true ]; then
        info "Step 10: Restoring git-crypt filters..."
        trap - EXIT
        restore_filters
    else
        info "Step 10: Skipping filter restore (not disabled)"
    fi
}

# Step 11: Pop stash (by specific ref, not implicit)
step_pop_stash() {
    if [ -z "$STASH_REF" ]; then
        info "Step 11: No stash to pop"; return 0
    fi
    info "Step 11: Popping stash ($STASH_REF)..."
    if [ "$DRY_RUN" = true ]; then
        info "  [dry-run] Would pop stash $STASH_REF"; return 0
    fi
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

# Step 13: Report success
step_report() {
    if [ "$DRY_RUN" = true ]; then
        echo ""; success "Dry run complete — no mutations performed (except fetch)"; return 0
    fi
    local new_head
    new_head=$(git -C "$WORKTREE_PATH" log --oneline -1)
    echo ""
    success "Rebase complete!"
    echo "  Branch: $EXPECTED_BRANCH"
    echo "  HEAD:   $new_head"
    echo "  Target: $TARGET_REF"
    if [ -n "$EXPECTED_SUBMODULE_SHA" ] && [ "$SKIP_SUBMODULE" = false ] && [ -n "$WT_SUB" ]; then
        local sub_head
        sub_head=$(git -C "$WT_SUB" rev-parse --short HEAD 2>/dev/null || echo "unknown")
        echo "  Submodule: docs/internal -> $sub_head"
    fi
}

main() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help) usage; exit 0 ;;
            --dry-run) DRY_RUN=true; shift ;;
            --no-submodule) SKIP_SUBMODULE=true; shift ;;
            -*) error "Unknown option: $1

Run '$(basename "$0") --help' for usage information." ;;
            *) break ;;
        esac
    done

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
