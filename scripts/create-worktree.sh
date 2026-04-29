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

# Source shared utilities (colors, logging, get_main_git_dir, is_git_crypt_encrypted)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Get the repository root (where this script is run from should be repo root)
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"

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
  3b. Symlinks .env from main repo (Varlock needs it for git-crypt unlock)
  4. Performs git reset --hard HEAD to checkout decrypted files

EOF
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
                if is_git_crypt_encrypted "$test_file"; then
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
# Verify project-level skill files are readable after worktree checkout
# Warns if any agent-prompt.md or SKILL.md files remain git-crypt encrypted
#######################################
verify_skill_readability() {
    local worktree_path="$1"
    local skills_dir="$worktree_path/.claude/skills"
    local encrypted_count=0
    local checked_count=0

    if [[ ! -d "$skills_dir" ]]; then
        return 0
    fi

    # Skip silently if xxd unavailable
    if ! command -v xxd >/dev/null 2>&1; then
        info "  xxd not available — skill readability check skipped"
        return 0
    fi

    while IFS= read -r -d '' skill_file; do
        checked_count=$((checked_count + 1))
        if is_git_crypt_encrypted "$skill_file"; then
            warn "Skill appears encrypted: ${skill_file#"$worktree_path/"}"
            encrypted_count=$((encrypted_count + 1))
        fi
    done < <(find "$skills_dir" \( -name "agent-prompt.md" -o -name "SKILL.md" \) -print0 2>/dev/null)

    if [[ $encrypted_count -gt 0 ]]; then
        # Auto-remedy: attempt git-crypt unlock if .env symlink is present
        if [[ -L "$worktree_path/.env" ]] || [[ -f "$worktree_path/.env" ]]; then
            info "  Attempting auto-unlock (git-crypt) in worktree..."
            local unlock_output
            if unlock_output=$(cd "$worktree_path" && varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"' 2>&1); then
                # Re-check after unlock
                encrypted_count=0
                while IFS= read -r -d '' skill_file; do
                    if is_git_crypt_encrypted "$skill_file"; then
                        encrypted_count=$((encrypted_count + 1))
                    fi
                done < <(find "$skills_dir" \( -name "agent-prompt.md" -o -name "SKILL.md" \) -print0 2>/dev/null)

                if [[ $encrypted_count -eq 0 ]]; then
                    success "  Auto-unlock succeeded — all skill files now readable"
                    return 0
                else
                    warn "  Auto-unlock ran but $encrypted_count file(s) still encrypted"
                fi
            else
                warn "  Auto-unlock failed: $unlock_output"
            fi
        fi

        echo ""
        warn "$encrypted_count of $checked_count skill file(s) are encrypted in this worktree."
        warn "Skills requiring git-crypt (e.g., /launchpad Stage 4 hive-mind-execution) will silently degrade."
        echo ""
        echo "To unlock:"
        echo "  cd $worktree_path"
        echo "  varlock run -- sh -c 'git-crypt unlock \"\${GIT_CRYPT_KEY_PATH/#\\~/$HOME}\"'"
        echo ""
    elif [[ $checked_count -gt 0 ]]; then
        success "  All $checked_count skill file(s) readable (git-crypt decryption verified)"
    fi
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
# Patch .mcp.json in worktree to use npx for skillsmith
#
# The main repo .mcp.json uses a local dist path that doesn't exist in
# worktrees (worktrees share the git history but not build artefacts).
# Worktrees use the published npm package instead — works on any machine
# without requiring a local build.
#
# @latest is intentional: worktrees are for feature development, not MCP
# server changes. Always using the latest published version is correct.
#
# NOTE: jq is guaranteed in Docker/CI (node:22-slim/Debian) but NOT on
# macOS developer machines. The command -v guard below is therefore
# essential, not just defensive.
#######################################
patch_mcp_json() {
    local worktree_path="$1"
    local mcp_json="$worktree_path/.mcp.json"

    if [[ ! -f "$mcp_json" ]]; then
        return 0
    fi

    if ! command -v jq >/dev/null 2>&1; then
        warn ".mcp.json found but jq is unavailable — skillsmith MCP entry not patched"
        echo "  Install jq (brew install jq) and re-run create-worktree.sh, or"
        echo "  manually set .mcp.json skillsmith entry to: npx -y @skillsmith/mcp-server"
        return 0
    fi

    # -r is load-bearing: returns "true"/"false" strings, not JSON booleans
    local has_skillsmith
    has_skillsmith=$(jq -r 'has("mcpServers") and (.mcpServers | has("skillsmith"))' "$mcp_json" 2>/dev/null || echo "false")
    # || echo "false" is intentional: safe with set -e — command substitution
    # suppresses errexit inside $(...); the fallback handles jq failures cleanly

    if [[ "$has_skillsmith" != "true" ]]; then
        return 0
    fi

    local tmp_file
    tmp_file=$(mktemp)
    trap 'rm -f "$tmp_file"' EXIT  # clean up on SIGINT/SIGTERM/EXIT

    # Use cat+redirect instead of mv to preserve original file permissions
    # (mktemp creates 0600; original .mcp.json is typically 0644)
    if jq '.mcpServers.skillsmith = {"command": "npx", "args": ["-y", "@skillsmith/mcp-server"]}' \
        "$mcp_json" > "$tmp_file" 2>/dev/null; then
        cat "$tmp_file" > "$mcp_json"
        rm -f "$tmp_file"
        trap - EXIT
        success "  Patched .mcp.json: skillsmith → npx (worktrees have no local dist)"
    else
        rm -f "$tmp_file"
        trap - EXIT
        warn "Failed to patch .mcp.json — skillsmith MCP may not connect in this worktree"
    fi
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
    info "Step 1: Creating worktree without checkout..."
    if [[ "$USE_EXISTING_BRANCH" == true ]]; then
        git worktree add --no-checkout "$worktree_path" "$branch_name"
    else
        git worktree add --no-checkout "$worktree_path" -b "$branch_name" "$base_branch"
    fi
    success "  Worktree created (without checkout)"

    # Step 2: Find worktree's gitdir
    info "Step 2: Locating worktree gitdir..."
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
    info "Step 3: Copying git-crypt keys..."
    local source_keys="$MAIN_GIT_DIR/git-crypt/keys"

    mkdir -p "$gitdir/git-crypt"
    cp -r "$source_keys" "$gitdir/git-crypt/"
    success "  Keys copied to worktree gitdir"

    # Step 3b: Symlink .env from main repo (Varlock needs it for git-crypt unlock)
    info "Step 3b: Symlinking .env from main repo..."
    if [[ -f "$REPO_ROOT/.env" ]]; then
        ln -sf "$REPO_ROOT/.env" "$worktree_path/.env"
        success "  .env symlinked from main repo"
    else
        warn "  No .env in main repo ($REPO_ROOT/.env) — Varlock commands will fail in this worktree"
    fi

    # Step 4: Checkout files with decryption
    info "Step 4: Checking out files (with decryption)..."
    (cd "$worktree_path" && git reset --hard HEAD)
    success "  Files checked out successfully"

    # Step 4b: Initialize submodules (docs/internal)
    if [[ -f "$worktree_path/.gitmodules" ]]; then
        info "Initializing submodules..."
        (cd "$worktree_path" && git submodule update --init 2>/dev/null) && \
            success "  Submodules initialized" || \
            warn "Submodule init failed (requires org access for private submodule)"
    fi

    # Step 4c: Verify project-level skill readability
    info "Step 4c: Verifying project-level skill readability..."
    verify_skill_readability "$worktree_path"

    # Step 4d: Symlink node_modules so host-side pre-commit hooks resolve
    # lint-staged, eslint, prettier, and check-file-length.mjs (SMI-4377).
    # Hook discovery (Layer 1) is handled by the committed .husky/_/ tree.
    # SMI-4381 also symlinks per-package node_modules so workspace-pinned
    # deps (e.g. zod@3.25.76 in packages/mcp-server) resolve correctly when
    # tsc runs from the worktree path inside Docker — without these, Node
    # walks up to the hoisted root node_modules and finds the wrong version.
    info "Step 4d: Symlinking node_modules from main repo (SMI-4377 + SMI-4381)..."
    assert_host_node_modules "$REPO_ROOT"
    if link_worktree_node_modules "$worktree_path" "$REPO_ROOT"; then
        success "  node_modules → $REPO_ROOT/node_modules"
    fi
    link_worktree_package_node_modules "$worktree_path" "$REPO_ROOT"
    success "  per-package node_modules → $REPO_ROOT/packages/*/node_modules"

    # Step 5: Generate Docker override file (if docker-compose.yml exists)
    if [[ -f "$worktree_path/docker-compose.yml" ]]; then
        info "Step 5: Generating Docker override file..."
        generate_docker_override "$worktree_path" "$branch_name"
        success "  Docker override file created"
    else
        info "Step 5: Skipping Docker setup (no docker-compose.yml found)"
    fi

    # Step 6: Patch .mcp.json skillsmith entry for worktree compatibility
    info "Step 6: Patching .mcp.json (skillsmith → npx)..."
    patch_mcp_json "$worktree_path"

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
    echo ""
    echo "Pre-commit hooks: active (SMI-4377)"
    echo "  - Hook discovery: .husky/_/ is tracked in main repo (inherited via checkout)"
    echo "  - Host tooling: node_modules symlinked to main repo"
    echo "  - Typecheck: runs on host tsc when invoked from worktree (Docker bind-mount doesn't cover .worktrees/)"
    echo ""
    echo "Note: existing worktrees need a one-time manual fix if skillsmith MCP fails:"
    echo "  Edit .mcp.json: set skillsmith command to 'npx', args to ['-y', '@skillsmith/mcp-server']"
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

    # Idempotent backfill: ensure all existing worktrees have node_modules
    # symlinks (SMI-4377 root) + per-package symlinks (SMI-4381). The
    # newly-created worktree is a no-op for these.
    echo ""
    info "Step 7: Backfilling node_modules symlinks on existing worktrees (SMI-4377 + SMI-4381)..."
    repair_worktrees_node_modules "$REPO_ROOT"
    repair_worktrees_package_node_modules "$REPO_ROOT"
}

# Run main function
main "$@"
