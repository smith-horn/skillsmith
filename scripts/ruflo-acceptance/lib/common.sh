#!/usr/bin/env bash
# Shared reporting primitives for the ruflo acceptance harness (SMI-6744 A1.4
# part iv). bash 3.2-safe: no associative arrays, no ${var^^}, no mapfile.
#
# Every arm prints, in this order:
#   arm <id> -- <what it checks>
#   applied=<what was actually done>
#   predicate <name>: HELD|FAILED with BOTH values
# Nothing is inferred from an exit code alone; a command's status is captured
# into a variable immediately and printed beside the values it produced.

ARMS_TOTAL=0
ARMS_HELD=0
ARMS_FAILED=0
MUT_KILLED=0
MUT_SURVIVED=0
LIMITATIONS_FILE="${LIMITATIONS_FILE:-}"

h1() { printf '\n========================================================================\n%s\n========================================================================\n' "$1"; }
h2() { printf '\n------------------------------------------------------------------------\n%s\n------------------------------------------------------------------------\n' "$1"; }

arm() { printf '\narm %s -- %s\n' "$1" "$2"; }
applied() { printf '  applied=%s\n' "$1"; }
note() { printf '  note: %s\n' "$1"; }

# predicate <name> <ok:0|1> <expected> <actual>
predicate() {
  ARMS_TOTAL=$((ARMS_TOTAL + 1))
  if [ "$2" -eq 0 ]; then
    ARMS_HELD=$((ARMS_HELD + 1))
    printf '  predicate %s: HELD\n    expected: %s\n    actual:   %s\n' "$1" "$3" "$4"
  else
    ARMS_FAILED=$((ARMS_FAILED + 1))
    printf '  predicate %s: FAILED\n    expected: %s\n    actual:   %s\n' "$1" "$3" "$4"
  fi
}

# observation <name> <text> -- recorded, never a pass/fail
observation() { printf '  observation %s: %s\n' "$1" "$2"; }

# mutation <name> <killed:0|1> <observed-values>
mutation() {
  if [ "$2" -eq 0 ]; then
    MUT_KILLED=$((MUT_KILLED + 1))
    printf '  mutation %s: KILLED\n    observed: %s\n' "$1" "$3"
  else
    MUT_SURVIVED=$((MUT_SURVIVED + 1))
    printf '  mutation %s: SURVIVED\n    observed: %s\n' "$1" "$3"
  fi
}

limitation() {
  printf '  LIMITATION: %s\n' "$1"
  if [ -n "$LIMITATIONS_FILE" ]; then printf '%s\n' "$1" >>"$LIMITATIONS_FILE"; fi
}

summary() {
  h2 "SUMMARY"
  printf 'predicates: %s held, %s failed (of %s)\nmutations:  %s KILLED, %s SURVIVED\n' \
    "$ARMS_HELD" "$ARMS_FAILED" "$ARMS_TOTAL" "$MUT_KILLED" "$MUT_SURVIVED"
  if [ -n "$LIMITATIONS_FILE" ] && [ -s "$LIMITATIONS_FILE" ]; then
    printf '\nlimitations recorded:\n'
    sed 's/^/  - /' "$LIMITATIONS_FILE"
  fi
}

# run_capture <rc-var-name> <out-file> -- runs "$@" with stdout+stderr to the
# file and the producer's own status captured, never a pipeline's last status.
# CLAUDE.md: "Capture the producer's output and status separately ... truncate
# only when displaying."
run_capture() {
  _rc_var="$1"
  _out="$2"
  shift 2
  set +e
  "$@" >"$_out" 2>&1
  _rc=$?
  set -e
  eval "$_rc_var=$_rc"
}
