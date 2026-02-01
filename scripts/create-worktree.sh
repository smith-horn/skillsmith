#!/usr/bin/env bash
#
# create-worktree.sh - Create git worktrees with git-crypt support
#
# This script automates the creation of git worktrees for repositories
# that use git-crypt encryption. It properly copies git-crypt keys to
# the worktree's gitdir so encrypted files can be read.
#
# Usage: ./scripts/create-worktree.sh <worktree-path> <branch-name> [base-branch]
#
# SMI-1822: Git-crypt worktree automation

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the repository root (where this script is run from should be repo root)
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"

# Get the actual .git directory (handles worktrees where .git is a file)
get_main_git_dir() {
    local repo_root="$1"
    local git_path="$repo_root/.git"

    if [[ -f "$git_path" ]]; then
        # We're in a worktree - .git is a file pointing to the gitdir
        local worktree_gitdir
        worktree_gitdir=$(sed 's/gitdir: //' "$git_path")

        # Handle relative paths
        if [[ ! "$worktree_gitdir" = /* ]]; then
            worktree_gitdir="$repo_root/$worktree_gitdir"
        fi

        # Normalize and find the main .git directory
        # Worktree gitdirs are typically at: main_repo/.git/worktrees/<name>
        # We need to go up to main_repo/.git
        worktree_gitdir=$(cd "$worktree_gitdir" 2>/dev/null && pwd)

        # The main .git dir is the parent of "worktrees" directory
        if [[ "$worktree_gitdir" == */.git/worktrees/* ]]; then
            echo "${worktree_gitdir%/worktrees/*}"
        else
            # Fallback: try to find commondir
            if [[ -f "$worktree_gitdir/commondir" ]]; then
                local commondir
                commondir=$(cat "$worktree_gitdir/commondir")
                if [[ ! "$commondir" = /* ]]; then
                    commondir="$worktree_gitdir/$commondir"
                fi
                cd "$commondir" 2>/dev/null && pwd
            else
                echo "$worktree_gitdir"
            fi
        fi
    elif [[ -d "$git_path" ]]; then
        # Normal repository - .git is a directory
        echo "$git_path"
    else
        echo ""
    fi
}

# The main .git directory (may differ from REPO_ROOT/.git if in worktree)
MAIN_GIT_DIR=""

#######################################
# Print usage information
#######################################
usage() {
    cat << EOF
Usage: $(basename "$0") <worktree-path> <branch-name> [base-branch]

Create a git worktree with git-crypt support for encrypted repositories.

Arguments:
  worktree-path   Path where the worktree will be created (relative or absolute)
  branch-name     Name of the new branch to create
  base-branch     Base branch to create from (default: main)

Options:
  -h, --help      Show this help message and exit

Examples:
  $(basename "$0") worktrees/my-feature feature/my-feature
  $(basename "$0") ../worktrees/bugfix fix/issue-123 develop
  $(basename "$0") /absolute/path/worktree feature/new-thing main

Requirements:
  - Must be run from within a git repository
  - git-crypt must be unlocked in the main repository first
  - The worktree path's parent directory must exist

Process:
  1. Creates worktree without checkout (avoids encrypted file issues)
  2. Locates the worktree's gitdir from .git file
  3. Copies git-crypt keys from main repo to worktree gitdir
  4. Performs git reset --hard HEAD to checkout decrypted files

EOF
}

#######################################
# Print error message and exit
#######################################
error() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

#######################################
# Print warning message
#######################################
warn() {
    echo -e "${YELLOW}Warning: $1${NC}" >&2
}

#######################################
# Print info message
#######################################
info() {
    echo -e "${BLUE}$1${NC}"
}

#######################################
# Print success message
#######################################
success() {
    echo -e "${GREEN}$1${NC}"
}

#######################################
# Check if git-crypt is unlocked
#######################################
check_git_crypt_unlocked() {
    local git_crypt_dir="$MAIN_GIT_DIR/git-crypt"
    local keys_dir="$git_crypt_dir/keys"

    # Check if git-crypt directory exists
    if [[ ! -d "$git_crypt_dir" ]]; then
        error "git-crypt directory not found at $git_crypt_dir

This repository may not use git-crypt, or git-crypt has never been initialized.
If the repository uses git-crypt, run 'git-crypt unlock' first."
    fi

    # Check if keys directory exists and has content
    if [[ ! -d "$keys_dir" ]] || [[ -z "$(ls -A "$keys_dir" 2>/dev/null)" ]]; then
        error "git-crypt keys not found. The repository appears to be locked.

Please unlock git-crypt in the main repository first:
  varlock run -- sh -c 'git-crypt unlock \"\${GIT_CRYPT_KEY_PATH/#\\~/$HOME}\"'

Or if you have the key path directly:
  git-crypt unlock /path/to/your/key"
    fi

    # Additional check: try to verify an encrypted file is readable
    # Look for a .gitattributes that defines encrypted patterns
    if [[ -f "$REPO_ROOT/.gitattributes" ]]; then
        local encrypted_pattern
        encrypted_pattern=$(grep -E 'filter=git-crypt' "$REPO_ROOT/.gitattributes" 2>/dev/null | head -1 | awk '{print $1}' || echo "")

        if [[ -n "$encrypted_pattern" ]]; then
            # Find a file matching the pattern and check if it's readable text
            local test_file
            test_file=$(find "$REPO_ROOT" -path "*/$encrypted_pattern" -type f 2>/dev/null | head -1 || echo "")

            if [[ -n "$test_file" ]] && [[ -f "$test_file" ]]; then
                # Check if file starts with git-crypt binary header
                if head -c 10 "$test_file" 2>/dev/null | grep -q "GITCRYPT"; then
                    error "git-crypt appears to be locked. Found encrypted file: $test_file

Please unlock git-crypt first:
  varlock run -- sh -c 'git-crypt unlock \"\${GIT_CRYPT_KEY_PATH/#\\~/$HOME}\"'"
                fi
            fi
        fi
    fi

    success "git-crypt is unlocked in main repository"
}

#######################################
# Validate arguments
#######################################
validate_args() {
    if [[ -z "${WORKTREE_PATH:-}" ]]; then
        error "Missing required argument: worktree-path

Run '$(basename "$0") --help' for usage information."
    fi

    if [[ -z "${BRANCH_NAME:-}" ]]; then
        error "Missing required argument: branch-name

Run '$(basename "$0") --help' for usage information."
    fi

    # Convert to absolute path if relative
    if [[ ! "$WORKTREE_PATH" = /* ]]; then
        WORKTREE_PATH="$REPO_ROOT/$WORKTREE_PATH"
    fi

    # Check if worktree already exists
    if [[ -d "$WORKTREE_PATH" ]]; then
        error "Worktree path already exists: $WORKTREE_PATH

If you want to recreate it, remove it first with:
  git worktree remove $WORKTREE_PATH"
    fi

    # Check if parent directory exists
    local parent_dir
    parent_dir="$(dirname "$WORKTREE_PATH")"
    if [[ ! -d "$parent_dir" ]]; then
        info "Creating parent directory: $parent_dir"
        mkdir -p "$parent_dir"
    fi

    # Check if branch already exists
    if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
        warn "Branch '$BRANCH_NAME' already exists. Will use existing branch."
        USE_EXISTING_BRANCH=true
    else
        USE_EXISTING_BRANCH=false
    fi
}

#######################################
# Generate Docker override file for worktree
# Creates unique container names and ports
#######################################
generate_docker_override() {
    local worktree_path="$1"
    local branch_name="$2"

    # Extract a short name from branch (e.g., feature/jwt-rollout -> jwt-rollout)
    local worktree_name
    worktree_name=$(basename "$branch_name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')

    # Calculate port offset based on hash of worktree name (1-99)
    local port_offset
    port_offset=$(echo -n "$worktree_name" | cksum | awk '{print ($1 % 99) + 1}')

    # Base ports: dev=3001, test=3002, orchestrator=3003
    # Offset ports for worktree
    local dev_app_port=$((3000 + port_offset * 10))
    local dev_mcp_port=$((3000 + port_offset * 10 + 1))
    local test_port=$((3000 + port_offset * 10 + 2))
    local orchestrator_port=$((3000 + port_offset * 10 + 3))

    cat > "$worktree_path/docker-compose.override.yml" << EOF
# Worktree-specific overrides (auto-generated by create-worktree.sh)
# Container names and ports must be unique per worktree
# Worktree: $branch_name
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

services:
  dev:
    container_name: ${worktree_name}-dev-1
    ports:
      - "${dev_app_port}:3000"   # Main app
      - "${dev_mcp_port}:3001"   # MCP server

  test:
    container_name: ${worktree_name}-test-1
    ports:
      - "${test_port}:3000"      # Test app

  orchestrator:
    container_name: ${worktree_name}-orchestrator-1
    ports:
      - "${orchestrator_port}:3000"  # Orchestrator
EOF
}

#######################################
# Create worktree with git-crypt support
#######################################
create_worktree() {
    local worktree_path="$1"
    local branch_name="$2"
    local base_branch="${3:-main}"

    info "Creating worktree at: $worktree_path"
    info "Branch: $branch_name (based on: $base_branch)"
    echo ""

    # Step 1: Create worktree without checkout
    info "Step 1/4: Creating worktree without checkout..."
    if [[ "$USE_EXISTING_BRANCH" == true ]]; then
        git worktree add --no-checkout "$worktree_path" "$branch_name"
    else
        git worktree add --no-checkout "$worktree_path" -b "$branch_name" "$base_branch"
    fi
    success "  Worktree created (without checkout)"

    # Step 2: Find worktree's gitdir
    info "Step 2/4: Locating worktree gitdir..."
    local git_file="$worktree_path/.git"
    if [[ ! -f "$git_file" ]]; then
        error "Could not find .git file in worktree at $git_file"
    fi

    # Parse the gitdir path from the .git file
    local gitdir
    gitdir=$(sed 's/gitdir: //' "$git_file")

    # Handle relative paths
    if [[ ! "$gitdir" = /* ]]; then
        gitdir="$worktree_path/$gitdir"
    fi

    # Normalize the path
    gitdir=$(cd "$gitdir" 2>/dev/null && pwd)

    if [[ ! -d "$gitdir" ]]; then
        error "Could not locate gitdir at: $gitdir"
    fi
    success "  Found gitdir: $gitdir"

    # Step 3: Copy git-crypt keys
    info "Step 3/4: Copying git-crypt keys..."
    local source_keys="$MAIN_GIT_DIR/git-crypt/keys"
    local dest_keys="$gitdir/git-crypt/keys"

    mkdir -p "$gitdir/git-crypt"
    cp -r "$source_keys" "$gitdir/git-crypt/"
    success "  Keys copied to worktree gitdir"

    # Step 4: Checkout files with decryption
    info "Step 4/4: Checking out files (with decryption)..."
    (cd "$worktree_path" && git reset --hard HEAD)
    success "  Files checked out successfully"

    # Step 5: Generate Docker override file (if docker-compose.yml exists)
    if [[ -f "$worktree_path/docker-compose.yml" ]]; then
        info "Step 5/5: Generating Docker override file..."
        generate_docker_override "$worktree_path" "$branch_name"
        success "  Docker override file created"
    else
        info "Step 5/5: Skipping Docker setup (no docker-compose.yml found)"
    fi

    echo ""
    success "Worktree created successfully!"
    echo ""
    echo "Worktree location: $worktree_path"
    echo "Branch: $branch_name"
    echo ""
    echo "To start working:"
    echo "  cd $worktree_path"
    if [[ -f "$worktree_path/docker-compose.override.yml" ]]; then
        echo ""
        echo "To start Docker in this worktree:"
        echo "  cd $worktree_path && docker compose --profile dev up -d"
    fi
}

#######################################
# Main entry point
#######################################
main() {
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                usage
                exit 0
                ;;
            -*)
                error "Unknown option: $1

Run '$(basename "$0") --help' for usage information."
                ;;
            *)
                break
                ;;
        esac
    done

    # Assign positional arguments
    WORKTREE_PATH="${1:-}"
    BRANCH_NAME="${2:-}"
    BASE_BRANCH="${3:-main}"
    USE_EXISTING_BRANCH=false

    # Validate we're in a git repository
    if [[ -z "$REPO_ROOT" ]]; then
        error "Not in a git repository. Please run from within a git repository."
    fi

    # Find the main .git directory (handles worktrees)
    MAIN_GIT_DIR=$(get_main_git_dir "$REPO_ROOT")
    if [[ -z "$MAIN_GIT_DIR" ]] || [[ ! -d "$MAIN_GIT_DIR" ]]; then
        error "Could not locate .git directory."
    fi

    info "Repository root: $REPO_ROOT"
    if [[ "$MAIN_GIT_DIR" != "$REPO_ROOT/.git" ]]; then
        info "Main git directory: $MAIN_GIT_DIR (running from worktree)"
    fi
    echo ""

    # Run validation and checks
    check_git_crypt_unlocked
    echo ""
    validate_args
    echo ""

    # Create the worktree
    create_worktree "$WORKTREE_PATH" "$BRANCH_NAME" "$BASE_BRANCH"
}

# Run main function
main "$@"
