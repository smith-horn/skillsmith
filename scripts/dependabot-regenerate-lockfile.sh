#!/usr/bin/env bash
# scripts/dependabot-regenerate-lockfile.sh
# Regenerate package-lock.json for Dependabot PRs after rebase.
#
# Sources scripts/_lib.sh for consistent logging (colors, error/warn/info/success).
# Uses Docker-first npm execution per CLAUDE.md policy.
#
# Prerequisites: gh CLI authenticated, Docker container running, clean working tree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

CONTAINER_NAME="skillsmith-dev-1"
DRY_RUN=false
PR_NUMBERS=()

usage() {
  cat << EOF
Regenerate package-lock.json for Dependabot PRs after rebase.

USAGE
  $(basename "$0") [OPTIONS] [PR_NUMBER ...]

OPTIONS
  --all       Process all open Dependabot PRs
  --dry-run   Preview changes without pushing
  -h, --help  Show this help message

EXAMPLES
  $(basename "$0") 452 453 454        # specific PRs
  $(basename "$0") --all              # all open Dependabot PRs
  $(basename "$0") --dry-run --all    # preview without pushing

PREREQUISITES
  - gh CLI authenticated
  - Docker container running: docker compose --profile dev up -d
  - Clean working tree (no staged, unstaged, or untracked changes)
  - On main branch (recommended)

NOTE
  Force-pushing to Dependabot branches may cause Dependabot to auto-close
  and recreate the PR. Test with a single PR first to verify behavior.
EOF
}

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --dry-run) DRY_RUN=true ;;
    --all)
      while IFS= read -r num; do
        PR_NUMBERS+=("$num")
      done < <(gh pr list --author "app/dependabot" --state open --json number --jq '.[].number')
      if [[ ${#PR_NUMBERS[@]} -eq 0 ]]; then
        info "No open Dependabot PRs found (verify: gh pr list --author 'app/dependabot')"
        exit 0
      fi
      ;;
    *)
      if [[ "$arg" =~ ^[0-9]+$ ]]; then
        PR_NUMBERS+=("$arg")
      else
        echo "Unknown argument: $arg. Run with --help for usage." >&2
        exit 1
      fi
      ;;
  esac
done

if [[ ${#PR_NUMBERS[@]} -eq 0 ]]; then
  usage >&2
  exit 1
fi

# Ensure clean working tree (staged, unstaged, and untracked)
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  error "Working tree is dirty. Commit or stash all changes first."
fi

# Verify Docker container is running
if ! docker ps --filter "name=$CONTAINER_NAME" --format '{{.Names}}' | grep -q "$CONTAINER_NAME"; then
  error "Docker container '$CONTAINER_NAME' is not running. Start with: docker compose --profile dev up -d"
fi

ORIGINAL_BRANCH=$(git branch --show-current)
SUCCESS=0
FAIL=0

info "Regenerating lock files for ${#PR_NUMBERS[@]} Dependabot PR(s) (dry-run: $DRY_RUN)"
echo ""

for pr in "${PR_NUMBERS[@]}"; do
  BRANCH=$(gh pr view "$pr" --json headRefName --jq '.headRefName')
  info "PR #$pr: $BRANCH"

  # Validate it's a Dependabot branch
  if [[ ! "$BRANCH" =~ ^dependabot/ ]]; then
    warn "Not a Dependabot branch ($BRANCH) — skipping"
    ((FAIL++)) || true
    sleep 1
    continue
  fi

  # Check for existing local branch
  if git show-ref --verify --quiet "refs/heads/$BRANCH" 2>/dev/null; then
    warn "Local branch '$BRANCH' already exists — will be reset to origin"
  fi

  # Checkout and rebase
  if ! git fetch origin "$BRANCH" 2>/dev/null; then
    warn "Could not fetch $BRANCH — skipping"
    ((FAIL++)) || true
    sleep 1
    continue
  fi

  git checkout -B "$BRANCH" "origin/$BRANCH" --no-track 2>/dev/null

  if ! git rebase origin/main; then
    warn "Rebase conflict on $BRANCH — aborting and skipping"
    git rebase --abort 2>/dev/null || true
    git checkout "$ORIGINAL_BRANCH" 2>/dev/null
    ((FAIL++)) || true
    sleep 1
    continue
  fi

  # Regenerate lock file via Docker (Docker-first policy)
  docker exec "$CONTAINER_NAME" npm install --package-lock-only --ignore-scripts 2>/dev/null

  if git diff --quiet package-lock.json 2>/dev/null; then
    success "Lock file already up to date"
    git checkout "$ORIGINAL_BRANCH" 2>/dev/null
    # Verify branch after checkout (git-crypt smudge filter protection)
    CURRENT=$(git branch --show-current)
    if [[ "$CURRENT" != "$ORIGINAL_BRANCH" ]]; then
      warn "Branch switched to $CURRENT after checkout — restoring to $ORIGINAL_BRANCH"
      git checkout "$ORIGINAL_BRANCH"
    fi
    ((SUCCESS++)) || true
    sleep 1
    continue
  fi

  git add package-lock.json
  git commit -m "chore(deps): regenerate package-lock.json after rebase"

  if $DRY_RUN; then
    info "Would push $BRANCH (dry-run — skipped)"
    git checkout "$ORIGINAL_BRANCH" 2>/dev/null
    info "Cleaned up local branch $BRANCH"
    git branch -D "$BRANCH" 2>/dev/null || true
  else
    if ! git push origin "$BRANCH" --force-with-lease 2>/dev/null; then
      warn "Push failed for $BRANCH — remote may have changed since fetch. Re-run to retry."
      git checkout "$ORIGINAL_BRANCH" 2>/dev/null
      ((FAIL++)) || true
      sleep 1
      continue
    fi
    success "Pushed $BRANCH"
    git checkout "$ORIGINAL_BRANCH" 2>/dev/null
  fi

  # Verify branch after checkout (git-crypt smudge filter protection)
  CURRENT=$(git branch --show-current)
  if [[ "$CURRENT" != "$ORIGINAL_BRANCH" ]]; then
    warn "Branch switched to $CURRENT after checkout — restoring to $ORIGINAL_BRANCH"
    git checkout "$ORIGINAL_BRANCH"
  fi

  ((SUCCESS++)) || true
  sleep 1
done

# Final branch verification
git checkout "$ORIGINAL_BRANCH" 2>/dev/null
CURRENT=$(git branch --show-current)
if [[ "$CURRENT" != "$ORIGINAL_BRANCH" ]]; then
  warn "Final branch verification failed — expected $ORIGINAL_BRANCH, got $CURRENT"
  git checkout "$ORIGINAL_BRANCH"
fi

echo ""
info "Done: $SUCCESS succeeded, $FAIL failed out of ${#PR_NUMBERS[@]} PRs."
