#!/usr/bin/env sh
# SMI-5024 dogfood gate — only emits telemetry when SKILLSMITH_TELEMETRY_DOGFOOD=1.
#
# Invoked from .claude/settings.json PreToolUse + PostToolUse Skill matchers.
# Reads stdin from Claude Code and forwards it to the production hook script.
#
# Cold path (SKILLSMITH_TELEMETRY_DOGFOOD unset or != "1"):
#   A single [ ] test — no jq, no curl, no stdin parsing. Exit 0 immediately.
#
# Hot path (SKILLSMITH_TELEMETRY_DOGFOOD=1):
#   exec replaces this shell with the production script; no extra process layer.
#
# Usage: dogfood-skill-telemetry.sh pre | post
[ "${SKILLSMITH_TELEMETRY_DOGFOOD:-}" = "1" ] || exit 0
exec "$(dirname "$0")/../packages/cli/templates/skill-telemetry.sh" "$@"
