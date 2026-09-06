#!/usr/bin/env bash
#
# remove-worktree-docker.sh - Docker cleanup helpers for remove-worktree.sh
#
# Split out of remove-worktree.sh (SMI-6401) once the SMI-6401 volume-cleanup
# fix pushed the parent script over this repo's 500-line file-length gate.
# Sourced by remove-worktree.sh; not meant to be run standalone. Depends on
# _lib.sh (info/success/warn/error/sanitize_project_name/get_main_git_dir)
# already being sourced by the caller.

# Network count threshold for warning
NETWORK_WARN_THRESHOLD=5

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
# Remove per-worktree Docker image and named volumes
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
#   - Path A: `docker compose <discovered --profile args> down --volumes
#     --rmi local` from the worktree dir (SMI-6401: profile discovery is
#     REQUIRED — dev/test are profile-gated, and Compose silently no-ops on
#     `down`/`config` for profile-gated services without an explicit
#     `--profile`)
#   - Path B: name-based fallback `docker rmi` + a `docker volume rm` loop
#     over every named volume `docker compose config --format json` reports
#     (falling back to the single historical `_node_modules` name if that
#     discovery fails) — idempotent
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
    # special chars. sanitize_project_name() (_lib.sh) is the single
    # canonical implementation -- shared with
    # prune-orphaned-docker-volumes.sh so the two can't drift (SMI-5750).
    local project_name
    project_name="$(sanitize_project_name "$(basename "$worktree_path")")"

    # SMI-6401: declared ONCE here, unconditionally — NOT inside the
    # `if [[ -f docker-compose.override.yml ]]` block below. A `local -a
    # x=()` statement only creates the variable when its containing block
    # actually runs; if the override file is absent (a real code path —
    # e.g. a worktree whose container was never started), a declaration
    # living only inside that `if` would never execute, and referencing
    # ${declared_volume_keys[@]} further down would crash with "unbound
    # variable" under this script's `set -euo pipefail` before
    # `git worktree remove` ever runs (caught in plan review — see
    # docs/internal/implementation/smi-6401-remove-worktree-volume-cleanup.md).
    local -a compose_profile_args=()
    local -a declared_volume_keys=()

    # Path A: prefer compose-managed teardown when the override file exists.
    # `down --volumes --rmi local` removes named volumes declared in compose
    # AND any image without an explicit `image:` field. NOTE: --rmi local is
    # load-bearing — if a service in docker-compose.yml gains an explicit
    # `image:` field, --rmi local becomes a silent no-op and Path B alone
    # carries the cleanup. The audit-standards check enforces no `image:`
    # field at lint time.
    #
    # SMI-6401: docker-compose.yml gates BOTH `dev` and `test` behind
    # `profiles:` keys (profiles: [dev] / profiles: [test]). Docker Compose
    # v2/v5 treats "no active profile" as "zero services in scope" for BOTH
    # `down` and `config` — confirmed empirically (see the plan doc): without
    # an explicit --profile flag, this `down --volumes --rmi local` call
    # used to silently touch NOTHING — not the container, not the image, not
    # a single named volume — despite exiting 0 and this function reporting
    # "Compose teardown complete" below. Every volume that appeared cleaned
    # up before this fix was actually removed by a DIFFERENT mechanism
    # entirely (stop_worktree_containers's own `--profile dev down` for the
    # container; the SMI-5750 orphan-prune step for *_native-seed-*
    # volumes; Path B's name-based `_node_modules` guess below) — this call
    # itself was a complete no-op. `config --profiles` discovers the actual
    # declared profile set instead of hardcoding "dev"/"test" literally, so
    # a future new profile can't reintroduce this same silent-no-op class of
    # bug (same "derive, don't hardcode" convention as SMI-5650/SMI-6050).
    if [[ -f "$worktree_path/docker-compose.override.yml" ]]; then
        local profile
        while IFS= read -r profile; do
            [[ -n "$profile" ]] && compose_profile_args+=(--profile "$profile")
        done < <(cd "$worktree_path" && docker compose config --profiles 2>/dev/null || true)
        if [[ "${#compose_profile_args[@]}" -eq 0 ]]; then
            warn "  No Compose profiles discovered (docker compose config --profiles returned nothing) — dev/test teardown may silently no-op"
        fi

        info "Removing per-worktree Docker image and volumes (compose)..."
        if (cd "$worktree_path" && docker compose ${compose_profile_args[@]+"${compose_profile_args[@]}"} down --volumes --rmi local 2>/dev/null); then
            success "  Compose teardown complete"
        else
            warn "  Compose teardown returned non-zero (continuing with name-based fallback)"
        fi

        # SMI-6401: derive the FULL per-worktree named-volume list from
        # docker-compose.yml's own resolved config (base + override,
        # profile-inclusive) instead of hardcoding "_node_modules" alone —
        # a hardcoded single name silently stopped covering
        # website-vercel-output (SMI-6192) and would silently miss any
        # FUTURE named volume the same way. Requires the SAME --profile args
        # as the `down` call above: `config` (like `down`) also returns
        # nothing for profile-gated services without them (confirmed live in
        # the plan doc — `docker compose config --format json` alone
        # returns `{"volumes":{}}` for this repo).
        local config_json
        config_json="$(cd "$worktree_path" && docker compose ${compose_profile_args[@]+"${compose_profile_args[@]}"} config --format json 2>/dev/null || true)"
        if [[ -n "$config_json" ]]; then
            local vol_key
            while IFS= read -r vol_key; do
                [[ -n "$vol_key" ]] && declared_volume_keys+=("$vol_key")
            done < <(printf '%s' "$config_json" | node -e '
let data = "";
process.stdin.on("data", (d) => { data += d; });
process.stdin.on("end", () => {
    try {
        const cfg = JSON.parse(data);
        const vols = (cfg && cfg.volumes) || {};
        for (const name of Object.keys(vols)) {
            if (vols[name] && vols[name].external) continue;
            console.log(name);
        }
    } catch (e) {
        // Malformed JSON — print nothing; caller falls back below.
    }
});
' 2>/dev/null || true)
        fi
    fi

    # Fall back to the single historical volume name if compose-config
    # discovery failed or was unavailable for any reason (no override file,
    # docker unreachable, malformed JSON, `node` unavailable) — this is a
    # best-effort safety net layered under Path A, never a hard failure, and
    # never regresses below the pre-SMI-6401 baseline behavior.
    if [[ "${#declared_volume_keys[@]}" -eq 0 ]]; then
        declared_volume_keys=("node_modules")
    fi

    # Path B: name-based fallback. Idempotent — these always run, even when
    # Path A succeeded, to catch any image/volume that compose lost track of
    # (e.g. previous partial runs, manually-renamed projects, or the compose
    # discovery above failing).
    info "Removing Docker resources by derived name..."
    docker rmi "${project_name}-dev" 2>/dev/null && success "  Removed image $project_name-dev" || true
    local vol_key removed_count=0
    for vol_key in "${declared_volume_keys[@]}"; do
        docker volume rm "${project_name}_${vol_key}" 2>/dev/null && removed_count=$((removed_count + 1)) || true
    done
    [[ "$removed_count" -gt 0 ]] && success "  Removed $removed_count volume(s) by derived name"

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
# of every removal, unconditionally — see the call site in main() (in
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
