#!/usr/bin/env bash
# shellcheck disable=SC2154  # run_capture assigns its rc variable by name through
# eval, which shellcheck cannot follow; every such variable IS assigned before use.
# ADR-170 § 6's consolidation control: "generate the scratch-only row with a
# random value AFTER the consolidation process and the expected-output fixture
# are prepared; run paired copies from the same baseline, one containing the row
# and one without; require only the seeded copy to produce the specified derived
# output, and require changing the row's random value to change that output;
# verify the opened database inode in every run."
#
# Order matters and is asserted by construction: the two copies and the stub's
# fixture are written first, and only then is the random token minted. A fixture
# prepared before the token exists cannot contain it.

CONSOL_VOL=""

consol_prepare() {
  CONSOL_VOL="a14-consol-$$"
  docker volume create "$CONSOL_VOL" >/dev/null
  # A snapshot of the live store, taken through the online-backup API by an
  # independently started process; the live volume itself is never written to.
  # The store volume is mounted READ-WRITE, not :ro, and query_only=ON is what
  # protects the data. Measured: with :ro, joining the WAL locking protocol
  # fails SQLITE_CANTOPEN whenever the -shm is absent, because creating that
  # shared-memory index is part of the protocol -- so the :ro mount turns a
  # WAL-inclusive snapshot into a crash exactly when the store is quiescent.
  run_capture _snap "$EVD/consol-snapshot.log" \
    docker run --rm --network none -v "$STORE_VOLUME":/srv/ruflo -v "$CONSOL_VOL":/scratchvol -v "$HARNESS":/harness:ro \
    --entrypoint node "$IMAGE" /harness/distill.mjs --prepare --src /srv/ruflo/.swarm/agentdb-memory.db --dst /scratchvol/baseline.db --pad 400
  applied "docker run ... distill.mjs --prepare (online-backup snapshot of the live store into a scratch volume, plus 400 synthetic padding rows so the served pass runs long enough to be externally observable)"
  observation "C0 snapshot" "rc=$_snap; $(tail -1 "$EVD/consol-snapshot.log")"
}

# consol_copy <name>
consol_copy() {
  docker run --rm --network none -v "$CONSOL_VOL":/scratchvol --entrypoint sh "$IMAGE" -c \
    "rm -f /scratchvol/$1.db /scratchvol/$1.db-wal /scratchvol/$1.db-shm && cp /scratchvol/baseline.db /scratchvol/$1.db" >/dev/null 2>&1
}

# consol_run <name> <token> <out-prefix> [--stub]
consol_run() {
  _name="$1"
  _token="$2"
  _pfx="$3"
  _stubflag="${4:-}"
  _dbpath="/scratchvol/$_name.db"
  # The external observer starts FIRST and runs in its own container process.
  docker run --rm --network none -v "$CONSOL_VOL":/scratchvol --entrypoint rm "$IMAGE" -f "/scratchvol/$_pfx.pid" "/scratchvol/$_pfx.stop" >/dev/null 2>&1 || true
  docker run -d --name "a14-fdwatch-$_pfx" --network none --pid host -v "$CONSOL_VOL":/scratchvol -v "$HARNESS":/harness:ro \
    --entrypoint node "$IMAGE" /harness/fd-watch.mjs --target "$_dbpath" --out "/scratchvol/$_pfx-fdwatch.json" \
    --pid-file "/scratchvol/$_pfx.pid" --stop-file "/scratchvol/$_pfx.stop" --max-ms 90000 >/dev/null 2>&1 || true
  # --pid host so the pid distill.mjs writes means the same number to the
  # observer; without it the observer would poll a pid from another namespace.
  # shellcheck disable=SC2086
  run_capture _rrc "$EVD/$_pfx-run.log" \
    docker run --rm --network none --pid host -v "$CONSOL_VOL":/scratchvol -v "$HARNESS":/harness:ro --entrypoint node "$IMAGE" \
    /harness/distill.mjs --run --db "$_dbpath" --out "/scratchvol/$_pfx-run.json" --pid-file "/scratchvol/$_pfx.pid" $_stubflag --fixture /scratchvol/fixture.json
  docker run --rm --network none -v "$CONSOL_VOL":/scratchvol --entrypoint sh "$IMAGE" -c "touch /scratchvol/$_pfx.stop" >/dev/null 2>&1 || true
  docker wait "a14-fdwatch-$_pfx" >/dev/null 2>&1 || true
  docker rm -f "a14-fdwatch-$_pfx" >/dev/null 2>&1 || true
  run_capture _irc "$EVD/$_pfx-inspect.log" \
    docker run --rm --network none -v "$CONSOL_VOL":/scratchvol -v "$HARNESS":/harness:ro --entrypoint node "$IMAGE" \
    /harness/distill.mjs --inspect --db "$_dbpath" --token "$_token" --out "/scratchvol/$_pfx-inspect.json"
  for _f in "$_pfx-run.json" "$_pfx-inspect.json" "$_pfx-fdwatch.json"; do
    docker run --rm --network none -v "$CONSOL_VOL":/scratchvol --entrypoint cat "$IMAGE" "/scratchvol/$_f" >"$EVD/$_f" 2>/dev/null || printf '{}\n' >"$EVD/$_f"
  done
  CONSOL_RUN_RC="$_rrc"
}

consolidation_arms() {
  h1 "ADR-170 § 6 -- consolidation causal control (paired scratch copies, never the live volume)"
  arm "C1" "paired copies from one baseline; only the seeded copy may produce the derived output"
  consol_prepare

  # Order: both copies exist, and the stub's fixture is written, BEFORE the
  # random token is minted.
  consol_copy seeded
  consol_copy unseeded
  consol_copy stubtarget
  printf '{"patterns":7,"processed":42,"episodes":7,"causalEdges":3,"note":"fixture prepared before the random token existed"}\n' >"$SCRATCH/fixture.json"
  docker run --rm --network none -v "$CONSOL_VOL":/scratchvol -v "$SCRATCH":/scratch --entrypoint sh "$IMAGE" -c \
    'cp /scratch/fixture.json /scratchvol/fixture.json' >/dev/null 2>&1
  observation "C1 ordering" "both scratch copies and the stub's expected-output fixture were written before the random token was generated"

  TOKEN="tok$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')"
  TOKEN2="tok$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')"
  VALUE="a14 consolidation canary $TOKEN structural trajectory sentence for distillation"
  VALUE2="a14 consolidation canary $TOKEN2 structural trajectory sentence for distillation"
  applied "minted two random tokens AFTER preparation: $TOKEN and $TOKEN2"

  run_capture _s1 "$EVD/consol-seed1.log" \
    docker run --rm --network none -v "$CONSOL_VOL":/scratchvol -v "$HARNESS":/harness:ro --entrypoint node "$IMAGE" \
    /harness/distill.mjs --seed-row --db /scratchvol/seeded.db --ns a14-consol --key "c-$TOKEN" --value "$VALUE"
  run_capture _s2 "$EVD/consol-seed2.log" \
    docker run --rm --network none -v "$CONSOL_VOL":/scratchvol -v "$HARNESS":/harness:ro --entrypoint node "$IMAGE" \
    /harness/distill.mjs --seed-row --db /scratchvol/stubtarget.db --ns a14-consol --key "c-$TOKEN2" --value "$VALUE2"
  observation "C1 seeding" "seeded.db got the $TOKEN row (rc=$_s1); unseeded.db got nothing; stubtarget.db got the $TOKEN2 row (rc=$_s2)"

  consol_run seeded "$TOKEN" c-seeded
  _seeded_rc="$CONSOL_RUN_RC"
  consol_run unseeded "$TOKEN" c-unseeded
  _unseeded_rc="$CONSOL_RUN_RC"

  _sk="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-seeded-run.json" distillSkipped 2>/dev/null || echo ERR)"
  _sc="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-seeded-run.json" distillCounters 2>/dev/null || echo ERR)"
  _uc="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-unseeded-run.json" distillCounters 2>/dev/null || echo ERR)"
  _sh_ep="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-seeded-inspect.json" hits episodes 2>/dev/null || echo ERR)"
  _sh_rp="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-seeded-inspect.json" hits reasoning_patterns 2>/dev/null || echo ERR)"
  _uh_ep="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-unseeded-inspect.json" hits episodes 2>/dev/null || echo ERR)"
  _uh_rp="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-unseeded-inspect.json" hits reasoning_patterns 2>/dev/null || echo ERR)"

  observation "C1 served pass" "seeded: skipped=$_sk counters=$_sc (rc=$_seeded_rc); unseeded: counters=$_uc (rc=$_unseeded_rc)"
  if [ "$_sk" != "none" ] && [ "$_sk" != "ERR" ]; then
    limitation "the served consolidation pass reported skipped='$_sk' -- the operation did not run to completion, so the paired control below measures nothing about consolidation. Recorded as a finding, not massaged."
  fi
  _seeded_total=$(( ${_sh_ep:-0} + ${_sh_rp:-0} ))
  _unseeded_total=$(( ${_uh_ep:-0} + ${_uh_rp:-0} ))
  if [ "$_seeded_total" -gt 0 ] && [ "$_unseeded_total" -eq 0 ]; then ok=0; else ok=1; fi
  predicate "C1 only the seeded copy produces derived output containing the row's random value" "$ok" \
    "seeded copy: >0 derived rows whose text contains $TOKEN; unseeded copy from the same baseline: 0" \
    "seeded episodes=$_sh_ep reasoning_patterns=$_sh_rp; unseeded episodes=$_uh_ep reasoning_patterns=$_uh_rp; seeded counts=$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-seeded-inspect.json" counts 2>/dev/null || echo ERR); unseeded counts=$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-unseeded-inspect.json" counts 2>/dev/null || echo ERR)"

  arm "C2" "changing the row's random value changes the derived output"
  applied "inspect the seeded copy for the OTHER token ($TOKEN2), which was never written to it"
  run_capture _c2 "$EVD/c-seeded-inspect2.log" \
    docker run --rm --network none -v "$CONSOL_VOL":/scratchvol -v "$HARNESS":/harness:ro --entrypoint node "$IMAGE" \
    /harness/distill.mjs --inspect --db /scratchvol/seeded.db --token "$TOKEN2" --out /scratchvol/c-seeded-inspect2.json
  docker run --rm --network none -v "$CONSOL_VOL":/scratchvol --entrypoint cat "$IMAGE" /scratchvol/c-seeded-inspect2.json >"$EVD/c-seeded-inspect2.json" 2>/dev/null || printf '{}\n' >"$EVD/c-seeded-inspect2.json"
  _alt_ep="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-seeded-inspect2.json" hits episodes 2>/dev/null || echo ERR)"
  _alt_rp="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-seeded-inspect2.json" hits reasoning_patterns 2>/dev/null || echo ERR)"
  consol_run stubtarget "$TOKEN2" c-alt
  _alt2_ep="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-alt-inspect.json" hits episodes 2>/dev/null || echo ERR)"
  _alt2_rp="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-alt-inspect.json" hits reasoning_patterns 2>/dev/null || echo ERR)"
  _alt_total=$(( ${_alt_ep:-0} + ${_alt_rp:-0} ))
  _alt2_total=$(( ${_alt2_ep:-0} + ${_alt2_rp:-0} ))
  if [ "$_alt_total" -eq 0 ] && [ "$_alt2_total" -gt 0 ]; then ok=0; else ok=1; fi
  predicate "C2 the derived output tracks the row's value" "$ok" \
    "the seeded copy's derived output contains $TOKEN and NOT $TOKEN2, while a copy seeded with $TOKEN2 produces output containing $TOKEN2" \
    "seeded-copy hits for TOKEN2: episodes=$_alt_ep reasoning_patterns=$_alt_rp; TOKEN2-copy hits for TOKEN2: episodes=$_alt2_ep reasoning_patterns=$_alt2_rp"

  arm "C3" "the opened database inode is verified in every run, by an external observer"
  applied "a separate container process polled /proc/*/fd at 2 ms while each run executed (strace is absent from node:22-slim); its verdict is compared against a known-negative below"
  _fd_seeded="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-seeded-fdwatch.json" matchedTargetInode 2>/dev/null || echo ERR)"
  _fd_unseeded="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-unseeded-fdwatch.json" matchedTargetInode 2>/dev/null || echo ERR)"
  observation "C3 observations" "seeded run: $(node "$HARNESS/lib/jqlite.mjs" "$EVD/c-seeded-fdwatch.json" fdObservations 2>/dev/null | cut -c1-300 || echo ERR)"
  if [ "$_fd_seeded" != "0" ] && [ "$_fd_seeded" != "ERR" ] && [ "$_fd_unseeded" != "0" ] && [ "$_fd_unseeded" != "ERR" ]; then ok=0; else ok=1; fi
  predicate "C3 external observation of the opened inode" "$ok" \
    "both runs are observed holding a descriptor whose device and inode equal the target database's" \
    "seeded matchedTargetInode=$_fd_seeded unseeded matchedTargetInode=$_fd_unseeded"
  if [ "$ok" -ne 0 ]; then
    limitation "the external /proc/*/fd observer did not catch the served pass's descriptor (seeded=$_fd_seeded unseeded=$_fd_unseeded). The run is short and the poller can miss it; the self-reported inode in the run evidence is NOT a substitute, because a mutant process forges exactly that. C3 is recorded as not established rather than as passing on the self-report."
  fi

  # The observer's known-negative. C3 above is its known-positive; an instrument
  # shown only to say "found it" has not been shown to be capable of saying
  # "absent", and a verdict from an instrument that cannot say both is not a
  # measurement of either.
  arm "C3-neg" "the same observer reports 0 for a process that never opens the target"
  applied "a container that writes its own host-namespace pid and then sleeps, watched by the same fd-watch.mjs against the same database path"
  docker run --rm --network none -v "$CONSOL_VOL":/scratchvol --entrypoint rm "$IMAGE" -f /scratchvol/neg.pid /scratchvol/neg.stop >/dev/null 2>&1 || true
  docker run -d --name "a14-fdwatch-neg-$$" --network none --pid host -v "$CONSOL_VOL":/scratchvol -v "$HARNESS":/harness:ro \
    --entrypoint node "$IMAGE" /harness/fd-watch.mjs --target /scratchvol/seeded.db --out /scratchvol/neg-fdwatch.json \
    --pid-file /scratchvol/neg.pid --stop-file /scratchvol/neg.stop --max-ms 30000 >/dev/null 2>&1 || true
  docker run --rm --network none --pid host -v "$CONSOL_VOL":/scratchvol --entrypoint sh "$IMAGE" -c \
    'echo $$ > /scratchvol/neg.pid; sleep 4' >/dev/null 2>&1 || true
  docker run --rm --network none -v "$CONSOL_VOL":/scratchvol --entrypoint touch "$IMAGE" /scratchvol/neg.stop >/dev/null 2>&1 || true
  docker wait "a14-fdwatch-neg-$$" >/dev/null 2>&1 || true
  docker rm -f "a14-fdwatch-neg-$$" >/dev/null 2>&1 || true
  docker run --rm --network none -v "$CONSOL_VOL":/scratchvol --entrypoint cat "$IMAGE" /scratchvol/neg-fdwatch.json >"$EVD/neg-fdwatch.json" 2>/dev/null || printf '{}\n' >"$EVD/neg-fdwatch.json"
  _negm="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/neg-fdwatch.json" matchedTargetInode 2>/dev/null || echo ERR)"
  _negsw="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/neg-fdwatch.json" field sweeps 2>/dev/null || echo ERR)"
  if [ "$_negm" = "0" ] && [ "$_negsw" != "0" ] && [ "$_negsw" != "ERR" ]; then ok=0; else ok=1; fi
  predicate "C3-neg the observer can also report absence" "$ok" \
    "matchedTargetInode=0 for a non-opening process, with a non-zero sweep count so the 0 is a look rather than a no-op" \
    "matchedTargetInode=$_negm sweeps=$_negsw"

  arm "M7" "required failing mutation: a command that opens the correct database and returns fixture-derived counters without reading the row"
  applied "distill.mjs --stub on the SAME paired copies: it opens the database (so any inode check passes) and answers from /scratchvol/fixture.json, written before the tokens existed"
  consol_copy stubseeded
  consol_copy stubunseeded
  run_capture _m6a "$EVD/m6-seed.log" \
    docker run --rm --network none -v "$CONSOL_VOL":/scratchvol -v "$HARNESS":/harness:ro --entrypoint node "$IMAGE" \
    /harness/distill.mjs --seed-row --db /scratchvol/stubseeded.db --ns a14-consol --key "c-$TOKEN" --value "$VALUE"
  consol_run stubseeded "$TOKEN" m6-seeded --stub
  consol_run stubunseeded "$TOKEN" m6-unseeded --stub
  _m6_s="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/m6-seeded-run.json" distillCounters 2>/dev/null || echo ERR)"
  _m6_u="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/m6-unseeded-run.json" distillCounters 2>/dev/null || echo ERR)"
  _m6_sh="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/m6-seeded-inspect.json" hits reasoning_patterns 2>/dev/null || echo ERR)"
  _m6_uh="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/m6-unseeded-inspect.json" hits reasoning_patterns 2>/dev/null || echo ERR)"
  _m6_fd="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/m6-seeded-fdwatch.json" matchedTargetInode 2>/dev/null || echo ERR)"
  # KILLED when the paired control separates them: identical counters AND no
  # token-bearing derived output on either side.
  if [ "$_m6_s" = "$_m6_u" ] && [ "${_m6_sh:-0}" -eq 0 ]; then ok=0; else ok=1; fi
  mutation "M7 fixture-derived consolidation counters" "$ok" \
    "seeded counters=$_m6_s unseeded counters=$_m6_u (identical => not derived from the input); token-bearing derived rows: seeded=$_m6_sh unseeded=$_m6_uh; external observations of the stub holding the target inode: $_m6_fd (the stub DOES open the correct database, so a passing inode check would not have caught it -- only the paired control does)"

  docker volume rm "$CONSOL_VOL" >/dev/null 2>&1 || true
}
