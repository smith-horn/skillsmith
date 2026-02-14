#!/bin/bash
# Worktree Manager - Create new worktree
# Usage: ./worktree-create.sh <feature-name> [issue-id] [base-branch]

set -e

FEATURE=$1
ISSUE=${2:-""}
BASE_BRANCH=${3:-"main"}
REPO_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_BASE=$(dirname "$REPO_ROOT")/worktrees
WORKTREE_DIR="$WORKTREE_BASE/$FEATURE"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

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

# Validation
if [ -z "$FEATURE" ]; then
    echo "Usage: $0 <feature-name> [issue-id] [base-branch]"
    echo ""
    echo "Arguments:"
    echo "  feature-name  Name for the worktree/branch (required)"
    echo "  issue-id      Linear issue ID like SMI-XXX (optional)"
    echo "  base-branch   Branch to base off of (default: main)"
    echo ""
    echo "Examples:"
    echo "  $0 session SMI-641"
    echo "  $0 webhooks SMI-645 main"
    echo "  $0 hotfix-auth"
    exit 1
fi

# Check if worktree already exists
if [ -d "$WORKTREE_DIR" ]; then
    print_error "Worktree already exists at: $WORKTREE_DIR"
    echo "Use: cd $WORKTREE_DIR"
    exit 1
fi

# Ensure we're in a git repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    print_error "Not in a git repository"
    exit 1
fi

echo ""
echo "=== Worktree Manager - Create ==="
echo ""

# Step 1: Fetch and update base branch
print_step "Fetching latest from origin..."
git fetch origin "$BASE_BRANCH"
print_success "Fetched origin/$BASE_BRANCH"

# Step 2: Create worktree directory if needed
print_step "Creating worktree directory..."
mkdir -p "$WORKTREE_BASE"

# Step 3: Determine branch name
if [ -n "$ISSUE" ]; then
    BRANCH_NAME="feature/$FEATURE-$ISSUE"
else
    BRANCH_NAME="feature/$FEATURE"
fi

# Step 4: Check if branch already exists
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    print_warning "Branch '$BRANCH_NAME' already exists"
    print_step "Creating worktree from existing branch..."
    git worktree add "$WORKTREE_DIR" "$BRANCH_NAME"
else
    print_step "Creating worktree with new branch..."
    git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" "origin/$BASE_BRANCH"
fi

print_success "Worktree created at: $WORKTREE_DIR"

# Step 5: Check for shared files that might cause conflicts
echo ""
print_step "Checking shared files registry..."
SHARED_FILES=(
    "packages/core/src/index.ts"
    "packages/core/package.json"
    "packages/mcp-server/src/index.ts"
    "package.json"
)

for file in "${SHARED_FILES[@]}"; do
    if [ -f "$REPO_ROOT/$file" ]; then
        RECENT_CHANGES=$(git log --oneline -3 -- "$file" 2>/dev/null | head -3)
        if [ -n "$RECENT_CHANGES" ]; then
            print_warning "Recent changes to $file:"
            echo "$RECENT_CHANGES" | sed 's/^/    /'
        fi
    fi
done

# Step 6: Summary
echo ""
echo "=== Summary ==="
echo ""
echo "Worktree: $WORKTREE_DIR"
echo "Branch:   $BRANCH_NAME"
echo "Base:     origin/$BASE_BRANCH"
[ -n "$ISSUE" ] && echo "Issue:    $ISSUE"
echo ""
echo "Next steps:"
echo "  1. cd $WORKTREE_DIR"
echo "  2. Start your development work"
echo "  3. Remember to rebase frequently: git fetch origin main && git rebase origin/main"
echo ""
print_success "Worktree ready!"
