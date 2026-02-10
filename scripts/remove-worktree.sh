#!/usr/bin/env bash
#
# remove-worktree.sh - Remove git worktrees with Docker network cleanup
#
# Removes a git worktree and cleans up associated Docker resources
# (containers, networks) to prevent stale network accumulation that
# degrades Docker Desktop DNS.
#
# Usage: ./scripts/remove-worktree.sh <worktree-path> [--force]
#
# SMI-2365: Docker network cleanup during worktree removal

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Network count threshold for warning
NETWORK_WARN_THRESHOLD=5

#######################################
# Print usage information
#######################################
usage() {
    cat << EOF
Usage: $(basename "$0") <worktree-path> [--force]

Remove a git worktree and clean up associated Docker resources.

Arguments:
  worktree-path   Path to the worktree to remove (relative or absolute)

Options:
  --force         Force removal even if worktree has dirty files
  --prune         Also prune stale Docker networks
  -h, --help      Show this help message and exit

Examples:
  $(basename "$0") worktrees/my-feature
  $(basename "$0") worktrees/my-feature --force
  $(basename "$0") worktrees/my-feature --force --prune

What this script does:
  1. Stops Docker containers associated with the worktree
  2. Removes the git worktree (with --force if specified)
  3. Checks Docker network count and warns if above threshold
  4. Optionally prunes stale Docker networks (--prune)

EOF
}

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
# Stop Docker containers for a worktree
#######################################
stop_worktree_containers() {
    local worktree_path="$1"

    # Check if docker-compose.override.yml exists in worktree
    if [[ -f "$worktree_path/docker-compose.override.yml" ]]; then
        info "Stopping Docker containers for worktree..."
        if (cd "$worktree_path" && docker compose --profile dev down 2>/dev/null); then
            success "  Docker containers stopped"
        else
            warn "  Could not stop Docker containers (may already be stopped)"
        fi
    fi
}

#######################################
# Check and warn about Docker network count
#######################################
check_docker_networks() {
    if ! command -v docker &>/dev/null; then
        return 0
    fi

    local network_count
    network_count=$(docker network ls --format '{{.Name}}' 2>/dev/null | wc -l | tr -d ' ')

    if [[ "$network_count" -gt "$NETWORK_WARN_THRESHOLD" ]]; then
        warn "Docker has $network_count networks (threshold: $NETWORK_WARN_THRESHOLD)"
        echo -e "${YELLOW}  Stale networks can degrade Docker Desktop DNS.${NC}"
        echo -e "${YELLOW}  Run with --prune or manually: docker network prune -f${NC}"
        echo ""

        # List non-default networks for visibility
        info "Non-default networks:"
        docker network ls --format '  {{.Name}} ({{.Driver}})' 2>/dev/null | grep -v -E "^  (bridge|host|none) " || true
        echo ""
    else
        success "Docker network count OK ($network_count networks)"
    fi
}

#######################################
# Prune stale Docker networks
#######################################
prune_docker_networks() {
    if ! command -v docker &>/dev/null; then
        warn "Docker not found, skipping network prune"
        return 0
    fi

    info "Pruning stale Docker networks..."
    local pruned
    pruned=$(docker network prune -f 2>&1)

    if echo "$pruned" | grep -q "Deleted Networks"; then
        success "  $pruned"
    else
        success "  No stale networks to remove"
    fi
}

#######################################
# Main entry point
#######################################
main() {
    local worktree_path=""
    local force_flag=""
    local prune_flag=false

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                usage
                exit 0
                ;;
            --force)
                force_flag="--force"
                shift
                ;;
            --prune)
                prune_flag=true
                shift
                ;;
            -*)
                error "Unknown option: $1\n\nRun '$(basename "$0") --help' for usage information."
                ;;
            *)
                if [[ -z "$worktree_path" ]]; then
                    worktree_path="$1"
                else
                    error "Unexpected argument: $1"
                fi
                shift
                ;;
        esac
    done

    if [[ -z "$worktree_path" ]]; then
        error "Missing required argument: worktree-path\n\nRun '$(basename "$0") --help' for usage information."
    fi

    # Validate we're in a git repository
    local repo_root
    repo_root="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
    if [[ -z "$repo_root" ]]; then
        error "Not in a git repository."
    fi

    # Convert to absolute path if relative
    if [[ ! "$worktree_path" = /* ]]; then
        worktree_path="$repo_root/$worktree_path"
    fi

    # Check worktree exists
    if [[ ! -d "$worktree_path" ]]; then
        error "Worktree not found at: $worktree_path"
    fi

    echo ""
    info "Removing worktree: $worktree_path"
    echo ""

    # Step 1: Stop Docker containers
    stop_worktree_containers "$worktree_path"

    # Step 2: Remove the worktree
    info "Removing git worktree..."
    if git worktree remove "$worktree_path" $force_flag 2>&1; then
        success "  Worktree removed"
    else
        error "Failed to remove worktree. Try with --force flag."
    fi

    # Step 3: Check Docker network count
    echo ""
    check_docker_networks

    # Step 4: Prune networks if requested
    if [[ "$prune_flag" == true ]]; then
        prune_docker_networks
    fi

    echo ""
    success "Worktree removal complete!"
}

main "$@"
