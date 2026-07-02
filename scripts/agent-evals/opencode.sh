#!/bin/sh
# scripts/agent-evals/opencode.sh — L2b headless eval runner: OpenCode.
# SMI-5456 Wave 1 Step 6 (Validation Ladder Level 2b).
#
# Drives the three MVP jobs through `opencode run "<prompt>"` — OpenCode's
# documented non-interactive mode (opencode.ai/docs/cli/).
#
# Precondition: the Skillsmith agent pack is installed (`sklx agent install`)
# and the `skillsmith` MCP server is registered in
# `~/.config/opencode/opencode.json` under the `mcp` key.
#
# SAFE TO COMMIT UNEXECUTED: runs only when a maintainer invokes it by hand.
# Missing binary -> clean exit 2 (see lib.sh check_binary), never a crash.
#
# Usage: ./scripts/agent-evals/opencode.sh

set -eu

SCRIPT_DIR=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

check_binary opencode

RESULTS_DIR=$(agent_eval_results_dir "$0")
LOG=$(agent_eval_log_path "$RESULTS_DIR" "opencode")

echo "[agent-eval] opencode -> $LOG"

run_job "$LOG" "keep-current" -- opencode run \
  "What skills do I have installed that are outdated, and what changed?"

run_job "$LOG" "audit-fix" -- opencode run \
  "Audit my installed skills for namespace collisions or issues, and tell me what you would fix. Do not apply anything yet."

run_job "$LOG" "vet-before-install" -- opencode run \
  "I am thinking about installing the skill anthropic/commit. Look it up and tell me whether it is safe to install."

echo "[agent-eval] done -- see $LOG"
