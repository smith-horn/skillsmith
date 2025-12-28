#!/bin/bash
# Worktree Manager - Sync all worktrees with main
# Usage: ./worktree-sync.sh [--dry-run]

set -e

DRY_RUN=false
if [ "$1" = "--dry-run" ]; then
    DRY_RUN=true
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

print_step() {
    echo -e "${CYAN}→${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

echo ""
echo "=== Worktree Manager - Sync ==="
echo ""

if [ "$DRY_RUN" = true ]; then
    print_warning "DRY RUN MODE - No changes will be made"
    echo ""
fi

# Fetch latest
print_step "Fetching latest from origin..."
git fetch origin main
print_success "Fetched origin/main"
echo ""

# Get main worktree path
MAIN_WORKTREE=$(git rev-parse --show-toplevel)

# Track results
SYNCED=0
CONFLICTS=0
SKIPPED=0

# Process each worktree
print_step "Checking worktrees..."
echo ""

while IFS= read -r line; do
    if [[ "$line" =~ ^worktree ]]; then
        WORKTREE_PATH=$(echo "$line" | cut -d' ' -f2)

        # Skip main worktree
        if [ "$WORKTREE_PATH" = "$MAIN_WORKTREE" ]; then
            continue
        fi

        # Get branch name
        BRANCH=$(cd "$WORKTREE_PATH" 2>/dev/null && git branch --show-current)

        if [ -z "$BRANCH" ]; then
            print_warning "Skipping $WORKTREE_PATH (detached HEAD)"
            ((SKIPPED++))
            continue
        fi

        # Calculate behind/ahead
        BEHIND=$(cd "$WORKTREE_PATH" && git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
        AHEAD=$(cd "$WORKTREE_PATH" && git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")

        echo "Worktree: $WORKTREE_PATH"
        echo "  Branch: $BRANCH"
        echo "  Status: $BEHIND behind, $AHEAD ahead of origin/main"

        if [ "$BEHIND" = "0" ]; then
            print_success "  Already up to date"
            ((SYNCED++))
        elif [ "$DRY_RUN" = true ]; then
            print_warning "  Would rebase onto origin/main"
            ((SYNCED++))
        else
            print_step "  Rebasing onto origin/main..."

            # Check for uncommitted changes
            if ! (cd "$WORKTREE_PATH" && git diff --quiet && git diff --cached --quiet); then
                print_warning "  Uncommitted changes detected - stashing..."
                (cd "$WORKTREE_PATH" && git stash push -m "worktree-sync auto-stash")
                STASHED=true
            else
                STASHED=false
            fi

            # Attempt rebase
            if (cd "$WORKTREE_PATH" && git rebase origin/main 2>/dev/null); then
                print_success "  Rebased successfully"
                ((SYNCED++))
            else
                print_error "  CONFLICT - Manual resolution needed"
                (cd "$WORKTREE_PATH" && git rebase --abort 2>/dev/null) || true
                ((CONFLICTS++))
            fi

            # Restore stash if needed
            if [ "$STASHED" = true ]; then
                print_step "  Restoring stashed changes..."
                (cd "$WORKTREE_PATH" && git stash pop) || print_warning "  Could not restore stash"
            fi
        fi

        echo ""
    fi
done < <(git worktree list --porcelain)

# Summary
echo "=== Summary ==="
echo ""
echo "Synced:    $SYNCED"
echo "Conflicts: $CONFLICTS"
echo "Skipped:   $SKIPPED"
echo ""

if [ "$CONFLICTS" -gt 0 ]; then
    print_error "Some worktrees have conflicts that need manual resolution"
    exit 1
else
    print_success "All worktrees synchronized!"
fi
