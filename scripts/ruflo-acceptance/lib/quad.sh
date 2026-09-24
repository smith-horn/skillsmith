#!/usr/bin/env bash
# $IMAGE, $STORE_VOLUME, $SERVICE, $SCRATCH, $EVD, $LAUNCHER and $ok are set
# by run.sh before this file is sourced, same convention as every sibling
# lib/*.sh.
#
# ADR-170 § 5 authority-quad LIVE mutations (SMI-6744 A1.8, cross-family gate
# finding PR-16 on PR #2931). Run against the RUNNING Compose service
# ($SERVICE) through the REAL scripts/mcp-ruflo-launcher.sh -- not a stubbed
# `docker` binary and not scripts/ruflo-launch-guard.mjs (a different check,
# § 4/§ 7's per-spawn writability/lock guard, owned by the parallel A1.4
# lane and exercised by scripts/tests/ruflo-launch-guard.test.ts). Each arm
# sends one JSON-RPC `initialize` on stdin and reads the launcher's own
# stdout/stderr TEXT -- never a bare exit code alone (this repo's own rule,
# quoted verbatim in mcp-ruflo-launcher.sh's own header: "branch on probe
# TEXT, never on a bare docker exec exit code").
#
# Covers ADR-170 § 5's "change the configured UUID only" (Q2, authority
# file's generationUuid) and "change the database UUID only" mutations,
# taken independently for EACH of the two SQLite store files (Q4 memory.db,
# Q5 agentdb-memory.db -- the same two-file split
# scripts/mcp-ruflo-launcher.sh's own Check 4(c)/(d) authenticates
# separately, per its header note on memory.db vs agentdb-memory.db), plus
# the authority file's instanceNonce (Q3). Q1 is the unmutated control --
# without it, a refusal on Q2-Q5 would not be attributable to the mutation
# specifically (the same "an instrument that never says pass is not a
# measurement" principle egress.sh's E0 control and consolidation.sh's M0
# honest control already apply elsewhere in this harness).
#
# NOT run here, on purpose (recorded, not silently skipped): the
# volume-delete/recreate mutation (quad a) and a copied-database mount
# (quad d's "empty/partial volume" leg) are destructive to the live named
# volume this session shares with every other MCP client attached to
# $SERVICE. Both are already exercised -- against a FAKED `docker` binary,
# so safely -- by scripts/tests/mcp-ruflo-launcher.test.sh's quad-a, quad-d
# and quad-d-agentdb-missing arms; this file adds what that stubbed suite
# cannot: proof that the REAL launcher, against the REAL running service,
# really refuses on quad (b) and (c).
#
# Every mutation this file makes is restored before quad_arms returns, in
# the SAME arm (not deferred to a single cleanup at the end) -- immediately
# followed by a fresh green probe, because a restore that was never watched
# to succeed is itself a silent-success risk (CLAUDE.md's "a fix you have
# not watched work is unverified", generalised from the regression-test
# rule). A process-wide EXIT trap is ALSO armed for the duration of this
# function as a defense-in-depth backstop against `set -e` aborting run.sh
# between a mutation and its own inline restore below; it is cleared before
# this function returns, so it never lingers over --consolidation or any
# other mode run afterward under --all.
#
# SMI-6744 A1.8 round-2 fix (cross-family gate finding, BLOCKED on PR #2931):
# a dirty flag (QUAD_DIRTY_AUTHORITY/_MEMORY_DB/_AGENTDB) now clears ONLY once
# the restoration is independently VERIFIED -- authority by `cmp -s` against
# the pre-mutation backup, a store marker by reading `store_generation.id`
# back and comparing it to the value recorded before that arm mutated it.
# quad_restore_authority/quad_restore_memory_db/quad_restore_agentdb do the
# attempt-then-verify and are the ONLY place a dirty flag is cleared. A
# failed verification is loud through the existing `predicate` mechanism
# (its own name always contains "restore:", and `predicate` already prints
# FAILED with both expected/actual when passed a nonzero $ok -- see
# lib/common.sh) and leaves the flag set, so the EXIT trap
# (quad_emergency_restore, both the armed trap AND the explicit call at the
# end of quad_arms below) retries exactly once more and prints its own loud
# outcome line: "restored on exit" or "RESTORE FAILED ON EXIT" with the exact
# manual-recovery command. run.sh's own exit code already reflects this --
# `predicate`'s FAILED branch increments ARMS_FAILED (lib/common.sh), and
# run.sh's tail exits 3 when ARMS_FAILED > 0.
#
# quad_test_should_noop_restore is a TEST-ONLY seam for the RED ARM that
# proved this: it is INERT (always says "don't no-op") unless
# RUFLO_QUAD_TEST_FAIL_RESTORE is exported, so it never changes behavior in a
# real run. See its own header comment below for the two env vars.

QUAD_INIT_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"quad-probe","version":"1.0.0"}}}'
QUAD_PROBE_TIMEOUT_S="${RUFLO_QUAD_PROBE_TIMEOUT_S:-8}"
QUAD_AUTHORITY_FILE="${RUFLO_QUAD_AUTHORITY_FILE:-$HOME/.skillsmith/ruflo-store.json}"
QUAD_MEMORY_DB="/srv/ruflo/.swarm/memory.db"
QUAD_AGENTDB="/srv/ruflo/.swarm/agentdb-memory.db"

QUAD_DIRTY_AUTHORITY=0
QUAD_DIRTY_MEMORY_DB=0
QUAD_DIRTY_AGENTDB=0
QUAD_MEMORY_DB_CURRENT_ID=""
QUAD_AGENTDB_CURRENT_ID=""

# Test-seam bookkeeping (see quad_test_should_noop_restore in
# lib/quad.restore.sh, sourced below). Each counter latches to 1 the first
# time its resource's restore is no-opped under RUFLO_QUAD_TEST_FAIL_RESTORE,
# so only the FIRST attempt fails -- simulating a transient `cp`/UPDATE
# failure that a retry recovers from -- unless
# RUFLO_QUAD_TEST_FAIL_RESTORE_PERSIST is also set. shellcheck (run without
# -x, matching this workflow's own convention -- see validate-hooks.yml's
# "SC1091 can't-follow-source is unavoidable" note) cannot see that
# lib/quad.restore.sh is the actual consumer of these three.
# shellcheck disable=SC2034
QUAD_TEST_FAIL_RESTORE_USED_AUTHORITY=0
# shellcheck disable=SC2034
QUAD_TEST_FAIL_RESTORE_USED_MEMORY_DB=0
# shellcheck disable=SC2034
QUAD_TEST_FAIL_RESTORE_USED_AGENTDB=0

# quad_md5 <file> -- macOS ships `md5 -q`; Linux hosts (and every container
# in this repo) ship `md5sum` instead. run.sh itself runs on the HOST, which
# is macOS in this dev environment but is not guaranteed to be everywhere
# this harness runs.
quad_md5() {
  if command -v md5 >/dev/null 2>&1; then
    md5 -q "$1"
  else
    md5sum "$1" | awk '{print $1}'
  fi
}

# quad_probe <label> -- runs $LAUNCHER with a JSON-RPC initialize on stdin.
# No GNU `timeout` on macOS (measured on this host, 2026-09-23 -- neither
# `timeout` nor `gtimeout` is on PATH), so a background+poll+kill watchdog
# bounds the wait instead. Measured live: a REFUSAL exits on its own in well
# under a second (no docker exec of the server is ever attempted -- the
# refusal happens during the launcher's own pre-flight checks); a
# SUCCESSFUL serve answers `initialize` in ~1-2s and then exits on its own
# once this function's stdin pipe closes at EOF (measured, 2026-09-23: no
# orphaned server process observed in either case). Sets QUAD_PROBE_OUT/
# QUAD_PROBE_ERR to file paths under $EVD; every verdict below reads their
# CONTENT, never QUAD_PROBE_RC alone.
quad_probe() {
  QUAD_PROBE_OUT="$EVD/quad-$1.out"
  QUAD_PROBE_ERR="$EVD/quad-$1.err"
  : >"$QUAD_PROBE_OUT"
  : >"$QUAD_PROBE_ERR"
  printf '%s\n' "$QUAD_INIT_REQUEST" | "$LAUNCHER" >"$QUAD_PROBE_OUT" 2>"$QUAD_PROBE_ERR" &
  _quad_pid=$!
  _quad_elapsed=0
  while kill -0 "$_quad_pid" 2>/dev/null && [ "$_quad_elapsed" -lt "$QUAD_PROBE_TIMEOUT_S" ]; do
    sleep 1
    _quad_elapsed=$((_quad_elapsed + 1))
  done
  if kill -0 "$_quad_pid" 2>/dev/null; then
    kill -TERM "$_quad_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$_quad_pid" 2>/dev/null || true
  fi
  set +e
  wait "$_quad_pid" 2>/dev/null
  QUAD_PROBE_RC=$?
  set -e
}

# quad_served -- 0 if the last quad_probe's stdout is a JSON-RPC reply
# carrying this session's own request id and a result. grep, not a full JSON
# parse: the rest of this harness's lib/*.sh reads jqlite.mjs's output
# rather than parsing JSON in bash directly, and a plain grep suffices here
# since the only thing under test is "did a server answer this request".
quad_served() {
  grep -q '"id":1' "$QUAD_PROBE_OUT" 2>/dev/null && grep -q '"result"' "$QUAD_PROBE_OUT" 2>/dev/null
}

# quad_refused_naming <substring> -- 0 if the last quad_probe produced NO
# stdout at all (never reached the server) AND its stderr names <substring>.
# Both halves together: a refusal must say why AND never serve.
quad_refused_naming() {
  [ ! -s "$QUAD_PROBE_OUT" ] && grep -qF "$1" "$QUAD_PROBE_ERR" 2>/dev/null
}

quad_random_uuid() { node -e "process.stdout.write(require('crypto').randomUUID())"; }

# quad_write_authority_field <field> <value>
quad_write_authority_field() {
  node -e '
    const fs = require("fs")
    const p = process.argv[1]
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    j[process.argv[2]] = process.argv[3]
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n")
  ' "$QUAD_AUTHORITY_FILE" "$1" "$2"
}

# quad_read_store_generation <container-db-path> -- prints the current
# store_generation.id, read through a throwaway --rm container from the
# service's own image with the live volume mounted read-write (matching the
# rest of this harness's own convention, e.g. lib/mutations.sh's mut_run and
# lib/consolidation.sh's consol_* helpers -- a different container, a
# different process, the same kernel, so it joins SQLite's normal file
# locking rather than reading around it).
quad_read_store_generation() {
  docker run --rm -v "$STORE_VOLUME":/srv/ruflo --entrypoint node "$IMAGE" -e '
    const Database = require("/opt/ruflo-seed/node_modules/better-sqlite3")
    const db = new Database(process.argv[1], { readonly: true })
    process.stdout.write(db.prepare("SELECT id FROM store_generation").get().id)
    db.close()
  ' "$1"
}

# quad_set_store_generation <container-db-path> <new-id>
quad_set_store_generation() {
  docker run --rm -v "$STORE_VOLUME":/srv/ruflo --entrypoint node "$IMAGE" -e '
    const Database = require("/opt/ruflo-seed/node_modules/better-sqlite3")
    const db = new Database(process.argv[1])
    db.prepare("UPDATE store_generation SET id = ?").run(process.argv[2])
    process.stdout.write(db.prepare("SELECT id FROM store_generation").get().id)
    db.close()
  ' "$1" "$2"
}

# Restore-mechanics helpers (quad_sq, quad_manual_restore_cmd,
# quad_test_should_noop_restore, quad_verify_authority_restored,
# quad_restore_authority/_memory_db/_agentdb, quad_emergency_restore) --
# split into their own sibling once this file crossed the repo's 500-line
# pre-commit gate (L-7/L-8, post-merge governance retro on PR #2931).
# shellcheck source=quad.restore.sh
source "$HARNESS/lib/quad.restore.sh"

quad_arms() {
  h1 "ADR-170 § 5 -- authority-quad LIVE mutations, against the running Compose service $SERVICE"
  note "the volume-delete/recreate mutation and a copied-database mount are NOT run here (destructive to the live named volume $STORE_VOLUME) -- covered instead by the stubbed scripts/tests/mcp-ruflo-launcher.test.sh suite's quad-a/quad-d/quad-d-agentdb-missing arms, which fake the docker binary specifically so those two can be exercised safely."

  if [ ! -f "$QUAD_AUTHORITY_FILE" ]; then
    arm "Q0" "authority file must exist before these arms can mutate and restore it"
    applied "test -f $QUAD_AUTHORITY_FILE"
    predicate "Q0 authority file exists" 1 "a readable $QUAD_AUTHORITY_FILE" "absent -- refusing to run Q1-Q5 without a baseline to restore"
    return
  fi

  QUAD_AUTHORITY_BACKUP="$EVD/quad-authority-backup.json"
  cp "$QUAD_AUTHORITY_FILE" "$QUAD_AUTHORITY_BACKUP"
  QUAD_AUTHORITY_BACKUP_MD5="$(quad_md5 "$QUAD_AUTHORITY_FILE")"

  trap 'quad_emergency_restore' EXIT

  arm "Q1" "baseline: the launcher serves initialize against the live, unmutated service"
  applied "printf '<initialize>' | $LAUNCHER (JSON-RPC on stdin)"
  quad_probe q1-baseline
  if quad_served; then ok=0; else ok=1; fi
  predicate "Q1 baseline initialize succeeds" "$ok" \
    "a JSON-RPC result reply carrying id=1" \
    "rc=$QUAD_PROBE_RC stdout=$(cat "$QUAD_PROBE_OUT") stderr=$(cat "$QUAD_PROBE_ERR")"
  if [ "$ok" -ne 0 ]; then
    limitation "Q1 baseline did not succeed against the unmutated service -- Q2-Q5 below are not differential and must be read as unattributed."
  fi

  # ---- Q2: authority file generationUuid rewritten --------------------------
  arm "Q2" "authority file generationUuid rewritten to a random UUID -- the launcher must refuse naming quad (c) and the authority file"
  QUAD_DIRTY_AUTHORITY=1
  _q2_new="$(quad_random_uuid)"
  quad_write_authority_field generationUuid "$_q2_new"
  applied "rewrote generationUuid in $QUAD_AUTHORITY_FILE to $_q2_new (was a value both store files agreed with)"
  quad_probe q2-mutated
  if quad_refused_naming "authority quad c" && quad_refused_naming "$QUAD_AUTHORITY_FILE"; then ok=0; else ok=1; fi
  predicate "Q2 generation mismatch refuses naming quad (c) and $QUAD_AUTHORITY_FILE" "$ok" \
    "no stdout; stderr names 'authority quad c' and $QUAD_AUTHORITY_FILE" \
    "rc=$QUAD_PROBE_RC stdout=$(cat "$QUAD_PROBE_OUT") stderr=$(cat "$QUAD_PROBE_ERR")"
  if quad_restore_authority; then ok=0; else ok=1; fi
  predicate "Q2 restore: authority file is byte-identical to its pre-mutation backup" "$ok" \
    "$QUAD_AUTHORITY_FILE cmp-equal to the backup taken before Q2" \
    "cmp -s exit=$([ "$ok" -eq 0 ] && echo 0 || echo nonzero); backup md5=$QUAD_AUTHORITY_BACKUP_MD5 current md5=$(quad_md5 "$QUAD_AUTHORITY_FILE")"
  if [ "$ok" -ne 0 ]; then
    note "Q2 inline restore did not verify -- $QUAD_AUTHORITY_FILE stays flagged dirty; the EXIT-trap retry attempts it once more when quad_arms returns."
  fi
  quad_probe q2-restored
  if quad_served; then ok=0; else ok=1; fi
  predicate "Q2 restore: initialize succeeds again" "$ok" \
    "a JSON-RPC result reply carrying id=1, after restoring $QUAD_AUTHORITY_FILE" \
    "rc=$QUAD_PROBE_RC stdout=$(cat "$QUAD_PROBE_OUT") stderr=$(cat "$QUAD_PROBE_ERR")"

  # ---- Q3: authority file instanceNonce rewritten ----------------------------
  arm "Q3" "authority file instanceNonce rewritten to a random UUID -- the launcher must refuse naming quad (b) and the authority file"
  # shellcheck disable=SC2034  # consumed by lib/quad.restore.sh (quad_emergency_restore), not visible to shellcheck without -x
  QUAD_DIRTY_AUTHORITY=1
  _q3_new="$(quad_random_uuid)"
  quad_write_authority_field instanceNonce "$_q3_new"
  applied "rewrote instanceNonce in $QUAD_AUTHORITY_FILE to $_q3_new (was the value $STORE_VOLUME's own label carries)"
  quad_probe q3-mutated
  if quad_refused_naming "authority quad b" && quad_refused_naming "$QUAD_AUTHORITY_FILE"; then ok=0; else ok=1; fi
  predicate "Q3 nonce mismatch refuses naming quad (b) and $QUAD_AUTHORITY_FILE" "$ok" \
    "no stdout; stderr names 'authority quad b' and $QUAD_AUTHORITY_FILE" \
    "rc=$QUAD_PROBE_RC stdout=$(cat "$QUAD_PROBE_OUT") stderr=$(cat "$QUAD_PROBE_ERR")"
  if quad_restore_authority; then ok=0; else ok=1; fi
  predicate "Q3 restore: authority file is byte-identical to its pre-mutation backup" "$ok" \
    "$QUAD_AUTHORITY_FILE cmp-equal to the backup taken before Q2/Q3" \
    "cmp -s exit=$([ "$ok" -eq 0 ] && echo 0 || echo nonzero); backup md5=$QUAD_AUTHORITY_BACKUP_MD5 current md5=$(quad_md5 "$QUAD_AUTHORITY_FILE")"
  if [ "$ok" -ne 0 ]; then
    note "Q3 inline restore did not verify -- $QUAD_AUTHORITY_FILE stays flagged dirty; the EXIT-trap retry attempts it once more when quad_arms returns."
  fi
  quad_probe q3-restored
  if quad_served; then ok=0; else ok=1; fi
  predicate "Q3 restore: initialize succeeds again" "$ok" \
    "a JSON-RPC result reply carrying id=1, after restoring $QUAD_AUTHORITY_FILE" \
    "rc=$QUAD_PROBE_RC stdout=$(cat "$QUAD_PROBE_OUT") stderr=$(cat "$QUAD_PROBE_ERR")"

  # ---- Q4: memory.db's own marker row changed, ONLY that file ---------------
  arm "Q4" "memory.db's store_generation row changed in place (agentdb-memory.db untouched) -- the launcher must refuse naming quad (c) and memory.db"
  QUAD_MEMORY_DB_ORIG_ID="$(quad_read_store_generation "$QUAD_MEMORY_DB")"
  # L-7 (post-merge governance retro, PR #2931): quad_restore_memory_db()
  # clears QUAD_DIRTY_MEMORY_DB (and reports a verified restore) whenever the
  # read-back current id equals QUAD_MEMORY_DB_ORIG_ID -- including when
  # BOTH are empty, which a failed read here would produce. Assert the
  # original id is actually readable BEFORE this arm mutates anything, so an
  # unreadable store_generation row refuses loudly instead of "restoring" to
  # an empty string that was never a real generation.
  if [ -z "$QUAD_MEMORY_DB_ORIG_ID" ]; then
    predicate "Q4 memory.db original store_generation.id readable before mutation" 1 \
      "a non-empty store_generation.id read from $QUAD_MEMORY_DB before Q4 mutates it" \
      "read back empty -- refusing to mutate without a known-good value to restore"
    return
  fi
  _q4_new="$(quad_random_uuid)"
  # shellcheck disable=SC2034  # consumed by lib/quad.restore.sh (quad_emergency_restore), not visible to shellcheck without -x
  QUAD_DIRTY_MEMORY_DB=1
  quad_set_store_generation "$QUAD_MEMORY_DB" "$_q4_new" >/dev/null
  applied "docker run --rm -v $STORE_VOLUME:/srv/ruflo ... UPDATE store_generation SET id='$_q4_new' in $QUAD_MEMORY_DB only; original id recorded: $QUAD_MEMORY_DB_ORIG_ID"
  quad_probe q4-mutated
  if quad_refused_naming "authority quad c" && quad_refused_naming "$QUAD_MEMORY_DB"; then ok=0; else ok=1; fi
  predicate "Q4 memory.db generation mismatch refuses naming quad (c) and $QUAD_MEMORY_DB" "$ok" \
    "no stdout; stderr names 'authority quad c' and $QUAD_MEMORY_DB" \
    "rc=$QUAD_PROBE_RC stdout=$(cat "$QUAD_PROBE_OUT") stderr=$(cat "$QUAD_PROBE_ERR")"
  if quad_restore_memory_db; then ok=0; else ok=1; fi
  predicate "Q4 restore: memory.db's store_generation.id is back to its original value" "$ok" \
    "id == $QUAD_MEMORY_DB_ORIG_ID (the value recorded before Q4 mutated it)" \
    "read back: $QUAD_MEMORY_DB_CURRENT_ID"
  if [ "$ok" -ne 0 ]; then
    note "Q4 inline restore did not verify -- $QUAD_MEMORY_DB stays flagged dirty; the EXIT-trap retry attempts it once more when quad_arms returns."
  fi
  quad_probe q4-restored
  if quad_served; then ok=0; else ok=1; fi
  predicate "Q4 restore: initialize succeeds again" "$ok" \
    "a JSON-RPC result reply carrying id=1, after restoring $QUAD_MEMORY_DB" \
    "rc=$QUAD_PROBE_RC stdout=$(cat "$QUAD_PROBE_OUT") stderr=$(cat "$QUAD_PROBE_ERR")"

  # ---- Q5: agentdb-memory.db's own marker row changed, ONLY that file -------
  arm "Q5" "agentdb-memory.db's store_generation row changed in place (memory.db untouched) -- the launcher must refuse naming quad (c) and agentdb-memory.db"
  QUAD_AGENTDB_ORIG_ID="$(quad_read_store_generation "$QUAD_AGENTDB")"
  # L-7: same assertion as Q4 above, for agentdb-memory.db's own original id.
  if [ -z "$QUAD_AGENTDB_ORIG_ID" ]; then
    predicate "Q5 agentdb-memory.db original store_generation.id readable before mutation" 1 \
      "a non-empty store_generation.id read from $QUAD_AGENTDB before Q5 mutates it" \
      "read back empty -- refusing to mutate without a known-good value to restore"
    return
  fi
  _q5_new="$(quad_random_uuid)"
  # shellcheck disable=SC2034  # consumed by lib/quad.restore.sh (quad_emergency_restore), not visible to shellcheck without -x
  QUAD_DIRTY_AGENTDB=1
  quad_set_store_generation "$QUAD_AGENTDB" "$_q5_new" >/dev/null
  applied "docker run --rm -v $STORE_VOLUME:/srv/ruflo ... UPDATE store_generation SET id='$_q5_new' in $QUAD_AGENTDB only; original id recorded: $QUAD_AGENTDB_ORIG_ID"
  quad_probe q5-mutated
  if quad_refused_naming "authority quad c" && quad_refused_naming "$QUAD_AGENTDB"; then ok=0; else ok=1; fi
  predicate "Q5 agentdb-memory.db generation mismatch refuses naming quad (c) and $QUAD_AGENTDB" "$ok" \
    "no stdout; stderr names 'authority quad c' and $QUAD_AGENTDB" \
    "rc=$QUAD_PROBE_RC stdout=$(cat "$QUAD_PROBE_OUT") stderr=$(cat "$QUAD_PROBE_ERR")"
  if quad_restore_agentdb; then ok=0; else ok=1; fi
  predicate "Q5 restore: agentdb-memory.db's store_generation.id is back to its original value" "$ok" \
    "id == $QUAD_AGENTDB_ORIG_ID (the value recorded before Q5 mutated it)" \
    "read back: $QUAD_AGENTDB_CURRENT_ID"
  if [ "$ok" -ne 0 ]; then
    note "Q5 inline restore did not verify -- $QUAD_AGENTDB stays flagged dirty; the EXIT-trap retry attempts it once more when quad_arms returns."
  fi
  quad_probe q5-restored
  if quad_served; then ok=0; else ok=1; fi
  predicate "Q5 restore: initialize succeeds again" "$ok" \
    "a JSON-RPC result reply carrying id=1, after restoring $QUAD_AGENTDB" \
    "rc=$QUAD_PROBE_RC stdout=$(cat "$QUAD_PROBE_OUT") stderr=$(cat "$QUAD_PROBE_ERR")"

  # Final guaranteed retry+report for anything an inline restore above left
  # dirty (a no-op for whatever already verified) -- covers the NORMAL return
  # path, since disarming the trap below does not itself fire it.
  quad_emergency_restore
  trap - EXIT
}
