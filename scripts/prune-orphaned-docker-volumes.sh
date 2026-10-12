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
# deleted; every other orphan is report-only. SMI-7089: under --only-project P the
# scope also covers every other owned volume of P (name `P_<key>`, project label P,
# volume label <key>: e.g. website-vercel-output) and P's `-test` image; an image
# must say it belongs to P (project label) and to the expected service. This is
# remove-worktree.sh's only deleter. The ownership and attachment gates
# run once at selection and AGAIN inside the critical section, just before the
# delete, against the identity recorded at selection: an image's ID (it is
# deleted BY ID, and only if its tag still resolves to that ID and the ID is
# owned) and a volume's CreatedAt (it must be unchanged and the volume still
# owned and unused). A mismatch skips that candidate; an unreadable re-inspect
# stops the run. <name> must not be the main checkout's project or a
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
# A listing or label read that fails is skipped AND makes the run exit 1, so it
# never reads as "nothing to prune". A DELETE that fails stops the run with exit
# 1 (C5 below).
#
# Concurrency (SMI-6981, ADR-180). Every delete is a critical section under the
# worktree lifecycle lock (lib/worktree-lifecycle.sh): a kernel-released flock on
# the git common directory that create-worktree.sh also takes around `git worktree
# add`. Inside it the order is: liveness re-read, lock-identity check, Docker
# re-inspect (attachment, ownership, and the image ID / volume CreatedAt recorded
# at selection), then the one bounded `docker volume rm` / `rmi <image ID>`.
#   G1. A worktree registered by create-worktree.sh is never deleted from after
#       its registration became observable -- while ALL of these hold: C1 it was
#       created through create-worktree.sh; C2 the common directory inode is not
#       replaced (detected at each check, NOT after the final check before the
#       delete); C3 no creator skips the lock (it has no opt-out); C4 the
#       filesystem is on the allow-list (apfs/hfs; overlayfs/tmpfs), else this
#       script refuses; C5 the delete completed (a timed-out delete has an UNKNOWN
#       outcome the daemon may still execute; the run stops with exit 1). ANY
#       failed delete does the same, whatever the CLI printed: a docker CLI can
#       send the request, lose the connection and exit nonzero while the daemon
#       still carries it out, and the output is never trusted to say which. The
#       cost: one refusal (in use, already gone) ends the run with exit 1 and
#       the remaining candidates wait for the next run. An
#       interrupt (INT/TERM/HUP, or this shell dying) mid-delete is forwarded to
#       the delete's process group and waited out (TERM, 2 s, KILL) before the
#       lock is released, but SIGKILL of this script releases the lock at once:
#       the supervisor then notices the lost parent within ~50 ms and kills the
#       group, which a delete already sent to the daemon can still outlive.
#   G1 DOES NOT HOLD for these (explicit exceptions: the delete can hit the
#   wrong object): E1 a VOLUME replaced between the in-lock re-inspect and
#   `volume rm` (Docker ignores our lock and has no compare-and-delete); E2 a
#   volume removed and re-created within the SAME SECOND as the one selected
#   (CreatedAt has one-second resolution; Docker has no volume ID). Nothing else.
#   Covered exactly: an IMAGE's ID is captured first, every Docker-observed
#   predicate (service, ownership, attachment) is judged on that ID (project and
#   scope come from the tag name that was resolved to it), and the section re-checks that
#   the tag still resolves to it, that it is owned and unattached, then deletes
#   BY ID. A VOLUME's CreatedAt, shape, project and ownership come from ONE
#   inspect at selection, and the section requires CreatedAt unchanged, owned and
#   unused. (A container started on an image between the in-lock check and `rmi`
#   is not detected here; docker's own in-use refusal would stop the run -- not
#   measured.)
#   G2. A worktree registered WITHOUT the lock (plain `git worktree add`, the
#       Claude Code harness, any other tool) is not excluded. The in-lock liveness
#       read shrinks the race to the gap between that read and the delete, which
#       is not zero and not measured. Inside it this script can DELETE DATA the
#       new worktree meant to reuse (a populated node_modules or native-seed
#       volume) or one Compose has already decided exists. Possible data loss,
#       accepted by design and tracked in SMI-7033 / SMI-7046.
# Fail-closed: an unobtainable lock, filesystem type, liveness read or identity
# deletes nothing further and exits 1.
#
# Residual risks (accepted, NOT eliminated):
#   1. See G2 above.
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
# 0), used when invoked from remove-worktree.sh. It is the only switch: the lock
# has no off-switch on either side. Tuning: SKILLSMITH_WORKTREE_LIFECYCLE_LOCK_WAIT
# (seconds per section, default 30), SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT (default 60). Registered in
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

# SMI-7089: a caller that NAMED a project (remove-worktree.sh) asked for that
# project's resources to be removed; "Docker unusable" must not read as success.
unusable_docker() {
    if [[ "$ONLY_PROJECT_SET" == true ]]; then
        error "$1 -- the targeted orphan prune for '$ONLY_PROJECT' could not run, so its image and volumes were NOT removed. Re-run once Docker is available: $0 --only-project $ONLY_PROJECT"
    fi
    warn "$1 -- skipping targeted orphan prune"
    exit 0
}

if ! command -v docker &>/dev/null; then
    unusable_docker "Docker not found"
fi

if ! docker info &>/dev/null; then
    unusable_docker "Docker daemon not reachable"
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
# shellcheck source=lib/worktree-lifecycle-docker.sh
source "$SCRIPT_DIR/lib/worktree-lifecycle-docker.sh"
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
# Filled via `printf -v` / image_labels_of, which shellcheck cannot see; declared here.
vol_shape_label="" vol_project_label="" vol_owned_label="" vol_created=""
img_service_label="" img_owned_label="" img_project_label="" img_labels_json="" img_expect_service="" img_id=""

# image_labels_of ID -- read an image's whole label map ONCE as JSON
# (worktree_lifecycle_image_labels) and set img_labels_json, img_service_label,
# img_owned_label and img_project_label from it. An image that merely vanished is
# silent; any OTHER failure warns and sets OP_FAILED. Returns 1 on failure.
image_labels_of() {
    local out rc
    if out="$(worktree_lifecycle_image_labels "$1")"; then
        img_labels_json="$out"
        img_service_label="$(worktree_lifecycle_json_label "$out" com.docker.compose.service)"
        img_owned_label="$(worktree_lifecycle_json_label "$out" app.skillsmith.owned)"
        img_project_label="$(worktree_lifecycle_json_label "$out" com.docker.compose.project)"
        return 0
    else
        rc=$?
    fi
    if ! grep -qiE 'no such image' <<< "$out"; then
        warn "  Could not inspect image $1 (${out:-no output}; status $rc) -- skipping"
        OP_FAILED=true
    fi
    return 1
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

# incarnation_of VOLUME CREATED_VAR SHAPE_VAR PROJECT_VAR OWNED_VAR -- ONE inspect
# at selection yields the identity (CreatedAt) AND every predicate label, so
# nothing is judged on a different incarnation than the one recorded. Like
# image_labels_of: a volume that merely vanished is silent, any other failure warns and
# sets OP_FAILED; returns 1.
incarnation_of() {
    local out rest
    if out="$(worktree_lifecycle_volume_state "$1")"; then
        printf -v "$2" '%s' "${out%%|*}"
        rest="${out#*|}"
        printf -v "$3" '%s' "${rest%%|*}"
        rest="${rest#*|}"
        printf -v "$4" '%s' "${rest%%|*}"
        printf -v "$5" '%s' "${rest##*|}"
        return 0
    fi
    if ! grep -qiE 'no such volume' <<< "$out"; then
        warn "  Could not inspect volume $1 (${out:-no output}) -- skipping"
        OP_FAILED=true
    fi
    return 1
}

# The deletion-scope predicate (candidate build AND pre-delete re-check).
in_scope() { [[ -n "$ONLY_PROJECT" && "$1" == "$ONLY_PROJECT" ]]; }

vol_list=""
if ! vol_list="$(docker volume ls --format '{{.Name}}' 2>/dev/null)"; then
    warn "Could not list volumes (docker volume ls failed) -- no volume candidates considered"
    LISTING_FAILED=true
    vol_list=""
fi

# --- volumes: build candidates against the initial protected snapshot ---
# Selection. Unscoped (report-only) runs keep classify_volume's two shapes. Under
# --only-project P a volume is ALSO considered when its name starts with `P_`
# (SMI-7089): a per-worktree volume such as `P_website-vercel-output` fits neither
# classify_volume shape and used to leak on every removal. It is a candidate only
# when ALL hold, judged on the one inspect that records CreatedAt: its
# com.docker.compose.project label is P, its com.docker.compose.volume label equals
# the name with `P_` removed, and it is owned. A `P_x_node_modules` that belongs to
# the project `P_x` fails the project label and is reported under its own project.
declare -a vol_candidates=() vol_candidate_created=() vol_candidate_project=()
while IFS= read -r vol; do
    [[ -z "$vol" ]] && continue
    cand_scoped=false
    if [[ -n "$ONLY_PROJECT" && "$vol" == "${ONLY_PROJECT}_"* ]]; then
        cand_scoped=true
    else
        classify_volume "$vol" || continue
        is_protected "$project" "$protected" && continue
    fi

    incarnation_of "$vol" vol_created vol_shape_label vol_project_label vol_owned_label || continue

    if [[ "$cand_scoped" == true ]]; then
        # P's own volume iff its volume label is the name minus `P_`. The project
        # label is judged ONCE, by the shared check below -- not here as well.
        if [[ "$vol_shape_label" == "${vol#"${ONLY_PROJECT}"_}" ]]; then
            project="$ONLY_PROJECT"
            expected_vol_key="${vol#"${ONLY_PROJECT}"_}"
        else
            # Not P's own volume: fall back to the shapes classify_volume knows, so
            # another project's orphan is still REPORTED (never deleted).
            classify_volume "$vol" || continue
            is_protected "$project" "$protected" && continue
        fi
    fi

    [[ "$vol_shape_label" == "$expected_vol_key" ]] || continue
    [[ "$vol_project_label" == "$project" ]] || continue
    # Container attachment is mutable state, not identity: it is re-read inside the
    # critical section. Every identity-bound predicate above came from the one
    # inspect that recorded CreatedAt, so no window exists between them.
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
    vol_candidate_created+=("$vol_created")
    vol_candidate_project+=("$project")
done <<< "$vol_list"

# Every delete below runs inside worktree_lifecycle_delete (lib/worktree-lifecycle.sh):
# one critical section per candidate under the worktree lifecycle lock, with the
# liveness read and the lock-identity check as the last operations before the one
# bounded delete. The protected set sampled above only pre-filters candidates.
# A failed delete never returns here: it exits the run (C5). The `|| OP_FAILED=true`
# on both calls only keeps the function in an errexit-suppressed `||` context,
# which its internal `x="$(…)" || error` checks were written and measured under.
if (( ${#vol_candidates[@]} > 0 )); then
    for i in "${!vol_candidates[@]}"; do
        vol="${vol_candidates[$i]}"
        project="${vol_candidate_project[$i]}"
        # Attachment, ownership and CreatedAt are re-checked INSIDE the section,
        # not here: any Docker actor can replace the volume while we wait for the
        # lock, and Docker deletes by name.
        worktree_lifecycle_delete "$main_repo" "$project" "$DRY_RUN" volume "$vol" "${vol_candidate_created[$i]}" || OP_FAILED=true
    done
fi

# --- images: same existence + ownership checks, each delete in its own section ---
img_list=""
if ! img_list="$(docker images --format '{{.Repository}}' 2>/dev/null)"; then
    warn "Could not list images (docker images failed) -- no image candidates considered"
    LISTING_FAILED=true
    img_list=""
fi
img_list="$(printf '%s\n' "$img_list" | sort -u)"

while IFS= read -r img; do
    [[ -z "$img" || "$img" == "<none>" ]] && continue
    # Report every `*-dev` image. Under --only-project P also consider P's `-test`
    # image (SMI-7089): the dev container is not the only service a worktree
    # builds, and that image leaked on every removal.
    if [[ "$img" == *-dev ]]; then
        project="${img%-dev}"
        img_expect_service="dev"
    elif [[ -n "$ONLY_PROJECT" && "$img" == "${ONLY_PROJECT}-test" ]]; then
        project="$ONLY_PROJECT"
        img_expect_service="test"
    else
        continue
    fi
    is_protected "$project" "$protected" && continue

    # IDENTITY FIRST: resolve the immutable image ID once, then judge every
    # Docker-observed image predicate (service, ownership, project, attachment) on
    # that ID (labels are immutable per ID), never on the tag. The scope comes from
    # the `<project>-<service>` tag name, which is what is resolved to the ID. A
    # tag retargeted after this line changes nothing that was checked; the section
    # re-checks that the tag still resolves to this ID and deletes BY ID.
    if ! img_id="$(worktree_lifecycle_image_id "$img")"; then
        warn "  Could not resolve image $img (${img_id:-no output}) -- skipping"
        OP_FAILED=true
        continue
    fi
    image_labels_of "$img_id" || continue
    if [[ "$img_labels_json" == "null" || "$img_labels_json" == "{}" ]]; then
        echo "UNCONFIRMED ownership: $img (the image carries no labels -- report only, never deleted)"
        continue
    fi
    [[ "$img_service_label" == "$img_expect_service" ]] || continue
    attached_or_unknown "ancestor=$img_id" && continue

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

    # SMI-7089: a tag is only a name. `P-test` can be retagged onto another
    # project's image, so the project the IMAGE says it belongs to must be P.
    if [[ "$img_project_label" != "$project" ]]; then
        echo "UNCONFIRMED project: $img (its image says project '${img_project_label:-<none>}', not '$project' -- report only, never deleted)"
        continue
    fi

    worktree_lifecycle_delete "$main_repo" "$project" "$DRY_RUN" image "$img" "$img_id" || OP_FAILED=true
done <<< "$img_list"

if [[ "$LISTING_FAILED" == true || "$OP_FAILED" == true ]]; then
    exit 1
fi
