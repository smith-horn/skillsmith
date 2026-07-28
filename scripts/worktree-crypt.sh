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

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# SMI-5702: colors, logging (error/warn/info/success), and get_main_git_dir
# now come from the shared _lib.sh instead of this file's own duplicated
# copies — also brings in ensure_git_crypt_filter_registered(), the actual
# fix for `cmd_fix` (see below).
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Get the repository root
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"

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
#
# SMI-5702: delegates to _lib.sh's has_git_crypt_magic_header() (the
# canonical consolidation of this file's former inline grep check, _lib.sh's
# old xxd-based is_git_crypt_encrypted(), and _rebase-git-crypt.sh's inline
# head+tr check).
#######################################
is_file_decrypted() {
    local file="$1"
    [[ -f "$file" ]] || return 1  # missing file: not readable, same as before
    ! has_git_crypt_magic_header "$file"  # readable == NOT carrying the magic header
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
    info "Step 1/3: Copying git-crypt keys..."
    mkdir -p "$gitdir/git-crypt"
    cp -r "$source_keys" "$gitdir/git-crypt/"
    success "  Keys copied to worktree gitdir"

    # SMI-5702: this is what actually breaks the fix-loop the plan describes
    # -- cmd_fix previously never touched filter config at all, so a
    # MISSING/HALF/FOREIGN filter.git-crypt registration survived a `fix`
    # run untouched and `git checkout -- .` below hard-errored under
    # `set -euo pipefail` in the MISSING state (a dead end for anything
    # re-running `fix` hoping it would self-correct).
    info "Step 2/3: Verifying git-crypt filter registration..."
    ensure_git_crypt_filter_registered "$worktree_path"

    # Re-checkout files
    info "Step 3/3: Re-checking out encrypted files..."
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

    # Find an encrypted file to test.
    #
    # SMI-5702: was its own hand-rolled pattern derivation
    # (`sed 's/\*\*//' | sed 's/^\///'`), which strips the trailing `**` but
    # leaves a trailing `/` — `find -path "*<pattern>" -type f` can then
    # never match, since no file path ends in `/`. Confirmed broken live
    # against this repo's own `.gitattributes` shape
    # (`supabase/functions/** filter=git-crypt`) during this plan's
    # verification: `cmd_fix` genuinely repaired a corrupted worktree, but
    # this derivation still reported "NEEDS FIX" because it never found a
    # test file to check in the first place. find_encrypted_test_file()
    # (scripts/_lib.sh) is the canonical, correctly-matching replacement.
    local encrypted_file=""
    encrypted_file=$(find_encrypted_test_file "$worktree_path" || echo "")

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
