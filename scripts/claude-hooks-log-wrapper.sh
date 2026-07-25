#!/usr/bin/env sh
# Wraps a `ruflo hooks <subcommand>` invocation called from .claude/settings.json's
# PreToolUse/PostToolUse hooks with best-effort JSON-lines logging to
# ~/.skillsmith/logs/claude-hooks-<date>.log, mirroring the existing
# session-audit logging convention (scripts/lib/session-start-audit-helper.ts's
# {timestamp, code, payload} shape) and session-stop-hook-safe.sh's
# retention-day env-var precedent.
#
# Usage: claude-hooks-log-wrapper.sh <hook-name> <identifier> -- <ruflo-args...>
#   hook-name   pre-command | post-command | pre-edit | post-edit  (log field only)
#   identifier  the (already-truncated by caller) command/file string, logged
#               (after best-effort secret redaction) for the log record
#   -- <args>   forwarded verbatim to `node .../ruflo.js hooks <hook-name> <args>`
#
# Always exits 0 -- wrapping/logging must never turn a call that previously
# succeeded (or was already suppressed) into a blocking hook error. This
# uniformly normalizes all 4 call sites to non-blocking, INCLUDING
# PreToolUse:Write|Edit|MultiEdit, which previously surfaced raw ruflo
# failures (no `2>/dev/null || true`). That's a deliberate, recorded
# plan-review decision (SMI-5813) -- the bounded stderr excerpt captured
# below into the log record is the mitigation for the lost raw-surfacing
# behavior: a failure is no longer visible live, but it is now durably
# inspectable with its actual error text, which the pre-fix state never had.
set -u
umask 077

HOOK_NAME="${1:-unknown}"
IDENTIFIER="${2:-}"
# `shift 2` is a fatal (uncatchable-by-`|| true`) error under dash when
# $# < 2 -- guard the count explicitly instead.
[ $# -ge 2 ] && shift 2 || shift $#
[ "${1:-}" = "--" ] && shift

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LOG_RETENTION_DAYS="${SKILLSMITH_HOOK_LOG_RETENTION_DAYS:-14}"
HOOK_TIMEOUT_SECONDS="${SKILLSMITH_HOOK_TIMEOUT_SECONDS:-3}"
case "$HOOK_TIMEOUT_SECONDS" in
  ''|*[!0-9]*|0) HOOK_TIMEOUT_SECONDS=3 ;;
esac
# `set -u` aborts on an unset $HOME -- guard it explicitly rather than
# relying on HOME always being set in every context this hook's shell runs in.
LOG_DIR="${HOME:-/tmp}/.skillsmith/logs"
mkdir -p "$LOG_DIR" 2>/dev/null
LOG_FILE="$LOG_DIR/claude-hooks-$(date -u +%Y-%m-%d).log"

# Sweep stale daily logs only when rolling to a NEW day's file, not on every
# invocation -- this hook fires on every Bash/Edit tool call (unlike
# session-stop-hook-safe.sh's once-per-session cadence), so an unconditional
# `find -delete` per call would add needless I/O to the hot path this fix
# exists to make less fragile.
if [ ! -f "$LOG_FILE" ]; then
  find "$LOG_DIR" -maxdepth 1 -name 'claude-hooks-*.log' -mtime "+${LOG_RETENTION_DAYS}" -delete 2>/dev/null
fi

# Best-effort secret redaction (defense-in-depth, not exhaustive -- Varlock
# already keeps most real secrets out of raw command text; this is a safety
# net for an ad-hoc token pasted into a curl/API call that would otherwise
# land verbatim in a 14-day-retained local log file). Expanded during the
# Sol/Codex cross-provider pass (SMI-5813) to cover modern provider-key
# prefixes, auth headers, env-var-style assignments, and quoted flag values
# (the original flag-value rule truncated at the first space, missing
# `--password 'two words'`-shaped values).
#
# No standalone `Authorization:` header rule -- an earlier draft had one and
# manual testing (during SMI-5813 plan-review) found it either double-
# redacted "Authorization: Bearer <token>" into "Bearer [REDACTED]
# [REDACTED]" or, worse, truncated the match at the first space and LEAKED
# the token ("Authorization: [REDACTED] abc123..."). The Bearer/Basic rules
# above already redact the two Authorization value schemes actually seen in
# practice; a raw unscoped-Authorization opaque token (no Bearer/Basic
# prefix) is the one shape this still misses -- accepted as a known,
# documented gap in a best-effort tool, not silently unhandled.
#
# Deliberately NOT routed through the repo's existing gitleaks-based
# pre-commit secret scanner (.husky/pre-commit) -- that would add an
# external-binary runtime dependency with an unverified CLI contract for
# scanning arbitrary strings (gitleaks' documented interface is
# git-diff/repo-scan-shaped, not "scan this string") into a hook-invoked
# script that must degrade gracefully when tools are missing. A reasonable
# future hardening if the patterns below prove to under-catch in practice.
redact() {
  printf '%s' "$1" | sed -E \
    -e 's/[Bb]earer [A-Za-z0-9._-]+/Bearer [REDACTED]/g' \
    -e 's/(sk|pk|rk)_(live|test)_[A-Za-z0-9]+/[REDACTED]/g' \
    -e 's/sk-(proj|ant|live|test)-[A-Za-z0-9_-]+/[REDACTED]/g' \
    -e 's/gh[pousr]_[A-Za-z0-9]{20,}/[REDACTED]/g' \
    -e 's/github_pat_[A-Za-z0-9_]+/[REDACTED]/g' \
    -e 's/xox[abprs]-[A-Za-z0-9-]+/[REDACTED]/g' \
    -e 's/npm_[A-Za-z0-9]+/[REDACTED]/g' \
    -e 's/AKIA[0-9A-Z]{16}/[REDACTED]/g' \
    -e 's/[Bb]asic [A-Za-z0-9+/=]{8,}/Basic [REDACTED]/g' \
    -e 's/([Xx]-[Aa]pi-[Kk]ey|[Xx]-[Aa]pi-[Tt]oken): *[^ "]+/\1: [REDACTED]/g' \
    -e "s/(-{1,2}[A-Za-z_-]*([Tt]oken|[Kk]ey|[Ss]ecret|[Pp]assword)[A-Za-z_-]*[= ])'[^']*'/\1'[REDACTED]'/g" \
    -e 's/(-{1,2}[A-Za-z_-]*([Tt]oken|[Kk]ey|[Ss]ecret|[Pp]assword)[A-Za-z_-]*[= ])"[^"]*"/\1"[REDACTED]"/g' \
    -e 's/(-{1,2}[A-Za-z_-]*([Tt]oken|[Kk]ey|[Ss]ecret|[Pp]assword)[A-Za-z_-]*[= ])[^ ]+/\1[REDACTED]/g' \
    -e 's/([A-Z][A-Z0-9_]*_(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*=)[^ ]+/\1[REDACTED]/g'
}

# Ruflo is advisory on this hot path. Run it behind an internal watchdog so
# a wedged state/database/network operation cannot consume Claude Code's much
# larger command-hook timeout before an ordinary Bash/Edit tool is dispatched.
STDERR_FILE=$(mktemp -t skillsmith-hook-stderr.XXXXXX 2>/dev/null) || STDERR_FILE=""
TIMEOUT_FILE=$(mktemp -t skillsmith-hook-timeout.XXXXXX 2>/dev/null) || TIMEOUT_FILE=""
if [ -n "$STDERR_FILE" ] && [ -n "$TIMEOUT_FILE" ]; then
  node "$PROJECT_DIR/node_modules/ruflo/bin/ruflo.js" hooks "$HOOK_NAME" "$@" \
    > /dev/null 2>"$STDERR_FILE" &
  RUFLO_PID=$!
  (
    sleep "$HOOK_TIMEOUT_SECONDS"
    printf '1' >"$TIMEOUT_FILE"
    kill "$RUFLO_PID" 2>/dev/null || true
  ) &
  WATCHDOG_PID=$!
  wait "$RUFLO_PID" 2>/dev/null
  EXIT_CODE=$?
  kill "$WATCHDOG_PID" 2>/dev/null || true
  wait "$WATCHDOG_PID" 2>/dev/null || true
  STDERR_OUT=$(cat "$STDERR_FILE" 2>/dev/null)
  if [ -s "$TIMEOUT_FILE" ]; then
    STDERR_OUT="${STDERR_OUT}${STDERR_OUT:+
}ruflo hook timed out after ${HOOK_TIMEOUT_SECONDS}s"
  fi
  rm -f "$STDERR_FILE" "$TIMEOUT_FILE"
else
  # If temporary-file creation fails, fail open without invoking an unbounded
  # downstream process. Logging below still records the local failure.
  EXIT_CODE=1
  STDERR_OUT="ruflo hook skipped: unable to create watchdog files"
  [ -n "$STDERR_FILE" ] && rm -f "$STDERR_FILE"
  [ -n "$TIMEOUT_FILE" ] && rm -f "$TIMEOUT_FILE"
fi
STDERR_EXCERPT=$(redact "$STDERR_OUT" | head -c 500)

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
IDENTIFIER_REDACTED=$(redact "$IDENTIFIER")
# HOOK_NAME is JSON-escaped like the other string fields rather than
# interpolated raw -- safe today only because all real call sites pass a
# fixed literal (pre-command/post-command/pre-edit/post-edit), but the
# wrapper's own public argument interface doesn't enforce that (found during
# the Sol/Codex cross-provider pass, SMI-5813).
ESCAPED_HOOK=$(printf '%s' "$HOOK_NAME" | jq -Rs . 2>/dev/null) || ESCAPED_HOOK='"unknown"'
ESCAPED_ID=$(printf '%s' "$IDENTIFIER_REDACTED" | jq -Rs . 2>/dev/null) || ESCAPED_ID='""'
ESCAPED_ERR=$(printf '%s' "$STDERR_EXCERPT" | jq -Rs . 2>/dev/null) || ESCAPED_ERR='""'

printf '{"timestamp":"%s","hook":%s,"exitCode":%s,"identifier":%s,"stderr":%s}\n' \
  "$TS" "$ESCAPED_HOOK" "$EXIT_CODE" "$ESCAPED_ID" "$ESCAPED_ERR" >> "$LOG_FILE" 2>/dev/null

exit 0
