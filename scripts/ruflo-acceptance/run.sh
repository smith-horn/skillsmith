#!/usr/bin/env bash
#
# ADR-170 acceptance harness for the ruflo MCP service (SMI-6744 A1.4 part iv).
#
# Covers the arms the committed suites do not: § 6's egress arms 1, 2 and 4,
# § 2's three seed-acceptance arms with the blinded read-back over an
# online-backup snapshot and the fresh-server re-retrieval, § 2's five arm-3
# failing mutations, § 5's authority-quad LIVE mutations (b) and (c) against
# the real launcher and the real running service, and § 6's consolidation
# causal control with its own required failing mutation.
#
# NOT covered here, on purpose, and each named in the report instead:
#   - the nine tree-manifest red arms (scripts/ruflo-seed/manifest.mjs and the
#     earlier acceptance script already ran them)
#   - the per-spawn writability and state.lock arms
#     (scripts/tests/ruflo-launch-guard.test.ts)
#   - the service-command and launcher-argv arms, INCLUDING authority quad
#     (a) and (d) against a FAKED docker binary
#     (scripts/tests/mcp-ruflo-launcher.test.sh)
#   - the external-digest mismatch refusal
#     (scripts/tests/ruflo-service-entrypoint.test.sh)
#   - § 8's federation test (scripts/ruflo-federation-test.sh)
#   - § 5's writer census and freeze, which are A1.6's
#   - § 5's authority-quad (a) volume-delete/recreate and quad (d) copied-
#     database mutations, destructive to the live named volume -- see
#     lib/quad.sh's own header for why those two stay stubbed-only
#   - § 6's own "delete network_mode: none" mutation, which recreates the LIVE
#     service: --mutation-egress prints the procedure and stops.
#
# Usage:
#   ./scripts/ruflo-acceptance/run.sh --all
#   ./scripts/ruflo-acceptance/run.sh --egress | --seed | --mutations | --consolidation | --quad
#   ./scripts/ruflo-acceptance/run.sh --mutation-egress     # prints, runs nothing
#
# Every arm prints applied= and its own predicate with both values. No verdict
# is taken from an exit code alone, and every MCP probe distinguishes a
# JSON-RPC error reply (exit 5) from a crash (exit 1).
#
# Writes: canary rows into the live dev store through the SERVED path (that is
# the test), and scratch Docker volumes and derived images that it removes.
# Never stops, restarts or recreates skillsmith-ruflo-1.
#
# Exit codes (this script's OWN process exit status -- distinct from the
# per-probe codes named above at line 37, which describe one MCP reply, not
# the harness run as a whole; derived by lib/common.sh's
# acceptance_exit_code(), M-5, post-merge governance retro on PR #2931):
#   2 -- usage error (no flag given, or an unrecognized one).
#   1 -- the Compose service $SERVICE is not present; ADR-170 § 6 requires
#        acceptance to run against the service itself.
#   4 -- REFUSING: nothing ran at all (no arm evaluated a predicate AND no
#        mutation was attempted) -- e.g. every selector flag happened to
#        select zero sections. This is not a pass; printed to stderr.
#   3 -- at least one predicate FAILED or at least one mutation SURVIVED.
#   0 -- otherwise: something ran, every predicate that ran HELD, and every
#        mutation that ran was KILLED.

set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HARNESS/../.." && pwd)"
LAUNCHER="$REPO_ROOT/scripts/mcp-ruflo-launcher.sh"
SERVICE="${RUFLO_SERVICE:-skillsmith-ruflo-1}"
STORE_VOLUME="${RUFLO_STORE_VOLUME:-skillsmith-ruflo-data}"
# ADR-170 § 5 names memory.db; the SERVED bridge writes memory rows to the
# sibling agentdb-memory.db (memory-bridge.js getAgentDbPath()). The arm reads
# the file the rows are actually in, and the report records the divergence.
STORE_DB="${RUFLO_STORE_DB:-/srv/ruflo/.swarm/agentdb-memory.db}"
# L-4 (post-merge governance retro, PR #2931): no fallback image name. The
# image is whatever the RUNNING service reports (docker-compose.yml pins no
# `image:`, SMI-4653, so the name is project-derived); when the service is
# absent this resolves empty and the refusal below (":$SERVICE is not
# present") fires before any arm uses it. A literal here would only encode
# whichever checkout last built the image, which is what this fixed.
IMAGE="${RUFLO_IMAGE:-$(docker inspect "$SERVICE" --format '{{.Config.Image}}' 2>/dev/null || true)}"
SCRATCH="${RUFLO_ACCEPT_SCRATCH:-${TMPDIR:-/tmp}/ruflo-acceptance}"
EVD="$SCRATCH/evidence"
mkdir -p "$EVD"
LIMITATIONS_FILE="$SCRATCH/limitations.txt"
: >"$LIMITATIONS_FILE"

# shellcheck source=lib/common.sh
. "$HARNESS/lib/common.sh"
# shellcheck source=lib/egress.sh
. "$HARNESS/lib/egress.sh"
# shellcheck source=lib/seed.sh
. "$HARNESS/lib/seed.sh"
# shellcheck source=lib/mutations.sh
. "$HARNESS/lib/mutations.sh"
# shellcheck source=lib/consolidation.sh
. "$HARNESS/lib/consolidation.sh"
# shellcheck source=lib/quad.sh
. "$HARNESS/lib/quad.sh"

# shellcheck disable=SC2034  # `ok` is the predicate scratch variable every sourced lib writes
ok=1
DO_EGRESS=0
DO_SEED=0
DO_MUT=0
DO_CONSOL=0
DO_EGRESS_MUT=0
DO_QUAD=0
if [ $# -eq 0 ]; then
  printf 'usage: %s [--all|--egress|--seed|--mutations|--consolidation|--quad|--mutation-egress]\n' "$0" >&2
  exit 2
fi
for a in "$@"; do
  case "$a" in
    --all) DO_EGRESS=1; DO_SEED=1; DO_MUT=1; DO_CONSOL=1; DO_QUAD=1 ;;
    --egress) DO_EGRESS=1 ;;
    --seed) DO_SEED=1 ;;
    --mutations) DO_MUT=1 ;;
    --consolidation) DO_CONSOL=1 ;;
    --quad) DO_QUAD=1 ;;
    --mutation-egress) DO_EGRESS_MUT=1 ;;
    *) printf 'unknown option: %s\n' "$a" >&2; exit 2 ;;
  esac
done

# The cache the host-side cross-implementation recomputation reads. Copied out
# of the RUNNING service by docker cp and verified by sha256 inside
# recompute.mjs, so the host arm reads the manifested artifacts and not
# whatever a host cache happens to hold.
prepare_host_cache() {
  _c="$SCRATCH/cache/Xenova/all-MiniLM-L6-v2"
  mkdir -p "$_c/onnx"
  _src=/opt/ruflo-seed/node_modules/@huggingface/transformers/.cache/Xenova/all-MiniLM-L6-v2
  for f in config.json tokenizer.json tokenizer_config.json; do
    [ -f "$_c/$f" ] || docker cp "$SERVICE:$_src/$f" "$_c/$f" >/dev/null
  done
  [ -f "$_c/onnx/model.onnx" ] || docker cp "$SERVICE:$_src/onnx/model.onnx" "$_c/onnx/model.onnx" >/dev/null
}

h1 "ruflo acceptance -- ADR-170 §§ 2 and 6 (SMI-6744 A1.4 part iv)"
printf 'started:   %s\nservice:   %s\nimage:     %s\nvolume:    %s\nstore db:  %s\nlauncher:  %s\nevidence:  %s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SERVICE" "$IMAGE" "$STORE_VOLUME" "$STORE_DB" "$LAUNCHER" "$EVD"
if ! docker inspect "$SERVICE" >/dev/null 2>&1; then
  printf '\nREFUSING: the Compose service %s is not present. ADR-170 § 6 requires acceptance to run against the service itself.\n' "$SERVICE" >&2
  exit 1
fi
printf 'container: %s (%s)\n' "$(docker inspect "$SERVICE" --format '{{.Id}}' | cut -c1-12)" "$(docker inspect "$SERVICE" --format '{{.State.Status}}')"

if [ "$DO_EGRESS_MUT" -eq 1 ]; then
  egress_mutation_doc
  exit 0
fi

[ "$DO_EGRESS" -eq 1 ] && egress_arms
if [ "$DO_SEED" -eq 1 ]; then
  h1 "ADR-170 § 2 -- seed acceptance, three arms"
  prepare_host_cache
  seed_arm1
  seed_arm2
  seed_wal_control
  seed_arm3
fi
if [ "$DO_MUT" -eq 1 ]; then
  h1 "ADR-170 § 2 -- required failing mutations"
  mutations_arm3
fi
[ "$DO_QUAD" -eq 1 ] && quad_arms
[ "$DO_CONSOL" -eq 1 ] && consolidation_arms

summary
h2 "NOT MEASURED by this harness"
cat <<'DOC'
  - provider identity. § 2 is explicit that artifact-to-output equivalence does
    not establish which runtime executed the inference, and nothing here claims
    it does. No arm above says "via onnxruntime", "native" or "WASM".
  - the § 6 mutation that deletes network_mode: none from the live service.
  - § 5's writer census and freeze (A1.6's). Authority-quad (b) and (c) ARE
    measured live by --quad; quad (a) and (d) stay stubbed-only (lib/quad.sh
    header) rather than destructively recreating the live volume.
  - the tree-manifest, launch-guard, launcher-argv, entrypoint-digest and
    federation arms, all already covered by committed suites.
  - byte-identical independent inference across platforms, which ADR-170
    records as unmeasured and which the host arm above only samples.
DOC
# M-5: derive the overall exit status through the one shared function
# (lib/common.sh's acceptance_exit_code()) instead of this inline check,
# which never gated on ARMS_TOTAL=0 -- a run that evaluated nothing at all
# used to fall through to the bare `exit 0` below indistinguishably from a
# real pass. `|| ACCEPTANCE_RC=$?` keeps this compatible with `set -e`: a
# non-zero return from the function would otherwise abort the script here
# with that same code anyway, but capturing it explicitly keeps the ACTUAL
# `exit` call visible at the bottom of this file rather than relying on
# errexit's own implicit propagation.
ACCEPTANCE_RC=0
acceptance_exit_code "$ARMS_TOTAL" "$ARMS_FAILED" "$MUT_KILLED" "$MUT_SURVIVED" || ACCEPTANCE_RC=$?
exit "$ACCEPTANCE_RC"
