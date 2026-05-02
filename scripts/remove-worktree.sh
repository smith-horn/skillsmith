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

# Source shared utilities (colors, logging, get_main_git_dir, is_git_crypt_encrypted)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Network count threshold for warning
NETWORK_WARN_THRESHOLD=5

#######################################
# Print usage information
#######################################
usage() {
    cat << EOF
Usage: $(basename "$0") <worktree-path> [--force] [--prune] [--keep-docker]

Remove a git worktree and clean up associated Docker resources.

Arguments:
  worktree-path   Path to the worktree to remove (relative or absolute)

Options:
  --force         Force removal even if worktree has dirty files
  --prune         Also prune stale Docker networks
  --keep-docker   Preserve the per-worktree Docker image and node_modules volume
                  (default: both are removed alongside the worktree)
  -h, --help      Show this help message and exit

Examples:
  $(basename "$0") worktrees/my-feature
  $(basename "$0") worktrees/my-feature --force
  $(basename "$0") worktrees/my-feature --force --prune
  $(basename "$0") worktrees/my-feature --keep-docker

What this script does:
  1. Stops Docker containers associated with the worktree
  2. Removes per-worktree Docker image and node_modules volume (unless --keep-docker)
  3. Removes the git worktree (with --force if specified)
  4. Checks Docker network count and warns if above threshold
  5. Optionally prunes stale Docker networks (--prune)

EOF
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
# Remove per-worktree Docker image and node_modules volume
#
# IMPORTANT: this function MUST run BEFORE `git worktree remove` because
# Path A (`docker compose down`) needs the worktree directory (and its
# docker-compose.override.yml) to still exist. Do NOT reorder.
#
# Arguments:
#   $1 - Worktree path (absolute)
#
# Behavior:
#   - Refuses to operate on the main repo (would destroy active dev resources)
#   - Path A: `docker compose down --volumes --rmi local` from the worktree dir
#   - Path B: name-based fallback `docker rmi`/`docker volume rm` (idempotent)
#######################################
cleanup_worktree_docker_resources() {
    local worktree_path="$1"

    if ! command -v docker &>/dev/null; then
        warn "Docker not found, skipping per-worktree resource cleanup"
        return 0
    fi

    # Critical guard: never operate on the main repo. Without this,
    # misinvoking `remove-worktree.sh /path/to/main` would destroy
    # `skillsmith-dev` + `skillsmith_node_modules`.
    local main_dir main_repo
    main_dir="$(get_main_git_dir "$worktree_path" 2>/dev/null || true)"
    if [[ -n "$main_dir" ]]; then
        main_repo="$(dirname "$main_dir")"
        if [[ "$worktree_path" == "$main_repo" ]]; then
            error "Refusing to clean Docker resources for the main repo: $worktree_path"
        fi
    fi

    # Compose-equivalent project name: lowercase + drop chars outside
    # [a-z0-9_-]. Matches docker compose v2 ProjectName sanitization.
    # Plain `basename` would diverge for dirs containing uppercase or
    # special chars.
    local project_name
    project_name="$(basename "$worktree_path" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')"

    # Path A: prefer compose-managed teardown when the override file exists.
    # `down --volumes --rmi local` removes named volumes declared in compose
    # AND any image without an explicit `image:` field. NOTE: --rmi local is
    # load-bearing — if a service in docker-compose.yml gains an explicit
    # `image:` field, --rmi local becomes a silent no-op and Path B alone
    # carries the cleanup. The audit-standards check enforces no `image:`
    # field at lint time.
    # No `--profile` filter so dev/test/orchestrator all tear down.
    if [[ -f "$worktree_path/docker-compose.override.yml" ]]; then
        info "Removing per-worktree Docker image and volumes (compose)..."
        if (cd "$worktree_path" && docker compose down --volumes --rmi local 2>/dev/null); then
            success "  Compose teardown complete"
        else
            warn "  Compose teardown returned non-zero (continuing with name-based fallback)"
        fi
    fi

    # Path B: name-based fallback. Idempotent — these always run, even when
    # Path A succeeded, to catch any image/volume that compose lost track of
    # (e.g. previous partial runs, manually-renamed projects).
    info "Removing Docker resources by derived name..."
    docker rmi "${project_name}-dev" 2>/dev/null && success "  Removed image $project_name-dev" || true
    docker volume rm "${project_name}_node_modules" 2>/dev/null && success "  Removed volume ${project_name}_node_modules" || true

    info "Tip: pass --keep-docker on future removals to preserve image + volume."
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
    local keep_docker=false

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
            --keep-docker)
                keep_docker=true
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

    # Critical guard: refuse to operate on the main repo BEFORE any side effects.
    # Without this, stop_worktree_containers below would `docker compose down`
    # the live skillsmith-dev-1 container if invoked on the main repo path.
    # Resolves before any docker/git/rm operation runs.
    local _main_dir _main_repo
    _main_dir="$(get_main_git_dir "$worktree_path" 2>/dev/null || true)"
    if [[ -n "$_main_dir" ]]; then
        _main_repo="$(dirname "$_main_dir")"
        # Normalize trailing slashes by resolving both paths
        if [[ -d "$_main_repo" ]]; then
            _main_repo="$(cd "$_main_repo" && pwd -P)"
        fi
        local _resolved_worktree
        _resolved_worktree="$(cd "$worktree_path" && pwd -P)"
        if [[ "$_resolved_worktree" == "$_main_repo" ]]; then
            error "Refusing to remove the main repo as a worktree: $worktree_path"
        fi
    fi

    echo ""
    info "Removing worktree: $worktree_path"
    echo ""

    # Step 1: Stop Docker containers
    stop_worktree_containers "$worktree_path"

    # Step 1b: Unlink node_modules symlink so `git worktree remove` sees a
    # clean tree (SMI-4377). A dangling symlink could confuse the removal
    # check; explicit cleanup keeps intent clear.
    if [[ -L "$worktree_path/node_modules" ]]; then
        rm -f "$worktree_path/node_modules"
    fi

    # Step 1c: Remove per-worktree Docker image + volume unless opted out.
    # Must run before `git worktree remove` so the worktree dir (and its
    # docker-compose.override.yml) are still on disk for compose teardown.
    if [[ "$keep_docker" == false ]]; then
        cleanup_worktree_docker_resources "$worktree_path"
    else
        info "Skipping per-worktree Docker resource cleanup (--keep-docker)"
    fi

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
