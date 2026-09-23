#!/usr/bin/env bash
# shellcheck disable=SC2154  # run_capture assigns its rc variable by name through
# eval, which shellcheck cannot follow; every such variable IS assigned before use.
# ADR-170 § 2's required failing mutations for arm 3, run as mutant SERVERS.
#
# What is under test here is the harness's predicates, which is the question
# § 2's mutation list asks: "each watched to fail". Each mutant is a server that
# behaves correctly except in one named way; the harness's ordinary probe,
# ordinary reader and ordinary compare.mjs then run against it unchanged, and
# the mutation is KILLED when at least one predicate FAILS.
#
# Nothing here touches skillsmith-ruflo-1 or its store. Every mutant runs in a
# throwaway container from the same image, with a scratch volume as cwd.
#
# The KILLED control is `honest`: the same stub with no mutation, which must
# PASS. Without it, a mutant failing would be evidence about the scaffolding
# rather than about the mutation -- a surviving mutant is not a gap until a
# differential run with a killed control says so.

# mut_stub_server_argv <volume> <mode> [precomputed-file]
mut_stub_server_argv() {
  _vol="$1"
  _mode="$2"
  _pre="${3:-}"
  MUT_ARGV="docker run --rm -i --network none -v $_vol:/srv/ruflo -v $HARNESS:/harness:ro -v $SCRATCH:/scratch --entrypoint node $IMAGE /harness/stub-server.mjs --mode $_mode --db /srv/ruflo/.swarm/agentdb-memory.db"
  if [ -n "$_pre" ]; then MUT_ARGV="$MUT_ARGV --precomputed $_pre"; fi
}

# mut_run <mode> <label> <expect: pass|fail> [published-canary] [published-mutant] [precomputed-file]
# Returns compare.mjs's exit code in MUT_CMP_RC.
mut_run() {
  _mode="$1"
  _label="$2"
  _expect="$3"
  _pub="${4:-}"
  _pubmut="${5:-}"
  _pre="${6:-}"
  _vol="a14-mut-$_mode-$$"
  docker volume create "$_vol" >/dev/null
  mut_stub_server_argv "$_vol" "$_mode" "$_pre"
  _pubargs=""
  if [ -n "$_pub" ]; then
    seed_write_plan1 "$EVD/mut-$_label-plan.json"
    _pubargs="--published-canary $_pub --published-mutant $_pubmut"
  else
    seed_write_plan "$EVD/mut-$_label-plan.json"
  fi
  # shellcheck disable=SC2086  # MUT_ARGV and _pubargs are built argument lists
  run_capture _prc "$EVD/mut-$_label-probe.log" node "$HARNESS/mcp-probe.mjs" \
    --out "$EVD/mut-$_label-probe.json" --plan "$EVD/mut-$_label-plan.json" --canaries 3 $_pubargs --timeout-ms 180000 -- $MUT_ARGV
  _cans="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/mut-$_label-probe.json" canaryList 2>/dev/null || echo '')"
  _alltext="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/mut-$_label-probe.json" canaryAndMutantList 2>/dev/null || echo '')"

  # The store reader, unchanged, against the mutant's own scratch volume.
  _keyargs=""
  for _k in $_cans; do _keyargs="$_keyargs --key $_k"; done
  # shellcheck disable=SC2086
  run_capture _rrc "$EVD/mut-$_label-reader.log" \
    docker run --rm --network none -v "$_vol":/srv/ruflo -v "$HARNESS":/harness:ro -v "$SCRATCH":/scratch \
    --entrypoint node "$IMAGE" /harness/store-reader.mjs --db /srv/ruflo/.swarm/agentdb-memory.db --ns a14-accept \
    --out "/scratch/mut-$_label-reader.json" $_keyargs
  cp "$SCRATCH/mut-$_label-reader.json" "$EVD/mut-$_label-reader.json" 2>/dev/null || printf '{}\n' >"$EVD/mut-$_label-reader.json"

  _texts=""
  for _t in $_alltext; do _texts="$_texts --text $_t"; done
  # shellcheck disable=SC2086
  run_capture _crc "$EVD/mut-$_label-recompute.log" \
    docker run --rm --network none -v "$HARNESS":/harness:ro -v "$SCRATCH":/scratch --entrypoint node "$IMAGE" \
    /harness/recompute.mjs --where container --transformers /opt/ruflo-seed/node_modules/@huggingface/transformers \
    --cache /opt/ruflo-seed/node_modules/@huggingface/transformers/.cache --out "/scratch/mut-$_label-recompute.json" $_texts
  cp "$SCRATCH/mut-$_label-recompute.json" "$EVD/mut-$_label-recompute.json" 2>/dev/null || printf '{}\n' >"$EVD/mut-$_label-recompute.json"

  # Fresh process: a SECOND stub server against the same scratch volume.
  # shellcheck disable=SC2086
  seed_write_fresh_plan "$EVD/mut-$_label-fresh-plan.json" $_cans
  # shellcheck disable=SC2086
  run_capture _frc "$EVD/mut-$_label-fresh-probe.log" node "$HARNESS/mcp-probe.mjs" \
    --out "$EVD/mut-$_label-fresh-probe.json" --plan "$EVD/mut-$_label-fresh-plan.json" --canaries 0 --timeout-ms 120000 -- $MUT_ARGV
  # shellcheck disable=SC2086
  run_capture _frrc "$EVD/mut-$_label-fresh-reader.log" \
    docker run --rm --network none -v "$_vol":/srv/ruflo -v "$HARNESS":/harness:ro -v "$SCRATCH":/scratch \
    --entrypoint node "$IMAGE" /harness/store-reader.mjs --db /srv/ruflo/.swarm/agentdb-memory.db --ns a14-accept \
    --out "/scratch/mut-$_label-fresh-reader.json" $_keyargs
  cp "$SCRATCH/mut-$_label-fresh-reader.json" "$EVD/mut-$_label-fresh-reader.json" 2>/dev/null || printf '{}\n' >"$EVD/mut-$_label-fresh-reader.json"

  run_capture MUT_CMP_RC "$EVD/mut-$_label-compare.txt" node "$HARNESS/compare.mjs" \
    --probe "$EVD/mut-$_label-probe.json" --reader "$EVD/mut-$_label-reader.json" \
    --recompute "$EVD/mut-$_label-recompute.json" --fresh-probe "$EVD/mut-$_label-fresh-probe.json" \
    --fresh-reader "$EVD/mut-$_label-fresh-reader.json" --label "$_label" --expect "$_expect"
  docker volume rm "$_vol" >/dev/null 2>&1 || true
  MUT_FAILED_LINES="$(grep -c 'FAILED' "$EVD/mut-$_label-compare.txt" 2>/dev/null || echo 0)"
  MUT_SUMMARY="compare.mjs rc=$MUT_CMP_RC, $MUT_FAILED_LINES failed predicate lines, probeRc=$_prc readerRc=$_rrc freshProbeRc=$_frc; full output at $EVD/mut-$_label-compare.txt"
}

mutations_arm3() {
  h2 "§ 2 arm 3 -- required failing mutations (mutant SERVERS in throwaway containers)"
  arm "M0" "the KILLED control: an honest stub server must PASS every arm-3 predicate"
  applied "docker run --rm ... stub-server.mjs --mode honest on a scratch volume; the same probe, reader, recompute and compare.mjs as the live arm"
  mut_run honest honest pass
  if [ "$MUT_CMP_RC" -eq 0 ]; then ok=0; else ok=1; fi
  predicate "M0 honest control passes" "$ok" \
    "the unmutated stub passes, so a mutant's failure is attributable to its mutation and not to the scaffolding" "$MUT_SUMMARY"
  if [ "$ok" -ne 0 ]; then
    limitation "the honest stub control did NOT pass, so the five mutation verdicts below are not differential and must be read as unattributed."
  fi

  # --- M1 precomputed vectors for published canaries --------------------------
  arm "M1" "a server returning precomputed vectors for published canaries; blinding must catch it"
  PUB_C="a14-published-canary-do-not-blind"
  PUB_F="a14-published-canary-do-not-blind-MUTATED"
  applied "bake the correct vectors for a PUBLISHED canary pair into the stub, then run the stub twice: once with the canary published (control, must pass) and once blinded (must fail)"
  run_capture _bake "$EVD/m1-bake.log" \
    docker run --rm --network none -v "$HARNESS":/harness:ro -v "$SCRATCH":/scratch --entrypoint node "$IMAGE" \
    /harness/recompute.mjs --where container --transformers /opt/ruflo-seed/node_modules/@huggingface/transformers \
    --cache /opt/ruflo-seed/node_modules/@huggingface/transformers/.cache --out /scratch/m1-bake.json --text "$PUB_C" --text "$PUB_F"
  node -e '
    const fs=require("fs");const p=process.argv[1];
    const d=JSON.parse(fs.readFileSync(p+"/m1-bake.json","utf8"));
    fs.writeFileSync(p+"/m1-precomputed.json", JSON.stringify(d.vectors));
  ' "$SCRATCH"
  mut_run precomputed m1-control pass "$PUB_C" "$PUB_F" /scratch/m1-precomputed.json
  _ctl_rc="$MUT_CMP_RC"
  _ctl_sum="$MUT_SUMMARY"
  mut_run precomputed m1-blinded fail "" "" /scratch/m1-precomputed.json
  if [ "$_ctl_rc" -eq 0 ] && [ "$MUT_CMP_RC" -ne 0 ]; then ok=0; else ok=1; fi
  mutation "M1 precomputed-vector server" "$ok" \
    "published-canary control: $_ctl_sum || blinded run: $MUT_SUMMARY -- KILLED requires the control to pass AND the blinded run to fail"

  # --- M2 freshness ----------------------------------------------------------
  arm "M2" "a server whose output does not change when a blinded input is mutated"
  applied "stub-server.mjs --mode frozen: one honest vector for every input"
  mut_run frozen m2-frozen fail
  if [ "$MUT_CMP_RC" -ne 0 ] && grep -q 'predicate P8 freshness: FAILED' "$EVD/mut-m2-frozen-compare.txt"; then ok=0; else ok=1; fi
  mutation "M2 frozen-output server (freshness arm)" "$ok" "$MUT_SUMMARY; P8 freshness failed: $(grep -c 'predicate P8 freshness: FAILED' "$EVD/mut-m2-frozen-compare.txt" || true)"

  # --- M3 returned-vs-persisted split ----------------------------------------
  arm "M3" "a server that returns the recomputed vector and persists a hash vector"
  applied "stub-server.mjs --mode split: embeddings_generate returns the real vector, memory_store persists a sha256-derived one"
  mut_run split m3-split fail
  if grep -q 'predicate P2 persisted==recomputed: FAILED' "$EVD/mut-m3-split-compare.txt"; then ok=0; else ok=1; fi
  mutation "M3 returned-honest/persisted-hash (only the persisted arm catches it)" "$ok" \
    "$MUT_SUMMARY; P1 returned==recomputed HELD $(grep -c 'predicate P1 returned==recomputed: HELD' "$EVD/mut-m3-split-compare.txt" || true) times while P2 persisted==recomputed FAILED $(grep -c 'predicate P2 persisted==recomputed: FAILED' "$EVD/mut-m3-split-compare.txt" || true) times -- which is exactly round-3 finding 1"

  # --- M4 shadow row ---------------------------------------------------------
  arm "M4" "a server that persists one honest canary row plus a second row carrying the same content"
  applied "stub-server.mjs --mode shadow: every memory_store writes <key> and <key>-shadow; its search returns both"
  mut_run shadow m4-shadow fail
  if grep -q 'predicate P6 no shadow carrier: FAILED' "$EVD/mut-m4-shadow-compare.txt" || grep -q 'predicate P7 fresh-process retrieval agrees: FAILED' "$EVD/mut-m4-shadow-compare.txt"; then ok=0; else ok=1; fi
  mutation "M4 shadow row consumed by search (named-row identity + fresh-process retrieval)" "$ok" \
    "$MUT_SUMMARY; P6 failed $(grep -c 'predicate P6 no shadow carrier: FAILED' "$EVD/mut-m4-shadow-compare.txt" || true) times, P7 failed $(grep -c 'predicate P7 fresh-process retrieval agrees: FAILED' "$EVD/mut-m4-shadow-compare.txt" || true) times"

  # --- M6 another deterministic implementation --------------------------------
  arm "M6" "a server that loads the manifested session but answers from another deterministic implementation"
  applied "stub-server.mjs --mode altimpl: warms the manifested pipeline, then returns and persists a sha256-derived vector per input, and writes plausible run events beside the store that no predicate reads"
  mut_run altimpl m6-altimpl fail
  if grep -q 'predicate P1 returned==recomputed: FAILED' "$EVD/mut-m6-altimpl-compare.txt"; then ok=0; else ok=1; fi
  mutation "M6 another deterministic implementation (the freshness arm alone would miss it)" "$ok" \
    "$MUT_SUMMARY; P1 returned==recomputed FAILED $(grep -c 'predicate P1 returned==recomputed: FAILED' "$EVD/mut-m6-altimpl-compare.txt" || true) times while P8 freshness HELD $(grep -c 'predicate P8 freshness: HELD' "$EVD/mut-m6-altimpl-compare.txt" || true) times -- the outputs DO change with the input, so only the independent recomputation catches this one"

  # --- M5 fabricated read-back ----------------------------------------------
  arm "M5" "a server that fabricates the read-back reply while the underlying row is wrong"
  applied "stub-server.mjs --mode fabricate: memory_retrieve and memory_search echo the canary, while the persisted row holds <canary>-TAMPERED and a hash vector"
  mut_run fabricate m5-fabricate fail
  if grep -q 'predicate P2 persisted==recomputed: FAILED' "$EVD/mut-m5-fabricate-compare.txt" || grep -q 'predicate P4 exactly one named row: FAILED' "$EVD/mut-m5-fabricate-compare.txt"; then ok=0; else ok=1; fi
  mutation "M5 fabricated read-back over a wrong row (only the independent reader catches it)" "$ok" \
    "$MUT_SUMMARY; the served retrieve/search replied found=true with the canary's own value in every case, and the bypassing reader is what disagreed"
}
