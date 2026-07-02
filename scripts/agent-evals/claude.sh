#!/bin/sh
# scripts/agent-evals/claude.sh — L2b headless eval runner: Claude Code.
# SMI-5456 Wave 1 Step 6 (Validation Ladder Level 2b).
#
# Drives the three MVP jobs (keep-current, audit-fix, vet-before-install)
# through `claude -p "<prompt>"` (Claude Code's headless one-shot mode,
# confirmed in the Step-0 spike) and captures all output to
# results/claude-code-<date>.log.
#
# Precondition: the Skillsmith agent pack is installed (`sklx agent install`)
# so the `skillsmith-agent` subagent + curated MCP profile are available in
# this session. This script does not install anything itself.
#
# SAFE TO COMMIT UNEXECUTED: runs only when a maintainer invokes it by hand.
# Missing binary -> clean exit 2 (see lib.sh check_binary), never a crash.
#
# Usage: ./scripts/agent-evals/claude.sh

set -eu

SCRIPT_DIR=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

check_binary claude

RESULTS_DIR=$(agent_eval_results_dir "$0")
LOG=$(agent_eval_log_path "$RESULTS_DIR" "claude-code")

echo "[agent-eval] claude-code -> $LOG"

run_job "$LOG" "keep-current" -- claude -p \
  "What skills do I have installed that are outdated, and what changed?"

run_job "$LOG" "audit-fix" -- claude -p \
  "Audit my installed skills for namespace collisions or issues, and tell me what you would fix. Do not apply anything yet."

run_job "$LOG" "vet-before-install" -- claude -p \
  "I am thinking about installing the skill anthropic/commit. Look it up and tell me whether it is safe to install."

echo "[agent-eval] done -- see $LOG"
