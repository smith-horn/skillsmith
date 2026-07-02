#!/bin/sh
# Skillsmith Agent - SessionStart hook (cursor). Generated; do not edit by hand.
# Writes/removes the agent-mediation marker file (SMI-5456). Self-contained
# POSIX sh, no CLI dependency; every path exits 0 so it never fails a session.
set -uC
HOME="${HOME:-/tmp}"
if [ "${SKILLSMITH_AGENT_HOOK_DISABLE:-}" = "1" ]; then cat >/dev/null 2>&1 || true; exit 0; fi
MARKER_DIR="${SKILLSMITH_AGENT_MARKER_DIR:-$HOME/.skillsmith/agent-markers}"
NUDGE_STATE="${SKILLSMITH_AGENT_NUDGE_STATE:-$HOME/.skillsmith/agent-nudge.state}"
NUDGE_COOLDOWN_SECONDS=72000
HARNESS="cursor"
SCHEMA=1

input=$(cat 2>/dev/null || true)
sid=""
if command -v jq >/dev/null 2>&1; then
  sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)
fi
if [ -z "$sid" ]; then
  sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi
if [ -z "$sid" ]; then
  sid="unknown-$(date +%s 2>/dev/null || echo 0)-$$"
fi
sid=$(printf '%s' "$sid" | tr -c 'A-Za-z0-9._-' '_')

now_s=$(date +%s 2>/dev/null || echo 0)
started_ms=$(( now_s * 1000 ))

# Nudge eligibility, capped by a cooldown stamp. A rare concurrent
# double-nudge across simultaneous sessions is acceptable (documented).
show_nudge=1
if [ -f "$NUDGE_STATE" ]; then
  last=$(cat "$NUDGE_STATE" 2>/dev/null || echo 0)
  case "$last" in ""|*[!0-9]*) last=0 ;; esac
  if [ $(( now_s - last )) -lt "$NUDGE_COOLDOWN_SECONDS" ]; then show_nudge=0; fi
fi

if [ "$show_nudge" -eq 1 ]; then
  nudge_origin=true
  trigger_id='"onboarding.session_start"'
else
  nudge_origin=false
  trigger_id=null
fi

mkdir -p "$MARKER_DIR" 2>/dev/null || exit 0
tmp="$MARKER_DIR/.$$.$now_s.tmp"
printf '{"schema":%s,"session_id":"%s","started_at":%s,"harness":"%s","agent_session":true,"nudge_origin":%s,"trigger_id":%s}\n' \
  "$SCHEMA" "$sid" "$started_ms" "$HARNESS" "$nudge_origin" "$trigger_id" > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; exit 0; }
mv -f "$tmp" "$MARKER_DIR/$sid.json" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; exit 0; }

if [ "$show_nudge" -eq 1 ]; then
  nudge_tmp="$NUDGE_STATE.$$.tmp"
  mkdir -p "$(dirname "$NUDGE_STATE")" 2>/dev/null || true
  printf '%s' "$now_s" > "$nudge_tmp" 2>/dev/null && mv -f "$nudge_tmp" "$NUDGE_STATE" 2>/dev/null || rm -f "$nudge_tmp" 2>/dev/null
  echo "The Skillsmith Agent is available. Ask it to audit your skills, check what is outdated, or vet a skill before you install it."
fi

exit 0
