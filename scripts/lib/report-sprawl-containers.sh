#!/usr/bin/env bash
# report-sprawl-containers.sh - report_containers(), sourced by
# prune-orphaned-docker-volumes.sh (split out to keep that file under the
# 500-line gate). Read-only: lists live-old, excessive and orphaned Skillsmith
# dev containers and mutates nothing.
#
# Depends on enumerate_worktree_paths() from lib/worktree-lifecycle.sh,
# resolved at CALL time, so this file only defines a function. The main
# checkout is an explicit argument: a bare call under `set -u` would fail
# inside the `$(...)` below and read as "enumeration failed", a silent pass.

# worktree_shared_projects WT_PATHS MAIN -- SMI-7089 (OD-5). Prints one
# "<project>\t<path>, <path>" line for every Compose project that two or more
# checkouts resolve to: registered worktrees (the listing in $1, main checkout
# included) plus unregistered `.worktrees/*/` directories under $2. Read-only.
# remove-worktree.sh and `worktree-docker.sh start|stop` REFUSE such a project, so
# this is how an operator finds them before trying to remove one. Needs only
# sanitize_project_name (_lib.sh).
worktree_shared_projects() {
    local wt_paths="$1" main="$2" entry d seen proj rows=""
    local -a registered=()
    while IFS= read -r entry; do
        [[ -n "$entry" ]] || continue
        registered+=("$entry")
        proj="$(sanitize_project_name "$(basename "$entry")")"
        [[ -n "$proj" ]] && rows+="${proj}"$'\t'"${entry}"$'\n'
    done <<< "$wt_paths"
    if [[ -d "$main/.worktrees" ]]; then
        for d in "$main"/.worktrees/*/; do
            [[ -d "$d" ]] || continue
            d="${d%/}"
            seen=0
            for entry in ${registered[@]+"${registered[@]}"}; do
                if [[ "$entry" -ef "$d" ]]; then
                    seen=1
                    break
                fi
            done
            [[ "$seen" -eq 1 ]] && continue
            proj="$(sanitize_project_name "$(basename "$d")")"
            [[ -n "$proj" ]] && rows+="${proj}"$'\t'"${d}"$'\n'
        done
    fi
    [[ -n "$rows" ]] || return 0
    printf '%s' "$rows" | sort | awk -F'\t' '
        { n[$1]++; list[$1] = (list[$1] == "" ? $2 : list[$1] ", " $2) }
        END { for (k in n) if (n[k] > 1) printf "%s\t%s\n", k, list[k] }' | sort
}

report_containers() {
    local main_repo="$1"
    local max_age="${SKILLSMITH_CONTAINER_SPRAWL_MAX_AGE_HOURS:-24}"
    local max_count="${SKILLSMITH_CONTAINER_SPRAWL_MAX_COUNT:-3}"
    [[ "$max_age" =~ ^[0-9]+$ ]] || max_age=24
    [[ "$max_count" =~ ^[0-9]+$ ]] || max_count=3

    local worktrees now count=0 shown=0 ids
    # A failed enumeration would make every owned container read "orphaned".
    if ! worktrees="$(enumerate_worktree_paths "$main_repo")"; then
        echo "Skillsmith container inventory: worktree enumeration failed -- not classifying"
        return 0
    fi
    local shared line
    shared="$(worktree_shared_projects "$worktrees" "$main_repo")"
    if [[ -n "$shared" ]]; then
        echo "Shared Compose projects (SMI-7089): these checkouts resolve to the SAME project, so remove-worktree.sh and worktree-docker.sh start/stop refuse them:"
        while IFS= read -r line; do
            printf '  %s: %s\n' "${line%%$'\t'*}" "${line#*$'\t'}"
        done <<< "$shared"
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
