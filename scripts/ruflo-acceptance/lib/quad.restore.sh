#!/usr/bin/env bash
# scripts/ruflo-acceptance/lib/quad.restore.sh -- restore-mechanics helpers for
# lib/quad.sh (SMI-6744 A1.8 authority-quad LIVE mutations). Split into this
# sibling once quad.sh crossed the repo's own 500-line pre-commit gate
# (scripts/check-file-length.mjs) after the L-7/L-8 fixes (post-merge governance
# retro on PR #2931).
#
# Sourced by scripts/ruflo-acceptance/run.sh alongside lib/quad.sh, in the same
# shell -- these functions read/set quad.sh's own globals
# (QUAD_AUTHORITY_FILE, QUAD_AUTHORITY_BACKUP, QUAD_MEMORY_DB*, QUAD_AGENTDB*,
# QUAD_DIRTY_*) and call its quad_set_store_generation()/
# quad_read_store_generation() helpers; not meant to be run standalone.
#
# bash 3.2-safe, shellcheck -S warning clean -- same conventions as quad.sh.

# quad_sq <string> -- single-quote a value for a pasteable sh command line, so
# a path or id carrying spaces, quotes or metacharacters stays one argument
# (the gate's round-3 Low: the header's "exact command" claim was not safe
# without this). Bash 3.2-safe.
quad_sq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# quad_manual_restore_cmd <container-db-path> <original-id> -- the literal
# docker one-liner a human can copy-paste to restore a store marker by hand,
# printed only when both the inline and EXIT-trap restores fail verification.
quad_manual_restore_cmd() {
  printf 'docker run --rm -v %s:/srv/ruflo --entrypoint node %s -e '\''const Database=require("/opt/ruflo-seed/node_modules/better-sqlite3");const db=new Database(process.argv[1]);db.prepare("UPDATE store_generation SET id=?").run(process.argv[2]);db.close()'\'' %s %s' \
    "$(quad_sq "$STORE_VOLUME")" "$(quad_sq "$IMAGE")" "$(quad_sq "$1")" "$(quad_sq "$2")"
}

# quad_test_should_noop_restore <resource> -- TEST-ONLY seam for the RED ARM
# that proved the round-2 fix (see header). INERT (always returns 1, "don't
# no-op") unless RUFLO_QUAD_TEST_FAIL_RESTORE is exported as exactly
# "authority", "memory_db" or "agentdb" -- never set in a real run, so this
# changes nothing outside that scratch-copy test. When set, it no-ops the
# FIRST restore attempt for the matching resource only (simulating a
# transient `cp`/UPDATE failure the EXIT-trap retry then recovers from);
# RUFLO_QUAD_TEST_FAIL_RESTORE_PERSIST additionally makes EVERY attempt
# (inline and the EXIT-trap retry) a no-op, simulating an unrecoverable one.
quad_test_should_noop_restore() {
  [ "${RUFLO_QUAD_TEST_FAIL_RESTORE:-}" = "$1" ] || return 1
  [ -n "${RUFLO_QUAD_TEST_FAIL_RESTORE_PERSIST:-}" ] && return 0
  case "$1" in
    authority)
      [ "$QUAD_TEST_FAIL_RESTORE_USED_AUTHORITY" -eq 1 ] && return 1
      QUAD_TEST_FAIL_RESTORE_USED_AUTHORITY=1
      ;;
    memory_db)
      [ "$QUAD_TEST_FAIL_RESTORE_USED_MEMORY_DB" -eq 1 ] && return 1
      QUAD_TEST_FAIL_RESTORE_USED_MEMORY_DB=1
      ;;
    agentdb)
      [ "$QUAD_TEST_FAIL_RESTORE_USED_AGENTDB" -eq 1 ] && return 1
      QUAD_TEST_FAIL_RESTORE_USED_AGENTDB=1
      ;;
    *)
      return 1
      ;;
  esac
  return 0
}

# quad_verify_authority_restored -- 0 iff the authority file is currently
# byte-identical to the pre-mutation backup taken before Q2.
quad_verify_authority_restored() {
  cmp -s "$QUAD_AUTHORITY_FILE" "$QUAD_AUTHORITY_BACKUP"
}

# quad_restore_authority -- attempts the cp restore, then independently
# VERIFIES it via cmp before touching the dirty flag. Clears
# QUAD_DIRTY_AUTHORITY and returns 0 ONLY when verified; otherwise leaves the
# flag set and returns 1, so a caller (inline arm code, or the EXIT trap) can
# tell a genuine restore from a no-op and never mistakes "we tried" for "it
# worked". Never lets a failed `cp` abort the caller under `set -e`.
#
# L-8 (post-merge governance retro, PR #2931): restores the CALLER's own
# errexit state afterward instead of unconditionally `set -e`-ing back on.
# quad_emergency_restore (the EXIT trap handler) starts its ENTIRE body with
# `set +e` specifically so nothing inside it can abort an already-exiting
# shell (its own header says so) -- an unconditional `set -e` here, called
# from inside that body, re-enabled errexit for every statement AFTER the
# first restore call in quad_emergency_restore, defeating that caller's own
# invariant. `case "$-" in *e*)` reads whether errexit was already active
# BEFORE this function's own `set +e` below, so the net effect on the
# caller's errexit state is always a no-op.
quad_restore_authority() {
  case "$-" in *e*) _quad_had_errexit=1 ;; *) _quad_had_errexit=0 ;; esac
  set +e
  if ! quad_test_should_noop_restore authority; then
    cp "$QUAD_AUTHORITY_BACKUP" "$QUAD_AUTHORITY_FILE" 2>/dev/null
  fi
  quad_verify_authority_restored
  _quad_authority_verified=$?
  [ "$_quad_had_errexit" -eq 1 ] && set -e
  if [ "$_quad_authority_verified" -eq 0 ]; then
    QUAD_DIRTY_AUTHORITY=0
    return 0
  fi
  return 1
}

# quad_restore_memory_db -- same contract as quad_restore_authority
# (including the L-8 errexit-preservation fix above), for memory.db's
# store_generation.id. Sets QUAD_MEMORY_DB_CURRENT_ID as a side effect so
# callers can report the read-back value without a second docker-run round
# trip.
quad_restore_memory_db() {
  case "$-" in *e*) _quad_had_errexit=1 ;; *) _quad_had_errexit=0 ;; esac
  set +e
  if ! quad_test_should_noop_restore memory_db; then
    quad_set_store_generation "$QUAD_MEMORY_DB" "$QUAD_MEMORY_DB_ORIG_ID" >/dev/null 2>&1
  fi
  QUAD_MEMORY_DB_CURRENT_ID="$(quad_read_store_generation "$QUAD_MEMORY_DB" 2>/dev/null)"
  [ "$_quad_had_errexit" -eq 1 ] && set -e
  if [ "$QUAD_MEMORY_DB_CURRENT_ID" = "$QUAD_MEMORY_DB_ORIG_ID" ]; then
    QUAD_DIRTY_MEMORY_DB=0
    return 0
  fi
  return 1
}

# quad_restore_agentdb -- same contract as quad_restore_memory_db
# (including the L-8 errexit-preservation fix above), for
# agentdb-memory.db's store_generation.id.
quad_restore_agentdb() {
  case "$-" in *e*) _quad_had_errexit=1 ;; *) _quad_had_errexit=0 ;; esac
  set +e
  if ! quad_test_should_noop_restore agentdb; then
    quad_set_store_generation "$QUAD_AGENTDB" "$QUAD_AGENTDB_ORIG_ID" >/dev/null 2>&1
  fi
  QUAD_AGENTDB_CURRENT_ID="$(quad_read_store_generation "$QUAD_AGENTDB" 2>/dev/null)"
  [ "$_quad_had_errexit" -eq 1 ] && set -e
  if [ "$QUAD_AGENTDB_CURRENT_ID" = "$QUAD_AGENTDB_ORIG_ID" ]; then
    QUAD_DIRTY_AGENTDB=0
    return 0
  fi
  return 1
}

# quad_emergency_restore -- the EXIT-trap handler (armed for the duration of
# quad_arms, see header) AND the explicit final retry quad_arms makes right
# before disarming that trap. Retries ONLY whatever is STILL flagged dirty --
# an inline restore that already verified has cleared its own flag, so this
# is a genuine second attempt, never a redundant no-op reported as one. Loud
# either way: "restored on exit" once verified, or "RESTORE FAILED ON EXIT"
# with the exact manual-recovery command when it still doesn't verify. Never
# lets a failure inside itself abort an already-exiting shell.
#
# L-D (SMI-6744 A1.8 retro): applies the SAME L-8 errexit-preservation fix
# to this function's OWN `set -e` at the end -- L-8 above fixed the three
# quad_restore_* callees but left this one, the file's own trap handler,
# calling those callees FROM an unconditional `set -e` context. Same shape
# one function over.
quad_emergency_restore() {
  case "$-" in *e*) _quad_emerg_had_errexit=1 ;; *) _quad_emerg_had_errexit=0 ;; esac
  set +e
  if [ "$QUAD_DIRTY_AUTHORITY" -eq 1 ]; then
    if quad_restore_authority; then
      printf 'quad: %s restored on exit\n' "$QUAD_AUTHORITY_FILE"
    else
      printf 'quad: RESTORE FAILED ON EXIT -- %s is still mutated; manual recovery: cp %s %s\n' \
        "$QUAD_AUTHORITY_FILE" "$(quad_sq "$QUAD_AUTHORITY_BACKUP")" "$(quad_sq "$QUAD_AUTHORITY_FILE")"
    fi
  fi
  if [ "$QUAD_DIRTY_MEMORY_DB" -eq 1 ]; then
    if quad_restore_memory_db; then
      printf 'quad: %s restored on exit (store_generation.id=%s)\n' "$QUAD_MEMORY_DB" "$QUAD_MEMORY_DB_ORIG_ID"
    else
      printf 'quad: RESTORE FAILED ON EXIT -- %s is still mutated; manual recovery: %s\n' \
        "$QUAD_MEMORY_DB" "$(quad_manual_restore_cmd "$QUAD_MEMORY_DB" "$QUAD_MEMORY_DB_ORIG_ID")"
    fi
  fi
  if [ "$QUAD_DIRTY_AGENTDB" -eq 1 ]; then
    if quad_restore_agentdb; then
      printf 'quad: %s restored on exit (store_generation.id=%s)\n' "$QUAD_AGENTDB" "$QUAD_AGENTDB_ORIG_ID"
    else
      printf 'quad: RESTORE FAILED ON EXIT -- %s is still mutated; manual recovery: %s\n' \
        "$QUAD_AGENTDB" "$(quad_manual_restore_cmd "$QUAD_AGENTDB" "$QUAD_AGENTDB_ORIG_ID")"
    fi
  fi
  [ "$_quad_emerg_had_errexit" -eq 1 ] && set -e
  return 0
}

