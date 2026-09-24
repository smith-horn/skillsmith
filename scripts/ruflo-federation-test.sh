#!/usr/bin/env bash
# scripts/ruflo-federation-test.sh -- ADR-170
# (docs/internal/adr/170-ruflo-mcp-server-tree-store-and-topology.md) SS8's
# "Required test, two checkouts, both cases, checking more than
# containers."
#
# Needs a live Docker daemon and STOPS the shared service (case B removes
# skillsmith-ruflo-1 before restoring it): run it from a broadcast window,
# never from a worker. Lint-checked in CI (validate-hooks.yml: bash -n and
# a warning-level shellcheck pass).
#
# Usage: scripts/ruflo-federation-test.sh <checkout-1-path> <checkout-2-path>
#
# Checkout shape (H-3(b), post-merge governance retro on PR #2931):
# ruflo-service-up.sh refuses a LINKED git worktree and an unversioned tree,
# so checkout 1 must be the MAIN checkout and checkout 2 an independent
# clone with its own .git -- `git clone --shared <main-checkout> <dir>`,
# checked out at the commit under test -- never a worktree of the same repo
# and never a bare export. Precondition 0b below refuses either shape up
# front so the failure never surfaces as a confusing case-B refusal.
#
# Asserts, in order (ADR-170 SS8):
#   0. the two checkouts resolve to DIFFERENT Compose project names -- "if
#      both resolve to one project, the second start reconciles the
#      existing service instead of colliding, and the first case proves
#      nothing" (SS8).
#   A. with checkout 1's container RUNNING: checkout 2's `up` fails on the
#      container-name collision (skillsmith-ruflo-1 is a fixed name, SS3),
#      AND the shared skillsmith-ruflo-data volume's Name/CreatedAt/label
#      are unchanged by the failed attempt -- SS8's own H5 measured that a
#      failed `up` still creates project-scoped side effects (a network,
#      previously also a volume before `external: true`), so this checks
#      networks and volumes, not only container state.
#   B. with checkout 1's container REMOVED: checkout 2's `up` attaches the
#      SAME volume (Name/CreatedAt/label equality against the pre-recorded
#      baseline) and the entrypoint's version line appears in `docker logs`.
#
# bash 3.2-safe. Lint-clean under `shellcheck -S warning`.
set -euo pipefail

VOLUME_NAME="skillsmith-ruflo-data"
CONTAINER_NAME="skillsmith-ruflo-1"
LABEL_KEY="app.skillsmith.ruflo.instance"

log() { echo "[ruflo-federation] $*"; }
# L-19: a literal `\n` in a plain `echo` argument is NOT a newline -- `%b`
# (not `%s`) makes printf expand it, same as `echo -e` would, so the two
# multi-line FAIL messages below (case A's unexpected success, case B's
# missing version line) render as real newlines instead of a literal
# backslash-n. $* is supplied as %b's DATA argument, never re-parsed as a
# format string itself, so a stray `%` inside a docker log line is safe.
fail() { printf '%b\n' "[ruflo-federation] FAIL: $*" >&2; exit 1; }
pass() { echo "[ruflo-federation] PASS: $*"; }

usage() {
    echo "Usage: $0 <checkout-1-path> <checkout-2-path>" >&2
    exit 2
}

[[ $# -eq 2 ]] || usage
CHECKOUT_1="$(cd "$1" && pwd)"
CHECKOUT_2="$(cd "$2" && pwd)"
[[ -f "$CHECKOUT_1/docker-compose.yml" ]] || fail "no docker-compose.yml under $CHECKOUT_1"
[[ -f "$CHECKOUT_2/docker-compose.yml" ]] || fail "no docker-compose.yml under $CHECKOUT_2"
[[ -x "$CHECKOUT_1/scripts/ruflo-service-up.sh" ]] || fail "missing $CHECKOUT_1/scripts/ruflo-service-up.sh"
# L-19: case B was calling a bare `docker compose ... up -d ruflo` for checkout
# 2, skipping ruflo-service-up.sh's volume-creation/authority-quad checks
# AND its RUFLO_SEED_EXPECTED_DIGEST export -- the entrypoint then refused on
# an empty digest and the "serving @claude-flow/cli@" grep could never match.
[[ -x "$CHECKOUT_2/scripts/ruflo-service-up.sh" ]] || fail "missing $CHECKOUT_2/scripts/ruflo-service-up.sh"
# L-19: project_name() below shells out to jq -- fail with a clear reason up
# front rather than a bare "jq: command not found" surfacing mid-run.
command -v jq >/dev/null 2>&1 || fail "jq is required (project_name() parses 'docker compose config --format json' with it) but was not found on PATH"

project_name() {
    local checkout="$1"
    (cd "$checkout" && docker compose -f docker-compose.yml config --format json 2>/dev/null | jq -r '.name // empty')
}

# L-19: `docker rm -f skillsmith-ruflo-1` in case B below destroys the
# SHARED service (every session's launcher targets this fixed container
# name) with no restoration -- registered as early as possible so ANY exit
# path (a case A/B assertion failing under `set -e`, or normal completion)
# leaves checkout 1's service running again rather than torn down.
# Registered before the preconditions (L-19) but ARMED only by the body, right
# before its first docker call that can change the service: on 2026-09-24
# three precondition probes of this script, each exiting before any docker
# call, still ran the unconditional `docker rm -f` below and recreated the
# live shared service three times. A refusal that touched nothing restores
# nothing.
SERVICE_TOUCHED=0
restore_checkout_1() {
    local rc=0
    if [[ "$SERVICE_TOUCHED" -ne 1 ]]; then
        log "EXIT trap: the service was never touched (a precondition refused first) -- nothing to restore"
        return 0
    fi
    log "EXIT trap: removing checkout 2's container (if present) and re-running $CHECKOUT_1/scripts/ruflo-service-up.sh to restore the shared service"
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    if "$CHECKOUT_1/scripts/ruflo-service-up.sh" >/tmp/ruflo-federation-restore.log 2>&1; then
        log "restoration: checkout 1's service is back up"
    else
        rc=$?
        echo "[ruflo-federation] RESTORATION FAILED (exit $rc) -- the shared skillsmith-ruflo-1 service may be left down. See /tmp/ruflo-federation-restore.log and re-run: $CHECKOUT_1/scripts/ruflo-service-up.sh" >&2
    fi
}
trap restore_checkout_1 EXIT

volume_snapshot() {
    # Name|CreatedAt|instance-label, joined so a single string compare
    # catches drift in any one field.
    local name created label
    name="$(docker volume inspect "$VOLUME_NAME" --format '{{.Name}}' 2>/dev/null || echo '<absent>')"
    created="$(docker volume inspect "$VOLUME_NAME" --format '{{.CreatedAt}}' 2>/dev/null || echo '<absent>')"
    label="$(docker volume inspect "$VOLUME_NAME" --format "{{index .Labels \"$LABEL_KEY\"}}" 2>/dev/null || echo '<absent>')"
    echo "$name|$created|$label"
}

container_running() {
    [[ "$(docker inspect "$CONTAINER_NAME" --format '{{.State.Running}}' 2>/dev/null || echo false)" == "true" ]]
}

# ---- 0b. both checkouts have the shape ruflo-service-up.sh accepts ----
# Mirrors check_not_linked_worktree() in scripts/ruflo-service-up.helpers.sh:
# git-dir == git-common-dir (a main checkout or an independent clone), and
# both resolvable (a real git checkout, not an export).
checkout_shape_ok() {
    local dir="$1" gdir cdir
    gdir="$(git -C "$dir" rev-parse --git-dir 2>/dev/null || true)"
    cdir="$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null || true)"
    [[ -n "$gdir" && -n "$cdir" ]] || return 1
    case "$gdir" in /*) : ;; *) gdir="$dir/$gdir" ;; esac
    case "$cdir" in /*) : ;; *) cdir="$dir/$cdir" ;; esac
    gdir="$(cd "$gdir" 2>/dev/null && pwd -P || printf '%s' "$gdir")"
    cdir="$(cd "$cdir" 2>/dev/null && pwd -P || printf '%s' "$cdir")"
    [[ "$gdir" == "$cdir" ]]
}
checkout_shape_ok "$CHECKOUT_1" || fail "checkout 1 ($CHECKOUT_1) is a linked worktree or not a git checkout -- ruflo-service-up.sh refuses both (H-3(b)); pass the MAIN checkout"
checkout_shape_ok "$CHECKOUT_2" || fail "checkout 2 ($CHECKOUT_2) is a linked worktree or not a git checkout -- ruflo-service-up.sh refuses both (H-3(b)); use an independent clone: git clone --shared <main-checkout> <dir>"
pass "both checkouts have the shape ruflo-service-up.sh accepts (git-dir == git-common-dir)"

# ---- 0. distinct project names ----
PROJECT_1="$(project_name "$CHECKOUT_1")"
PROJECT_2="$(project_name "$CHECKOUT_2")"
log "checkout 1 ($CHECKOUT_1) Compose project: $PROJECT_1"
log "checkout 2 ($CHECKOUT_2) Compose project: $PROJECT_2"
[[ -n "$PROJECT_1" ]] || fail "could not resolve checkout 1's Compose project name"
[[ -n "$PROJECT_2" ]] || fail "could not resolve checkout 2's Compose project name"
if [[ "$PROJECT_1" == "$PROJECT_2" ]]; then
    fail "both checkouts resolve to the SAME Compose project name ($PROJECT_1) -- case A proves nothing under this condition (ADR-170 SS8)"
fi
pass "checkouts resolve to distinct Compose projects: '$PROJECT_1' != '$PROJECT_2'"

# ---- establish the baseline: bring checkout 1 up (also creates the volume
# on a machine where it does not exist yet) ----
log "bringing up checkout 1's service: $CHECKOUT_1/scripts/ruflo-service-up.sh"
SERVICE_TOUCHED=1
"$CHECKOUT_1/scripts/ruflo-service-up.sh"
container_running || fail "checkout 1's container is not running after ruflo-service-up.sh"
BASELINE_SNAPSHOT="$(volume_snapshot)"
log "baseline volume snapshot (Name|CreatedAt|label): $BASELINE_SNAPSHOT"

# ---- A. checkout 1 running: checkout 2's up must fail on the name collision ----
# L-19: export RUFLO_SEED_EXPECTED_DIGEST for THIS attempt too (from checkout
# 2's own committed digest file) so a missing/empty digest can never be a
# second, confounding reason for the up to fail -- the ONLY possible failure
# reason left is the container-name collision this case exists to prove.
CHECKOUT_2_DIGEST_FILE="$CHECKOUT_2/scripts/ruflo-seed/SEED-MANIFEST.sha256"
[[ -f "$CHECKOUT_2_DIGEST_FILE" ]] || fail "missing $CHECKOUT_2_DIGEST_FILE -- cannot rule out an empty-digest refusal as an alternate reason for case A's expected failure"
RUFLO_SEED_EXPECTED_DIGEST="$(tr -d '[:space:]' < "$CHECKOUT_2_DIGEST_FILE")"
export RUFLO_SEED_EXPECTED_DIGEST
log "attempting checkout 2's up while checkout 1's container is running (expect failure): docker compose -f $CHECKOUT_2/docker-compose.yml --profile ruflo up -d ruflo"
set +e
(cd "$CHECKOUT_2" && docker compose -f docker-compose.yml --profile ruflo up -d ruflo) >/tmp/ruflo-federation-case-a.log 2>&1
CASE_A_EXIT=$?
set -e
log "checkout 2's up exit code while checkout 1 is running: $CASE_A_EXIT"
if [[ "$CASE_A_EXIT" -eq 0 ]]; then
    fail "checkout 2's up SUCCEEDED while checkout 1's container was running -- expected a container-name collision. Output:\n$(cat /tmp/ruflo-federation-case-a.log)"
fi
# L-19: exit != 0 alone is also satisfied by a compose parse error or a
# missing image -- the queen MEASURED the real collision text, so require it
# verbatim rather than trusting a bare non-zero exit code.
COLLISION_TEXT="Conflict. The container name \"/$CONTAINER_NAME\" is already in use"
if ! grep -qF "$COLLISION_TEXT" /tmp/ruflo-federation-case-a.log; then
    fail "checkout 2's up failed (exit $CASE_A_EXIT) but NOT with the expected collision message ('$COLLISION_TEXT') -- some other failure reason. Output:\n$(cat /tmp/ruflo-federation-case-a.log)"
fi
pass "checkout 2's up failed as expected (exit $CASE_A_EXIT) with the container-name collision message, while checkout 1's container held $CONTAINER_NAME"

PROJECT_2_NETWORKS="$(docker network ls --filter "label=com.docker.compose.project=$PROJECT_2" --format '{{.Name}}' | tr '\n' ' ')"
log "networks labelled for checkout 2's project after the failed up: ${PROJECT_2_NETWORKS:-<none>}"

AFTER_CASE_A_SNAPSHOT="$(volume_snapshot)"
log "volume snapshot after the failed up: $AFTER_CASE_A_SNAPSHOT"
if [[ "$AFTER_CASE_A_SNAPSHOT" != "$BASELINE_SNAPSHOT" ]]; then
    fail "the shared volume changed after checkout 2's failed up -- before='$BASELINE_SNAPSHOT' after='$AFTER_CASE_A_SNAPSHOT' (it must not be recreated by a failed attempt)"
fi
pass "shared volume Name/CreatedAt/label unchanged by checkout 2's failed up"

# ---- B. checkout 1 removed: checkout 2's up must attach the SAME volume ----
log "removing checkout 1's container: docker rm -f $CONTAINER_NAME"
docker rm -f "$CONTAINER_NAME" >/dev/null
container_running && fail "container $CONTAINER_NAME still reports running after docker rm -f"

log "bringing up checkout 2's service now that checkout 1's container is gone: $CHECKOUT_2/scripts/ruflo-service-up.sh"
"$CHECKOUT_2/scripts/ruflo-service-up.sh"
container_running || fail "checkout 2's container did not come up after checkout 1's was removed"

FINAL_SNAPSHOT="$(volume_snapshot)"
log "volume snapshot after checkout 2's up: $FINAL_SNAPSHOT"
if [[ "$FINAL_SNAPSHOT" != "$BASELINE_SNAPSHOT" ]]; then
    fail "checkout 2 attached a DIFFERENT volume instance -- baseline='$BASELINE_SNAPSHOT' final='$FINAL_SNAPSHOT'"
fi
pass "checkout 2 attached the same volume instance (Name/CreatedAt/label all equal to the baseline)"

# The entrypoint prints its version line only AFTER walking the served tree for
# the digest check (measured ~11 s on the calibration machine), so a single read
# right after `up -d` races it -- the first live run of this test failed here for
# exactly that reason (2026-09-23). Poll up to RUFLO_FED_LOG_DEADLINE_S (default
# 60) seconds; a refusing entrypoint never prints the line, so the deadline is
# the failure path, not a fallback.
LOG_DEADLINE_S="${RUFLO_FED_LOG_DEADLINE_S:-60}"
LOG_TAIL=""
log_line_seen=0
elapsed=0
while [[ "$elapsed" -lt "$LOG_DEADLINE_S" ]]; do
    LOG_TAIL="$(docker logs "$CONTAINER_NAME" 2>&1 | tail -20)"
    if grep -q '\[ruflo-entrypoint\] serving @claude-flow/cli@' <<<"$LOG_TAIL"; then
        log_line_seen=1
        break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
done
if [[ "$log_line_seen" -ne 1 ]]; then
    fail "entrypoint version line not found in docker logs $CONTAINER_NAME within ${LOG_DEADLINE_S}s. Last 20 lines:\n$LOG_TAIL"
fi
pass "entrypoint version line present in docker logs $CONTAINER_NAME after ${elapsed}s"

log "all federation assertions passed"
