#!/usr/bin/env bash
# scripts/ruflo-federation-test.sh -- ADR-170
# (docs/internal/adr/170-ruflo-mcp-server-tree-store-and-topology.md) SS8's
# "Required test, two checkouts, both cases, checking more than
# containers."
#
# NOT run by this worker: every arm below needs a live Docker daemon, and
# this task's rules forbid running Docker. It is exercised by the queen in
# a dedicated build window once the `ruflo` image stage (a parallel, in-
# progress A1.4 lane) exists -- see the handback report's "Not done / not
# checked" list. This script IS lint-checked (`bash -n`, `shellcheck -S
# warning`) as part of this deliverable.
#
# Usage: scripts/ruflo-federation-test.sh <checkout-1-path> <checkout-2-path>
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
fail() { echo "[ruflo-federation] FAIL: $*" >&2; exit 1; }
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

project_name() {
    local checkout="$1"
    (cd "$checkout" && docker compose -f docker-compose.yml config --format json 2>/dev/null | jq -r '.name // empty')
}

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
"$CHECKOUT_1/scripts/ruflo-service-up.sh"
container_running || fail "checkout 1's container is not running after ruflo-service-up.sh"
BASELINE_SNAPSHOT="$(volume_snapshot)"
log "baseline volume snapshot (Name|CreatedAt|label): $BASELINE_SNAPSHOT"

# ---- A. checkout 1 running: checkout 2's up must fail on the name collision ----
log "attempting checkout 2's up while checkout 1's container is running (expect failure): docker compose -f $CHECKOUT_2/docker-compose.yml --profile ruflo up -d ruflo"
set +e
(cd "$CHECKOUT_2" && docker compose -f docker-compose.yml --profile ruflo up -d ruflo) >/tmp/ruflo-federation-case-a.log 2>&1
CASE_A_EXIT=$?
set -e
log "checkout 2's up exit code while checkout 1 is running: $CASE_A_EXIT"
if [[ "$CASE_A_EXIT" -eq 0 ]]; then
    fail "checkout 2's up SUCCEEDED while checkout 1's container was running -- expected a container-name collision. Output:\n$(cat /tmp/ruflo-federation-case-a.log)"
fi
pass "checkout 2's up failed as expected (exit $CASE_A_EXIT) while checkout 1's container held skillsmith-ruflo-1"

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

log "bringing up checkout 2's service now that checkout 1's container is gone"
(cd "$CHECKOUT_2" && docker compose -f docker-compose.yml --profile ruflo up -d ruflo)
container_running || fail "checkout 2's container did not come up after checkout 1's was removed"

FINAL_SNAPSHOT="$(volume_snapshot)"
log "volume snapshot after checkout 2's up: $FINAL_SNAPSHOT"
if [[ "$FINAL_SNAPSHOT" != "$BASELINE_SNAPSHOT" ]]; then
    fail "checkout 2 attached a DIFFERENT volume instance -- baseline='$BASELINE_SNAPSHOT' final='$FINAL_SNAPSHOT'"
fi
pass "checkout 2 attached the same volume instance (Name/CreatedAt/label all equal to the baseline)"

LOG_TAIL="$(docker logs "$CONTAINER_NAME" 2>&1 | tail -20)"
if ! grep -q '\[ruflo-entrypoint\] serving @claude-flow/cli@' <<<"$LOG_TAIL"; then
    fail "entrypoint version line not found in docker logs $CONTAINER_NAME. Last 20 lines:\n$LOG_TAIL"
fi
pass "entrypoint version line present in docker logs $CONTAINER_NAME"

log "all federation assertions passed"
