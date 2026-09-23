#!/usr/bin/env bash
# shellcheck disable=SC2154  # run_capture assigns its rc variable by name through
# eval, which shellcheck cannot follow; every such variable IS assigned before use.
# ADR-170 § 2 seed acceptance: the three arms, the freshness arm, and the five
# § 2 failing mutations this part covers.
#
# Arm 1 (outcome)    memory_bridge_status over stdio from the RUNNING service
# Arm 2 (necessity)  derived images with only model.onnx removed / corrupted
# Arm 3 (provenance) blinded canaries, bypassed read-back over an online-backup
#                    snapshot, independent recomputation, fresh-server retrieval

# Builds the probe call plan. Labels are what compare.mjs keys on.
seed_write_plan() {
  _plan="$1"
  cat >"$_plan" <<'JSON'
[
  { "label": "bridge_status", "params": { "name": "memory_bridge_status", "arguments": {} } },
  { "label": "embeddings_init", "params": { "name": "embeddings_init", "arguments": { "hyperbolic": false, "force": true } } },
  { "label": "store:{{C0}}", "params": { "name": "memory_store", "arguments": { "key": "{{C0}}", "value": "{{C0}}", "namespace": "a14-accept" } } },
  { "label": "store:{{C1}}", "params": { "name": "memory_store", "arguments": { "key": "{{C1}}", "value": "{{C1}}", "namespace": "a14-accept" } } },
  { "label": "store:{{C2}}", "params": { "name": "memory_store", "arguments": { "key": "{{C2}}", "value": "{{C2}}", "namespace": "a14-accept" } } },
  { "label": "generate:{{C0}}", "params": { "name": "embeddings_generate", "arguments": { "text": "{{C0}}", "hyperbolic": false, "normalize": true } } },
  { "label": "generate:{{C1}}", "params": { "name": "embeddings_generate", "arguments": { "text": "{{C1}}", "hyperbolic": false, "normalize": true } } },
  { "label": "generate:{{C2}}", "params": { "name": "embeddings_generate", "arguments": { "text": "{{C2}}", "hyperbolic": false, "normalize": true } } },
  { "label": "generate:{{F0}}", "params": { "name": "embeddings_generate", "arguments": { "text": "{{F0}}", "hyperbolic": false, "normalize": true } } },
  { "label": "generate:{{F1}}", "params": { "name": "embeddings_generate", "arguments": { "text": "{{F1}}", "hyperbolic": false, "normalize": true } } },
  { "label": "generate:{{F2}}", "params": { "name": "embeddings_generate", "arguments": { "text": "{{F2}}", "hyperbolic": false, "normalize": true } } }
]
JSON
}

# The one-canary form, for the precomputed-server mutation's published control:
# that run has exactly one (canary, mutant) pair, so a three-canary plan would
# reference {{C1}}/{{C2}} that do not exist and the probe would die there --
# which would make the control fail for a reason unrelated to the mutation.
seed_write_plan1() {
  _plan="$1"
  cat >"$_plan" <<'JSON'
[
  { "label": "bridge_status", "params": { "name": "memory_bridge_status", "arguments": {} } },
  { "label": "embeddings_init", "params": { "name": "embeddings_init", "arguments": { "hyperbolic": false, "force": true } } },
  { "label": "store:{{C0}}", "params": { "name": "memory_store", "arguments": { "key": "{{C0}}", "value": "{{C0}}", "namespace": "a14-accept" } } },
  { "label": "generate:{{C0}}", "params": { "name": "embeddings_generate", "arguments": { "text": "{{C0}}", "hyperbolic": false, "normalize": true } } },
  { "label": "generate:{{F0}}", "params": { "name": "embeddings_generate", "arguments": { "text": "{{F0}}", "hyperbolic": false, "normalize": true } } }
]
JSON
}

seed_write_fresh_plan() {
  _plan="$1"
  shift
  printf '[\n' >"$_plan"
  _sep=""
  for _c in "$@"; do
    printf '%s  { "label": "retrieve:%s", "params": { "name": "memory_retrieve", "arguments": { "key": "%s", "namespace": "a14-accept" } } },\n' "$_sep" "$_c" "$_c" >>"$_plan"
    printf '  { "label": "search:%s", "params": { "name": "memory_search", "arguments": { "query": "%s", "namespace": "a14-accept", "limit": 5 } } }' "$_c" "$_c" >>"$_plan"
    _sep=",
"
  done
  printf '\n]\n' >>"$_plan"
}

# seed_read_store <db> <ns> <out.json> <key...>
seed_read_store() {
  _db="$1"
  _ns="$2"
  _out="$3"
  shift 3
  _keyargs=""
  for _k in "$@"; do _keyargs="$_keyargs --key $_k"; done
  # shellcheck disable=SC2086  # _keyargs is a deliberately built argument list
  # The reader writes its evidence to the harness scratch mount, never into the
  # store volume: this arm reads the store, it does not add files to it.
  set +e
  docker run --rm --network none -v "$STORE_VOLUME":/srv/ruflo -v "$HARNESS":/harness:ro -v "$SCRATCH":/scratch \
    --entrypoint node "$IMAGE" /harness/store-reader.mjs --db "$_db" --ns "$_ns" --out "/scratch/$(basename "$_out")" $_keyargs \
    >"$_out.stdout" 2>&1
  _rc=$?
  set -e
  cp "$SCRATCH/$(basename "$_out")" "$_out" 2>/dev/null || printf '{}\n' >"$_out"
  return $_rc
}

seed_arm1() {
  h2 "§ 2 arm 1 -- outcome: embeddingBackend from the RUNNING Compose service"
  arm "S1" "memory_bridge_status over stdio via the committed launcher returns embeddingBackend: onnx"
  applied "node mcp-probe.mjs -- $LAUNCHER  (one tools/call, full JSON recorded at $EVD/s1-probe.json)"
  printf '[{"label":"bridge_status","params":{"name":"memory_bridge_status","arguments":{}}}]\n' >"$EVD/s1-plan.json"
  run_capture s1_rc "$EVD/s1-probe.log" node "$HARNESS/mcp-probe.mjs" --out "$EVD/s1-probe.json" --plan "$EVD/s1-plan.json" --canaries 0 -- "$LAUNCHER"
  _backend="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s1-probe.json" bridgeBackend 2>/dev/null || echo ERR)"
  _outcome="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s1-probe.json" probeOutcome 2>/dev/null || echo ERR)"
  if [ "$_backend" = "onnx" ] && [ "$_outcome" = "ok" ]; then ok=0; else ok=1; fi
  predicate "S1 embeddingBackend" "$ok" "agentdb.embeddingBackend == onnx, probe outcome == ok (rc 0, not 5 and not 1)" \
    "embeddingBackend=$_backend probeOutcome=$_outcome probeRc=$s1_rc"
  observation "S1 full reply" "$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s1-probe.json" bridgeStatusJson 2>/dev/null || echo ERR)"
}

# seed_necessity_image <tag> <dockerfile-body> <label>
seed_necessity_image() {
  _tag="$1"
  _body="$2"
  _label="$3"
  mkdir -p "$SCRATCH/ctx-$_tag"
  printf 'FROM %s\n%s\n' "$IMAGE" "$_body" >"$SCRATCH/ctx-$_tag/Dockerfile"
  run_capture _bld "$EVD/necessity-$_tag-build.log" docker build -q -t "ruflo-a14-$_tag" "$SCRATCH/ctx-$_tag"
  if [ "$_bld" -ne 0 ]; then
    predicate "S2 $_label build" 1 "the derived image builds" "docker build rc=$_bld; see $EVD/necessity-$_tag-build.log"
    return 0
  fi
  # A throwaway scratch volume as cwd: never the live store.
  _vol="a14-necessity-$_tag-$$"
  docker volume create "$_vol" >/dev/null
  printf '[{"label":"bridge_status","params":{"name":"memory_bridge_status","arguments":{}}},{"label":"init","params":{"name":"embeddings_init","arguments":{"hyperbolic":false,"force":true}}},{"label":"generate:necessity-probe","params":{"name":"embeddings_generate","arguments":{"text":"necessity-probe","hyperbolic":false,"normalize":true}}}]\n' >"$EVD/necessity-plan.json"
  run_capture _rc "$EVD/necessity-$_tag-probe.log" node "$HARNESS/mcp-probe.mjs" \
    --out "$EVD/necessity-$_tag-probe.json" --plan "$EVD/necessity-plan.json" --canaries 0 --timeout-ms 90000 -- \
    docker run --rm -i --network none -v "$_vol":/srv/ruflo -w /srv/ruflo --entrypoint node "ruflo-a14-$_tag" \
    /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js mcp start
  _backend="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/necessity-$_tag-probe.json" bridgeBackend 2>/dev/null || echo ERR)"
  _outcome="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/necessity-$_tag-probe.json" probeOutcome 2>/dev/null || echo ERR)"
  docker volume rm "$_vol" >/dev/null 2>&1 || true
  docker rmi "ruflo-a14-$_tag" >/dev/null 2>&1 || true
  # § 2 arm 2: "the same request must fail or return mock".
  if [ "$_backend" != "onnx" ] || [ "$_outcome" != "ok" ]; then ok=0; else ok=1; fi
  mutation "S2 $_label" "$ok" "embeddingBackend=$_backend probeOutcome=$_outcome probeRc=$_rc (onnx+ok would mean the manifested model was not necessary)"
  # A surviving image still reported onnx. That is not the end of the question:
  # arm 3 compares against the MANIFESTED artifacts, so if the vector diverges,
  # arm 3 catches what arm 2's self-reported label missed. Measured, not assumed.
  if [ "$ok" -ne 0 ]; then
    _div="$(node -e '
      const fs = require("fs");
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      const r = (p.responses || []).find((x) => x.label === "generate:necessity-probe");
      const got = r && r.parsed && r.parsed.embedding;
      const want = b.vectors && b.vectors["necessity-probe"];
      if (!got || !want) { process.stdout.write("could not compare: got=" + !!got + " baseline=" + !!want); process.exit(0); }
      let max = 0;
      for (let i = 0; i < want.length; i += 1) max = Math.max(max, Math.abs(got[i] - want[i]));
      process.stdout.write("maxAbsDiff vs the manifested recomputation = " + max + (max > 0 ? " (DIVERGED: arm 3 would catch this image)" : " (identical: arm 3 would NOT catch it either)"));
    ' "$EVD/necessity-$_tag-probe.json" "$EVD/necessity-baseline.json" 2>&1 || echo "comparison failed")"
    observation "S2 $_label follow-up" "$_div"
  fi
}

seed_arm2() {
  h2 "§ 2 arm 2 -- necessity by removal (derived images, throwaway containers)"
  arm "S2" "with ONLY onnx/model.onnx removed, and separately with only its bytes corrupted at the same size, the same request must fail or report mock"
  applied "docker build THREE images FROM $IMAGE (removal, header corruption, weight-region corruption); each runs the served cli entrypoint directly (--entrypoint node) so the seed-manifest gate does not pre-empt the model arm; scratch volume as cwd; --network none; each image is removed afterwards"
  _cache=/opt/ruflo-seed/node_modules/@huggingface/transformers/.cache/Xenova/all-MiniLM-L6-v2/onnx/model.onnx
  # The baseline the surviving-image follow-up compares against: the unmodified
  # manifested artifacts, recomputed in their own process.
  run_capture _base "$EVD/necessity-baseline.log" \
    docker run --rm --network none -v "$HARNESS":/harness:ro -v "$SCRATCH":/scratch --entrypoint node "$IMAGE" \
    /harness/recompute.mjs --where container --transformers /opt/ruflo-seed/node_modules/@huggingface/transformers \
    --cache /opt/ruflo-seed/node_modules/@huggingface/transformers/.cache --out /scratch/necessity-baseline.json --text necessity-probe
  cp "$SCRATCH/necessity-baseline.json" "$EVD/necessity-baseline.json" 2>/dev/null || printf '{}\n' >"$EVD/necessity-baseline.json"
  seed_necessity_image "nomodel" "RUN rm $_cache" "model.onnx removed"
  # conv=notrunc keeps the file length identical, so these arms differ from the
  # removal arm in bytes alone -- "only its bytes corrupted", as § 2 words it.
  # Two placements, because they are not the same experiment: the protobuf
  # header decides whether the model parses at all, while a region deep in the
  # weights can corrupt the ANSWER while the file still parses.
  seed_necessity_image "corrupthead" \
    "RUN dd if=/dev/urandom of=$_cache bs=1024 seek=0 count=8 conv=notrunc && ls -l $_cache" \
    "model.onnx corrupted at the protobuf header (same size)"
  seed_necessity_image "corruptweights" \
    "RUN dd if=/dev/urandom of=$_cache bs=1024 seek=20000 count=64 conv=notrunc && ls -l $_cache" \
    "model.onnx corrupted ~20 MB in, inside the weight region (same size)"
}

# The known-positive/known-negative control for store-reader.mjs's WAL-inclusive
# claim. Runs on a SCRATCH database in a throwaway container, never the live
# store: a writer commits a row and holds its connection so the frame stays in
# the -wal, and the reader must (a) miss it in a main-file-only copy and
# (b) find it in the online-backup snapshot. A key never written is the
# negative. Without this the reader would report the same "not WAL-resident"
# line whether it can see WAL state or not.
seed_wal_control() {
  h2 "§ 2 arm 3 -- WAL-inclusive instrument control (scratch database)"
  arm "S3-WAL" "store-reader.mjs distinguishes a WAL-resident row from a checkpointed one"
  _vol="a14-walctl-$$"
  docker volume create "$_vol" >/dev/null
  _k="walctl-$(node -e 'process.stdout.write(require("crypto").randomBytes(6).toString("hex"))')"
  applied "wal-holder.mjs commits key=$_k on a scratch DB and holds its connection open (no checkpoint); store-reader.mjs then runs against it unmodified"
  docker run -d --name "a14-walctl-$$" --network none -v "$_vol":/scratchvol -v "$HARNESS":/harness:ro \
    --entrypoint node "$IMAGE" /harness/wal-holder.mjs --db /scratchvol/ctl.db --ns wal-control --key "$_k" \
    --ready /scratchvol/ready --go /scratchvol/go --hold-ms 120000 >/dev/null 2>&1 || true
  _w=0
  while [ "$_w" -lt 300 ]; do
    if docker run --rm --network none -v "$_vol":/scratchvol --entrypoint test "$IMAGE" -f /scratchvol/ready >/dev/null 2>&1; then break; fi
    sleep 0.2
    _w=$((_w + 1))
  done
  run_capture _wrc "$EVD/s3-walctl-reader.log" \
    docker run --rm --network none -v "$_vol":/scratchvol -v "$HARNESS":/harness:ro -v "$SCRATCH":/scratch \
    --entrypoint node "$IMAGE" /harness/store-reader.mjs --db /scratchvol/ctl.db --ns wal-control \
    --key "$_k" --key "walctl-never-written" --out /scratch/s3-walctl-reader.json
  cp "$SCRATCH/s3-walctl-reader.json" "$EVD/s3-walctl-reader.json" 2>/dev/null || printf '{}\n' >"$EVD/s3-walctl-reader.json"
  docker run --rm --network none -v "$_vol":/scratchvol --entrypoint touch "$IMAGE" /scratchvol/go >/dev/null 2>&1 || true
  docker rm -f "a14-walctl-$$" >/dev/null 2>&1 || true
  docker volume rm "$_vol" >/dev/null 2>&1 || true
  _pos_main="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-walctl-reader.json" mainOnlyRowCount "$_k" 2>/dev/null || echo ERR)"
  _pos_bk="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-walctl-reader.json" rowCount "$_k" 2>/dev/null || echo ERR)"
  _neg_bk="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-walctl-reader.json" rowCount walctl-never-written 2>/dev/null || echo ERR)"
  _wal="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-walctl-reader.json" walSize 2>/dev/null || echo ERR)"
  if [ "$_pos_main" = "0" ] && [ "$_pos_bk" = "1" ] && [ "$_neg_bk" = "0" ]; then ok=0; else ok=1; fi
  predicate "S3-WAL the reader sees WAL-resident state a main-file-only copy cannot" "$ok" \
    "known positive: 0 rows in the main-file-only copy and exactly 1 in the online-backup snapshot; known negative: 0 in the backup" \
    "positive mainFileOnly=$_pos_main backup=$_pos_bk; negative backup=$_neg_bk; source -wal=$_wal B; readerRc=$_wrc"
}

seed_arm3() {
  h2 "§ 2 arm 3 -- blinded provenance, bypassed read-back, fresh-process retrieval"
  arm "S3" "3 canaries generated AFTER the session initialised; returned, persisted and independently recomputed vectors must all agree; exactly one named row; a fresh server session must agree"
  applied "node mcp-probe.mjs --canaries 3 -- $LAUNCHER (store + generate through the served path); then a throwaway container takes an online-backup snapshot; then recompute.mjs in its own process; then a SECOND launcher session retrieves"
  seed_write_plan "$EVD/s3-plan.json"
  # The session is HELD open across the read. SQLite checkpoints the WAL when
  # the last connection closes, so a reader that starts after the session ends
  # can only ever observe a checkpointed main file -- and § 2's positive arm
  # needs an acknowledged canary that is still WAL-resident.
  _hold="$SCRATCH/s3-hold"
  rm -f "$_hold" "$_hold.go"
  ( node "$HARNESS/mcp-probe.mjs" --out "$EVD/s3-probe.json" --plan "$EVD/s3-plan.json" --canaries 3 \
      --hold-file "$_hold" --hold-ms 180000 -- "$LAUNCHER" >"$EVD/s3-probe.log" 2>&1; echo $? >"$SCRATCH/s3-probe.rc" ) &
  _probe_pid=$!
  _waited=0
  while [ ! -f "$_hold" ] && [ "$_waited" -lt 2400 ]; do
    sleep 0.1
    _waited=$((_waited + 1))
  done
  if [ -f "$_hold" ]; then
    observation "S3 session hold" "the serving process is still alive and still owns its store connection; the bypassing reader runs now"
    CANARIES="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(c.map(x=>x.c).join(" "))' "$_hold")"
    # shellcheck disable=SC2086  # word splitting of the canary list is intended
    seed_read_store "$STORE_DB" a14-accept "$EVD/s3-reader.json" $CANARIES
  else
    observation "S3 session hold" "the probe never reached its hold point within 240 s; the reader will run after the session ends instead"
    limitation "the held-session read did not happen, so any WAL-residency observation below is about a post-close state."
  fi
  : >"$_hold.go"
  wait "$_probe_pid" 2>/dev/null || true
  s3_rc="$(cat "$SCRATCH/s3-probe.rc" 2>/dev/null || echo 99)"
  predicate "S3a probe outcome" "$([ "$s3_rc" -eq 0 ] && echo 0 || echo 1)" \
    "exit 0 (every reply a JSON-RPC result); 5 would be an error reply, 1 a crash" "rc=$s3_rc outcome=$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-probe.json" probeOutcome)"
  CANARIES="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-probe.json" canaryList)"
  ALLTEXT="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-probe.json" canaryAndMutantList)"
  observation "S3 blinded canaries" "$CANARIES (generated at $(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-probe.json" field canaryGeneratedAt), after initialize returned)"
  if [ ! -f "$EVD/s3-reader.json" ]; then
    # shellcheck disable=SC2086
    seed_read_store "$STORE_DB" a14-accept "$EVD/s3-reader.json" $CANARIES
  fi
  observation "S3 store reader" "db=$STORE_DB wal=$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-reader.json" walSize) B; reader ran in its own container, joined the WAL locking protocol, took an online-backup snapshot of its read transaction"

  _texts=""
  for _t in $ALLTEXT; do _texts="$_texts --text $_t"; done
  # shellcheck disable=SC2086
  run_capture rc_ct "$EVD/s3-recompute-container.log" \
    docker run --rm --network none -v "$HARNESS":/harness:ro -v "$SCRATCH":/scratch --entrypoint node "$IMAGE" \
    /harness/recompute.mjs --where container --transformers /opt/ruflo-seed/node_modules/@huggingface/transformers \
    --cache /opt/ruflo-seed/node_modules/@huggingface/transformers/.cache --out /scratch/s3-recompute-container.json $_texts
  cp "$SCRATCH/s3-recompute-container.json" "$EVD/s3-recompute-container.json" 2>/dev/null || true
  # shellcheck disable=SC2086
  run_capture rc_host "$EVD/s3-recompute-host.log" node "$HARNESS/recompute.mjs" --where host \
    --transformers "$REPO_ROOT/node_modules/@huggingface/transformers" --cache "$SCRATCH/cache" \
    --out "$EVD/s3-recompute-host.json" $_texts
  predicate "S3b independent recomputation ran from the manifested artifacts" \
    "$([ "$rc_ct" -eq 0 ] && echo 0 || echo 1)" \
    "recompute.mjs verifies all four manifested sha256 digests before loading and exits 2 on any mismatch" \
    "containerRc=$rc_ct hostRc=$rc_host; container transformers=$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-recompute-container.json" field transformersVersion 2>/dev/null || echo ERR), host transformers=$(node "$HARNESS/lib/jqlite.mjs" "$EVD/s3-recompute-host.json" field transformersVersion 2>/dev/null || echo ERR)"

  # Fresh server session: a NEW process, through the launcher, retrieving the
  # same canaries; then the SAME bypassing reader re-reads the rows.
  # shellcheck disable=SC2086
  seed_write_fresh_plan "$EVD/s3-fresh-plan.json" $CANARIES
  run_capture s3f_rc "$EVD/s3-fresh-probe.log" node "$HARNESS/mcp-probe.mjs" --out "$EVD/s3-fresh-probe.json" --plan "$EVD/s3-fresh-plan.json" --canaries 0 -- "$LAUNCHER"
  # shellcheck disable=SC2086
  seed_read_store "$STORE_DB" a14-accept "$EVD/s3-fresh-reader.json" $CANARIES
  observation "S3 fresh session" "a second launcher spawn (rc=$s3f_rc) retrieved and searched each canary; its PID is not the PID that wrote them"

  run_capture s3cmp_rc "$EVD/s3-compare.txt" node "$HARNESS/compare.mjs" \
    --probe "$EVD/s3-probe.json" --reader "$EVD/s3-reader.json" --recompute "$EVD/s3-recompute-container.json" \
    --fresh-probe "$EVD/s3-fresh-probe.json" --fresh-reader "$EVD/s3-fresh-reader.json" --label "honest service, container recomputation"
  cat "$EVD/s3-compare.txt"
  predicate "S3c all arm-3 predicates against the container recomputation" "$([ "$s3cmp_rc" -eq 0 ] && echo 0 || echo 1)" \
    "every predicate HELD (compare.mjs exit 0)" "compare.mjs rc=$s3cmp_rc; full output above and at $EVD/s3-compare.txt"

  run_capture s3h_rc "$EVD/s3-compare-host.txt" node "$HARNESS/compare.mjs" \
    --probe "$EVD/s3-probe.json" --reader "$EVD/s3-reader.json" --recompute "$EVD/s3-recompute-host.json" \
    --label "honest service, HOST cross-implementation recomputation"
  cat "$EVD/s3-compare-host.txt"
  observation "S3d cross-implementation" "the host recomputation uses a different transformers major on a different OS and architecture; compare.mjs rc=$s3h_rc. Byte equality is NOT expected to hold there; the determinism clause's 1e-6 tolerance is what it is judged by, and the max-abs-diff is printed above."
}
