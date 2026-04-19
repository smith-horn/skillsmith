#!/usr/bin/env bash
#
# submodule-hash.sh — write a Turborepo cache-invalidation sentinel
#
# Computes a stable hash for the current state of packages/enterprise/
# and writes it to packages/enterprise/.submodule-hash. Turborepo reads
# that sentinel as an input for mcp-server and cli build tasks so their
# cache invalidates whenever the enterprise source advances.
#
# Works in both pre-Wave-0 (enterprise as a regular directory) and
# post-Wave-0 (enterprise as a git submodule) layouts:
#   - pre-Wave-0:  git tree hash of packages/enterprise at HEAD
#   - post-Wave-0: git rev-parse HEAD inside packages/enterprise
#
# Idempotent; safe to call repeatedly. Intended invocation points:
#   - npm postinstall hook
#   - post-merge / post-checkout git hooks (added in Wave 0)
#   - manual re-run after `git submodule update`
#
# Exit codes:
#   0  hash written (or unchanged)
#   1  packages/enterprise missing
#   2  git not available or repo not a git repo
#
# SMI-4354.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTERPRISE_DIR="$REPO_ROOT/packages/enterprise"
HASH_FILE="$ENTERPRISE_DIR/.submodule-hash"

if ! command -v git >/dev/null 2>&1; then
  echo "submodule-hash: git not available" >&2
  exit 2
fi

if [[ ! -d "$REPO_ROOT/.git" ]] && [[ ! -f "$REPO_ROOT/.git" ]]; then
  echo "submodule-hash: $REPO_ROOT is not a git checkout — skipping" >&2
  exit 2
fi

if [[ ! -d "$ENTERPRISE_DIR" ]]; then
  echo "submodule-hash: $ENTERPRISE_DIR does not exist" >&2
  exit 1
fi

# Post-Wave-0: submodule layout — packages/enterprise has its own .git file
# or directory. Its HEAD is the tracked submodule commit.
if [[ -e "$ENTERPRISE_DIR/.git" ]]; then
  HASH=$(git -C "$ENTERPRISE_DIR" rev-parse HEAD 2>/dev/null || echo "")
  SOURCE="submodule HEAD"
else
  # Pre-Wave-0: enterprise is a regular directory in the parent repo.
  # Use the git tree hash of the packages/enterprise entry at HEAD.
  HASH=$(git -C "$REPO_ROOT" rev-parse HEAD:packages/enterprise 2>/dev/null || echo "")
  SOURCE="tree hash"
fi

if [[ -z "$HASH" ]]; then
  # Enterprise exists but is not tracked (e.g., checked-in externally,
  # fresh scaffold, or filter-repo in progress). Write a timestamp so
  # turbo still invalidates on re-run but we don't error the build.
  HASH="untracked-$(date -u +%s)"
  SOURCE="timestamp fallback"
fi

PREV=""
if [[ -f "$HASH_FILE" ]]; then
  PREV=$(cat "$HASH_FILE")
fi

if [[ "$PREV" == "$HASH" ]]; then
  exit 0
fi

printf '%s\n' "$HASH" > "$HASH_FILE"

# Quiet in CI to reduce log noise; verbose locally.
if [[ "${CI:-false}" != "true" ]]; then
  echo "submodule-hash: $HASH_FILE updated ($SOURCE: $HASH)"
fi
