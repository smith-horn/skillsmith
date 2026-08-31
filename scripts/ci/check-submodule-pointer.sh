#!/usr/bin/env bash
# scripts/ci/check-submodule-pointer.sh
# SMI-6260 Wave 1 — docs/internal (and other .gitmodules mount) gitlink
# ancestry gate. Full design:
# docs/internal/implementation/smi-6260-docs-internal-pointer-regression-gate.md
# ("Design decisions" section — binding, reviewed twice).
#
# Closes the PR #2609 failure mode: a submodule pointer bump that LOOKS like
# a clean forward move (git diff/git status show a normal single-line SHA
# change) but is actually a regression relative to the submodule's own
# upstream history, or relative to what the target ref already registers.
#
# Usage:
#   check-submodule-pointer.sh --mode=<block|warn> [--ref=<ref>]
#     [--target=<ref>] [--before=<sha>] [--pat-available=<true|false>]
#
#   --mode=block   CI (pointer-check / pointer-autorepair). Exits non-zero
#                  if any BLOCKING_MOUNTS entry FAILs. Retries a failed
#                  fetch once before reporting R-FETCH.
#   --mode=warn    Pre-push (.husky/pre-push). Always exits 0 — advisory
#                  only; the hard gate is Wave 2's CI job. No fetch retry
#                  (a local failure is cheap to re-run manually).
#   --ref          The ref under test — source of S. Default: HEAD.
#   --target       The diff-base / "already registered" ref — source of B,
#                  and (with --before absent) the R0 diff base too.
#                  Default: origin/main.
#   --before       Overrides --target as B's source ref (post-merge
#                  B_prev reconstruction from `github.event.before`; Wave 2
#                  uses this — Wave 1 accepts and honors the flag without a
#                  caller that passes it yet).
#   --pat-available  Whether a credential is available to fetch a private
#                  mount's remote (R8/R9). Default: true (a local
#                  --mode=warn run uses the developer's own git
#                  credentials, not a CI-issued PAT).
#
# Generic over every .gitmodules entry (parse_gitmodules_mounts /
# get_mount_field in check-submodule-pointer.helpers.sh mirror
# scripts/ci/classify-changes.ts's getSubmoduleMounts()/isSubmoduleMount()
# exact-match discipline — never glob-match a mount path). Blocking
# behavior is gated per-mount by BLOCKING_MOUNTS below: only docs/internal
# is blocking in v1 (per the plan's "Scope boundary" design decision); the
# three skillsmith-strategy mounts are warn-only even under --mode=block.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=check-submodule-pointer.helpers.sh
source "$SCRIPT_DIR/check-submodule-pointer.helpers.sh"

# v1 blocking allowlist (plan's "Scope boundary" design decision). The three
# skillsmith-strategy mounts (.claude/skills, .claude/plans,
# .claude/hive-mind) run warn-only even under --mode=block.
BLOCKING_MOUNTS=("docs/internal")

MODE=""
REF="HEAD"
TARGET="origin/main"
BEFORE=""
PAT_AVAILABLE="true"

for arg in "$@"; do
    case "$arg" in
        --mode=*) MODE="${arg#*=}" ;;
        --ref=*) REF="${arg#*=}" ;;
        --target=*) TARGET="${arg#*=}" ;;
        --before=*) BEFORE="${arg#*=}" ;;
        --pat-available=*) PAT_AVAILABLE="${arg#*=}" ;;
        *)
            echo "check-submodule-pointer.sh: unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

if [ "$MODE" != "block" ] && [ "$MODE" != "warn" ]; then
    echo "Usage: $0 --mode=<block|warn> [--ref=<ref>] [--target=<ref>] [--before=<sha>] [--pat-available=<true|false>]" >&2
    exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
    echo "check-submodule-pointer.sh: not inside a git repository" >&2
    exit 2
fi

GITMODULES="$REPO_ROOT/.gitmodules"
if [ ! -f "$GITMODULES" ]; then
    echo "check-submodule-pointer.sh: no .gitmodules found — nothing to check."
    exit 0
fi

DIFF_BASE="${BEFORE:-$TARGET}"

if ! git -C "$REPO_ROOT" rev-parse --verify -q "${REF}^{commit}" >/dev/null 2>&1; then
    echo "check-submodule-pointer.sh: --ref='$REF' does not resolve to a commit in this repo" >&2
    exit 2
fi
if ! git -C "$REPO_ROOT" rev-parse --verify -q "${DIFF_BASE}^{commit}" >/dev/null 2>&1; then
    echo "check-submodule-pointer.sh: diff-base '$DIFF_BASE' (--before or --target) does not resolve to a commit in this repo" >&2
    exit 2
fi

CHANGED_FILES="$(git -C "$REPO_ROOT" diff --name-only "$DIFF_BASE" "$REF" 2>/dev/null || true)"
MOUNTS="$(parse_gitmodules_mounts "$GITMODULES")"

if [ -z "$MOUNTS" ]; then
    echo "check-submodule-pointer.sh: no submodule mounts declared in .gitmodules"
    exit 0
fi

is_blocking_mount() {
    for _CSP_BM in "${BLOCKING_MOUNTS[@]}"; do
        [ "$_CSP_BM" = "$1" ] && return 0
    done
    return 1
}

ANY_BLOCKING_FAIL=0

while IFS= read -r MOUNT; do
    [ -z "$MOUNT" ] && continue
    BLOCKING=0
    is_blocking_mount "$MOUNT" && BLOCKING=1

    evaluate_mount "$REPO_ROOT" "$MOUNT" "$REF" "$DIFF_BASE" "$CHANGED_FILES" "$MODE" "$PAT_AVAILABLE" "$BLOCKING"
    MOUNT_STATUS=$?

    if [ "$MOUNT_STATUS" -ne 0 ] && [ "$BLOCKING" -eq 1 ] && [ "$MODE" = "block" ]; then
        ANY_BLOCKING_FAIL=1
    fi
done <<EOF
$MOUNTS
EOF

if [ "$MODE" = "warn" ]; then
    exit 0
fi

if [ "$ANY_BLOCKING_FAIL" -eq 1 ]; then
    exit 1
fi
exit 0
