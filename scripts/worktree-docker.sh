#!/usr/bin/env bash
#
# worktree-docker.sh - Docker helper for git worktrees
#
# Manages Docker containers in worktrees with unique names and ports
# to avoid conflicts with main repository containers.
#
# Usage: ./scripts/worktree-docker.sh <command> [worktree-path]
#
# Commands:
#   start     Start Docker containers in worktree
#   stop      Stop Docker containers in worktree
#   status    Show status of worktree containers
#   generate  Generate docker-compose.override.yml for worktree
#   ports     Show port mappings for worktree
#
# SMI-2160: Docker worktree configuration

set -euo pipefail

# SMI-5626: source the shared lib so cmd_generate can delegate to the single
# override generator source of truth (generate_docker_override_to_stdout),
# instead of maintaining a divergent heredoc that omitted the volumes block.
# Sourced BEFORE this script's own error()/info()/success()/warn()/color
# definitions below so those local definitions take precedence (they are
# functionally identical, but keeping this script's own copies avoids any
# behavioral surprise from a future _lib.sh divergence).
WORKTREE_DOCKER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$WORKTREE_DOCKER_LIB_DIR/_lib.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

#######################################
# Print usage information
#######################################
usage() {
    cat << EOF
Usage: $(basename "$0") <command> [worktree-path]

Docker helper for git worktrees with isolated containers.

Commands:
  start     Start Docker containers in worktree (docker compose up -d)
  stop      Stop Docker containers in worktree (docker compose down)
  status    Show status of worktree containers
  generate  Generate docker-compose.override.yml for worktree
  ports     Show port mappings for worktree
  exec      Run a command in the container matching this worktree/checkout
            (SMI-5559 — resolves the container name from cwd instead of a
            hardcoded name, so it never silently targets the wrong container)
  resolve   Print "<container-name> <resolved-from>" for this worktree/checkout
            and exit 0/1 by whether it's running (SMI-5570/SMI-5074 — for
            other scripts to consume without reimplementing name resolution)

Arguments:
  worktree-path   Path to the worktree (default: current directory)

Examples:
  $(basename "$0") start ../worktrees/my-feature
  $(basename "$0") stop
  $(basename "$0") status ../worktrees/jwt-rollout
  $(basename "$0") generate ../worktrees/new-feature
  $(basename "$0") ports
  $(basename "$0") exec -- npm run build        # like: docker exec <container> npm run build
  $(basename "$0") exec ../worktrees/jwt-rollout -- npm test  # like: docker exec <container> npm test
  $(basename "$0") resolve ../worktrees/jwt-rollout             # prints name; exit 0/1 = running/not

Note:
  This script ensures each worktree has unique container names and ports
  to allow parallel Docker development across multiple worktrees.

EOF
}

#######################################
# Error handling
#######################################
error() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

info() {
    echo -e "${BLUE}$1${NC}"
}

success() {
    echo -e "${GREEN}$1${NC}"
}

warn() {
    echo -e "${YELLOW}$1${NC}"
}

#######################################
# Get worktree name from path
#######################################
get_worktree_name() {
    local worktree_path="$1"

    # Get branch name from worktree
    local branch_name
    branch_name=$(cd "$worktree_path" && git branch --show-current 2>/dev/null || echo "")

    if [[ -z "$branch_name" ]]; then
        # Fallback to directory name
        branch_name=$(basename "$worktree_path")
    fi

    # SMI-5559: basename strips any "/"-prefixed path segments (e.g.
    # fix/smi-5560-infra-hardening -> smi-5560-infra-hardening) — matches
    # _lib.sh's generate_docker_override_to_stdout exactly, which is what
    # actually names the running container. Without this, any branch using
    # this repo's conventional prefixes (fix/, feat/, chore/...) resolved a
    # DIFFERENT, non-existent container name here than the one
    # create-worktree.sh actually created — found via a live test of the
    # new `exec` subcommand.
    branch_name=$(basename "$branch_name")

    # Sanitize for container name
    echo "$branch_name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/--*/-/g' | sed 's/^-//;s/-$//'
}

#######################################
# Generate docker-compose.override.yml
#######################################
cmd_generate() {
    local worktree_path="$1"

    if [[ ! -f "$worktree_path/docker-compose.yml" ]]; then
        error "No docker-compose.yml found in $worktree_path"
    fi

    # SMI-5626: delegate to _lib.sh's single generator source of truth
    # (generate_docker_override_to_stdout) instead of a divergent local
    # heredoc. The old heredoc emitted NO volumes block, so running
    # `worktree-docker.sh generate` — including cmd_start's auto-generate when
    # the override file is missing — silently stripped the SMI-4689/5560
    # per-package :ro mounts and the SMI-5626 root node_modules mount, a live
    # auto-invoked silent-regression path (plan-review escalated this fix from
    # optional to mandatory). Delegating keeps this command byte-for-byte in
    # lock-step with create-worktree.sh / repair-worktrees.sh.
    local worktree_name branch_name repo_root
    worktree_name=$(get_worktree_name "$worktree_path")

    # Pass the raw branch name (generate_docker_override_to_stdout does its own
    # basename+sanitize to derive the container slug, matching get_worktree_name).
    branch_name=$(cd "$worktree_path" && git branch --show-current 2>/dev/null || echo "")
    if [[ -z "$branch_name" ]]; then
        branch_name=$(basename "$worktree_path")
    fi

    # MAIN repo root (for resolving root + per-package node_modules bind mounts).
    # git-common-dir points at main's .git; its parent is the main checkout.
    repo_root=$(cd "$worktree_path" && cd "$(git rev-parse --git-common-dir)/.." && pwd)

    info "Generating docker-compose.override.yml for: $worktree_name"

    generate_docker_override_to_stdout "$worktree_path" "$branch_name" "$repo_root" \
        > "$worktree_path/docker-compose.override.yml"

    success "Generated: $worktree_path/docker-compose.override.yml"
    echo ""
    echo "Port mappings:"
    cmd_ports "$worktree_path"
}

#######################################
# Start Docker containers
#######################################
cmd_start() {
    local worktree_path="$1"

    if [[ ! -f "$worktree_path/docker-compose.yml" ]]; then
        error "No docker-compose.yml found in $worktree_path"
    fi

    # Generate override if missing
    if [[ ! -f "$worktree_path/docker-compose.override.yml" ]]; then
        warn "No docker-compose.override.yml found. Generating..."
        cmd_generate "$worktree_path"
        echo ""
    fi

    info "Starting Docker containers..."
    # SMI-4298: export DEV_PORT to the SAME host port this worktree's own
    # override already maps to container port 3001, BEFORE `up`. Compose
    # concatenates `ports:` across -f files rather than replacing them, so
    # without this the base file's `${DEV_PORT:-3001}:3001` is published in
    # ADDITION to this worktree's bucketed pair and every worktree also
    # claims host port 3001. Runs AFTER the auto-generate block above so a
    # just-generated override is read back, never a stale or absent one.
    # Confined to this subshell so DEV_PORT does not leak into cmd_status.
    (
        cd "$worktree_path" \
            && export_worktree_dev_port "$worktree_path" \
            && docker compose --profile dev up -d
    )

    echo ""
    success "Docker containers started!"
    cmd_status "$worktree_path"
}

#######################################
# Stop Docker containers
#######################################
cmd_stop() {
    local worktree_path="$1"

    if [[ ! -f "$worktree_path/docker-compose.yml" ]]; then
        error "No docker-compose.yml found in $worktree_path"
    fi

    info "Stopping Docker containers..."
    (cd "$worktree_path" && docker compose --profile dev down)

    success "Docker containers stopped."
}

#######################################
# Show container status
#######################################
cmd_status() {
    local worktree_path="$1"

    local worktree_name
    worktree_name=$(get_worktree_name "$worktree_path")

    info "Container status for: $worktree_name"
    echo ""

    # Show containers matching worktree name
    docker ps -a --filter "name=${worktree_name}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "No containers found"
}

#######################################
# Resolve the container name + resolution source for a worktree/checkout
# path, without any docker calls or side effects (SMI-5559, extracted for
# SMI-5570/SMI-5074 so hook-docker-detect.sh can reuse this exact
# derivation via subprocess instead of reimplementing it in POSIX sh).
#
# Prints two space-separated fields to stdout: "<container_name> <resolved_from...>"
# where resolved_from may itself contain spaces ("main checkout" /
# "worktree branch (override)" / "worktree branch (recomputed)") — caller
# should read the first field with `read -r name rest` or `cut -d' ' -f1`
# and treat the remainder as the label.
#
# SMI-5570/SMI-5074: for a worktree, prefers the container_name already
# CONFIGURED in docker-compose.override.yml over recomputing one fresh
# from get_worktree_name(). Both derive from the branch name, but
# get_worktree_name() reads whatever branch is CURRENTLY checked out,
# while the override file is a snapshot from whenever it was last
# (re)generated — switching branches within an existing worktree without
# re-running create-worktree.sh/repair-worktrees.sh drifts these apart,
# and the override file (what actually provisioned the running container)
# is ground truth for "is a container up for this worktree", not a fresh
# recomputation of "what would we name one today." Falls back to fresh
# computation only when no override file exists yet (e.g. before the
# worktree's first `docker compose up`).
#######################################
resolve_container_name() {
    local worktree_path="$1"

    if ! git -C "$worktree_path" rev-parse --git-dir >/dev/null 2>&1; then
        error "Not a git checkout: $worktree_path"
    fi

    local gcd gd container_name resolved_from
    gcd=$(git -C "$worktree_path" rev-parse --git-common-dir 2>/dev/null)
    gd=$(git -C "$worktree_path" rev-parse --git-dir 2>/dev/null)

    if [[ -n "$gcd" && "$gcd" == "$gd" ]]; then
        # Main checkout (git-common-dir == git-dir, i.e. not a linked
        # worktree) — container name is the hardcoded base-compose name,
        # never a derived slug.
        container_name="skillsmith-dev-1"
        resolved_from="main checkout"
    elif [[ -f "$worktree_path/docker-compose.override.yml" ]] \
        && container_name=$(grep -A1 '^  dev:' "$worktree_path/docker-compose.override.yml" \
            | grep 'container_name:' | head -1 | sed 's/.*container_name: *//') \
        && [[ -n "$container_name" ]]; then
        resolved_from="worktree branch (override)"
    else
        local worktree_name
        worktree_name=$(get_worktree_name "$worktree_path")
        container_name="${worktree_name}-dev-1"
        resolved_from="worktree branch (recomputed — no override.yml found; run create-worktree.sh or repair-worktrees.sh)"
    fi

    printf '%s %s\n' "$container_name" "$resolved_from"
}

#######################################
# Print the resolved container name + whether it's currently running
# (SMI-5570/SMI-5074). Used by hook-docker-detect.sh to decide pre-push
# routing without reimplementing name resolution.
#
# stdout: "<container_name> <resolved_from>"
# stderr: (nothing on success)
# Exit code: 0 if the container is running; 1 if not (no error message
# printed here — the caller decides whether/how to surface that; use
# `exec` instead of `resolve` if you want the ready-made error text).
#######################################
cmd_resolve() {
    local worktree_path="$1"
    local name_and_source container_name
    name_and_source=$(resolve_container_name "$worktree_path")
    container_name=$(printf '%s' "$name_and_source" | cut -d' ' -f1)
    printf '%s\n' "$name_and_source"
    docker ps --filter "name=^${container_name}\$" --format '{{.Names}}' | grep -qx "$container_name"
}

#######################################
# Exec a command in the container matching this worktree/checkout (SMI-5559).
#
# Resolves the expected container name from the caller's cwd instead of
# trusting a hardcoded string — a long-lived main container makes
# `docker exec skillsmith-dev-1 <cmd>` "succeed" from ANY worktree
# regardless of whether that worktree's own container is even running.
#######################################
cmd_exec() {
    local worktree_path="$1"
    shift

    if [[ $# -eq 0 ]]; then
        error "No command given.

Usage: $(basename "$0") exec [worktree-path] -- <cmd...>"
    fi

    local name_and_source container_name resolved_from
    name_and_source=$(resolve_container_name "$worktree_path")
    container_name=$(printf '%s' "$name_and_source" | cut -d' ' -f1)
    resolved_from=$(printf '%s' "$name_and_source" | cut -d' ' -f2-)

    if ! docker ps --filter "name=^${container_name}\$" --format '{{.Names}}' | grep -qx "$container_name"; then
        error "Container '$container_name' is not running for $worktree_path (resolved from $resolved_from).

Start it first:
  cd $worktree_path && docker compose --profile dev up -d"
    fi

    success "Running in: $container_name"
    docker exec "$container_name" "$@"
}

#######################################
# Show port mappings
#######################################
cmd_ports() {
    local worktree_path="$1"

    if [[ ! -f "$worktree_path/docker-compose.override.yml" ]]; then
        warn "No docker-compose.override.yml found"
        return
    fi

    info "Port mappings from docker-compose.override.yml:"
    echo ""
    grep -E '^\s+-\s+"[0-9]+:' "$worktree_path/docker-compose.override.yml" | sed 's/^[[:space:]]*/  /'
}

#######################################
# Main entry point
#######################################
main() {
    if [[ $# -lt 1 ]]; then
        usage
        exit 1
    fi

    local command="$1"
    shift

    # `exec` takes a variable-length passthrough command, not a single
    # optional worktree-path arg like the other subcommands — parse it
    # separately before falling into the generic path below.
    if [[ "$command" == "exec" ]]; then
        local exec_worktree_path="."
        if [[ "${1:-}" != "--" ]]; then
            exec_worktree_path="${1:-.}"
            shift
        fi
        if [[ "${1:-}" != "--" ]]; then
            error "Usage: $(basename "$0") exec [worktree-path] -- <cmd...>"
        fi
        shift
        if [[ ! "$exec_worktree_path" = /* ]]; then
            exec_worktree_path="$(cd "$exec_worktree_path" 2>/dev/null && pwd)" || error "Invalid path: $exec_worktree_path"
        fi
        cmd_exec "$exec_worktree_path" "$@"
        return
    fi

    local worktree_path="${1:-.}"

    # Convert to absolute path
    if [[ ! "$worktree_path" = /* ]]; then
        worktree_path="$(cd "$worktree_path" 2>/dev/null && pwd)" || error "Invalid path: $worktree_path"
    fi

    case "$command" in
        start)
            cmd_start "$worktree_path"
            ;;
        stop)
            cmd_stop "$worktree_path"
            ;;
        status)
            cmd_status "$worktree_path"
            ;;
        generate)
            cmd_generate "$worktree_path"
            ;;
        ports)
            cmd_ports "$worktree_path"
            ;;
        resolve)
            cmd_resolve "$worktree_path"
            ;;
        -h|--help|help)
            usage
            exit 0
            ;;
        *)
            error "Unknown command: $command

Run '$(basename "$0") --help' for usage information."
            ;;
    esac
}

main "$@"
