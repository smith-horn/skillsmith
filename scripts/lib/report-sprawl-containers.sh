#!/usr/bin/env bash
# report-sprawl-containers.sh - report_containers(), sourced by
# prune-orphaned-docker-volumes.sh (split out to keep that file under the
# 500-line gate). Read-only: lists live-old, excessive and orphaned Skillsmith
# dev containers and mutates nothing.
#
# Depends on the sourcing script's enumerate_worktree_paths() and $main_repo,
# resolved at CALL time, so this file only defines a function.

report_containers() {
    local max_age="${SKILLSMITH_CONTAINER_SPRAWL_MAX_AGE_HOURS:-24}"
    local max_count="${SKILLSMITH_CONTAINER_SPRAWL_MAX_COUNT:-3}"
    [[ "$max_age" =~ ^[0-9]+$ ]] || max_age=24
    [[ "$max_count" =~ ^[0-9]+$ ]] || max_count=3

    local worktrees now count=0 shown=0 ids
    # A failed enumeration would make every owned container read "orphaned".
    if ! worktrees="$(enumerate_worktree_paths)"; then
        echo "Skillsmith container inventory: worktree enumeration failed -- not classifying"
        return 0
    fi
    # A failed listing must not read as "zero containers, all clean".
    if ! ids="$(docker ps -q \
        --filter 'label=app.skillsmith.owned=true' \
        --filter 'label=com.docker.compose.service=dev' 2>/dev/null)"; then
        echo "Skillsmith container inventory: could not list containers (docker ps failed) -- not classifying"
        return 1
    fi
    now="$(date +%s)"
    local -a findings=()
    local id name created created_ts path created_epoch age_hours class normalized

    while IFS= read -r id; do
        [[ -n "$id" ]] || continue
        name="$(docker inspect "$id" --format '{{.Name}}' 2>/dev/null | sed 's#^/##' || true)"
        created="$(docker inspect "$id" --format '{{.Created}}' 2>/dev/null || true)"
        path="$(docker inspect "$id" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
        [[ -n "$name" && -n "$created" && -n "$path" && "$path" = /* ]] || continue
        count=$((count + 1))
        normalized="$(cd "$path" 2>/dev/null && pwd -P || printf '%s' "$path")"
        # Docker's `Created` is UTC. BSD `date -j -f` reads the string as LOCAL
        # time, which skewed the age by the TZ offset (8h in PDT), so pin TZ=UTC.
        # The fractional part and trailing Z are dropped first (BSD date warns on Z).
        created_ts="${created%%.*}"
        created_ts="${created_ts%Z}"
        if TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "$created_ts" +%s >/dev/null 2>&1; then
            created_epoch="$(TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "$created_ts" +%s)"
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
    done <<< "$ids"

    if (( count > max_count )); then
        # shellcheck disable=SC2154  # main_repo is set by the sourcing script
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
