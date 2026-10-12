#!/usr/bin/env bash
# worktree-project-attribution.sh - the Compose-project attribution check
# (SMI-7089, ADR-180 G5). Sourced by remove-worktree.sh and worktree-docker.sh;
# defines functions only. Requires _lib.sh (error, sanitize_project_name,
# get_main_git_dir) and lib/worktree-lifecycle.sh (enumerate_worktree_paths,
# worktree_lifecycle_bounded, is_own_non_worktree_project) sourced first.
#
# WHY. A Compose project name is COMPUTED from a directory basename, so two
# directories can resolve to the same project (`_foo`, `-foo` and `foo` all give
# `foo`). Every project-scoped Compose call (`up`, and the old `down`) acts on ALL of
# the project's containers, networks and volumes, whichever directory created them.
# Three callers act on checkout X's project: remove-worktree.sh and
# worktree-docker.sh stop (they now remove EXACTLY the container IDs U6 approved,
# never `compose down`) and worktree-docker.sh start (`up`, rechecked right before).
# Each must first show that
# nothing it can SEE shares X's project, and refuse -- changing nothing -- when it
# cannot.
#
# THIS IS A FAIL-CLOSED ATTRIBUTION CHECK, NOT A PROOF OF UNIQUENESS. It passes
# only when ALL of these hold; any unreadable input refuses:
#   R0  docker is reachable (`docker info`, bounded). In docker-optional mode
#       (remove-worktree.sh) a missing binary or unreachable daemon instead skips
#       U5/U6 and every Docker step; docker-required mode refuses.
#   U1  `git worktree list --porcelain` exited 0 and exactly ONE entry is the
#       same file (`-ef`, never a string compare) as X.
#   U2  no other registered entry, the main checkout included, sanitizes to P.
#   U3  no other `.worktrees/*/` directory sanitizes to P.
#   U4  P is not one of our own non-worktree projects.
#   U5  `docker compose config` run from X reports `.name == P`. Skipped only
#       when X holds no Compose file at all (no Compose call can then be made
#       from X).
#   U6  EVERY container (`ps -a`, running or stopped, not just the first) labelled
#       com.docker.compose.project=P has a working_dir label naming an existing
#       directory that is the same file as X. Labels are read once as JSON.
# It does NOT cover (ADR-180 G5): C6 a peer that has no container and is not in
# this repository's listing; C7 a plain `git worktree add` between this check and
# the Compose call; C8 the check runs outside the lifecycle lock; E3 a container
# for P started elsewhere between U6 and the call; E4 a container whose
# working_dir names X's path but was created by an earlier occupant of that path
# (a path label cannot prove which incarnation wrote it).

# Set by worktree_project_attribution_or_die for the caller:
#   reachable | absent | unreachable
WPA_DOCKER=""
# Set by worktree_project_attribution_or_die (and the recheck): the container IDs U6
# approved, one per line. The ONLY containers a caller may remove (CA-1).
WPA_CONTAINER_IDS=""
# The same containers as "<full id> <compose service label>" lines (service may be
# empty). The stop path keeps only the dev-profile services among them.
WPA_CONTAINER_SVCS=""
# Set by worktree_project_remove_approved: one "<network id or project>: <reason>"
# line per project network it could NOT clean up (listing failed, attachment query
# failed, still attached, `network rm` refused). Empty = network cleanup complete.
WPA_NETWORK_INCOMPLETE=""

_wpa_timeout() { _wtl_uint_env SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT 60; }

# stdin: `docker compose config --format json`. stdout: the project name.
_wpa_json_name() {
    node -e '
let d = "";
process.stdin.on("data", (c) => { d += c; }).on("end", () => {
  let j;
  try { j = JSON.parse(d); } catch (e) { process.exit(2); }
  if (j === null || typeof j !== "object" || typeof j.name !== "string" || j.name === "") process.exit(3);
  process.stdout.write(j.name);
});'
}

# stdin: `{{json .Config.Labels}}`. stdout: the working_dir label. Exit 2
# unparseable, 3 null/not an object (no labels), 4 label missing/empty/<no value>.
_wpa_json_workdir() {
    node -e '
let d = "";
process.stdin.on("data", (c) => { d += c; }).on("end", () => {
  let j;
  try { j = JSON.parse(d); } catch (e) { process.exit(2); }
  if (j === null || typeof j !== "object" || Array.isArray(j)) process.exit(3);
  const v = j["com.docker.compose.project.working_dir"];
  if (typeof v !== "string" || v === "" || v === "<no value>") process.exit(4);
  process.stdout.write(v);
});'
}

# stdin: `{{json .Config.Labels}}`. stdout: the compose service label (may be empty).
_wpa_json_service() {
    node -e '
let d = "";
process.stdin.on("data", (c) => { d += c; }).on("end", () => {
  let j;
  try { j = JSON.parse(d); } catch (e) { process.exit(2); }
  const v = j && typeof j === "object" ? j["com.docker.compose.service"] : "";
  process.stdout.write(typeof v === "string" && /^[A-Za-z0-9_.-]*$/.test(v) ? v : "");
});'
}

# worktree_project_peers MAIN X P -- U1-U4. Prints one "reason|detail" line per
# peer. Returns 0 (zero or more peer lines), 1 the listing failed, 2 X is not
# listed exactly once, 3 MAIN/.worktrees exists but cannot be read. Never calls error(), so it is safe in a $(...) capture.
worktree_project_peers() {
    local main="$1" x="$2" p="$3" raw entry base d seen found=0
    local -a registered=()
    raw="$(enumerate_worktree_paths "$main")" || return 1
    worktree_lifecycle_worktrees_dir_readable "$main" || return 3
    while IFS= read -r entry; do
        [[ -z "$entry" ]] && continue
        registered+=("$entry")
        if [[ "$entry" -ef "$x" ]]; then
            found=$((found + 1))
            continue
        fi
        base="$(sanitize_project_name "$(basename "$entry")")"
        [[ "$base" == "$p" ]] || continue
        if [[ "$entry" -ef "$main" ]]; then
            printf 'main checkout|%s\n' "$entry"
        else
            printf 'registered worktree|%s\n' "$entry"
        fi
    done <<< "$raw"
    [[ "$found" -eq 1 ]] || return 2

    while IFS= read -r -d '' d; do
        [[ "$d" -ef "$x" ]] && continue
        seen=0
        for entry in ${registered[@]+"${registered[@]}"}; do
            if [[ "$entry" -ef "$d" ]]; then
                seen=1
                break
            fi
        done
        [[ "$seen" -eq 1 ]] && continue
        base="$(sanitize_project_name "$(basename "$d")")"
        if [[ "$base" == "$p" ]]; then
            printf 'unregistered .worktrees directory|%s\n' "$d"
        fi
    done < <(worktree_lifecycle_worktrees_dirs "$main")
    if is_own_non_worktree_project "$p"; then
        printf 'own non-worktree Compose project|%s\n' "$p"
    fi
    return 0
}

# worktree_project_docker_check X P -- U5 and U6. On refusal prints the reason on
# stdout and returns 1. On a pass prints the APPROVED containers (every container of
# the project, running or stopped, each shown to come from X) as "<full id> <service>"
# lines and returns 0. IDs are listed with --no-trunc: Docker resolves a reference as
# a full ID first, then an exact NAME, then an ID prefix, so a container NAMED like a
# 12-hex short ID could otherwise be inspected or removed in place of the real one. Every Docker call is bounded. Never calls error().
worktree_project_docker_check() {
    local x="$1" p="$2" t cfg name ids id labels wd rc svc approved=""
    t="$(_wpa_timeout)"
    command -v node >/dev/null 2>&1 || { echo "node is required to read Docker's JSON output and was not found on PATH"; return 1; }

    if [[ -f "$x/docker-compose.yml" || -f "$x/docker-compose.override.yml" ]]; then
        if ! cfg="$(cd "$x" && worktree_lifecycle_bounded "$t" docker compose config --format json 2>/dev/null)"; then
            echo "could not read the Compose configuration for $x (docker compose config failed or timed out)"
            return 1
        fi
        if name="$(printf '%s' "$cfg" | _wpa_json_name)"; then :; else
            echo "could not parse the Compose configuration for $x (no project name in the output)"
            return 1
        fi
        if [[ "$name" != "$p" ]]; then
            echo "Compose resolves the project '$name' for $x, not '$p'"
            return 1
        fi
    fi

    if ! ids="$(worktree_lifecycle_bounded "$t" docker ps -aq --no-trunc --filter "label=com.docker.compose.project=$p" 2>/dev/null)"; then
        echo "could not list the containers of project '$p' (docker ps failed or timed out)"
        return 1
    fi
    while IFS= read -r id; do
        [[ -z "$id" ]] && continue
        if ! labels="$(worktree_lifecycle_bounded "$t" docker inspect --type container "$id" --format '{{json .Config.Labels}}' 2>/dev/null)"; then
            echo "could not inspect container $id of project '$p'"
            return 1
        fi
        if wd="$(printf '%s' "$labels" | _wpa_json_workdir)"; then :; else
            rc=$?
            echo "container $id of project '$p' has no readable com.docker.compose.project.working_dir label (parse status $rc), so it cannot be attributed to $x"
            return 1
        fi
        if [[ ! -d "$wd" ]]; then
            echo "container $id of project '$p' names a working_dir that no longer exists ($wd), so it cannot be attributed to $x"
            return 1
        fi
        if ! [[ "$wd" -ef "$x" ]]; then
            echo "container $id of project '$p' was created from $wd, not $x"
            return 1
        fi
        svc="$(printf '%s' "$labels" | _wpa_json_service)" || svc=""
        approved+="$id $svc"$'\n'
    done <<< "$ids"
    printf '%s' "$approved"
    return 0
}

# Refusal text for a shared project. $1 = X, $2 = P, $3 = the peer lines, $4 = mode.
_wpa_peer_message() {
    local x="$1" p="$2" peers="$3" mode="$4" line
    printf 'The Compose project %s is not unique to %s, so a project-scoped Docker call from it would act on another checkout too (SMI-7089). Nothing was changed.\n\nOther checkouts that resolve to the same project:\n' "$p" "$x"
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        printf '  - %s: %s\n' "${line%%|*}" "${line#*|}"
    done <<< "$peers"
    if [[ "$mode" == docker-optional ]]; then
        printf '\nTo remove just this worktree safely:\n  1. List its own containers: docker ps -aq --no-trunc --filter label=com.docker.compose.project=%s -- keep only those whose com.docker.compose.project.working_dir label is %s, and docker rm -f those IDs.\n  2. git worktree remove --force %s\n  3. Leave the project'"'"'s volumes, image and network alone: they are shared with the other checkout.\n' "$p" "$x" "$x"
    fi
}

# _wpa_record_approved LINES -- split the check's "<id> <service>" lines into
# WPA_CONTAINER_SVCS (as is) and WPA_CONTAINER_IDS (first column).
_wpa_record_approved() {
    local line
    WPA_CONTAINER_SVCS="$1"
    WPA_CONTAINER_IDS=""
    while IFS= read -r line; do
        [[ -n "$line" ]] && WPA_CONTAINER_IDS+="${line%% *}"$'\n'
    done <<< "$1"
    return 0
}

# worktree_project_attribution_or_die MAIN X P MODE
#   MODE = docker-optional (remove-worktree.sh) | docker-required (worktree-docker.sh)
# Runs R0, then U1-U4, then U5, then U6 (see the header). On any failure it calls
# error(), which exits the script BEFORE the caller's first side effect. Call it
# as a plain statement, never inside $(...): error() inside a substitution only
# ends the subshell. R0 runs first so every refusal leaves a `docker info` call.
worktree_project_attribution_or_die() {
    local main="$1" x="$2" p="$3" mode="$4" t rc peers reason real realp
    WPA_DOCKER=""
    WPA_CONTAINER_IDS=""
    WPA_CONTAINER_SVCS=""
    [[ -n "$main" && -d "$main" ]] || error "could not resolve the main checkout for $x -- refusing: without it the Compose project cannot be attributed (SMI-7089). Nothing was changed."
    if [[ -z "$p" ]]; then
        if [[ "$mode" == docker-optional ]]; then
            error "the directory name of $x sanitizes to an empty Compose project name -- refusing: it cannot be attributed (SMI-7089). Nothing was changed. No Compose project can exist for an empty name, so there is nothing for Docker to clean up. Check that the worktree has nothing to lose (git -C $x status --porcelain), then remove it with git directly: git worktree remove --force $x"
        else
            error "the directory name of $x sanitizes to an empty Compose project name -- refusing: it cannot be attributed (SMI-7089). Nothing was changed. Rename the worktree so its name has letters or digits (git worktree move $x <new-path>), then retry."
        fi
    fi

    # Compose names the project from the path AS INVOKED. A symlinked checkout path
    # therefore gives one directory two project names (measured), and the
    # attribution below would be about the wrong one. Refuse; the real path is the
    # one every other tool sees.
    real="$(cd "$x" 2>/dev/null && pwd -P)" || error "could not resolve the real path of $x -- refusing (SMI-7089). Nothing was changed."
    realp="$(sanitize_project_name "$(basename "$real")")"
    if [[ "$realp" != "$p" ]]; then
        error "$x is a symlink: invoked by that path its Compose project is '$p', but its real path $real names the project '${realp:-<empty>}' -- refusing: the project cannot be attributed (SMI-7089). Nothing was changed. Use the real path: $real"
    fi

    t="$(_wpa_timeout)"
    if ! command -v docker >/dev/null 2>&1; then
        WPA_DOCKER=absent
    elif worktree_lifecycle_bounded "$t" docker info >/dev/null 2>&1; then
        WPA_DOCKER=reachable
    else
        WPA_DOCKER=unreachable
    fi
    if [[ "$WPA_DOCKER" != reachable && "$mode" != docker-optional ]]; then
        error "Docker is not available (docker is $WPA_DOCKER) -- refusing: the Compose project '$p' cannot be attributed to $x (SMI-7089). Nothing was changed."
    fi

    if peers="$(worktree_project_peers "$main" "$x" "$p")"; then rc=0; else rc=$?; fi
    case "$rc" in
        0) ;;
        1) error "\`git worktree list\` failed -- refusing: a partial listing could hide a checkout that shares the Compose project '$p' (SMI-7089). Nothing was changed." ;;
        3) error "$main/.worktrees exists but cannot be read and searched -- refusing: a directory that cannot be listed would read as \"no other checkout shares the Compose project '$p'\" (SMI-7089). Nothing was changed." ;;
        2) error "$x is not listed exactly once by \`git worktree list\` (it is not a registered worktree of $main, or it is listed twice) -- refusing: the Compose project '$p' cannot be attributed to it (SMI-7089). Nothing was changed." ;;
        *) error "worktree attribution failed with an unexpected status ($rc) -- refusing (SMI-7089). Nothing was changed." ;;
    esac
    if [[ -n "$peers" ]]; then
        error "$(_wpa_peer_message "$x" "$p" "$peers" "$mode")"
    fi

    if [[ "$WPA_DOCKER" == reachable ]]; then
        if reason="$(worktree_project_docker_check "$x" "$p")"; then
            _wpa_record_approved "$reason"
        else
            error "$reason -- refusing: the Compose project '$p' cannot be attributed to $x (SMI-7089). Nothing was changed."
        fi
    fi
}

# worktree_project_recheck_for_path X -- U5+U6 again, for a caller whose first check
# is stale by the time it acts (worktree-docker.sh start, right before `up`). Dies
# on a refusal; refreshes WPA_CONTAINER_IDS. Docker must be reachable.
worktree_project_recheck_for_path() {
    local x="$1" p reason
    p="$(sanitize_project_name "$(basename "$x")")"
    if reason="$(worktree_project_docker_check "$x" "$p")"; then
        _wpa_record_approved "$reason"
    else
        error "$reason -- refusing: the Compose project '$p' no longer attributes to $x since the first check (SMI-7089). Nothing was started."
    fi
}

# worktree_path_inside DIR TREE -- 0 when DIR is TREE or anywhere below it. Walks the
# ancestors of DIR and compares each to TREE with `-ef` (same file), so it holds on a
# case-insensitive filesystem (pwd -P keeps the typed case) and a sibling `x2` is not
# "inside" `x`.
worktree_path_inside() {
    local d tree="$2"
    d="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
    while :; do
        [[ "$d" -ef "$tree" ]] && return 0
        [[ "$d" == / || "$d" == . || -z "$d" ]] && return 1
        d="$(dirname "$d")"
    done
}

# worktree_project_remove_approved P [X] -- remove EXACTLY the containers U6 approved
# (WPA_CONTAINER_IDS, full IDs), then the project's networks that nothing uses.
# Replaces `compose down`, which acts on whatever the project holds at the moment it
# runs: container IDs are never reused, so a container another checkout starts after
# U6, or one from a checkout re-created at the same path, cannot be touched. No
# approved ID -> no `rm` call. `rm -f` failing is FATAL (error(): the caller's
# worktree stays, exit 1, IDs named).
# With X (the `stop` path) only the approved containers whose compose service is one
# of the DEV PROFILE's are removed -- what `compose --profile dev down` used to act
# on. The main checkout's project also holds the machine-shared `ruflo` service and
# the `test` profile; those must survive a `stop`. The set comes from Compose
# (`--profile dev config --services`); an unreadable answer REFUSES (nothing removed).
# remove-worktree.sh passes no X: a worktree's own containers all go, and its project
# can never be the main checkout's (U2 refuses a worktree that shares main's project).
# A network is removed by ID only when NO container, running or not, is attached to
# it (`ps -a --filter network=`): Docker itself refuses only while an ACTIVE endpoint
# exists, so a created/exited container would otherwise silently lose its network.
# A skipped or refused network is never forced and never aborts here (an attached
# network may belong to another checkout's container): it is warned about AND
# recorded in WPA_NETWORK_INCOMPLETE, and the caller must turn that into an
# incomplete (non-zero) outcome. Container-removal failure stays fatal (error()).
worktree_project_remove_approved() {
    local p="$1" x="${2:-}" t id svc nets users devsvcs line
    WPA_NETWORK_INCOMPLETE=""
    local -a idv=()
    t="$(_wpa_timeout)"
    if [[ -n "$x" ]]; then
        if ! devsvcs="$(cd "$x" && worktree_lifecycle_bounded "$t" docker compose --profile dev config --services 2>/dev/null)" || [[ -z "$devsvcs" ]]; then
            error "could not read which Compose services belong to the dev profile for $x -- refusing to remove any container (SMI-7089): without that set the main checkout's shared services (ruflo) and test profile could be removed. Nothing was changed."
        fi
        while IFS= read -r line; do
            id="${line%% *}"
            svc="${line#* }"
            [[ -n "$id" ]] || continue
            if printf '%s\n' "$devsvcs" | grep -qxF -- "$svc"; then
                idv+=("$id")
            else
                info "  Leaving container $id running: its service '${svc:-<none>}' is not in the dev profile"
            fi
        done <<< "$WPA_CONTAINER_SVCS"
    else
        while IFS= read -r id; do
            [[ -n "$id" ]] && idv+=("$id")
        done <<< "$WPA_CONTAINER_IDS"
    fi
    if [[ "${#idv[@]}" -gt 0 ]]; then
        info "Stopping and removing the project's approved containers..."
        if ! worktree_lifecycle_bounded "$t" docker rm -f "${idv[@]}" >/dev/null 2>&1; then
            error "could not remove the approved container(s) of Compose project '$p': ${idv[*]} -- stopping here (SMI-7089): nothing else was changed. Inspect them with: docker ps -a --no-trunc --filter label=com.docker.compose.project=$p"
        fi
        success "  Removed ${#idv[@]} container(s)"
    fi
    if ! nets="$(worktree_lifecycle_bounded "$t" docker network ls --filter "label=com.docker.compose.project=$p" --format '{{.ID}}' 2>/dev/null)"; then
        warn "  Could not list the project's networks (continuing)"
        WPA_NETWORK_INCOMPLETE+="project $p: could not list its networks"$'\n'
        return 0
    fi
    while IFS= read -r id; do
        [[ -n "$id" ]] || continue
        if ! users="$(worktree_lifecycle_bounded "$t" docker ps -aq --no-trunc --filter "network=$id" 2>/dev/null)"; then
            warn "  Network $id skipped: could not check which containers use it"
            WPA_NETWORK_INCOMPLETE+="$id: could not check which containers use it"$'\n'
        elif [[ -n "$users" ]]; then
            warn "  Network $id left in place: container(s) still attached ($(printf '%s' "$users" | tr '\n' ' '))"
            WPA_NETWORK_INCOMPLETE+="$id: still used by $(printf '%s' "$users" | tr '\n' ' ')"$'\n'
        elif ! worktree_lifecycle_bounded "$t" docker network rm "$id" >/dev/null 2>&1; then
            warn "  Network $id was not removed (Docker refused); left in place"
            WPA_NETWORK_INCOMPLETE+="$id: docker network rm was refused"$'\n'
        fi
    done <<< "$nets"
    return 0
}

# worktree_project_gate_for_path X MODE -- the same check for a caller that holds
# only a checkout path (worktree-docker.sh). Resolves the main checkout and the
# project itself; an unresolvable main checkout refuses.
worktree_project_gate_for_path() {
    local x="$1" mode="$2" main_git main p
    main_git="$(get_main_git_dir "$x" 2>/dev/null || true)"
    [[ -n "$main_git" ]] || error "could not resolve the main checkout of $x -- refusing (SMI-7089). Nothing was changed."
    main="$(dirname "$main_git")"
    main="$(cd "$main" 2>/dev/null && pwd -P)" || error "could not resolve the main checkout of $x -- refusing (SMI-7089). Nothing was changed."
    p="$(sanitize_project_name "$(basename "$x")")"
    worktree_project_attribution_or_die "$main" "$x" "$p" "$mode"
}
