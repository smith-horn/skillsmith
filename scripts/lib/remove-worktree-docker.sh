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
# Stop and remove the worktree's Compose containers and project network
#
# SMI-7089: this is remove-worktree.sh's ONLY project-scoped Compose call, and it
# never deletes a volume or an image: no `--volumes`, no `--rmi`, no name-based
# `docker volume rm` / `docker rmi`. Those deletes belong to the orphan pruner
# (prune-orphaned-docker-volumes.sh --only-project), which runs AFTER
# `git worktree remove` and takes the worktree lifecycle lock for each one.
# `down` is still needed first: it removes the containers and the network, and
# the pruner skips any volume a container is still attached to.
#
# MUST run only after worktree_project_attribution_or_die passed in the same run
# (lib/worktree-project-attribution.sh): `down` acts on EVERY container of the
# Compose project, so it is safe only once nothing else can share that project.
# It is skipped when that check found Docker unavailable (WPA_DOCKER).
#
# SMI-6401: dev/test are profile-gated and Compose silently no-ops `down` for a
# profile-gated service without an explicit --profile, so the declared profiles
# are discovered (`config --profiles`) rather than hard-coded. If discovery
# returns nothing, fall back to --profile dev.
#######################################
stop_worktree_containers() {
    local worktree_path="$1" profile
    local -a profile_args=()

    [[ -f "$worktree_path/docker-compose.override.yml" ]] || return 0
    if [[ "${WPA_DOCKER:-}" != reachable ]]; then
        info "Skipping Docker container stop (Docker is ${WPA_DOCKER:-not checked}) -- no Docker resources were touched"
        return 0
    fi

    while IFS= read -r profile; do
        [[ -n "$profile" ]] && profile_args+=(--profile "$profile")
    done < <(cd "$worktree_path" && docker compose config --profiles 2>/dev/null || true)
    if [[ "${#profile_args[@]}" -eq 0 ]]; then
        warn "  No Compose profiles discovered (docker compose config --profiles returned nothing) -- stopping the dev profile only"
        profile_args=(--profile dev)
    fi

    info "Stopping Docker containers for worktree..."
    if (cd "$worktree_path" && docker compose "${profile_args[@]}" down 2>/dev/null); then
        success "  Docker containers stopped"
    else
        warn "  Could not stop Docker containers (may already be stopped)"
    fi
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
    local network_count names
    if ! names="$(docker network ls --format '{{.Name}}' 2>&1)"; then
        warn "Could not list Docker networks: ${names:-no output}"
        return 0
    fi
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
