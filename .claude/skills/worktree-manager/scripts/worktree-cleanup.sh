#!/bin/bash
# Worktree Manager - Clean up worktrees
# Usage: ./worktree-cleanup.sh [--all] [--force] [worktree-name]

set -e

ALL=false
FORCE=false
TARGET=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --all)
            ALL=true
            shift
            ;;
        --force|-f)
            FORCE=true
            shift
            ;;
        *)
            TARGET=$1
            shift
            ;;
    esac
done

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
echo "=== Worktree Manager - Cleanup ==="
echo ""

# Get main worktree
MAIN_WORKTREE=$(git rev-parse --show-toplevel)

# Function to check if worktree is merged
is_merged() {
    local worktree_path=$1
    local branch=$(cd "$worktree_path" && git branch --show-current 2>/dev/null)

    if [ -z "$branch" ]; then
        return 1
    fi

    # Check if branch is merged into main
    if git branch --merged origin/main | grep -q "$branch"; then
        return 0
    fi
    return 1
}

# Function to remove a single worktree
remove_worktree() {
    local worktree_path=$1
    local branch=$(cd "$worktree_path" 2>/dev/null && git branch --show-current)

    echo "Worktree: $worktree_path"
    echo "  Branch: $branch"

    # Check for uncommitted changes
    if ! (cd "$worktree_path" && git diff --quiet && git diff --cached --quiet 2>/dev/null); then
        if [ "$FORCE" = true ]; then
            print_warning "  Uncommitted changes (forcing removal)"
        else
            print_error "  Has uncommitted changes - skipping (use --force to override)"
            return 1
        fi
    fi

    # Check if merged
    if is_merged "$worktree_path"; then
        print_success "  Branch is merged into main"
    else
        if [ "$FORCE" = true ]; then
            print_warning "  Branch NOT merged (forcing removal)"
        else
            print_warning "  Branch NOT merged into main - skipping (use --force to override)"
            return 1
        fi
    fi

    # Remove worktree
    print_step "  Removing worktree..."
    git worktree remove "$worktree_path" ${FORCE:+--force}
    print_success "  Removed worktree"

    # Optionally delete branch
    if [ -n "$branch" ]; then
        if git branch --merged origin/main | grep -q "$branch"; then
            print_step "  Deleting merged branch..."
            git branch -d "$branch" 2>/dev/null || true
            print_success "  Deleted branch: $branch"
        fi
    fi

    echo ""
    return 0
}

# If specific target provided
if [ -n "$TARGET" ]; then
    # Find worktree matching target
    FOUND=false
    while IFS= read -r line; do
        if [[ "$line" =~ ^worktree ]]; then
            WORKTREE_PATH=$(echo "$line" | cut -d' ' -f2)
            if [[ "$WORKTREE_PATH" == *"$TARGET"* ]] && [ "$WORKTREE_PATH" != "$MAIN_WORKTREE" ]; then
                FOUND=true
                remove_worktree "$WORKTREE_PATH"
            fi
        fi
    done < <(git worktree list --porcelain)

    if [ "$FOUND" = false ]; then
        print_error "No worktree found matching: $TARGET"
        exit 1
    fi
elif [ "$ALL" = true ]; then
    # Remove all worktrees except main
    print_warning "Removing ALL worktrees..."
    echo ""

    REMOVED=0
    SKIPPED=0

    while IFS= read -r line; do
        if [[ "$line" =~ ^worktree ]]; then
            WORKTREE_PATH=$(echo "$line" | cut -d' ' -f2)
            if [ "$WORKTREE_PATH" != "$MAIN_WORKTREE" ]; then
                if remove_worktree "$WORKTREE_PATH"; then
                    ((REMOVED++))
                else
                    ((SKIPPED++))
                fi
            fi
        fi
    done < <(git worktree list --porcelain)

    echo "=== Summary ==="
    echo "Removed: $REMOVED"
    echo "Skipped: $SKIPPED"
else
    echo "Usage: $0 [--all] [--force] [worktree-name]"
    echo ""
    echo "Options:"
    echo "  --all       Remove all worktrees (except main)"
    echo "  --force     Force removal even if unmerged/uncommitted"
    echo "  worktree    Specific worktree to remove (partial match)"
    echo ""
    echo "Current worktrees:"
    git worktree list
    exit 0
fi

# Prune stale references
print_step "Pruning stale worktree references..."
git worktree prune
print_success "Pruned stale references"

echo ""
echo "Remaining worktrees:"
git worktree list
