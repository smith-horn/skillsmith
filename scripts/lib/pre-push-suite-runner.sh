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
# DEFINES: suite_budget, init_suite_budgets, run_suite, run_suite_timed
# SETS (run_suite_timed): FAILED_PACKAGES (appended)
#
# Why the timeout lives INSIDE the container: the host-side `timeout` in
# .husky/pre-push only kills the `docker exec` client. The in-container `wait`
# never returns and the whole vitest process group keeps running (measured: 20
# survivors). `timeout` as the job's group leader kills vitest and every worker
# when it fires, even if the host client is already gone (measured: 0 survivors).

# ---- Per-suite budgets (seconds) --------------------------------------------
# Measured idle on 10 CPUs: core 157-163 s, cli 16-17 s, mcp-server 23-24 s,
# enterprise 9 s. Each budget is roughly 2x the measurement (core ~2.2x) so a
# loaded laptop passes, while a hung suite is cut off. The host backstop in
# .husky/pre-push (690 s) must stay above the SUM of these (630 s).
suite_budget() {
  case "$1" in
    core) echo 360 ;;
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

init_suite_budgets() {
  SUITE_BUDGET_OVERRIDE=""
  local raw="${SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS:-}"
  if [ -n "$raw" ]; then
    if [[ "$raw" =~ ^[1-9][0-9]*$ ]]; then
      SUITE_BUDGET_OVERRIDE="$raw"
      echo "ℹ️  SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=$raw: every suite gets a ${raw}s budget (defaults ignored)"
    else
      echo "⚠️  SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS='$raw' is not a positive integer — using default per-suite budgets"
    fi
  fi
  local ka="${SKILLSMITH_PRE_PUSH_KILL_AFTER_SECS:-15}"
  if [[ "$ka" =~ ^[1-9][0-9]*$ ]]; then SUITE_KILL_AFTER="$ka"; else SUITE_KILL_AFTER=15; fi

  SUITE_TIMEOUT_BIN=""
  if [ "${SKILLSMITH_PRE_PUSH_NO_PG_SWEEP:-0}" != "1" ]; then
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
# appends the package to FAILED_PACKAGES on either.
run_suite_timed() {
  local pkg="$1" cmd="$2" budget out ec start elapsed
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
  # 124 = timeout fired; 137 = needed the kill-after SIGKILL. 137 alone could
  # be an OOM kill, so it only counts as a timeout once the budget has elapsed.
  if [ -n "$SUITE_TIMEOUT_BIN" ] && { [ "$ec" -eq 124 ] || { [ "$ec" -eq 137 ] && [ "$elapsed" -ge "$budget" ]; }; }; then
    echo "  ⏱  packages/$pkg exceeded its ${budget}s budget (timed out; killed) after ${elapsed}s"
  else
    echo "  ✗ packages/$pkg failed (exit $ec, ${elapsed}s)"
  fi
  echo "$out"
  return "$ec"
}
