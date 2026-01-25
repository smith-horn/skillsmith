#!/usr/bin/env bash
#
# worktree-crypt.sh - Git worktree helper for encrypted repositories
#
# This script provides commands for working with git worktrees in repositories
# that use git-crypt encryption. It wraps create-worktree.sh and adds
# fix/status commands.
#
# Usage:
#   ./scripts/worktree-crypt.sh create <worktree-path> <branch-name> [base-branch]
#   ./scripts/worktree-crypt.sh fix <worktree-path>
#   ./scripts/worktree-crypt.sh status <worktree-path>
#
# SMI-1824: Worktree manager skill git-crypt documentation update

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Get the repository root
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

MAIN_GIT_DIR=""

#######################################
# Print usage information
#######################################
usage() {
    cat << EOF
Usage: $(basename "$0") <command> [arguments]

Commands:
  create <worktree-path> <branch-name> [base-branch]
      Create a new worktree with git-crypt support
      (Wrapper for create-worktree.sh)

  fix <worktree-path>
      Fix an existing worktree that has encrypted files showing as binary.
      Copies git-crypt keys and re-checks out files.

  status <worktree-path>
      Check the encryption status of a worktree.
      Shows whether encrypted files are readable.

Options:
  -h, --help    Show this help message

Examples:
  $(basename "$0") create ../worktrees/my-feature feature/my-feature
  $(basename "$0") fix ../worktrees/my-feature
  $(basename "$0") status ../worktrees/my-feature

EOF
}

#######################################
# Print messages
#######################################
error() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

warn() {
    echo -e "${YELLOW}Warning: $1${NC}" >&2
}

info() {
    echo -e "${BLUE}$1${NC}"
}

success() {
    echo -e "${GREEN}$1${NC}"
}

#######################################
# Validate worktree path exists
#######################################
validate_worktree_path() {
    local worktree_path="$1"

    # Convert to absolute path if relative
    if [[ ! "$worktree_path" = /* ]]; then
        worktree_path="$REPO_ROOT/$worktree_path"
    fi

    if [[ ! -d "$worktree_path" ]]; then
        error "Worktree path does not exist: $worktree_path"
    fi

    if [[ ! -f "$worktree_path/.git" ]]; then
        error "Not a git worktree (no .git file): $worktree_path"
    fi

    echo "$worktree_path"
}

#######################################
# Get worktree gitdir from .git file
#######################################
get_worktree_gitdir() {
    local worktree_path="$1"
    local git_file="$worktree_path/.git"

    local gitdir
    gitdir=$(sed 's/gitdir: //' "$git_file")

    # Handle relative paths
    if [[ ! "$gitdir" = /* ]]; then
        gitdir="$worktree_path/$gitdir"
    fi

    # Normalize the path
    if [[ -d "$gitdir" ]]; then
        gitdir=$(cd "$gitdir" 2>/dev/null && pwd)
        echo "$gitdir"
    else
        echo ""
    fi
}

#######################################
# Check if an encrypted file is readable
#######################################
is_file_decrypted() {
    local file="$1"

    if [[ ! -f "$file" ]]; then
        return 1
    fi

    # Check if file starts with git-crypt binary header
    if head -c 10 "$file" 2>/dev/null | grep -q "GITCRYPT"; then
        return 1  # Still encrypted
    fi

    return 0  # Decrypted (readable)
}

#######################################
# Command: create
#######################################
cmd_create() {
    local worktree_path="${1:-}"
    local branch_name="${2:-}"
    local base_branch="${3:-main}"

    if [[ -z "$worktree_path" ]] || [[ -z "$branch_name" ]]; then
        error "Usage: $(basename "$0") create <worktree-path> <branch-name> [base-branch]"
    fi

    # Delegate to create-worktree.sh
    local create_script="$SCRIPT_DIR/create-worktree.sh"
    if [[ ! -x "$create_script" ]]; then
        error "create-worktree.sh not found or not executable at: $create_script"
    fi

    exec "$create_script" "$worktree_path" "$branch_name" "$base_branch"
}

#######################################
# Command: fix
#######################################
cmd_fix() {
    local worktree_path="${1:-}"

    if [[ -z "$worktree_path" ]]; then
        error "Usage: $(basename "$0") fix <worktree-path>"
    fi

    # Validate and get absolute path
    worktree_path=$(validate_worktree_path "$worktree_path")

    info "Fixing git-crypt in worktree: $worktree_path"
    echo ""

    # Get worktree gitdir
    local gitdir
    gitdir=$(get_worktree_gitdir "$worktree_path")
    if [[ -z "$gitdir" ]]; then
        error "Could not locate gitdir for worktree"
    fi

    info "Worktree gitdir: $gitdir"

    # Check if keys already exist
    local source_keys="$MAIN_GIT_DIR/git-crypt/keys"
    local dest_keys="$gitdir/git-crypt/keys"

    if [[ ! -d "$source_keys" ]]; then
        error "git-crypt keys not found in main repo at: $source_keys

Please unlock git-crypt in the main repository first:
  cd $REPO_ROOT
  varlock run -- sh -c 'git-crypt unlock \"\${GIT_CRYPT_KEY_PATH/#\\~/$HOME}\"'"
    fi

    # Copy keys
    info "Step 1/2: Copying git-crypt keys..."
    mkdir -p "$gitdir/git-crypt"
    cp -r "$source_keys" "$gitdir/git-crypt/"
    success "  Keys copied to worktree gitdir"

    # Re-checkout files
    info "Step 2/2: Re-checking out encrypted files..."
    (cd "$worktree_path" && git checkout -- .)
    success "  Files re-checked out"

    echo ""

    # Verify fix worked
    cmd_status "$worktree_path" --quiet
}

#######################################
# Command: status
#######################################
cmd_status() {
    local worktree_path="${1:-}"
    local quiet="${2:-}"

    if [[ -z "$worktree_path" ]]; then
        error "Usage: $(basename "$0") status <worktree-path>"
    fi

    # Validate and get absolute path
    worktree_path=$(validate_worktree_path "$worktree_path")

    if [[ -z "$quiet" ]]; then
        info "Checking git-crypt status in worktree: $worktree_path"
        echo ""
    fi

    # Get worktree gitdir
    local gitdir
    gitdir=$(get_worktree_gitdir "$worktree_path")

    # Check if keys exist in worktree gitdir
    local has_keys=false
    if [[ -d "$gitdir/git-crypt/keys" ]] && [[ -n "$(ls -A "$gitdir/git-crypt/keys" 2>/dev/null)" ]]; then
        has_keys=true
    fi

    # Find an encrypted file to test
    local encrypted_file=""
    if [[ -f "$worktree_path/.gitattributes" ]]; then
        local pattern
        pattern=$(grep -E 'filter=git-crypt' "$worktree_path/.gitattributes" 2>/dev/null | head -1 | awk '{print $1}' | sed 's/\*\*//' | sed 's/^\///' || echo "")

        if [[ -n "$pattern" ]]; then
            encrypted_file=$(find "$worktree_path" -path "*$pattern" -type f 2>/dev/null | head -1 || echo "")
        fi
    fi

    # Check if encrypted file is readable
    local files_readable=false
    if [[ -n "$encrypted_file" ]] && [[ -f "$encrypted_file" ]]; then
        if is_file_decrypted "$encrypted_file"; then
            files_readable=true
        fi
    fi

    # Report status
    if [[ -z "$quiet" ]]; then
        echo "Worktree: $worktree_path"
        echo "Gitdir: $gitdir"
        echo ""

        if [[ "$has_keys" == true ]]; then
            success "Keys: Present in worktree gitdir"
        else
            warn "Keys: NOT found in worktree gitdir"
        fi

        if [[ -n "$encrypted_file" ]]; then
            if [[ "$files_readable" == true ]]; then
                success "Encrypted files: Readable (decrypted)"
                echo "  Test file: $encrypted_file"
            else
                echo -e "${RED}Encrypted files: Still encrypted (binary)${NC}"
                echo "  Test file: $encrypted_file"
            fi
        else
            warn "Encrypted files: Could not find test file"
        fi

        echo ""

        if [[ "$has_keys" == true ]] && [[ "$files_readable" == true ]]; then
            success "Status: OK - Worktree is properly configured"
        elif [[ "$has_keys" == true ]] && [[ "$files_readable" == false ]]; then
            warn "Status: Keys present but files still encrypted"
            echo ""
            echo "Try running: $(basename "$0") fix $worktree_path"
        else
            echo -e "${RED}Status: Keys missing - worktree needs fixing${NC}"
            echo ""
            echo "Run: $(basename "$0") fix $worktree_path"
        fi
    else
        # Quiet mode - just show success/failure
        if [[ "$has_keys" == true ]] && [[ "$files_readable" == true ]]; then
            success "Worktree git-crypt status: OK"
        else
            error "Worktree git-crypt status: NEEDS FIX"
        fi
    fi
}

#######################################
# Main entry point
#######################################
main() {
    # Check for help flag
    if [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
        usage
        exit 0
    fi

    # Get command
    local command="${1:-}"
    shift || true

    if [[ -z "$command" ]]; then
        usage
        exit 1
    fi

    # Validate we're in a git repository
    if [[ -z "$REPO_ROOT" ]]; then
        error "Not in a git repository. Please run from within a git repository."
    fi

    # Find the main .git directory
    MAIN_GIT_DIR=$(get_main_git_dir "$REPO_ROOT")
    if [[ -z "$MAIN_GIT_DIR" ]] || [[ ! -d "$MAIN_GIT_DIR" ]]; then
        error "Could not locate .git directory."
    fi

    # Run command
    case "$command" in
        create)
            cmd_create "$@"
            ;;
        fix)
            cmd_fix "$@"
            ;;
        status)
            cmd_status "$@"
            ;;
        *)
            error "Unknown command: $command

Run '$(basename "$0") --help' for usage information."
            ;;
    esac
}

# Run main function
main "$@"
