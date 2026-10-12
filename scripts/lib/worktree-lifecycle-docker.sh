#!/usr/bin/env bash
# worktree-lifecycle-docker.sh - the Docker-state reads of the orphan pruner and
# the in-lock gate (SMI-6981). Sourced by prune-orphaned-docker-volumes.sh after
# lib/worktree-lifecycle.sh, whose worktree_lifecycle_delete calls _wtl_gate;
# defines functions only.

# _wtl_dk ARGS... -- run `docker ARGS`, stdout+stderr on stdout, docker's own
# status. Inside the critical section (the lock is held) the call goes through
# the supervisor, bounded by SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT (default 60 s, the
# delete's timeout): a hung inspect must not hold the lock. The supervisor passes
# stdout and the exit status through unchanged (124 = timed out, 128+n = signal),
# so parsing is identical either way. At selection (lock not held) it is direct.
# Worst case inside the section, T = that timeout, each call up to T + 2 s grace:
# a volume is 2 gate calls + the delete, an image 3 + the delete, so an image
# holds the lock at most 4 * (T + 2) = 248 s at the default (a creator waiting
# the default 120 s for the lock then reports it busy and creates nothing).
_wtl_dk() {
    if [[ "${WORKTREE_LIFECYCLE_LOCK_HELD:-0}" == 1 ]]; then
        worktree_lifecycle_bounded "$(_wtl_uint_env SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT 60)" docker "$@" 2>&1
    else
        docker "$@" 7<&- </dev/null 2>&1
    fi
}

# worktree_lifecycle_volume_state NAME -- ONE `docker volume inspect` printed as
# "<CreatedAt>|<compose volume label>|<compose project label>|<owned label>"; on
# failure prints the reason and returns docker's status (124 = timed out) or 1 if
# the output does not parse. Selection takes its predicates (shape, project,
# ownership) AND its identity (CreatedAt) from this one result, so they describe
# the same incarnation. CreatedAt is the identity: Docker has no volume ID or
# compare-and-delete, but a volume re-created under the same name gets a new
# CreatedAt (measured, docker 29.7.2), at ONE-SECOND resolution: a same-second
# replacement is invisible.
worktree_lifecycle_volume_state() {
    local out rc
    if out="$(_wtl_dk volume inspect "$1" --format '{{.CreatedAt}}|{{index .Labels "com.docker.compose.volume"}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "app.skillsmith.owned"}}')"; then
        :
    else
        rc=$?
        printf '%s' "$out"
        return "$rc"
    fi
    if [[ ! "$out" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^|]*\|[^|]*\|[^|]*\|[^|]*$ ]]; then
        printf 'unparseable inspect output: %s' "$out"
        return 1
    fi
    printf '%s' "$out"
}

# worktree_lifecycle_image_id TAG -- prints the immutable image ID the tag
# resolves to now; on failure prints the reason and returns docker's status (124 =
# timed out), or 1 if the output is not a sha256 ID.
worktree_lifecycle_image_id() {
    local out rc
    if out="$(_wtl_dk image inspect "$1" --format '{{.Id}}')"; then
        :
    else
        rc=$?
        printf '%s' "$out"
        return "$rc"
    fi
    if [[ ! "$out" =~ ^sha256:[0-9a-f]{64}$ ]]; then
        printf 'unparseable image ID: %s' "$out"
        return 1
    fi
    printf '%s' "$out"
}

# worktree_lifecycle_image_labels ID -- ONE read of an image's whole label map as
# JSON (`null` when the image has none), printed on success; on failure prints the
# reason and returns docker's status (124 = timed out), or 1 if the output is
# neither `null` nor an object. SMI-7089: read once as JSON and parsed, never
# inferred from a template error -- a six-field template failed on an unlabelled
# image where one-field ones did not, so "unlabelled" is only ever what the JSON
# says, not what a failed template implies.
worktree_lifecycle_image_labels() {
    local out rc
    if out="$(_wtl_dk image inspect "$1" --format '{{json .Config.Labels}}')"; then
        :
    else
        rc=$?
        printf '%s' "$out"
        return "$rc"
    fi
    if [[ "$out" != null && ! "$out" =~ ^\{.*\}$ ]]; then
        printf 'unparseable image labels: %s' "$out"
        return 1
    fi
    printf '%s' "$out"
}

# worktree_lifecycle_json_label JSON KEY -- the string value of KEY in a flat
# label map, empty if absent. The needle includes the quotes, the colon and the
# opening quote of the value, so it cannot match inside another label's value
# (those quotes are backslash-escaped in the JSON) or as the tail of a longer key.
worktree_lifecycle_json_label() {
    local json="$1" needle rest
    needle="\"$2\":\""
    rest="${json#*"$needle"}"
    [[ "$rest" != "$json" ]] || return 0
    printf '%s' "${rest%%\"*}"
}

# _wtl_gate_fail WHAT STATUS DETAIL -- the stop message for an in-lock Docker
# call that did not answer: names the call and the object.
_wtl_gate_fail() {
    case "$2" in
        124) echo "$1 under the worktree lifecycle lock timed out after $(_wtl_uint_env SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT 60)s -- deleting nothing further." ;;
        12[89]|1[3-9][0-9]) echo "$1 under the worktree lifecycle lock was interrupted (status $2) -- deleting nothing further." ;;
        *) echo "$1 under the worktree lifecycle lock failed (exit $2: ${3:-no output}) -- deleting nothing further." ;;
    esac
}

# _wtl_gate KIND NAME EXPECT -- the Docker re-inspect INSIDE the critical section,
# the last checks before the delete. EXPECT is the volume's CreatedAt or the
# image's ID captured at selection. Returns 0 to proceed (an image's delete
# target is left in _WTL_RM_TARGET) or 1 to SKIP with the reason in _WTL_SKIP. A
# call that cannot run, parse, or finish within the timeout stops the whole run
# via error() (the kernel then releases the lock), like a failed delete. A
# mismatch SKIPS only that candidate: nothing was deleted and the object now
# there is not ours to touch.
# Coverage starts at IDENTITY CAPTURE (selection), where every Docker-observed
# predicate (volume: shape, project, ownership; image: service, ownership,
# attachment) was judged on the captured identity; an image's project/scope
# comes from the tag name that was resolved to the ID. Images: deleted BY ID,
# only if the tag still resolves to it, it is owned and no container uses it.
# Volumes: only if CreatedAt is unchanged, still owned and unused. NOT covered:
# Docker ignores this lock, so a volume replaced between this inspect and
# `volume rm`, or re-created within the same second as the original, is deleted.
_wtl_gate() {
    local kind="$1" name="$2" expect="$3" state cur owned attached rc
    _WTL_SKIP=""
    _WTL_RM_TARGET="$name"
    if [[ "$kind" == volume ]]; then
        attached="$(_wtl_dk ps -aq --filter "volume=$name")" \
            || { rc=$?; error "$(_wtl_gate_fail "checking containers on volume $name" "$rc" "$attached")"; }
        [[ -z "$attached" ]] || { _WTL_SKIP="a container is attached"; return 1; }
        # Last: the incarnation read sits immediately before the delete.
        state="$(worktree_lifecycle_volume_state "$name")" \
            || { rc=$?; error "$(_wtl_gate_fail "re-inspecting volume $name" "$rc" "$state")"; }
        cur="${state%%|*}"
        owned="${state##*|}"
        if [[ "$cur" != "$expect" ]]; then
            _WTL_SKIP="it was re-created since selection (CreatedAt $expect -> $cur)"
            return 1
        fi
        if [[ "$owned" != true ]]; then
            _WTL_SKIP="it no longer carries app.skillsmith.owned=true"
            return 1
        fi
    else
        attached="$(_wtl_dk ps -aq --filter "ancestor=$expect")" \
            || { rc=$?; error "$(_wtl_gate_fail "checking containers on image $expect" "$rc" "$attached")"; }
        [[ -z "$attached" ]] || { _WTL_SKIP="a container is attached"; return 1; }
        owned="$(_wtl_dk image inspect "$expect" --format '{{index .Config.Labels "app.skillsmith.owned"}}')" \
            || { rc=$?; error "$(_wtl_gate_fail "re-inspecting image $expect" "$rc" "$owned")"; }
        if [[ "$owned" != true ]]; then
            _WTL_SKIP="image $expect no longer carries app.skillsmith.owned=true"
            return 1
        fi
        # Last: the tag must still resolve to the ID we will delete.
        cur="$(worktree_lifecycle_image_id "$name")" \
            || { rc=$?; error "$(_wtl_gate_fail "re-resolving image $name" "$rc" "$cur")"; }
        if [[ "$cur" != "$expect" ]]; then
            _WTL_SKIP="the tag now points at $cur, not the selected $expect"
            return 1
        fi
        _WTL_RM_TARGET="$expect"
    fi
    return 0
}
