#!/bin/bash
# Worktree Manager - Show status of all worktrees
# Usage: ./worktree-status.sh [--verbose]

VERBOSE=false
if [ "$1" = "--verbose" ] || [ "$1" = "-v" ]; then
    VERBOSE=true
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Fetch latest (silently)
git fetch origin main 2>/dev/null

echo ""
echo -e "${BOLD}=== Worktree Status ===${NC}"
echo ""

# Table header
printf "%-50s %-25s %-8s %-8s %-10s\n" "PATH" "BRANCH" "BEHIND" "AHEAD" "STATUS"
printf "%-50s %-25s %-8s %-8s %-10s\n" "----" "------" "------" "-----" "------"

# Get main worktree
MAIN_WORKTREE=$(git rev-parse --show-toplevel)

# Process each worktree
while IFS= read -r line; do
    if [[ "$line" =~ ^worktree ]]; then
        WORKTREE_PATH=$(echo "$line" | cut -d' ' -f2)

        # Get relative path for display
        DISPLAY_PATH=$(echo "$WORKTREE_PATH" | sed "s|$HOME|~|")

        # Get branch
        BRANCH=$(cd "$WORKTREE_PATH" 2>/dev/null && git branch --show-current 2>/dev/null)
        if [ -z "$BRANCH" ]; then
            BRANCH="(detached)"
        fi

        # Calculate behind/ahead
        BEHIND=$(cd "$WORKTREE_PATH" && git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
        AHEAD=$(cd "$WORKTREE_PATH" && git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")

        # Determine status
        if [ "$WORKTREE_PATH" = "$MAIN_WORKTREE" ]; then
            STATUS="${CYAN}main${NC}"
        elif [ "$BEHIND" = "0" ]; then
            STATUS="${GREEN}synced${NC}"
        elif [ "$BEHIND" != "?" ] && [ "$BEHIND" -gt 10 ]; then
            STATUS="${RED}stale${NC}"
        elif [ "$BEHIND" != "?" ] && [ "$BEHIND" -gt 0 ]; then
            STATUS="${YELLOW}behind${NC}"
        else
            STATUS="${YELLOW}unknown${NC}"
        fi

        # Check for uncommitted changes
        HAS_CHANGES=""
        if ! (cd "$WORKTREE_PATH" && git diff --quiet 2>/dev/null); then
            HAS_CHANGES=" ${YELLOW}*${NC}"
        fi

        printf "%-50s %-25s %-8s %-8s %b%s\n" "$DISPLAY_PATH" "$BRANCH" "$BEHIND" "$AHEAD" "$STATUS" "$HAS_CHANGES"

        # Verbose output
        if [ "$VERBOSE" = true ] && [ "$WORKTREE_PATH" != "$MAIN_WORKTREE" ]; then
            echo ""
            echo "  Recent commits:"
            (cd "$WORKTREE_PATH" && git log --oneline -3 2>/dev/null) | sed 's/^/    /'
            echo ""
        fi
    fi
done < <(git worktree list --porcelain)

echo ""

# Shared files check
echo -e "${BOLD}=== Shared Files Recent Activity ===${NC}"
echo ""

SHARED_FILES=(
    "packages/core/src/index.ts"
    "packages/core/package.json"
    "packages/mcp-server/src/index.ts"
    "package.json"
)

for file in "${SHARED_FILES[@]}"; do
    LAST_CHANGE=$(git log --oneline -1 -- "$file" 2>/dev/null)
    if [ -n "$LAST_CHANGE" ]; then
        echo "$file:"
        echo "  $LAST_CHANGE"
    fi
done

echo ""
echo -e "${CYAN}Legend:${NC} * = uncommitted changes"
echo ""
