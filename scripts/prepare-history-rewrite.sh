#!/usr/bin/env bash
#
# prepare-history-rewrite.sh - Prepare for git history rewrite (SMI-2138)
#
# This script performs all pre-flight checks and creates a verified backup
# before a git history rewrite using BFG Repo-Cleaner. It does NOT execute
# the actual rewrite -- only validates readiness and creates a backup.
#
# Usage: ./scripts/prepare-history-rewrite.sh [--dry-run] [--skip-backup]
#
# SMI-2138: History rewrite preparation for go-public

set -euo pipefail

# Colors for output (matches create-worktree.sh style)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Script configuration
BACKUP_DIR="${BACKUP_DIR:-$(pwd)}"
DRY_RUN=false
SKIP_BACKUP=false
READY=true
WARNINGS=0
ERRORS=0

#######################################
# Print usage information
#######################################
usage() {
    cat << 'EOF'
Usage: prepare-history-rewrite.sh [OPTIONS]

Prepare for git history rewrite by validating prerequisites, creating a
verified backup, and producing a summary of affected files. This script
does NOT execute the actual rewrite.

Options:
  --dry-run       Show what would be done without creating a backup
  --skip-backup   Skip the backup step (use if backup already exists)
  --backup-dir    Directory to store the backup (default: current directory)
  -h, --help      Show this help message and exit

Environment:
  BACKUP_DIR      Override default backup directory

Prerequisites:
  - BFG Repo-Cleaner (bfg) must be installed
  - gh CLI must be installed and authenticated
  - Must be run from within the skillsmith git repository
  - No uncommitted changes allowed

Process:
  1. Verify BFG is installed and accessible
  2. Verify repository state (clean working tree, correct remote)
  3. Create full --mirror backup with integrity verification
  4. Audit files: list unencrypted files that need history cleaning
  5. Check for open PRs that would be affected
  6. Check for active worktrees that must be removed first
  7. Output readiness summary

Output:
  READY TO REWRITE    All checks passed, backup verified
  NOT READY           One or more blocking issues found

EOF
}

#######################################
# Logging helpers
#######################################
error() {
    echo -e "${RED}ERROR: $1${NC}" >&2
    ERRORS=$((ERRORS + 1))
    READY=false
}

warn() {
    echo -e "${YELLOW}WARNING: $1${NC}" >&2
    WARNINGS=$((WARNINGS + 1))
}

info() {
    echo -e "${BLUE}$1${NC}"
}

success() {
    echo -e "${GREEN}$1${NC}"
}

header() {
    echo ""
    echo -e "${BOLD}=== $1 ===${NC}"
    echo ""
}

#######################################
# Check: BFG Repo-Cleaner is installed
#######################################
check_bfg() {
    header "Step 1/6: Checking BFG Repo-Cleaner"

    # Try bfg command directly
    if command -v bfg &>/dev/null; then
        local bfg_version
        bfg_version=$(bfg --version 2>&1 | head -1 || echo "unknown")
        success "  BFG found: $bfg_version"
        return 0
    fi

    # Try as a Java jar (common Homebrew / manual install)
    local jar_locations=(
        "/usr/local/share/bfg/bfg.jar"
        "/opt/homebrew/share/bfg/bfg.jar"
        "$HOME/bin/bfg.jar"
        "$HOME/.local/share/bfg/bfg.jar"
    )

    for jar in "${jar_locations[@]}"; do
        if [[ -f "$jar" ]]; then
            success "  BFG jar found: $jar"
            return 0
        fi
    done

    error "BFG Repo-Cleaner not found.

Install via Homebrew:
  brew install bfg

Or download the jar from:
  https://rtyley.github.io/bfg-repo-cleaner/"
}

#######################################
# Check: Repository state is clean
#######################################
check_repo_state() {
    header "Step 2/6: Checking repository state"

    # Verify we are in a git repo
    local repo_root
    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
    if [[ -z "$repo_root" ]]; then
        error "Not in a git repository."
        return 1
    fi
    success "  Repository root: $repo_root"

    # Verify remote exists
    local remote_url
    remote_url="$(git remote get-url origin 2>/dev/null || echo "")"
    if [[ -z "$remote_url" ]]; then
        error "No 'origin' remote configured."
        return 1
    fi
    success "  Remote origin: $remote_url"

    # Verify the remote points to smith-horn/skillsmith
    if ! echo "$remote_url" | grep -qi "smith-horn/skillsmith"; then
        error "Remote does not appear to be smith-horn/skillsmith: $remote_url"
        return 1
    fi
    success "  Remote matches expected repository"

    # Check for uncommitted changes (excluding smudge filter artifacts)
    local dirty_count
    dirty_count=$(git status --porcelain 2>/dev/null | grep -cv '^$' || echo "0")
    if [[ "$dirty_count" -gt 0 ]]; then
        # Check if all dirty files are smudge filter artifacts (binary diffs on encrypted files)
        local real_changes
        real_changes=$(git status --porcelain 2>/dev/null | grep -v '^\?\?' | grep -cv '^$' || echo "0")
        if [[ "$real_changes" -gt 0 ]]; then
            warn "Working tree has $real_changes uncommitted change(s)."
            warn "Review with: git status"
            warn "Git-crypt smudge artifacts are expected and can be ignored."
        fi
    else
        success "  Working tree is clean"
    fi

    # Verify gh CLI is available
    if ! command -v gh &>/dev/null; then
        error "gh CLI not found. Install: brew install gh"
        return 1
    fi
    success "  gh CLI found"

    # Verify gh is authenticated
    if ! gh auth status &>/dev/null 2>&1; then
        error "gh CLI not authenticated. Run: gh auth login"
        return 1
    fi
    success "  gh CLI authenticated"
}

#######################################
# Create mirror backup with integrity check
#######################################
create_backup() {
    header "Step 3/6: Creating mirror backup"

    if [[ "$SKIP_BACKUP" == true ]]; then
        info "  Skipping backup (--skip-backup)"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        info "  [DRY RUN] Would create mirror backup in: $BACKUP_DIR"
        info "  [DRY RUN] Command: git clone --mirror <remote-url> skillsmith-backup-YYYYMMDD.git"
        return 0
    fi

    local remote_url
    remote_url="$(git remote get-url origin 2>/dev/null)"
    local date_stamp
    date_stamp="$(date +%Y%m%d)"
    local backup_name="skillsmith-backup-${date_stamp}.git"
    local backup_path="${BACKUP_DIR}/${backup_name}"

    # Check if backup already exists
    if [[ -d "$backup_path" ]]; then
        warn "Backup already exists at: $backup_path"
        warn "Remove it first or use --skip-backup to skip."
        READY=false
        return 1
    fi

    info "  Cloning mirror to: $backup_path"
    info "  This may take several minutes..."
    echo ""

    # Use git clone --mirror (no shell interpolation risk -- variables are not user-supplied)
    if git clone --mirror "$remote_url" "$backup_path"; then
        success "  Mirror clone complete"
    else
        error "Mirror clone failed."
        return 1
    fi

    # Verify backup integrity
    info "  Verifying backup integrity with git fsck..."
    if (cd "$backup_path" && git fsck --full --no-dangling 2>&1); then
        success "  Backup integrity verified (git fsck --full passed)"
    else
        error "Backup integrity check failed! Do NOT proceed with history rewrite."
        return 1
    fi

    # Show backup size
    local backup_size
    backup_size=$(du -sh "$backup_path" 2>/dev/null | cut -f1)
    success "  Backup size: $backup_size"
    success "  Backup location: $backup_path"
}

#######################################
# Audit unencrypted files in history
#######################################
audit_files() {
    header "Step 4/6: Auditing unencrypted files"

    info "  Running git-crypt status to identify unencrypted files..."
    echo ""

    # Count unencrypted files by top-level directory
    local status_output
    if ! status_output=$(git-crypt status 2>&1); then
        warn "git-crypt status returned an error (repository may be locked)."
        warn "Output: $status_output"
        return 0
    fi

    # Extract and summarize "not encrypted" files
    local not_encrypted_count
    not_encrypted_count=$(echo "$status_output" | grep -c "not encrypted" || echo "0")

    if [[ "$not_encrypted_count" -eq 0 ]]; then
        success "  No unencrypted files found in tracked paths."
        return 0
    fi

    info "  Files marked 'not encrypted' by directory:"
    echo ""
    echo "$status_output" | grep "not encrypted" | awk -F/ '{print $1}' | sort | uniq -c | sort -rn | while read -r line; do
        echo "    $line"
    done
    echo ""

    info "  Total unencrypted files: $not_encrypted_count"
    echo ""

    # List detailed file paths (first 50)
    info "  Unencrypted file listing (first 50):"
    echo ""
    echo "$status_output" | grep "not encrypted" | head -50 | while read -r line; do
        echo "    $line"
    done

    local remaining=$((not_encrypted_count - 50))
    if [[ "$remaining" -gt 0 ]]; then
        echo "    ... and $remaining more"
    fi

    echo ""
    info "  These are the files that exist OUTSIDE git-crypt encryption."
    info "  Review this list to determine which need removal from history."
    info "  Full output: git-crypt status 2>&1 | grep 'not encrypted'"
}

#######################################
# Check for open pull requests
#######################################
check_open_prs() {
    header "Step 5/6: Checking open pull requests"

    if [[ "$DRY_RUN" == true ]]; then
        info "  [DRY RUN] Would check for open PRs via gh CLI"
        return 0
    fi

    local pr_list
    pr_list=$(gh pr list --state open --json number,title,headRefName,author --limit 50 2>/dev/null || echo "")

    if [[ -z "$pr_list" ]] || [[ "$pr_list" == "[]" ]]; then
        success "  No open pull requests found."
        return 0
    fi

    local pr_count
    pr_count=$(echo "$pr_list" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

    if [[ "$pr_count" -gt 0 ]]; then
        warn "Found $pr_count open pull request(s). These will be invalidated by history rewrite!"
        echo ""
        # Parse and display PRs
        echo "$pr_list" | python3 -c "
import sys, json
prs = json.load(sys.stdin)
for pr in prs:
    num = pr.get('number', '?')
    title = pr.get('title', 'untitled')
    branch = pr.get('headRefName', 'unknown')
    author = pr.get('author', {}).get('login', 'unknown')
    print(f'    #{num} [{branch}] {title} (by {author})')
" 2>/dev/null || echo "    (could not parse PR list)"
        echo ""
        warn "All open PRs must be merged or closed before history rewrite."
        warn "Collaborators must re-create PRs after re-cloning."
    fi
}

#######################################
# Check for active worktrees
#######################################
check_worktrees() {
    header "Step 6/6: Checking active worktrees"

    local worktree_list
    worktree_list=$(git worktree list 2>/dev/null || echo "")

    # Count worktrees (first line is always the main worktree)
    local worktree_count
    worktree_count=$(echo "$worktree_list" | wc -l | tr -d ' ')

    if [[ "$worktree_count" -le 1 ]]; then
        success "  No additional worktrees found (only main)."
        return 0
    fi

    local extra_count=$((worktree_count - 1))
    warn "Found $extra_count additional worktree(s). These must be removed before history rewrite!"
    echo ""
    echo "$worktree_list" | while read -r line; do
        echo "    $line"
    done
    echo ""
    warn "Remove worktrees with: ./scripts/remove-worktree.sh <path> --force --prune"
    warn "After history rewrite, worktrees cannot be reconciled and must be re-created."
}

#######################################
# Print final readiness summary
#######################################
print_summary() {
    echo ""
    echo -e "${BOLD}============================================${NC}"
    echo -e "${BOLD}  HISTORY REWRITE PREPARATION SUMMARY${NC}"
    echo -e "${BOLD}============================================${NC}"
    echo ""

    if [[ "$DRY_RUN" == true ]]; then
        echo -e "  Mode:     ${YELLOW}DRY RUN${NC} (no backup created)"
    else
        echo -e "  Mode:     ${GREEN}FULL${NC}"
    fi

    echo -e "  Errors:   ${ERRORS}"
    echo -e "  Warnings: ${WARNINGS}"
    echo ""

    if [[ "$READY" == true ]] && [[ "$ERRORS" -eq 0 ]]; then
        echo -e "  ${GREEN}${BOLD}STATUS: READY TO REWRITE${NC}"
        echo ""
        echo "  Next steps:"
        echo "    1. Send notification to collaborators (see docs/templates/history-rewrite-notification.md)"
        echo "    2. Merge or close all open PRs"
        echo "    3. Remove all worktrees"
        echo "    4. Execute history rewrite with BFG"
        echo "    5. Force-push rewritten history"
        echo "    6. All collaborators re-clone"
    else
        echo -e "  ${RED}${BOLD}STATUS: NOT READY${NC}"
        echo ""
        echo "  Resolve the above errors before proceeding."
        echo "  Warnings should be reviewed but are not blocking."
    fi

    echo ""
    echo -e "${BOLD}============================================${NC}"
    echo ""
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
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --skip-backup)
                SKIP_BACKUP=true
                shift
                ;;
            --backup-dir)
                BACKUP_DIR="${2:-}"
                if [[ -z "$BACKUP_DIR" ]]; then
                    echo -e "${RED}Error: --backup-dir requires a path argument${NC}" >&2
                    exit 1
                fi
                shift 2
                ;;
            -*)
                echo -e "${RED}Error: Unknown option: $1${NC}" >&2
                echo ""
                usage
                exit 1
                ;;
            *)
                echo -e "${RED}Error: Unexpected argument: $1${NC}" >&2
                echo ""
                usage
                exit 1
                ;;
        esac
    done

    echo ""
    echo -e "${BOLD}Skillsmith History Rewrite Preparation (SMI-2138)${NC}"
    echo -e "${BOLD}=================================================${NC}"

    if [[ "$DRY_RUN" == true ]]; then
        echo -e "${YELLOW}Running in DRY RUN mode -- no backup will be created.${NC}"
    fi

    # Run all checks in order
    check_bfg
    check_repo_state
    create_backup
    audit_files
    check_open_prs
    check_worktrees

    # Print final summary
    print_summary

    # Exit with appropriate code
    if [[ "$READY" == true ]] && [[ "$ERRORS" -eq 0 ]]; then
        exit 0
    else
        exit 1
    fi
}

# Run main function
main "$@"
