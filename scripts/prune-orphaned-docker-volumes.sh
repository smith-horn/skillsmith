#!/usr/bin/env bash
#
# prune-orphaned-docker-volumes.sh - Targeted reclaim of orphaned per-worktree
# Docker volumes/images (SMI-5750)
#
# Problem: <slug>_node_modules and <slug>_native-seed-<module> volumes (the
# latter declared per-worktree by _lib.sh's enumerate_native_module_volumes,
# SMI-5650 for the root-only volumes, SMI-5784 for the per-package
# native-seed-<pkg>-<module> volumes layered on top of the SAME naming
# convention) and <slug>-dev images accumulate whenever a worktree disappears
# without remove-worktree.sh running (crashes, manual `rm -rf`, `git worktree
# remove` by hand), and nothing safe ever reclaims them. On this machine, the
# native-seed volumes are the numerically DOMINANT orphan class -- SMI-5650
# shipped a fixed 5 per worktree (one per NATIVE_MODULES_FOR_OVERLAY entry);
# SMI-5784 added an UNBOUNDED number more on top (up to 5 additional per
# package that diverges from root, so the total varies per worktree rather
# than being a fixed count) -- both conventions must be covered or this
# script does not meet its own goal of preventing unbounded orphan
# accumulation (SMI-5616). A blanket `docker volume prune` is unsafe: it
# deletes ANY volume not attached to a RUNNING container, including a
# still-existing worktree's volume whose container is merely stopped, forcing
# an expensive native-module rebuild (better-sqlite3 / onnxruntime-node /
# hnswlib-node, SMI-4698) in a concurrently-active session.
#
# Safety predicate: WORKTREE EXISTENCE (`git worktree list`), NOT
# container-running-state. A volume/image is only a deletion candidate if its
# derived project name is absent from every worktree git currently knows
# about, regardless of whether that worktree's container is running,
# stopped, or was never started. This is what makes the prune safe at ANY
# concurrency level, unlike a blanket `docker volume prune`.
#
# Ownership gate: the generic Compose-label shape checks below
# (com.docker.compose.volume=<key>, com.docker.compose.service=dev) are
# conventions ANY other repo's `dev` service + same-named volume also
# satisfies -- they are not proof a resource belongs to Skillsmith. Real
# ownership is the `app.skillsmith.owned=true` label (added to
# docker-compose.yml's node_modules volume and to each per-worktree
# native-seed-<module> volume declaration in _lib.sh's
# enumerate_native_module_volumes, by this same change). A candidate that
# passes the generic checks but lacks that label is REPORT-ONLY ("UNCONFIRMED
# ownership") unless --include-unlabeled is passed explicitly.
#
# Residual risks (accepted, NOT eliminated -- see docs/internal/implementation/
# smi-5750-targeted-volume-prune.md § Shared-State audit):
#   1. TOCTOU -- narrowed, not eliminated. The protected set is re-derived
#      immediately before the delete loop, but this is NOT a locking
#      mechanism: a concurrent create-worktree.sh can still register a
#      worktree after that re-scan and before `docker volume rm` /
#      `docker rmi` runs. Worst case: a just-created worktree's still-empty
#      volume is deleted and silently recreated empty by its next
#      `compose up` -- one redundant native-module rebuild, no data loss.
#   2. Cross-repo -- another repo's `*_node_modules` / `*_native-seed-*`
#      volume or `*-dev` image that happens to pass the generic Compose-shape
#      checks is never auto-deleted (the ownership gate above). The residual
#      is confined to explicit --include-unlabeled runs, where the operator
#      reviews the reported UNCONFIRMED list first, and the deleted artifact
#      is always a rebuildable dependency cache, never data.
#
# Usage: ./scripts/prune-orphaned-docker-volumes.sh [--dry-run] [--include-unlabeled] [--report-containers]
#   --dry-run             Report what would be deleted; delete nothing.
#   --include-unlabeled   Also delete UNCONFIRMED-ownership candidates (the
#                          one-time pre-label backlog escape hatch).
#
# Opt-out: SKILLSMITH_ORPHAN_PRUNE_DISABLE=1 skips the prune entirely (exit
# 0), used when invoked from remove-worktree.sh. Registered in
# docs/internal/process/guards-and-opt-outs.md (SMI-5418).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

DRY_RUN=false
INCLUDE_UNLABELED=false
REPORT_CONTAINERS=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --include-unlabeled)
            INCLUDE_UNLABELED=true
            shift
            ;;
        --report-containers)
            REPORT_CONTAINERS=true
            shift
            ;;
        -h|--help)
            echo "Usage: $(basename "$0") [--dry-run] [--include-unlabeled] [--report-containers]"
            echo "  --report-containers  Report live-old, excessive, and orphaned Skillsmith dev containers; mutate nothing."
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            ;;
    esac
done

if [[ "${SKILLSMITH_ORPHAN_PRUNE_DISABLE:-}" == "1" ]]; then
    info "SKILLSMITH_ORPHAN_PRUNE_DISABLE=1 set -- skipping targeted orphan prune"
    exit 0
fi

if ! command -v docker &>/dev/null; then
    warn "Docker not found -- skipping targeted orphan prune"
    exit 0
fi

if ! docker info &>/dev/null; then
    warn "Docker daemon not reachable -- skipping targeted orphan prune"
    exit 0
fi

repo_root="$(cd "$SCRIPT_DIR/.." && pwd)"
main_gitdir="$(get_main_git_dir "$repo_root" 2>/dev/null || true)"
if [[ -n "$main_gitdir" ]]; then
    main_repo="$(dirname "$main_gitdir")"
else
    main_repo="$repo_root"
fi

report_containers() {
    local max_age="${SKILLSMITH_CONTAINER_SPRAWL_MAX_AGE_HOURS:-24}"
    local max_count="${SKILLSMITH_CONTAINER_SPRAWL_MAX_COUNT:-3}"
    [[ "$max_age" =~ ^[0-9]+$ ]] || max_age=24
    [[ "$max_count" =~ ^[0-9]+$ ]] || max_count=3

    local worktrees now count=0 shown=0
    worktrees="$(git -C "$main_repo" worktree list --porcelain 2>/dev/null |
        awk '/^worktree / { sub(/^worktree /, ""); print }' || true)"
    now="$(date +%s)"
    local -a findings=()
    local id name created path created_epoch age_hours class normalized

    while IFS= read -r id; do
        [[ -n "$id" ]] || continue
        name="$(docker inspect "$id" --format '{{.Name}}' 2>/dev/null | sed 's#^/##' || true)"
        created="$(docker inspect "$id" --format '{{.Created}}' 2>/dev/null || true)"
        path="$(docker inspect "$id" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
        [[ -n "$name" && -n "$created" && -n "$path" && "$path" = /* ]] || continue
        count=$((count + 1))
        normalized="$(cd "$path" 2>/dev/null && pwd -P || printf '%s' "$path")"
        if date -j -f '%Y-%m-%dT%H:%M:%S' "${created%%.*}" +%s >/dev/null 2>&1; then
            created_epoch="$(date -j -f '%Y-%m-%dT%H:%M:%S' "${created%%.*}" +%s)"
        else
            created_epoch="$(date -d "$created" +%s 2>/dev/null || printf '%s' "$now")"
        fi
        age_hours=$(((now - created_epoch) / 3600))
        class=""
        if ! grep -qxF "$normalized" <<< "$worktrees"; then
            class="orphaned"
        elif (( age_hours >= max_age )); then
            class="live-old"
        fi
        [[ -n "$class" ]] && findings+=("$name"$'\t'"$class"$'\t'"${age_hours}h"$'\t'"$normalized")
    done < <(docker ps -q \
        --filter 'label=app.skillsmith.owned=true' \
        --filter 'label=com.docker.compose.service=dev' 2>/dev/null || true)

    if (( count > max_count )); then
        findings+=("all-live"$'\t'"excessive"$'\t'"${count}/${max_count}"$'\t'"$main_repo")
    fi
    (( ${#findings[@]} == 0 )) && return 0
    echo "Skillsmith container inventory: ${#findings[@]} finding(s); inspect resource use with: docker stats"
    for finding in "${findings[@]}"; do
        (( shown >= 5 )) && break
        printf '  %s\n' "$finding"
        shown=$((shown + 1))
    done
}

if [[ "$REPORT_CONTAINERS" == true ]]; then
    report_containers
    exit 0
fi

# sanitize_project_name() (_lib.sh) is the single canonical sanitization
# implementation -- shared with remove-worktree.sh's project_name derivation
# so the two can never drift apart (SMI-5750 governance fix; a prior version
# of this script had its own verbatim copy). Its trailing '\n' matters here
# specifically: derive_protected() below calls it in a loop and concatenates
# every call's stdout into one command substitution -- without a guaranteed
# trailing newline per call, BSD sed (macOS) would silently glue consecutive
# sanitized names together on one line (e.g. "foo-bar" + "baz-qux" ->
# "foo-barbaz-qux"), breaking is_protected()'s exact-line grep -qxF match for
# every case with more than one worktree registered (i.e. almost always).

# derive_protected(): canonical enumeration via `git worktree list
# --porcelain` (covers out-of-tree worktrees -- create-worktree.sh:49-52),
# UNIONED with a `.worktrees/*/` directory scan as conservative
# belt-and-braces. Two distinct names sanitizing to the same project name
# can only OVER-protect (both land in the set) -- never false-orphan.
derive_protected() {
    local wt_path base
    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        base="$(basename "$wt_path")"
        sanitize_project_name "$base"
    done < <(git -C "$main_repo" worktree list --porcelain 2>/dev/null | awk '/^worktree / { print $2 }')

    if [[ -d "$main_repo/.worktrees" ]]; then
        local d
        for d in "$main_repo"/.worktrees/*/; do
            [[ -d "$d" ]] || continue
            sanitize_project_name "$(basename "${d%/}")"
        done
    fi
}

is_protected() {
    local project="$1" protected_set="$2"
    grep -qxF "$project" <<< "$protected_set"
}

# Classify a volume name into a (project, expected compose.volume label)
# pair, covering both conventions this script recognizes: the base
# `<project>_node_modules` volume (docker-compose.yml) and the per-module
# `<project>_native-seed-<module>` / `<project>_native-seed-<pkg>-<module>`
# volumes (_lib.sh's enumerate_native_module_volumes, SMI-5650 root-only +
# SMI-5784 per-package) -- the numerically dominant orphan class on this
# machine, and no longer a fixed count per worktree now that per-package
# overlays exist (see header). Sets
# $project and $expected_vol_key; returns 1 (no match) for anything else, so
# `classify_volume "$vol" || continue` skips unrelated volumes cleanly.
# Native module names can themselves contain hyphens (e.g.
# onnxruntime-node), so the split point is the LAST "_native-seed-"
# occurrence (bash `%pattern` removes the shortest matching suffix, which
# for a "*_native-seed-*" glob means matching starts as late as possible in
# the string, i.e. at the last occurrence) -- project names never embed that
# literal substring in practice, so there is normally only one occurrence
# anyway.
classify_volume() {
    local vol="$1"
    if [[ "$vol" == *_node_modules ]]; then
        project="${vol%_node_modules}"
        expected_vol_key="node_modules"
    elif [[ "$vol" == *_native-seed-* ]]; then
        project="${vol%_native-seed-*}"
        expected_vol_key="${vol#"${project}"_}"
    else
        return 1
    fi
}

protected="$(derive_protected)"

# --- volumes: build candidates against the initial protected snapshot ---
declare -a vol_candidates=()
while IFS= read -r vol; do
    [[ -z "$vol" ]] && continue
    classify_volume "$vol" || continue
    is_protected "$project" "$protected" && continue

    vol_shape_label="$(docker volume inspect "$vol" --format '{{index .Labels "com.docker.compose.volume"}}' 2>/dev/null || true)"
    vol_project_label="$(docker volume inspect "$vol" --format '{{index .Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
    vol_owned_label="$(docker volume inspect "$vol" --format '{{index .Labels "app.skillsmith.owned"}}' 2>/dev/null || true)"

    [[ "$vol_shape_label" == "$expected_vol_key" ]] || continue
    [[ "$vol_project_label" == "$project" ]] || continue
    [[ -n "$(docker ps -aq --filter "volume=$vol" 2>/dev/null || true)" ]] && continue

    if [[ "$vol_owned_label" != "true" ]]; then
        echo "UNCONFIRMED ownership: $vol"
        [[ "$INCLUDE_UNLABELED" != true ]] && continue
    fi

    vol_candidates+=("$vol")
done < <(docker volume ls --format '{{.Name}}' 2>/dev/null || true)

# TOCTOU narrowing (NOT elimination -- see header + Shared-State audit):
# re-derive the protected set once, immediately before the delete loop. A
# concurrent create-worktree.sh can still register a worktree after this
# re-scan and before `volume rm` -- that residual window is accepted, not
# closed. This is a narrowing measure, not a locking mechanism.
protected="$(derive_protected)"

if (( ${#vol_candidates[@]} > 0 )); then
    for vol in "${vol_candidates[@]}"; do
        classify_volume "$vol" || continue
        is_protected "$project" "$protected" && continue
        if [[ "$DRY_RUN" == true ]]; then
            info "[dry-run] would remove volume $vol"
        elif docker volume rm "$vol" >/dev/null 2>&1; then
            success "  Removed volume $vol"
        else
            warn "  Could not remove volume $vol (already gone or in use -- continuing)"
        fi
    done
fi

# --- images: same existence + ownership checks, against the re-derived set ---
while IFS= read -r img; do
    [[ -z "$img" || "$img" == "<none>" ]] && continue
    [[ "$img" == *-dev ]] || continue
    project="${img%-dev}"
    is_protected "$project" "$protected" && continue

    img_service_label="$(docker image inspect "$img" --format '{{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null || true)"
    [[ "$img_service_label" == "dev" ]] || continue
    [[ -n "$(docker ps -aq --filter "ancestor=$img" 2>/dev/null || true)" ]] && continue

    img_owned_label="$(docker image inspect "$img" --format '{{index .Config.Labels "app.skillsmith.owned"}}' 2>/dev/null || true)"
    if [[ "$img_owned_label" != "true" ]]; then
        echo "UNCONFIRMED ownership: $img"
        [[ "$INCLUDE_UNLABELED" != true ]] && continue
    fi

    if [[ "$DRY_RUN" == true ]]; then
        info "[dry-run] would remove image $img"
    elif docker rmi "$img" >/dev/null 2>&1; then
        success "  Removed image $img"
    else
        warn "  Could not remove image $img (already gone or in use -- continuing)"
    fi
done < <(docker images --format '{{.Repository}}' 2>/dev/null | sort -u || true)
