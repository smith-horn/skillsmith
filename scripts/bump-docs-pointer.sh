#!/usr/bin/env bash
# scripts/bump-docs-pointer.sh
# SMI-6260 Wave 2 — minimal docs/internal pointer bump helper.
#
# Ancestry-validates the target via scripts/ci/check-submodule-pointer.sh
# before committing (never reimplements the ancestry check inline — see
# docs/internal/implementation/smi-6260-docs-internal-pointer-regression-gate.md,
# item 6). No branch creation, no push — caller's responsibility. Do not
# grow this into a general submodule tool (plan's explicit scope boundary).
#
# Usage:
#   scripts/bump-docs-pointer.sh [--dry-run] [--to=<sha>]
#
#   --dry-run   Print what would happen; make no changes.
#   --to=<sha>  Bump to an explicit target instead of docs/internal's
#               configured upstream tip. Still ancestry-checked.
#
# Ordering note (deviates from the plan's literal step order — see the Wave 2
# implementation report): check-submodule-pointer.sh reads S via
# `git ls-tree <ref>`, which reads the COMMITTED tree, not the working
# directory. Checking out the new pointer without committing first would
# leave the check evaluating the OLD (still-committed) S. This script
# instead commits first, then validates, and reverts the commit (and the
# submodule's own checkout) on failure — preserving the plan's actual
# invariant ("never leave an invalid pointer committed") via revert-on-
# failure rather than validate-before-commit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOUNT="docs/internal"
MOUNT_DIR="$REPO_ROOT/$MOUNT"

DRY_RUN=0
TARGET_SHA=""

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --to=*) TARGET_SHA="${arg#*=}" ;;
        *)
            echo "bump-docs-pointer.sh: unknown argument: $arg" >&2
            echo "Usage: $0 [--dry-run] [--to=<sha>]" >&2
            exit 2
            ;;
    esac
done

if [ ! -e "$MOUNT_DIR/.git" ]; then
    echo "bump-docs-pointer.sh: $MOUNT is not an initialized submodule checkout — run 'git submodule update --init $MOUNT' first" >&2
    exit 2
fi

if [ -n "$(git -C "$MOUNT_DIR" status --porcelain 2>/dev/null)" ]; then
    echo "bump-docs-pointer.sh: $MOUNT has local uncommitted changes — aborting (never bump a dirty submodule)" >&2
    exit 1
fi

if [ -n "$(git -C "$REPO_ROOT" diff --cached --name-only 2>/dev/null)" ]; then
    echo "bump-docs-pointer.sh: the parent repo already has staged changes — aborting to avoid committing unrelated staged content alongside the pointer bump" >&2
    exit 1
fi

BRANCH="$(git config -f "$REPO_ROOT/.gitmodules" --get submodule."$MOUNT".branch 2>/dev/null || echo main)"

echo "bump-docs-pointer.sh: fetching $MOUNT's $BRANCH from origin..."
git -C "$MOUNT_DIR" fetch origin "$BRANCH" --prune --quiet

if [ -n "$TARGET_SHA" ]; then
    T="$TARGET_SHA"
else
    T="$(git -C "$MOUNT_DIR" rev-parse "origin/$BRANCH")"
fi

CURRENT="$(git -C "$MOUNT_DIR" rev-parse HEAD)"
if [ "$CURRENT" = "$T" ]; then
    echo "bump-docs-pointer.sh: $MOUNT is already at $T — nothing to do."
    exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "bump-docs-pointer.sh: [dry-run] would bump $MOUNT from $CURRENT to $T"
    exit 0
fi

git -C "$MOUNT_DIR" checkout --detach --quiet "$T"

PREV_PARENT_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
git -C "$REPO_ROOT" add "$MOUNT"
git -C "$REPO_ROOT" commit --quiet -m "chore(docs): bump docs/internal pointer to ${T:0:7}"

echo "bump-docs-pointer.sh: validating ancestry..."
if ! "$REPO_ROOT/scripts/ci/check-submodule-pointer.sh" --mode=block --ref=HEAD --target="$PREV_PARENT_HEAD"; then
    echo "bump-docs-pointer.sh: ancestry check failed against the new pointer — reverting commit and submodule checkout" >&2
    git -C "$REPO_ROOT" reset --quiet --hard "$PREV_PARENT_HEAD"
    git -C "$MOUNT_DIR" checkout --detach --quiet "$CURRENT"
    exit 1
fi

echo "bump-docs-pointer.sh: committed $(git -C "$REPO_ROOT" rev-parse --short HEAD). Push when ready — this script never pushes."
