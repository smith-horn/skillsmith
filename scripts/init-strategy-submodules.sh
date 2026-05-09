#!/usr/bin/env bash
# init-strategy-submodules.sh — Idempotent sparse-checkout cone setup for strategy submodules
#
# SMI-4829 — Shape (b) sparse-checkout foundation
# See: docs/internal/implementation/smi-4829-strategy-extraction.md
#      §6.2.2 "Investigation" and §"Sparse-Checkout Strategy"
#
# Three strategy submodule mount-points map to one cone each:
#   .claude/skills     →  /skills/
#   .claude/plans      →  /plans/
#   .claude/hive-mind  →  /hive-mind/
#
# Discovery order:
#   1. Read .gitmodules via enumerate_submodules (from _lib.sh), filter to
#      paths whose remote URL contains "skillsmith-strategy".
#   2. Fall back to the literal 3-path list if .gitmodules has no strategy
#      entries (pre-cutover state — silent no-op overall).
#
# Idempotency: if the sparse-checkout file already matches the canonical cone,
# the script exits 0 without writing anything. Safe to run on every checkout.
#
# Exit codes:
#   0 — success (including fast-exit when already canonical, and pre-cutover no-op)
#   1 — unrecoverable error (message on stderr)
#
# Bash; sources _lib.sh (also bash). Avoids arrays and local for portability parity.
# Tested with bash -n + shellcheck.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# enumerate_submodules is defined in _lib.sh (SMI-4829 Wave 2A).
# We source only the function we need; sourcing _lib.sh as a whole imports
# color vars and helpers, which is fine.
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# ---------------------------------------------------------------------------
# canonical_cone <mount_path>
#
# Emit the canonical sparse-checkout cone content for a given mount-point.
# Each cone file contains exactly one directory pattern — the leaf folder
# that this submodule should expose (prefixed with /).
#
# mount_path examples: .claude/skills  .claude/plans  .claude/hive-mind
# ---------------------------------------------------------------------------
canonical_cone() {
    _mount="$1"
    case "$_mount" in
        .claude/skills)     printf '/skills/\n'    ;;
        .claude/plans)      printf '/plans/\n'     ;;
        .claude/hive-mind)  printf '/hive-mind/\n' ;;
        *)
            printf 'init-strategy-submodules: no canonical cone for mount "%s"\n' "$_mount" >&2
            return 1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# setup_cone <repo_root> <mount_path>
#
# Write the canonical sparse-checkout cone for <mount_path> if it differs
# from what is currently on disk. Then enable sparse-checkout config keys
# and re-apply the tree (read-tree -m -u HEAD).
#
# Returns 0 on success; 1 on error (message on stderr).
# ---------------------------------------------------------------------------
setup_cone() {
    _repo_root="$1"
    _mount="$2"
    _abs_mount="$_repo_root/$_mount"

    # Submodule's git module dir lives under the main repo's .git/modules/<path>.
    # We need the main repo's .git dir; in a worktree .git is a file.
    _main_git_dir="$(get_main_git_dir "$_repo_root")"
    if [ -z "$_main_git_dir" ]; then
        printf 'init-strategy-submodules: could not resolve main .git dir for %s\n' "$_repo_root" >&2
        return 1
    fi

    _modules_dir="$_main_git_dir/modules/$_mount"
    _sparse_file="$_modules_dir/info/sparse-checkout"
    _canonical="$(canonical_cone "$_mount")" || return 1

    # Fast-exit: if the cone already matches canonical, nothing to do.
    if [ -f "$_sparse_file" ]; then
        _current="$(cat "$_sparse_file" 2>/dev/null || true)"
        if [ "$_current" = "$_canonical" ]; then
            return 0
        fi
    fi

    # The .git/modules/<path>/info dir may not exist yet (uninitialized submodule).
    if [ ! -d "$_modules_dir/info" ]; then
        mkdir -p "$_modules_dir/info"
    fi

    printf '%s' "$_canonical" > "$_sparse_file"

    # Enable sparse-checkout in the submodule's git config.
    # SMI-4829/Wave-2A footgun: git config --file <abs-path> still walks cwd
    # for [includeIf "gitdir:..."] — subshell into / to break discovery.
    _sub_config="$_modules_dir/config"
    if [ -f "$_sub_config" ]; then
        (cd / && git config --file "$_sub_config" core.sparseCheckout true) || true
        (cd / && git config --file "$_sub_config" core.sparseCheckoutCone true) || true
    fi

    # Apply the cone if the submodule working tree is initialized.
    if [ -d "$_abs_mount/.git" ] || [ -f "$_abs_mount/.git" ]; then
        git -C "$_abs_mount" read-tree -m -u HEAD 2>/dev/null || true
    fi

    printf 'init-strategy-submodules: cone set for %s\n' "$_mount"
}

# ---------------------------------------------------------------------------
# has_skill_files <dir>
#
# Return 0 if dir contains at least one SKILL.md anywhere under it.
# Uses find -quit for early exit; compatible with POSIX sh + BSD find.
# ---------------------------------------------------------------------------
has_skill_files() {
    _dir="$1"
    [ -d "$_dir" ] || return 1
    # find exits as soon as it prints one result; we treat non-empty as "has files"
    _found="$(find "$_dir" -name 'SKILL.md' 2>/dev/null | head -1)"
    [ -n "$_found" ]
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
    REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
        printf 'init-strategy-submodules: must be run inside a git repository\n' >&2
        return 1
    }

    # --- Step 1: discover strategy submodule paths ---
    # enumerate_submodules returns all submodule paths from .gitmodules.
    # We filter to those whose configured URL contains "skillsmith-strategy".
    # This requires a second pass through .gitmodules; we use git config directly
    # (with the / subshell guard) to look up each URL.
    _gitmodules="$REPO_ROOT/.gitmodules"
    _strategy_paths=""

    if [ -f "$_gitmodules" ]; then
        _all_paths="$(enumerate_submodules "$REPO_ROOT")"
        for _path in $_all_paths; do
            _url="$(cd / && git config --file "$_gitmodules" "submodule.$_path.url" 2>/dev/null || true)"
            case "$_url" in
                *skillsmith-strategy*)
                    _strategy_paths="$_strategy_paths $_path"
                    ;;
            esac
        done
    fi

    # Strip leading space
    _strategy_paths="${_strategy_paths# }"

    # --- Step 2: pre-cutover fallback ---
    # If .gitmodules has no strategy entries yet (pre-cutover), the script is a
    # no-op: no cones to write, no submodule dirs to configure.
    if [ -z "$_strategy_paths" ]; then
        # Silent no-op — pre-cutover state is expected; not an error.
        return 0
    fi

    # --- Step 3: write canonical cones for each strategy mount ---
    _rc=0
    for _mount in $_strategy_paths; do
        setup_cone "$REPO_ROOT" "$_mount" || _rc=1
    done

    return "$_rc"
}

main "$@"
