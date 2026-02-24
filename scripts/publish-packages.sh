#!/usr/bin/env bash
# publish-packages.sh — publish @skillsmith packages in dependency order
#
# Lesson from SMI-2714 retro: always publish core before cli.
# Publishing cli first caused ETARGET failures when the dep version
# wasn't yet live on npm.
#
# Usage:
#   ./scripts/publish-packages.sh           # publish all (core → cli)
#   ./scripts/publish-packages.sh core      # publish core only
#   ./scripts/publish-packages.sh cli       # publish cli only (verifies core dep first)
#   ./scripts/publish-packages.sh --dry-run # show what would be published

set -euo pipefail

DRY_RUN=false
TARGET="${1:-all}"

if [[ "$TARGET" == "--dry-run" ]]; then
  DRY_RUN=true
  TARGET="all"
fi

log() { echo "  $*"; }
ok()  { echo "  ✓ $*"; }
err() { echo "  ✗ $*" >&2; exit 1; }

publish_package() {
  local dir="$1"
  local name
  name=$(node -e "process.stdout.write(require('$dir/package.json').name)")
  local version
  version=$(node -e "process.stdout.write(require('$dir/package.json').version)")

  log "Publishing $name@$version from $dir..."

  # Check if this version is already published
  local published
  published=$(npm view "$name@$version" version 2>/dev/null || echo "")
  if [[ "$published" == "$version" ]]; then
    ok "$name@$version already published — skipping"
    return 0
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    ok "[dry-run] Would publish $name@$version"
    return 0
  fi

  # Build must happen in Docker first — this script only publishes
  (cd "$dir" && npm publish --ignore-scripts)
  ok "$name@$version published"

  # Wait for npm registry propagation
  log "Waiting for $name@$version to propagate..."
  local attempts=0
  while [[ $attempts -lt 10 ]]; do
    sleep 3
    local live
    live=$(npm view "$name@$version" version 2>/dev/null || echo "")
    if [[ "$live" == "$version" ]]; then
      ok "$name@$version is live on npm"
      return 0
    fi
    attempts=$((attempts + 1))
    log "  Still propagating... ($attempts/10)"
  done
  err "$name@$version did not propagate within 30s — check npm manually"
}

verify_dep() {
  local dep_name="$1"
  local dep_version="$2"

  log "Verifying $dep_name@$dep_version is on npm..."
  local live
  live=$(npm view "$dep_name@$dep_version" version 2>/dev/null || echo "")
  if [[ "$live" != "$dep_version" ]]; then
    err "$dep_name@$dep_version not found on npm (got: '$live'). Publish core first."
  fi
  ok "$dep_name@$dep_version confirmed on npm"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_DIR="$REPO_ROOT/packages/core"
CLI_DIR="$REPO_ROOT/packages/cli"

echo ""
echo "Skillsmith Package Publisher"
echo "──────────────────────────────"

case "$TARGET" in
  all)
    publish_package "$CORE_DIR"
    # Verify core dep version matches what CLI expects
    CORE_DEP=$(node -e "process.stdout.write(require('$CLI_DIR/package.json').dependencies['@skillsmith/core'])")
    verify_dep "@skillsmith/core" "$CORE_DEP"
    publish_package "$CLI_DIR"
    ;;
  core)
    publish_package "$CORE_DIR"
    ;;
  cli)
    # Verify core dep is live before publishing CLI
    CORE_DEP=$(node -e "process.stdout.write(require('$CLI_DIR/package.json').dependencies['@skillsmith/core'])")
    verify_dep "@skillsmith/core" "$CORE_DEP"
    publish_package "$CLI_DIR"
    ;;
  *)
    echo "Usage: $0 [all|core|cli|--dry-run]"
    exit 1
    ;;
esac

echo ""
echo "Done."
