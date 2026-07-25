#!/usr/bin/env bash
# _rebase-submodule.sh — submodule directional-guard alignment for
# rebase-worktree.sh's Step 8 (SMI-4829).
#
# Split out of rebase-worktree.sh per CLAUDE.md's 500-line file-length
# convention (SMI-5773). Sourced only, never run standalone — relies on
# rebase-worktree.sh's globals (SKIP_SUBMODULE, SUBMODULES, EXPECTED_SUBMODULE_SHAS,
# WT_SUB_PATHS, WORKTREE_PATH, TARGET_REF, DRY_RUN, ALLOW_SUBMODULE_AHEAD_GLOBAL,
# ALLOW_SUBMODULE_AHEAD_PATHS) and _lib.sh's info/warn/success/error, all
# already in scope via bash's shared-process sourcing model regardless of
# which file defines them.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# SMI-4829: returns 0 (true) if --allow-submodule-ahead applies to $1 (global form, or a matching scoped form).
is_allow_ahead_for() {
    [ "$ALLOW_SUBMODULE_AHEAD_GLOBAL" = true ] && return 0
    local p; for p in "${ALLOW_SUBMODULE_AHEAD_PATHS[@]:-}"; do [ "$p" = "$1" ] && return 0; done
    return 1
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

        # SMI-5823: distinguish "objects genuinely unavailable" (Step 5's
        # fetch attempts — main checkout's copy, then origin — didn't obtain
        # them) from "objects present but neither is an ancestor of the
        # other" (a real divergence). Both used to hit the identical hard
        # error below, which is what made a fixable missing-object gap look
        # like an unresolvable submodule conflict.
        if ! git -C "$wt_sub" cat-file -e "${expected_sha}^{commit}" 2>/dev/null || \
           ! git -C "$wt_sub" cat-file -e "${target_sub_sha}^{commit}" 2>/dev/null; then
            error "Worktree submodule ($sub_path): could not verify ancestry — one or both commit objects are unavailable locally.
  Worktree: $expected_sha
  Target:   $target_sub_sha
Step 5's cross-fetch (main checkout's copy, then origin) could not obtain the missing object. Check network/auth access to this submodule's origin remote, then retry.
This is NOT necessarily a real divergence — it means the objects couldn't be verified, not that they conflict."
        fi

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
