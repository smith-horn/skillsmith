#!/usr/bin/env sh
# Skillsmith skill-invocation telemetry hook (SMI-5012 / SMI-5020 W3.S1).
#
# Invoked from ~/.claude/settings.json PreToolUse + PostToolUse matchers on
# the `Skill` tool. Captures skill-invocation latency telemetry for the
# Skillsmith /functions/v1/events endpoint.
#
# PRIVACY INVARIANTS (DO NOT WEAKEN):
#   - NEVER reads `.tool_input.args` from the hook stdin payload. EVER.
#     Only `.session_id` and `.tool_input.skill` are extracted.
#   - NEVER captures absolute paths, cwd, env vars, or file contents.
#   - NEVER blocks the user. Exits 0 in every code path. No `set -e`.
#   - Curl is fire-and-forget (backgrounded + output redirected).
#
# CROSS-PLATFORM:
#   - POSIX `sh` only (NOT bash). Runs on macOS /bin/sh (dash-equiv),
#     Linux /bin/sh (dash/bash), and Git Bash on Windows (via .cmd shim).
#   - `date +%s%3N` (GNU) falls back to `date +%s` (BSD/macOS) for second-
#     precision when millisecond precision is unavailable.
#
# STATE:
#   - Start files: $HOME/.skillsmith/run/skill-$SESSION-$SKILL.start
#     Per M8: lives under ~/.skillsmith/run (NOT /tmp) so files survive
#     reboot; orphans GC'd by next pre-call's 1h sweep.
#
# OPT-IN GATES (both must pass; checked before parsing stdin):
#   1. SKILLSMITH_TELEMETRY_DISABLE != "1"   (panic switch env var)
#   2. ~/.skillsmith/config.json `.telemetry.enabled == true`
#
# VERIFICATION (1000-iteration micro-bench):
#   PAYLOAD='{"session_id":"abc","tool_input":{"skill":"search"}}'
#   for i in $(seq 1 1000); do
#     printf '%s' "$PAYLOAD" | time \
#       sh packages/cli/templates/skill-telemetry.sh pre
#   done
#   # Target: <25ms p95 EXCLUDING the backgrounded curl in `post`.
#
# Claude Code hook stdin contract:
#   https://code.claude.com/docs/en/hooks.md

set -u

MODE="${1:-}"

# ---- Gate 1: panic switch ----
if [ "${SKILLSMITH_TELEMETRY_DISABLE:-}" = "1" ]; then
  exit 0
fi

# ---- Gate 2: jq availability (defensive; required by other Skillsmith hooks) ----
command -v jq >/dev/null 2>&1 || exit 0

# ---- Gate 3: opt-in config (single jq invocation for all three reads) ----
CONFIG="${HOME}/.skillsmith/config.json"
if [ ! -f "$CONFIG" ]; then
  exit 0
fi
# Output is newline-separated: enabled-bool, endpoint, anonymousId.
# `jq -e` here would require a separate call; we instead check the first
# line for "true" via `case`. One jq fork instead of three.
CFG_OUT="$(jq -r '
  (.telemetry.enabled // false),
  (.telemetry.endpoint // "https://vrcnzpmndtroqxxoqkzy.supabase.co/functions/v1/events"),
  (.telemetry.anonymousId // "")
' "$CONFIG" 2>/dev/null)"
# POSIX line-extraction without spawning awk/sed.
CFG_ENABLED="${CFG_OUT%%
*}"
CFG_REST="${CFG_OUT#*
}"
ENDPOINT="${CFG_REST%%
*}"
ANON_ID="${CFG_REST#*
}"
case "$CFG_ENABLED" in
  true) ;;
  *) exit 0 ;;
esac

# ---- Parse Claude Code hook stdin payload (single jq for both reads) ----
# IMPORTANT: only `.session_id` and `.tool_input.skill` are extracted.
# `.tool_input.args` is NEVER read. See privacy invariants above.
PAYLOAD="$(cat 2>/dev/null || printf '%s' '{}')"
STDIN_OUT="$(printf '%s' "$PAYLOAD" | jq -r '(.session_id // ""), (.tool_input.skill // "")' 2>/dev/null)"
SESSION_ID="${STDIN_OUT%%
*}"
SKILL_NAME="${STDIN_OUT#*
}"

RUN_DIR="${HOME}/.skillsmith/run"
mkdir -p "$RUN_DIR" 2>/dev/null || true

# ---- Quarantine path: unparseable payload ----
# Per risk #13 (line 803): tool_input.skill shape changes ship a
# `skill_invoke_unparsed` event. Emit ONLY from `pre` so we don't
# double-count (post has no matching start file to read anyway).
if [ -z "$SESSION_ID" ] || [ -z "$SKILL_NAME" ]; then
  if [ "$MODE" = "pre" ] && [ -n "$ANON_ID" ]; then
    QUARANTINE_PAYLOAD="$(jq -n \
      --arg event 'skill_invoke_unparsed' \
      --arg anon "$ANON_ID" \
      --arg source 'claude-code-hook' \
      --arg framework 'claude-code' \
      --arg platform "$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')" \
      '{event:$event, anonymous_id:$anon, metadata:{source:$source, framework:$framework, platform:$platform, success:false}}' \
      2>/dev/null)"
    if [ -n "$QUARANTINE_PAYLOAD" ]; then
      nohup curl -s -m 5 -X POST \
        -H 'Content-Type: application/json' \
        -d "$QUARANTINE_PAYLOAD" \
        "$ENDPOINT" >/dev/null 2>&1 &
    fi
  fi
  exit 0
fi

START_FILE="$RUN_DIR/skill-${SESSION_ID}-${SKILL_NAME}.start"

case "$MODE" in
  pre)
    # GC orphans older than 1h (mtime), then record start time (ms epoch).
    # `find -mmin` is portable across BSD (macOS) and GNU (Linux/Git Bash).
    find "$RUN_DIR" -maxdepth 1 -name 'skill-*.start' -type f -mmin +60 -delete 2>/dev/null || true
    NOW_MS="$(date +%s%3N 2>/dev/null)"
    # BSD date doesn't support %3N — falls back to seconds with 000 suffix.
    case "$NOW_MS" in
      *N|'')
        NOW_MS="$(date +%s 2>/dev/null)000"
        ;;
    esac
    printf '%s' "$NOW_MS" > "$START_FILE" 2>/dev/null || true
    ;;

  post)
    if [ ! -f "$START_FILE" ]; then
      exit 0
    fi
    START_MS="$(cat "$START_FILE" 2>/dev/null)"
    rm -f "$START_FILE" 2>/dev/null || true
    if [ -z "$START_MS" ]; then
      exit 0
    fi

    NOW_MS="$(date +%s%3N 2>/dev/null)"
    case "$NOW_MS" in
      *N|'')
        NOW_MS="$(date +%s 2>/dev/null)000"
        ;;
    esac

    # Pure-sh integer arithmetic; both operands are integers above.
    DURATION_MS=$((NOW_MS - START_MS))
    if [ "$DURATION_MS" -lt 0 ]; then
      DURATION_MS=0
    fi

    # If no anonymous id has been provisioned yet, we have nothing to send.
    if [ -z "$ANON_ID" ]; then
      exit 0
    fi

    PLATFORM="$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"

    # Build payload (see wire format at skill-invoke-telemetry.md:614-643).
    # NOTE: only $SKILL_NAME and $SESSION_ID flow from stdin → payload.
    # No args, no paths, no env vars.
    PAYLOAD_JSON="$(jq -n \
      --arg event 'skill_invoke' \
      --arg anon "$ANON_ID" \
      --arg skill "$SKILL_NAME" \
      --arg session "$SESSION_ID" \
      --argjson dur "$DURATION_MS" \
      --arg source 'claude-code-hook' \
      --arg framework 'claude-code' \
      --arg platform "$PLATFORM" \
      '{event:$event, anonymous_id:$anon, metadata:{skill_name:$skill, session_id:$session, duration_ms:$dur, source:$source, framework:$framework, platform:$platform, success:true, is_subagent:false}}' \
      2>/dev/null)"

    if [ -z "$PAYLOAD_JSON" ]; then
      exit 0
    fi

    # Fire-and-forget. `nohup` + `&` + redirected fd's mean the parent
    # shell does not wait on the curl process. `-m 5` caps the curl at
    # 5s in case the endpoint is unreachable (no impact on hook latency
    # because the curl is already detached).
    nohup curl -s -m 5 -X POST \
      -H 'Content-Type: application/json' \
      -d "$PAYLOAD_JSON" \
      "$ENDPOINT" >/dev/null 2>&1 &
    ;;

  *)
    # Unknown mode — silently exit. Belt-and-suspenders.
    :
    ;;
esac

exit 0
