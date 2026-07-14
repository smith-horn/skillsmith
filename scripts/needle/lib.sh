#!/usr/bin/env bash
# scripts/needle/lib.sh — NEEDLE-specific helpers for scripts/needle/dispatch.sh.
# SMI-5668 (ADR-128 pilot: NEEDLE-based Codex dispatch).
#
# Sources scripts/agent-evals/lib.sh for check_binary rather than duplicating
# it. Bash (not POSIX sh, unlike agent-evals/lib.sh) because dispatch.sh
# itself needs bash's [[ ]]/BASH_SOURCE for its create-worktree.sh-style
# flag parsing — see docs/internal/implementation/smi-5668-needle-codex-dispatch.md § 4.

set -euo pipefail

NEEDLE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../agent-evals/lib.sh
source "$NEEDLE_LIB_DIR/../agent-evals/lib.sh"

# NEEDLE_ALLOWED_MODELS — the Codex models confirmed present in
# ~/.codex/models_cache.json at diligence time (see this doc's § Surface
# Grounding). An explicit allowlist, not passed through unchecked: {model}
# flows into a shell-interpreted invoke_template (codex-adapter.yaml), so an
# unvalidated value reaching it would be a command-injection surface.
NEEDLE_ALLOWED_MODELS="gpt-5.6-sol gpt-5.5 gpt-5.6-luna gpt-5.6-terra"

# needle_model_allowed MODEL — returns 0 if MODEL is in the allowlist above,
# 1 otherwise.
needle_model_allowed() {
  local model="$1" allowed
  for allowed in $NEEDLE_ALLOWED_MODELS; do
    if [[ "$model" == "$allowed" ]]; then
      return 0
    fi
  done
  return 1
}

# needle_results_dir SCRIPT_PATH — print (and ensure) scripts/needle/results/
# next to the calling script, mirroring agent_eval_results_dir's convention
# (results/*.log are gitignored via the repo's blanket *.log rule).
needle_results_dir() {
  local script_dir results_dir
  script_dir=$(CDPATH="" cd -- "$(dirname -- "$1")" && pwd)
  results_dir="$script_dir/results"
  mkdir -p "$results_dir"
  echo "$results_dir"
}

# needle_log_path RESULTS_DIR — print today's dispatch summary log path.
needle_log_path() {
  local log_date
  log_date=$(date +%Y-%m-%d 2>/dev/null || echo "unknown-date")
  echo "$1/codex-$log_date.log"
}

# needle_bead_trace_path WORKSPACE BEAD_ID — print the path to NEEDLE's own
# per-bead trace file. Not guaranteed to exist — caller checks before
# reading it.
needle_bead_trace_path() {
  echo "$1/.beads/traces/$2/trace.jsonl"
}
