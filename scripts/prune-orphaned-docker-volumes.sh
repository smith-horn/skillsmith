#!/usr/bin/env bash
#
# prune-orphaned-docker-volumes.sh - Targeted reclaim of orphaned per-worktree
# Docker volumes/images (SMI-5750)
#
# <slug>_node_modules, <slug>_native-seed-<module> and
# <slug>_native-seed-<pkg>-<module> volumes (_lib.sh's
# enumerate_native_module_volumes; the per-package count is unbounded, SMI-5784)
# and <slug>-dev images accumulate whenever a worktree disappears without
# remove-worktree.sh running. A blanket `docker volume prune` is unsafe: it
# deletes ANY volume not attached to a RUNNING container, including a live
# worktree's whose container is merely stopped (forcing a native-module rebuild,
# SMI-4698).
#
# Safety predicate: WORKTREE EXISTENCE (`git worktree list`), NOT container
# state. A volume/image is a deletion candidate only if its derived project
# name is absent from every worktree git knows about, whether that worktree's
# container is running, stopped or never started.
#
# Deletion scope: NOTHING is deleted unless the caller names the one Compose
# project it may delete with `--only-project <name>`. Without it the run is
# report-only (never `volume rm` / `rmi`, whatever other flags are set). With
# it, only owned, unattached resources whose project equals <name> exactly are
# deleted, after the ownership, attachment and final re-check gates; every other
# orphan is report-only. <name> must not be the main checkout's project or a
# live worktree's. remove-worktree.sh passes the removed worktree's project.
#
# Ownership gate: the generic Compose-label shape checks are conventions any
# other repo's `dev` service also satisfies. Real ownership is the
# `app.skillsmith.owned=true` label; a candidate lacking it is REPORT-ONLY
# ("UNCONFIRMED ownership") and no flag waives that (SMI-6981; own unlabelled
# volumes: SMI-7028). The label proves Skillsmith-BUILT, not "belongs to a live
# worktree" (SMI-7033): see risk 3.
#
# Fail-closed (SMI-6981): the protected set is used only if `git worktree list`
# COMPLETED successfully; a failing docker query that gates a deletion means skip.
# A listing, label read or delete that fails (other than the object being gone)
# is skipped AND makes the run exit 1, so it never reads as "nothing to prune".
#
# Residual risks (accepted, NOT eliminated):
#   1. TOCTOU -- narrowed, not eliminated. The protected set is re-derived
#      before each delete loop and attachment + ownership re-read immediately
#      before each `volume rm` / `rmi`, but nothing locks: a concurrent
#      create-worktree.sh can register a worktree after the last check.
#   2. Cross-repo -- eliminated (SMI-6981): another repo's resource is never
#      auto-deleted, and --only-project cannot name a project into scope that
#      lacks the ownership label.
#   3. OUR OWN non-worktree Compose projects -- only the MEASURED FAMILY is gated
#      (is_own_non_worktree_project, SMI-7033, a second layer behind
#      --only-project). Add other names there.
#
# Usage: ./scripts/prune-orphaned-docker-volumes.sh [--only-project <name>] [--dry-run] [--include-unlabeled] [--report-containers]
#   --only-project <name> The ONLY Compose project that may be deleted from.
#                          Omitted: report-only. Refused if <name> is empty,
#                          malformed, the main checkout, or a live worktree.
#   --dry-run             Report what would be deleted; delete nothing.
#   --include-unlabeled   REPORT-ONLY since SMI-6981; deletes nothing. Retained
#                          so passing it warns rather than silently behaving
#                          differently than an operator expects.
#   --report-containers   Report live-old, excessive, and orphaned Skillsmith
#                          dev containers; mutate nothing.
#
# Opt-out: SKILLSMITH_ORPHAN_PRUNE_DISABLE=1 skips the prune entirely (exit
# 0), used when invoked from remove-worktree.sh. Registered in
# docs/internal/process/guards-and-opt-outs.md (SMI-5418).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

DRY_RUN=false
REPORT_CONTAINERS=false
ONLY_PROJECT=""
ONLY_PROJECT_SET=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --only-project|--only-project=*)
            if [[ "$1" == --only-project=* ]]; then
                ONLY_PROJECT="${1#--only-project=}"
                shift
            else
                [[ $# -ge 2 ]] || error "--only-project requires a project name"
                ONLY_PROJECT="$2"
                shift 2
            fi
            ONLY_PROJECT_SET=true
            ;;
        --include-unlabeled)
            # SMI-6981: retained but NO LONGER DESTRUCTIVE, so an operator who
            # passes it is told what changed. Deliberately sets no variable:
            # dead state a later reader assumes is live is its own hazard.
            warn "--include-unlabeled is REPORT-ONLY since SMI-6981 and no longer deletes anything."
            warn "  It used to waive the app.skillsmith.owned check, so unconfirmed resources are now"
            warn "  always listed, never removed. Reclaiming our OWN unlabelled volumes needs SMI-7028."
            shift
            ;;
        --report-containers)
            REPORT_CONTAINERS=true
            shift
            ;;
        -h|--help)
            # The header's Usage block is the single source of the help text.
            sed -n '/^# Usage:/,/^# Opt-out/{/^# Opt-out/d;s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            error "Unknown option: $1"
            ;;
    esac
done

# Validate before any docker call: the shape sanitize_project_name emits.
if [[ "$ONLY_PROJECT_SET" == true && ! "$ONLY_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    error "--only-project '$ONLY_PROJECT' is not a valid Compose project name (expected [a-z0-9][a-z0-9_-]*) -- refusing to prune."
fi

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

# shellcheck source=lib/worktree-lifecycle.sh
source "$SCRIPT_DIR/lib/worktree-lifecycle.sh"
# shellcheck source=lib/report-sprawl-containers.sh
source "$SCRIPT_DIR/lib/report-sprawl-containers.sh"

if [[ "$REPORT_CONTAINERS" == true ]]; then
    report_containers "$main_repo" || exit 1
    exit 0
fi

info "Orphan prune scope: ${ONLY_PROJECT:-none (report-only; pass --only-project to delete)}"

# Set when a docker LISTING fails: nothing is deleted from it, but the run must
# not read as "nothing to prune" (exit 1).
LISTING_FAILED=false
# Set when a gating inspect or a delete FAILS for a reason other than the object
# having vanished: the run did not do what it was asked to, so it exits 1.
OP_FAILED=false
# Filled by label_of via `printf -v`, which shellcheck cannot see; declared here.
vol_shape_label="" vol_project_label="" vol_owned_label="" recheck_owned=""
img_service_label="" img_owned_label=""

# label_of KIND OBJECT LABEL VAR -- read one label into VAR. Returns nonzero when
# it could not be read: if the object merely vanished (benign) nothing else
# happens; any OTHER failure warns and sets OP_FAILED, because an unreadable
# label must not read as "label absent" (a silent skip, exit 0).
label_of() {
    local kind="$1" obj="$2" label="$3" var="$4" path=".Labels" out
    [[ "$kind" == image ]] && path=".Config.Labels"
    if out="$(docker "$kind" inspect "$obj" --format "{{index $path \"$label\"}}" 2>&1)"; then
        printf -v "$var" '%s' "$out"
        return 0
    fi
    if ! grep -qiE 'no such (volume|image)' <<< "$out"; then
        warn "  Could not inspect $kind $obj (${out:-no output}) -- skipping"
        OP_FAILED=true
    fi
    return 1
}

# Skillsmith-BUILT Compose projects that are not worktrees (SMI-7033). The
# ownership label cannot distinguish these from a worktree's resources, and the
# worktree-existence predicate cannot protect them, so they are named here.
# Matches the exact project name OR the `skillsmith-eval-cron-` prefix family
# (any `skillsmith-eval-cron-<suffix>`) -- a prefix match, so it can over-protect
# a lookalike name, which is the safe direction. Never a substring match.
is_own_non_worktree_project() {
    case "$1" in
        skillsmith-eval-cron|skillsmith-eval-cron-*) return 0 ;;
        *) return 1 ;;
    esac
}

# Returns 0 (=> caller must SKIP) when containers are attached to the resource
# named by the `docker ps` filter in $1 OR when that query FAILED. A failed query
# is "unknown", not "unattached": treating it as unattached would let a transient
# daemon error license a delete (SMI-6981). Callers: `attached_or_unknown F && continue`.
attached_or_unknown() {
    local out
    if ! out="$(docker ps -aq --filter "$1" 2>/dev/null)"; then
        warn "  Could not check container attachment for ${1#*=} -- skipping (unknown is not unattached)"
        return 0
    fi
    [[ -n "$out" ]]
}

# Classify a volume name into (project, expected compose.volume label), covering
# `<project>_node_modules` and `<project>_native-seed-<module>` /
# `<project>_native-seed-<pkg>-<module>`. Sets $project and $expected_vol_key;
# returns 1 for anything else, so `classify_volume "$vol" || continue` skips
# unrelated volumes. Module names can contain hyphens, so the split point is the
# LAST "_native-seed-" (bash `%pattern` removes the shortest matching suffix).
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

protected="$(derive_protected_or_die "$main_repo")"

if [[ -n "$ONLY_PROJECT" ]] && is_protected "$ONLY_PROJECT" "$protected"; then
    error "--only-project '$ONLY_PROJECT' is the main checkout or a live worktree -- refusing to prune."
fi

# The deletion-scope predicate (candidate build AND pre-delete re-check).
in_scope() { [[ -n "$ONLY_PROJECT" && "$1" == "$ONLY_PROJECT" ]]; }

vol_list=""
if ! vol_list="$(docker volume ls --format '{{.Name}}' 2>/dev/null)"; then
    warn "Could not list volumes (docker volume ls failed) -- no volume candidates considered"
    LISTING_FAILED=true
    vol_list=""
fi

# --- volumes: build candidates against the initial protected snapshot ---
declare -a vol_candidates=()
while IFS= read -r vol; do
    [[ -z "$vol" ]] && continue
    classify_volume "$vol" || continue
    is_protected "$project" "$protected" && continue

    label_of volume "$vol" com.docker.compose.volume vol_shape_label || continue
    label_of volume "$vol" com.docker.compose.project vol_project_label || continue
    label_of volume "$vol" app.skillsmith.owned vol_owned_label || continue

    [[ "$vol_shape_label" == "$expected_vol_key" ]] || continue
    [[ "$vol_project_label" == "$project" ]] || continue
    attached_or_unknown "volume=$vol" && continue

    # SMI-6981: an unconfirmed volume is NEVER a deletion candidate, whatever
    # --include-unlabeled says. `app.skillsmith.owned` is the only NON-CIRCULAR
    # ownership signal in this chain. The project-label check above cannot
    # substitute: it compares against a $project parsed from the candidate's own
    # NAME, so it passes for any foreign Compose project using default naming.
    # On a shared daemon, absence of ownership evidence means DO NOT DELETE.
    if [[ "$vol_owned_label" != "true" ]]; then
        echo "UNCONFIRMED ownership: $vol (report only -- never deleted)"
        continue
    fi

    if is_own_non_worktree_project "$project"; then
        echo "NON-WORKTREE project: $vol (owned, but not a worktree's -- report only, never deleted)"
        continue
    fi

    if ! in_scope "$project"; then
        echo "REPORT-ONLY orphan: $vol (project not named by --only-project -- never deleted)"
        continue
    fi

    vol_candidates+=("$vol")
done <<< "$vol_list"

# TOCTOU narrowing (NOT elimination): re-derive the protected set immediately
# before the delete loop. A concurrent create-worktree.sh can still register a
# worktree after this and before `volume rm` -- accepted residual (risk 1).
protected="$(derive_protected_or_die "$main_repo")"

if (( ${#vol_candidates[@]} > 0 )); then
    for vol in "${vol_candidates[@]}"; do
        classify_volume "$vol" || continue
        is_protected "$project" "$protected" && continue
        # SMI-6981: re-evaluate attachment and ownership against the object as it
        # is now -- the two NON-CIRCULAR components. Shape and project labels are
        # not re-read: both derive from the candidate's own name, so re-reading
        # establishes nothing. Between candidate construction and here a volume
        # can have become attached, or been replaced by a DIFFERENT volume under
        # the same name, which Docker would happily let us delete.
        attached_or_unknown "volume=$vol" && continue
        label_of volume "$vol" app.skillsmith.owned recheck_owned || continue
        [[ "$recheck_owned" == "true" ]] || continue
        if [[ "$DRY_RUN" == true ]]; then
            info "[dry-run] would remove volume $vol"
        elif rm_out="$(docker volume rm "$vol" 2>&1)"; then
            success "  Removed volume $vol"
        elif grep -qi 'no such volume' <<< "$rm_out"; then
            info "  Volume $vol already gone"
        else
            warn "  Could not remove volume $vol (${rm_out:-no output})"
            OP_FAILED=true
        fi
    done
fi

# --- images: same existence + ownership checks, against the re-derived set ---
# SMI-6981: re-derive AGAIN here -- the pre-volume-loop snapshot is a whole
# deletion loop stale. This buys symmetry (each loop decides from a snapshot
# taken immediately before it), not per-candidate worktree freshness.
protected="$(derive_protected_or_die "$main_repo")"

img_list=""
if ! img_list="$(docker images --format '{{.Repository}}' 2>/dev/null)"; then
    warn "Could not list images (docker images failed) -- no image candidates considered"
    LISTING_FAILED=true
    img_list=""
fi
img_list="$(printf '%s\n' "$img_list" | sort -u)"

while IFS= read -r img; do
    [[ -z "$img" || "$img" == "<none>" ]] && continue
    [[ "$img" == *-dev ]] || continue
    project="${img%-dev}"
    is_protected "$project" "$protected" && continue

    label_of image "$img" com.docker.compose.service img_service_label || continue
    [[ "$img_service_label" == "dev" ]] || continue
    attached_or_unknown "ancestor=$img" && continue

    label_of image "$img" app.skillsmith.owned img_owned_label || continue
    # SMI-6981: --include-unlabeled gated `docker rmi` exactly as it gated
    # `volume rm`, so a foreign `*-dev` image with no attached container and no
    # ownership label was deletable. Same rule, same reason.
    if [[ "$img_owned_label" != "true" ]]; then
        echo "UNCONFIRMED ownership: $img (report only -- never deleted)"
        continue
    fi

    if is_own_non_worktree_project "$project"; then
        echo "NON-WORKTREE project: $img (owned, but not a worktree's -- report only, never deleted)"
        continue
    fi

    if ! in_scope "$project"; then
        echo "REPORT-ONLY orphan: $img (project not named by --only-project -- never deleted)"
        continue
    fi

    # Final re-read of attachment and ownership immediately before the delete, as
    # the volume loop does: an image can gain a container or be replaced between
    # the scan above and the `rmi` below.
    attached_or_unknown "ancestor=$img" && continue
    label_of image "$img" app.skillsmith.owned recheck_owned || continue
    [[ "$recheck_owned" == "true" ]] || continue

    if [[ "$DRY_RUN" == true ]]; then
        info "[dry-run] would remove image $img"
    elif rm_out="$(docker rmi "$img" 2>&1)"; then
        success "  Removed image $img"
    elif grep -qi 'no such image' <<< "$rm_out"; then
        info "  Image $img already gone"
    else
        warn "  Could not remove image $img (${rm_out:-no output})"
        OP_FAILED=true
    fi
done <<< "$img_list"

if [[ "$LISTING_FAILED" == true || "$OP_FAILED" == true ]]; then
    exit 1
fi
