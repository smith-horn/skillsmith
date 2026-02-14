#!/bin/bash
# git-crypt-worktree.sh - Create and manage git worktrees in git-crypt repos
#
# Usage:
#   ./git-crypt-worktree.sh create <worktree-path> <branch-name>
#   ./git-crypt-worktree.sh fix <worktree-path>
#   ./git-crypt-worktree.sh status [worktree-path]
#
# This script handles the git-crypt smudge filter issue that prevents
# worktree creation in encrypted repositories.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the main repo's .git directory
get_main_git_dir() {
    local git_dir
    git_dir=$(git rev-parse --git-dir 2>/dev/null)

    # If we're in a worktree, resolve to main .git
    if [[ -f "$git_dir" ]]; then
        # It's a worktree - .git is a file pointing to the real location
        git_dir=$(cat "$git_dir" | sed 's/gitdir: //')
        # Go up from .git/worktrees/<name> to .git
        git_dir=$(dirname "$(dirname "$git_dir")")
    fi

    echo "$git_dir"
}

# Check if repo uses git-crypt
check_git_crypt() {
    local git_dir
    git_dir=$(get_main_git_dir)

    if [[ -d "$git_dir/git-crypt" ]]; then
        return 0
    else
        return 1
    fi
}

# Check if git-crypt is unlocked
is_unlocked() {
    local git_dir
    git_dir=$(get_main_git_dir)

    if [[ -f "$git_dir/git-crypt/keys/default" ]]; then
        return 0
    else
        return 1
    fi
}

# Save git-crypt filter config
save_filter_config() {
    SAVED_SMUDGE=$(git config --get filter.git-crypt.smudge 2>/dev/null || echo "")
    SAVED_CLEAN=$(git config --get filter.git-crypt.clean 2>/dev/null || echo "")
    SAVED_REQUIRED=$(git config --get filter.git-crypt.required 2>/dev/null || echo "")
    SAVED_TEXTCONV=$(git config --get diff.git-crypt.textconv 2>/dev/null || echo "")
}

# Disable git-crypt filter temporarily
disable_filter() {
    git config --unset filter.git-crypt.smudge 2>/dev/null || true
    git config --unset filter.git-crypt.clean 2>/dev/null || true
    git config --unset filter.git-crypt.required 2>/dev/null || true
    git config --unset diff.git-crypt.textconv 2>/dev/null || true
}

# Restore git-crypt filter config
restore_filter() {
    if [[ -n "$SAVED_SMUDGE" ]]; then
        git config filter.git-crypt.smudge "$SAVED_SMUDGE"
    fi
    if [[ -n "$SAVED_CLEAN" ]]; then
        git config filter.git-crypt.clean "$SAVED_CLEAN"
    fi
    if [[ -n "$SAVED_REQUIRED" ]]; then
        git config filter.git-crypt.required "$SAVED_REQUIRED"
    fi
    if [[ -n "$SAVED_TEXTCONV" ]]; then
        git config diff.git-crypt.textconv "$SAVED_TEXTCONV"
    fi
}

# Get the key file path from environment or common locations
find_key_file() {
    # Check environment variable first
    if [[ -n "${GIT_CRYPT_KEY_PATH:-}" ]] && [[ -f "$GIT_CRYPT_KEY_PATH" ]]; then
        echo "$GIT_CRYPT_KEY_PATH"
        return 0
    fi

    # Check common locations based on repo name
    local repo_name
    repo_name=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")

    local common_paths=(
        "$HOME/.keys/${repo_name}-git-crypt.key"
        "$HOME/.keys/${repo_name}.key"
        "$HOME/.${repo_name}-keys/${repo_name}-git-crypt.key"
        "$HOME/.skillsmith-keys/skillsmith-git-crypt.key"
    )

    for path in "${common_paths[@]}"; do
        if [[ -f "$path" ]]; then
            echo "$path"
            return 0
        fi
    done

    return 1
}

# Unlock git-crypt in worktree using key file
unlock_worktree() {
    local worktree_path="$1"
    local key_file

    # Find key file
    if ! key_file=$(find_key_file); then
        echo -e "${RED}Error: Could not find git-crypt key file${NC}"
        echo -e "${YELLOW}Set GIT_CRYPT_KEY_PATH or place key in ~/.keys/<repo>-git-crypt.key${NC}"
        return 1
    fi

    echo "  Using key: $key_file"

    # Run unlock in worktree
    if (cd "$worktree_path" && git-crypt unlock "$key_file" 2>/dev/null); then
        return 0
    else
        echo -e "${RED}Error: Failed to unlock git-crypt${NC}"
        return 1
    fi
}

# Copy git-crypt keys to worktree (legacy method, kept for reference)
copy_keys_to_worktree() {
    local worktree_name="$1"
    local git_dir
    git_dir=$(get_main_git_dir)

    local worktree_git_dir="$git_dir/worktrees/$worktree_name"

    if [[ ! -d "$worktree_git_dir" ]]; then
        echo -e "${RED}Error: Worktree git directory not found: $worktree_git_dir${NC}"
        return 1
    fi

    # Create git-crypt keys directory in worktree
    mkdir -p "$worktree_git_dir/git-crypt/keys"

    # Copy the key
    if [[ -f "$git_dir/git-crypt/keys/default" ]]; then
        cp "$git_dir/git-crypt/keys/default" "$worktree_git_dir/git-crypt/keys/"
        echo -e "${GREEN}✓ Copied git-crypt keys to worktree${NC}"
    else
        echo -e "${RED}Error: No git-crypt key found in main repo${NC}"
        echo -e "${YELLOW}Hint: Run 'git-crypt unlock <key-path>' in main repo first${NC}"
        return 1
    fi
}

# Create worktree with git-crypt support
cmd_create() {
    local worktree_path="$1"
    local branch_name="$2"

    if [[ -z "$worktree_path" ]] || [[ -z "$branch_name" ]]; then
        echo -e "${RED}Usage: $0 create <worktree-path> <branch-name>${NC}"
        echo "Example: $0 create ../worktrees/feature-x feature/feature-x"
        exit 1
    fi

    # Check if this is a git-crypt repo
    if ! check_git_crypt; then
        echo -e "${YELLOW}Note: This repo doesn't use git-crypt. Using standard worktree creation.${NC}"
        git worktree add "$worktree_path" -b "$branch_name"
        exit 0
    fi

    # Check if unlocked
    if ! is_unlocked; then
        echo -e "${RED}Error: git-crypt is not unlocked${NC}"
        echo -e "${YELLOW}Hint: Run 'git-crypt unlock <key-path>' first${NC}"
        exit 1
    fi

    echo -e "${GREEN}Creating worktree with git-crypt support...${NC}"

    # Get worktree name from path
    local worktree_name
    worktree_name=$(basename "$worktree_path")

    # Save and disable filter
    echo "  Temporarily disabling git-crypt filter..."
    save_filter_config
    disable_filter

    # Create worktree
    echo "  Creating worktree at $worktree_path..."
    if ! git worktree add "$worktree_path" -b "$branch_name" 2>/dev/null; then
        # Branch might already exist, try without -b
        if ! git worktree add "$worktree_path" "$branch_name" 2>/dev/null; then
            restore_filter
            echo -e "${RED}Error: Failed to create worktree${NC}"
            exit 1
        fi
    fi

    # Restore filter
    echo "  Restoring git-crypt filter..."
    restore_filter

    # Unlock git-crypt in worktree
    echo "  Unlocking git-crypt in worktree..."
    if ! unlock_worktree "$worktree_path"; then
        echo -e "${RED}Warning: Could not auto-unlock worktree${NC}"
        echo -e "${YELLOW}Run manually: cd $worktree_path && git-crypt unlock <key-path>${NC}"
    fi

    echo -e "${GREEN}✓ Worktree created successfully at $worktree_path${NC}"
    echo -e "${GREEN}✓ git-crypt unlocked${NC}"
    echo ""
    echo "Next steps:"
    echo "  cd $worktree_path"
    echo "  # Start working!"
}

# Fix existing worktree
cmd_fix() {
    local worktree_path="$1"

    if [[ -z "$worktree_path" ]]; then
        echo -e "${RED}Usage: $0 fix <worktree-path>${NC}"
        exit 1
    fi

    if [[ ! -d "$worktree_path" ]]; then
        echo -e "${RED}Error: Worktree path does not exist: $worktree_path${NC}"
        exit 1
    fi

    # Get worktree name
    local worktree_name
    worktree_name=$(basename "$worktree_path")

    echo -e "${GREEN}Fixing git-crypt in worktree: $worktree_name${NC}"

    # Unlock git-crypt in worktree
    echo "  Unlocking git-crypt..."
    if ! unlock_worktree "$worktree_path"; then
        echo -e "${RED}Error: Could not unlock worktree${NC}"
        exit 1
    fi

    echo -e "${GREEN}✓ Worktree fixed - git-crypt unlocked${NC}"
}

# Show status
cmd_status() {
    local worktree_path="$1"

    echo -e "${GREEN}git-crypt Status${NC}"
    echo "================"

    # Check main repo
    if check_git_crypt; then
        echo -e "Repository uses git-crypt: ${GREEN}Yes${NC}"

        if is_unlocked; then
            echo -e "Main repo unlocked: ${GREEN}Yes${NC}"
        else
            echo -e "Main repo unlocked: ${RED}No${NC}"
            echo -e "${YELLOW}Hint: Run 'git-crypt unlock <key-path>'${NC}"
        fi
    else
        echo -e "Repository uses git-crypt: ${YELLOW}No${NC}"
        exit 0
    fi

    # Check specific worktree if provided
    if [[ -n "$worktree_path" ]]; then
        echo ""
        echo "Worktree: $worktree_path"

        local worktree_name
        worktree_name=$(basename "$worktree_path")
        local git_dir
        git_dir=$(get_main_git_dir)
        local worktree_key="$git_dir/worktrees/$worktree_name/git-crypt/keys/default"

        if [[ -f "$worktree_key" ]]; then
            echo -e "Worktree has git-crypt keys: ${GREEN}Yes${NC}"
        else
            echo -e "Worktree has git-crypt keys: ${RED}No${NC}"
            echo -e "${YELLOW}Hint: Run '$0 fix $worktree_path'${NC}"
        fi
    fi

    # List encrypted files
    echo ""
    echo "Encrypted paths (from .gitattributes):"
    if [[ -f ".gitattributes" ]]; then
        grep "filter=git-crypt" .gitattributes 2>/dev/null | awk '{print "  " $1}' || echo "  (none found)"
    else
        echo "  (no .gitattributes file)"
    fi
}

# Main
case "${1:-}" in
    create)
        shift
        cmd_create "$@"
        ;;
    fix)
        shift
        cmd_fix "$@"
        ;;
    status)
        shift
        cmd_status "$@"
        ;;
    *)
        echo "git-crypt-worktree - Manage git worktrees in git-crypt repositories"
        echo ""
        echo "Usage:"
        echo "  $0 create <worktree-path> <branch-name>  Create worktree with git-crypt support"
        echo "  $0 fix <worktree-path>                   Fix git-crypt in existing worktree"
        echo "  $0 status [worktree-path]                Show git-crypt status"
        echo ""
        echo "Examples:"
        echo "  $0 create ../worktrees/feature-x feature/feature-x"
        echo "  $0 fix ../worktrees/feature-x"
        echo "  $0 status ../worktrees/feature-x"
        exit 1
        ;;
esac
