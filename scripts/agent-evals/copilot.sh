#!/bin/sh
# scripts/agent-evals/copilot.sh — L2b headless eval runner: GitHub Copilot
# CLI (the Copilot/VS Code Tier-1 target's headless surface — the VS Code
# chat surface itself has no headless mode, so L3 covers that interactively).
# SMI-5456 Wave 1 Step 6 (Validation Ladder Level 2b).
#
# Drives the three MVP jobs through
# `copilot -p "<prompt>" --allow-all-tools` — GitHub's documented
# non-interactive invocation (docs.github.com/en/copilot/reference/
# copilot-cli-reference/cli-command-reference). `--allow-all-tools` is
# REQUIRED for headless/automated use: without it, Copilot CLI blocks on
# interactive tool-approval prompts that never resolve in a non-interactive
# shell.
#
# Precondition: the Skillsmith agent pack is installed (`sklx agent install`)
# and the `skillsmith` MCP server is registered at `~/.copilot/mcp-config.json`
# (Copilot CLI's global MCP config — see the worker report on
# `agent-harness-targets.ts` for a filename correction: the code currently
# targets `~/.copilot/mcp.json`, but Copilot CLI reads `mcp-config.json`).
#
# SAFE TO COMMIT UNEXECUTED: runs only when a maintainer invokes it by hand.
# Missing binary -> clean exit 2 (see lib.sh check_binary), never a crash.
#
# Usage: ./scripts/agent-evals/copilot.sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=./lib.sh
. "$SCRIPT_DIR/lib.sh"

check_binary copilot

RESULTS_DIR=$(agent_eval_results_dir "$0")
LOG=$(agent_eval_log_path "$RESULTS_DIR" "copilot")

echo "[agent-eval] copilot -> $LOG"

run_job "$LOG" "keep-current" -- copilot -p \
  "What skills do I have installed that are outdated, and what changed?" --allow-all-tools

run_job "$LOG" "audit-fix" -- copilot -p \
  "Audit my installed skills for namespace collisions or issues, and tell me what you would fix. Do not apply anything yet." --allow-all-tools

run_job "$LOG" "vet-before-install" -- copilot -p \
  "I am thinking about installing the skill anthropic/commit. Look it up and tell me whether it is safe to install." --allow-all-tools

echo "[agent-eval] done -- see $LOG"
