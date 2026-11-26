#!/usr/bin/env bash
# scripts/lib/pre-push-suite-runner.sh
# SMI-7218 Wave 2: per-suite budgets and an in-container kill for pre-push Phase 4.
#
# Sourced by scripts/pre-push-coverage-check.sh (and by its behaviour tests).
# bash only: the inner wrapper relies on `set -m` and `kill -KILL -- -PGID`,
# which silently fail under sh (measured).
#
# REQUIRES from the caller's scope:
#   USE_DOCKER   0|1   (from scripts/lib/hook-docker-detect.sh)
#   run_cmd <args...>  (docker exec on the Docker route, plain exec on host)
#
# DEFINES: suite_budget, suggest_budget, init_suite_budgets, run_suite,
#          run_suite_timed, print_failure_summary
# SETS (run_suite_timed): FAILED_PACKAGES, TIMED_OUT_PACKAGES (appended),
#          SUITE_SUGGESTED_BUDGET (largest suggestion so far; 0 = none)
#
# Why the timeout lives INSIDE the container: the host-side `timeout` in
# .husky/pre-push only kills the `docker exec` client. The in-container `wait`
# never returns and the whole vitest process group keeps running (measured: 20
# survivors). `timeout` as the job's group leader kills vitest and every worker
# when it fires, even if the host client is already gone (measured: 0 survivors).

# ---- Per-suite budgets (seconds) --------------------------------------------
# Measured on 10 CPUs, three runs each (SMI-7218). Idle: core 157-163 s,
# cli 16-17 s, mcp-server 23-24 s, enterprise 9 s. With a second core suite
# looping in the same container: core 328-343 s, cli 28-51 s, mcp-server
# 41-45 s, enterprise 16-26 s. Each budget sits well above the loaded maximum
# (core about 1.6x), so a busy laptop passes while a hung suite is cut off.
# The host backstop in .husky/pre-push must stay above the sum of
# (budget + kill-after) plus a startup margin; its tests check that.
suite_budget() {
  case "$1" in
    core) echo 540 ;;
    cli) echo 90 ;;
    mcp-server) echo 120 ;;
    enterprise) echo 60 ;;
    *) echo 120 ;;
  esac
}

# One override knob: SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS applies to EVERY suite.
# Test-only: SKILLSMITH_PRE_PUSH_KILL_AFTER_SECS shortens the TERM->KILL grace
# (default 15 s) so behaviour tests stay fast. Not a user-facing knob.
SUITE_BUDGET_OVERRIDE=""
SUITE_KILL_AFTER=15
SUITE_TIMEOUT_BIN=""
# Set at source time too (not only in init_suite_budgets), so a caller that
# sources this file and never calls init_suite_budgets still works under set -u.
TIMED_OUT_PACKAGES=""
SUITE_SUGGESTED_BUDGET=0

# suggest_budget <budget>
# Twice the budget, capped at the override's 5-digit limit (99999). Prints
# nothing when that would not raise the budget, so no message ever suggests a
# value that cannot help.
suggest_budget() {
  local s=$(($1 * 2))
  if [ "$s" -gt 99999 ]; then s=99999; fi
  if [ "$s" -gt "$1" ]; then echo "$s"; fi
  return 0
}

init_suite_budgets() {
  TIMED_OUT_PACKAGES=""
  SUITE_SUGGESTED_BUDGET=0
  SUITE_BUDGET_OVERRIDE=""
  local raw="${SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS:-}"
  if [ -n "$raw" ]; then
    if [[ "$raw" =~ ^[1-9][0-9]{0,4}$ ]]; then
      SUITE_BUDGET_OVERRIDE="$raw"
      echo "ℹ️  SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=$raw: every suite gets a ${raw}s budget (defaults ignored)"
    else
      echo "⚠️  SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS='$raw' is not a positive integer of at most 5 digits — using default per-suite budgets"
    fi
  fi
  local ka="${SKILLSMITH_PRE_PUSH_KILL_AFTER_SECS:-15}"
  if [[ "$ka" =~ ^[1-9][0-9]*$ ]]; then SUITE_KILL_AFTER="$ka"; else SUITE_KILL_AFTER=15; fi

  SUITE_TIMEOUT_BIN=""
  if [ "${SKILLSMITH_PRE_PUSH_NO_PG_SWEEP:-0}" = "1" ]; then
    echo "ℹ️  SKILLSMITH_PRE_PUSH_NO_PG_SWEEP=1: suites run plainly, with no process-group sweep and no per-suite timeout"
  else
    if [ "${USE_DOCKER:-0}" = "1" ]; then
      SUITE_TIMEOUT_BIN="timeout" # GNU timeout lives in the dev container image
    elif command -v timeout >/dev/null 2>&1; then
      SUITE_TIMEOUT_BIN="timeout"
    elif command -v gtimeout >/dev/null 2>&1; then
      SUITE_TIMEOUT_BIN="gtimeout"
    else
      echo "ℹ️  Host route: neither timeout nor gtimeout found — suites run with no per-suite timeout"
    fi
  fi
}

# run_suite <budget_secs> <command-string>
# Runs one suite in its own process group (SMI-4931), under an in-group
# `timeout` (SMI-7218) when SUITE_TIMEOUT_BIN is set. After `wait`, the group is
# SIGKILLed to sweep workers leaked past a normal exit.
# SKILLSMITH_PRE_PUSH_NO_PG_SWEEP=1 keeps its existing meaning: a plain
# invocation, with no process group and no inner timeout either.
run_suite() {
  local budget="$1" cmd="$2"
  if [ "${SKILLSMITH_PRE_PUSH_NO_PG_SWEEP:-0}" = "1" ]; then
    run_cmd bash -c "$cmd"
    return $?
  fi
  # shellcheck disable=SC2016  # single-quoted ON PURPOSE: $1..$4/$_vp/$_ec must
  # expand in the inner `bash -c` child, never in this top-level shell.
  run_cmd bash -c '
    set -m
    if [ -n "$4" ]; then
      ( exec "$4" --kill-after="${3}s" "$2" bash -c "$1" ) &
    else
      ( eval "$1" ) &
    fi
    _vp=$!
    wait "$_vp"; _ec=$?
    kill -KILL -- -"$_vp" 2>/dev/null
    exit "$_ec"
  ' _ "$cmd" "$budget" "$SUITE_KILL_AFTER" "$SUITE_TIMEOUT_BIN"
}

# run_suite_timed <pkg> <command-string>
# Runs the suite, prints elapsed seconds, tells a timeout from a failure, and
# appends the package to FAILED_PACKAGES on either (and to TIMED_OUT_PACKAGES
# on a timeout).
run_suite_timed() {
  local pkg="$1" cmd="$2" budget out ec start elapsed suggestion
  budget="${SUITE_BUDGET_OVERRIDE:-$(suite_budget "$pkg")}"
  start=$SECONDS
  out=$(run_suite "$budget" "$cmd" 2>&1)
  ec=$?
  elapsed=$((SECONDS - start))
  if [ "$ec" -eq 0 ]; then
    echo "  ✓ packages/$pkg passed (${elapsed}s)"
    return 0
  fi
  FAILED_PACKAGES="$FAILED_PACKAGES $pkg"
  # A suite reaches its budget only when `timeout` fires (124, or 137 once the
  # kill-after SIGKILL was needed), so a timeout needs BOTH that status AND the
  # elapsed time. A 124 or 137 the suite produced itself before its budget (an
  # OOM kill, or a tool's own status) is a plain failure. Residual: elapsed is
  # measured on the host and includes docker exec startup, so a suite's own
  # 124/137 within about a second of the budget can still read as a timeout.
  if [ -n "$SUITE_TIMEOUT_BIN" ] && { [ "$ec" -eq 124 ] || [ "$ec" -eq 137 ]; } && [ "$elapsed" -ge "$budget" ]; then
    TIMED_OUT_PACKAGES="$TIMED_OUT_PACKAGES $pkg"
    echo "  ⏱  packages/$pkg exceeded its ${budget}s budget (timed out; killed) after ${elapsed}s"
    echo "     Cause: the suite hung, or the machine is busy enough to slow it past the budget."
    suggestion="$(suggest_budget "$budget")"
    if [ -n "$suggestion" ]; then
      if [ "$suggestion" -gt "$SUITE_SUGGESTED_BUDGET" ]; then SUITE_SUGGESTED_BUDGET="$suggestion"; fi
      echo "     If it is only slow, raise every suite's budget for one push:"
      echo "       SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=$suggestion git push"
    fi
  else
    echo "  ✗ packages/$pkg failed (exit $ec, ${elapsed}s)"
  fi
  echo "$out"
  return "$ec"
}

# print_failure_summary <hint-prefix> <vitest-bin>
# The end-of-phase summary. Timed-out suites are named as such, and when any
# timed out with a useful suggestion, the one-push budget override is named
# before the last-resort --no-verify.
print_failure_summary() {
  local prefix="$1" vitest="$2" pkg
  for pkg in $FAILED_PACKAGES; do
    case " $TIMED_OUT_PACKAGES " in
      *" $pkg "*) echo "⏱  packages/$pkg timed out (budget exceeded)" ;;
      *) echo "❌ Tests failed in packages/$pkg!" ;;
    esac
    echo "   Run: ${prefix}bash -c \"cd packages/$pkg && ${vitest} run\""
  done
  echo ""
  if [ -n "$TIMED_OUT_PACKAGES" ] && [ "${SUITE_SUGGESTED_BUDGET:-0}" -gt 0 ]; then
    echo "   If a timed-out suite is only slow: SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=$SUITE_SUGGESTED_BUDGET git push"
    echo "   Last resort, skipping every pre-push check: git push --no-verify"
  else
    echo "   Bypass: git push --no-verify"
  fi
}
