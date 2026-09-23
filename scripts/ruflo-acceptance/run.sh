#!/usr/bin/env bash
#
# ADR-170 acceptance harness for the ruflo MCP service (SMI-6744 A1.4 part iv).
#
# Covers the arms the committed suites do not: § 6's egress arms 1, 2 and 4,
# § 2's three seed-acceptance arms with the blinded read-back over an
# online-backup snapshot and the fresh-server re-retrieval, § 2's five arm-3
# failing mutations, and § 6's consolidation causal control with its own
# required failing mutation.
#
# NOT covered here, on purpose, and each named in the report instead:
#   - the nine tree-manifest red arms (scripts/ruflo-seed/manifest.mjs and the
#     earlier acceptance script already ran them)
#   - the per-spawn writability and state.lock arms
#     (scripts/tests/ruflo-launch-guard.test.ts)
#   - the service-command and launcher-argv arms
#     (scripts/tests/mcp-ruflo-launcher.test.sh)
#   - the external-digest mismatch refusal
#     (scripts/tests/ruflo-service-entrypoint.test.sh)
#   - § 8's federation test (scripts/ruflo-federation-test.sh)
#   - § 5's writer census and freeze, which are A1.6's
#   - § 6's own "delete network_mode: none" mutation, which recreates the LIVE
#     service: --mutation-egress prints the procedure and stops.
#
# Usage:
#   ./scripts/ruflo-acceptance/run.sh --all
#   ./scripts/ruflo-acceptance/run.sh --egress | --seed | --mutations | --consolidation
#   ./scripts/ruflo-acceptance/run.sh --mutation-egress     # prints, runs nothing
#
# Every arm prints applied= and its own predicate with both values. No verdict
# is taken from an exit code alone, and every MCP probe distinguishes a
# JSON-RPC error reply (exit 5) from a crash (exit 1).
#
# Writes: canary rows into the live dev store through the SERVED path (that is
# the test), and scratch Docker volumes and derived images that it removes.
# Never stops, restarts or recreates skillsmith-ruflo-1.

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
IMAGE="${RUFLO_IMAGE:-$(docker inspect "$SERVICE" --format '{{.Config.Image}}' 2>/dev/null || echo smi-6744-lane-a-ruflo)}"
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

# shellcheck disable=SC2034  # `ok` is the predicate scratch variable every sourced lib writes
ok=1
DO_EGRESS=0
DO_SEED=0
DO_MUT=0
DO_CONSOL=0
DO_EGRESS_MUT=0
if [ $# -eq 0 ]; then
  printf 'usage: %s [--all|--egress|--seed|--mutations|--consolidation|--mutation-egress]\n' "$0" >&2
  exit 2
fi
for a in "$@"; do
  case "$a" in
    --all) DO_EGRESS=1; DO_SEED=1; DO_MUT=1; DO_CONSOL=1 ;;
    --egress) DO_EGRESS=1 ;;
    --seed) DO_SEED=1 ;;
    --mutations) DO_MUT=1 ;;
    --consolidation) DO_CONSOL=1 ;;
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
[ "$DO_CONSOL" -eq 1 ] && consolidation_arms

summary
h2 "NOT MEASURED by this harness"
cat <<'DOC'
  - provider identity. § 2 is explicit that artifact-to-output equivalence does
    not establish which runtime executed the inference, and nothing here claims
    it does. No arm above says "via onnxruntime", "native" or "WASM".
  - the § 6 mutation that deletes network_mode: none from the live service.
  - § 5's writer census, freeze and authority-quad mutations (A1.6's).
  - the tree-manifest, launch-guard, launcher-argv, entrypoint-digest and
    federation arms, all already covered by committed suites.
  - byte-identical independent inference across platforms, which ADR-170
    records as unmeasured and which the host arm above only samples.
DOC
if [ "$ARMS_FAILED" -gt 0 ] || [ "$MUT_SURVIVED" -gt 0 ]; then exit 3; fi
exit 0
