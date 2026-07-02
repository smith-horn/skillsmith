#!/bin/sh
# scripts/agent-evals/lib.sh — shared helpers for the L2b headless eval
# runners (SMI-5456 Wave 1 Step 6, Validation Ladder Level 2b).
# Sourced (not executed) by each <harness>.sh runner in this directory.
#
# Conventions: POSIX sh only (dash-compatible, no bash-isms — no `local`,
# no `[[ ]]`, no arrays). ASCII output only. Every runner using this file is
# safe to commit unexecuted: nothing here makes a network call, installs
# anything, or runs automatically — a maintainer invokes a runner by hand.

# check_binary NAME — print a clear message and exit 2 if NAME is not on
# PATH. Exit code 2 is the documented "harness not installed" signal for
# every runner in this directory (never a bare crash).
check_binary() {
  bin="$1"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[agent-eval] SKIP: '$bin' not found on PATH -- harness not installed on this machine." >&2
    echo "[agent-eval] Install it, then re-run this script." >&2
    exit 2
  fi
}

# agent_eval_results_dir SCRIPT_PATH — print (and ensure) the results/
# directory next to the calling script, resolved absolutely regardless of
# the caller's cwd.
agent_eval_results_dir() {
  script_dir=$(CDPATH="" cd -- "$(dirname -- "$1")" && pwd)
  results_dir="$script_dir/results"
  mkdir -p "$results_dir"
  echo "$results_dir"
}

# agent_eval_log_path RESULTS_DIR HARNESS_NAME — print today's log path.
agent_eval_log_path() {
  eval_date=$(date +%Y-%m-%d 2>/dev/null || echo "unknown-date")
  echo "$1/$2-$eval_date.log"
}

# run_job LOG JOB_ID -- CMD [ARGS...] — append a delimited section to LOG
# recording CMD's combined stdout+stderr and exit code. CMD is invoked as a
# real argument list (never a concatenated/eval'd string), matching the
# repo's no-shell-injection convention for process invocation.
#
# Never aborts the caller on a non-zero CMD exit (records it instead) so one
# failing MVP job does not stop the remaining jobs in the same eval run —
# the point of this suite is to observe behavior, not to gate on it.
run_job() {
  log="$1"
  job_id="$2"
  shift 2
  if [ "$1" = "--" ]; then shift; fi
  {
    echo "=== JOB: $job_id ($(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) UTC) ==="
    if "$@"; then
      status=0
    else
      status=$?
    fi
    echo "=== JOB: $job_id EXIT=$status ==="
    echo ""
  } >>"$log" 2>&1
}
