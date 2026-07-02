#!/bin/sh
# scripts/agent-evals/codex.sh — L2b headless eval runner: Codex.
# SMI-5456 Wave 1 Step 6 (Validation Ladder Level 2b).
#
# Drives the three MVP jobs through `codex exec "<prompt>"` — Codex's
# headless one-shot mode.
#
# Precondition: the Skillsmith agent pack is installed (`sklx agent install`)
# and the `skillsmith` MCP server is registered in `~/.codex/config.toml`.
#
# SAFE TO COMMIT UNEXECUTED: runs only when a maintainer invokes it by hand.
# Missing binary -> clean exit 2 (see lib.sh check_binary), never a crash.
#
# Usage: ./scripts/agent-evals/codex.sh

set -eu

SCRIPT_DIR=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

check_binary codex

RESULTS_DIR=$(agent_eval_results_dir "$0")
LOG=$(agent_eval_log_path "$RESULTS_DIR" "codex")

echo "[agent-eval] codex -> $LOG"

run_job "$LOG" "keep-current" -- codex exec \
  "What skills do I have installed that are outdated, and what changed?"

run_job "$LOG" "audit-fix" -- codex exec \
  "Audit my installed skills for namespace collisions or issues, and tell me what you would fix. Do not apply anything yet."

run_job "$LOG" "vet-before-install" -- codex exec \
  "I am thinking about installing the skill anthropic/commit. Look it up and tell me whether it is safe to install."

echo "[agent-eval] done -- see $LOG"
