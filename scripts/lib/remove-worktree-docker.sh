#!/usr/bin/env bash
#
# remove-worktree-docker.sh - Docker cleanup helpers for remove-worktree.sh
#
# Split out of remove-worktree.sh (SMI-6401) once the SMI-6401 volume-cleanup
# fix pushed the parent script over this repo's 500-line file-length gate.
# Sourced by remove-worktree.sh; not meant to be run standalone. Depends on
# _lib.sh (info/success/warn/error) already being sourced by the caller.
#
# SMI-7089: this file no longer deletes anything. The per-worktree image and
# volume deletes that used to live here (Path A `down --volumes --rmi local`,
# Path B name-based `docker rmi` / `docker volume rm`) acted on a Compose project
# by NAME with no ownership check, no lock and no liveness re-read, so a second
# directory resolving to the same project lost its resources too. They are gone;
# the orphan pruner is the only deleter.

# Network count threshold for warning
NETWORK_WARN_THRESHOLD=5

#######################################
# Stop and remove the worktree's containers (and then its project networks)
#
# SMI-7089: this is remove-worktree.sh's ONLY Docker mutation before the worktree is
# removed, and it is NOT a project-scoped Compose call. `compose down` acts on
# whatever the project holds at the moment it runs, so a container another checkout
# starts after the attribution check would go too. Instead it removes EXACTLY the
# container IDs the attribution check approved (WPA_CONTAINER_IDS; IDs are never
# reused) with `docker rm -f`, then the project's networks, which Docker refuses to
# remove while anything is attached (a warning, never forced). It deletes no volume
# or image: those belong to the orphan pruner, which runs AFTER `git worktree remove`
# under the lifecycle lock.
#
# MUST run only after worktree_project_attribution_or_die passed in the same run
# (lib/worktree-project-attribution.sh). Skipped when that check found Docker
# unavailable (WPA_DOCKER). A failed `rm -f` is fatal: the caller's worktree stays.
#######################################
stop_worktree_containers() {
    local worktree_path="$1"

    if [[ "${WPA_DOCKER:-}" != reachable ]]; then
        info "Skipping Docker container stop (Docker is ${WPA_DOCKER:-not checked}) -- no Docker resources were touched"
        return 0
    fi
    worktree_project_remove_approved "$(sanitize_project_name "$(basename "$worktree_path")")"
}

#######################################
# Check and warn about Docker network count
#######################################
check_docker_networks() {
    if ! command -v docker &>/dev/null; then
        return 0
    fi

    # Captured with `if !`, never a bare `x=$(a | b)`: under `set -euo pipefail` a
    # failing `docker network ls` (daemon gone) would abort the script AFTER
    # `git worktree remove` already ran, with no summary.
    # stdout only is the list of names: stderr from a SUCCESSFUL call (a daemon
    # warning) must not be counted as networks, so it goes to a scratch file that
    # is read only to explain a failure.
    local network_count names errfile
    errfile="$(mktemp "${TMPDIR:-/tmp}/rwd-netls.XXXXXX" 2>/dev/null)" || errfile=/dev/null
    if ! names="$(docker network ls --format '{{.Name}}' 2>"$errfile")"; then
        warn "Could not list Docker networks (docker network ls failed): $(cat "$errfile" 2>/dev/null)"
        [[ "$errfile" == /dev/null ]] || rm -f "$errfile"
        return 0
    fi
    [[ "$errfile" == /dev/null ]] || rm -f "$errfile"
    if [[ -z "$names" ]]; then
        network_count=0
    else
        network_count=$(printf '%s\n' "$names" | wc -l | tr -d ' ')
    fi

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
    # Best-effort and user-requested: a failure warns and returns 0 (a bare
    # `pruned=$(...)` would abort the script under `set -e` after the worktree
    # was already removed).
    if ! pruned="$(docker network prune -f 2>&1)"; then
        warn "  network prune failed: ${pruned:-no output}"
        return 0
    fi

    if echo "$pruned" | grep -q "Deleted Networks"; then
        success "  $pruned"
    else
        success "  No stale networks to remove"
    fi
}

#######################################
# Report reclaimable global Docker resources (read-only)
#
# SMI-5145: surface the global reclaimable state — unused images, orphaned
# volumes, and build cache — that accumulates across worktrees. Read-only;
# never deletes. The aggressive reclaim (image -a / volume prune) is printed
# as a MANUAL command, not run by --prune, because it can force expensive
# native-module rebuilds (better-sqlite3 / onnxruntime, SMI-4698) in other
# still-active worktrees.
#
# SMI-5750: a separate, TARGETED orphan prune (only volumes/images belonging
# to worktrees git no longer knows about) now runs automatically at the end
# of every removal (SMI-7089: it is remove-worktree.sh's only deleter),
# unconditionally — see the call site in main() (in
# remove-worktree.sh), after the --prune block. It is safe at any
# concurrency level because its deletion predicate is worktree-existence,
# not container-running state. The two BLANKET commands printed below
# remain manual-only; the SMI-4698 concurrent-session rebuild-cost warning
# is unchanged by this.
#
# No GB-threshold gate (cf. NETWORK_WARN_THRESHOLD): parsing docker's
# human-readable sizes would reintroduce a numeric-parse/errexit landmine;
# this report is informational, so `docker system df` output is echoed raw.
#######################################
check_docker_reclaimable() {
    if ! command -v docker &>/dev/null; then
        return 0
    fi

    info "Reclaimable Docker resources (global):"
    # Bare command, NOT inside a $(...) assignment, so under `set -euo pipefail`
    # an unguarded non-zero exit (daemon hiccup) would abort the script before
    # "Worktree removal complete!" — the `|| warn` keeps it tolerant.
    docker system df 2>/dev/null || warn "  Could not read 'docker system df'"
    echo ""
    info "To reclaim more (manual — NOT run by --prune):"
    echo -e "${YELLOW}  docker image prune -a   # unused tagged images${NC}"
    echo -e "${YELLOW}  docker volume prune     # orphaned volumes (WARNING: forces native-module rebuilds in other worktrees)${NC}"
    echo ""
    info "Note: a targeted orphan prune (SMI-5750) already runs automatically,"
    info "below, on every removal — the two blanket commands above stay manual"
    info "only, for the same SMI-4698 concurrent-session rebuild-cost reason."
}

#######################################
# Prune the SAFE global Docker categories (dangling images + build cache)
#
# SMI-5145: run under --prune alongside prune_docker_networks. These do NOT
# affect another worktree's ability to resume — named *_node_modules volumes
# are preserved, and `image prune -f` removes only dangling/untagged images
# (tagged images referenced by any running/stopped container are kept).
# Aggressive `image -a` / `volume prune` stay manual (check_docker_reclaimable).
# Each command is `|| warn`-tolerant so a transient non-zero exit doesn't abort
# the script under `set -euo pipefail`.
#######################################
prune_docker_safe() {
    if ! command -v docker &>/dev/null; then
        warn "Docker not found, skipping safe image/cache prune"
        return 0
    fi

    info "Pruning dangling images..."
    docker image prune -f 2>&1 || warn "  image prune returned non-zero"
    info "Pruning build cache..."
    docker builder prune -f 2>&1 || warn "  builder prune returned non-zero"
}
