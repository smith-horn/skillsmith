#!/bin/sh
# scripts/agent-evals/cursor.sh — L2b headless eval runner: Cursor.
# SMI-5456 Wave 1 Step 6 (Validation Ladder Level 2b).
#
# Drives the three MVP jobs through
# `cursor-agent -p --force --output-format json "<prompt>"` — the Step-0
# spike's confirmed headless shape. `--force` is REQUIRED: per a
# Cursor-staff forum reply (forum.cursor.com/t/mcp-access-in-headless-mode/
# 136709, dated 2025-10-10 — re-verify this is still current), MCP tool
# access in `-p` mode is otherwise reported as "not available or accessible"
# even with a trusted workspace. Cursor auto-loads MCP servers from the same
# `mcp.json` the desktop editor uses.
#
# Precondition: the Skillsmith agent pack is installed (`sklx agent install`).
#
# SAFE TO COMMIT UNEXECUTED: runs only when a maintainer invokes it by hand.
# Missing binary -> clean exit 2 (see lib.sh check_binary), never a crash.
#
# Usage: ./scripts/agent-evals/cursor.sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

check_binary cursor-agent

RESULTS_DIR=$(agent_eval_results_dir "$0")
LOG=$(agent_eval_log_path "$RESULTS_DIR" "cursor")

echo "[agent-eval] cursor -> $LOG"

run_job "$LOG" "keep-current" -- cursor-agent -p --force --output-format json \
  "What skills do I have installed that are outdated, and what changed?"

run_job "$LOG" "audit-fix" -- cursor-agent -p --force --output-format json \
  "Audit my installed skills for namespace collisions or issues, and tell me what you would fix. Do not apply anything yet."

run_job "$LOG" "vet-before-install" -- cursor-agent -p --force --output-format json \
  "I am thinking about installing the skill anthropic/commit. Look it up and tell me whether it is safe to install."

echo "[agent-eval] done -- see $LOG"
