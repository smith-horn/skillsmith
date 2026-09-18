#!/usr/bin/env sh
# Records one JSON-lines entry per Claude Code hook invocation to
# ~/.skillsmith/logs/claude-hooks-<date>.log, mirroring the existing
# session-audit logging convention (scripts/lib/session-start-audit-helper.ts's
# {timestamp, code, payload} shape) and session-stop-hook-safe.sh's
# retention-day env-var precedent.
#
# Usage: claude-hooks-log-wrapper.sh <hook-name> <identifier> [-- <ignored...>]
#   hook-name   pre-command | post-command | pre-edit | post-edit  (log field)
#   identifier  the (already-truncated by caller) command/file string, logged
#               after best-effort secret redaction
#   -- <args>   accepted and ignored. Retained so a stale call site cannot
#               break. SMI-6724 Wave 1 removed the ruflo invocation these
#               were forwarded to; see the note further down.
#
# Always exits 0 -- logging must never turn a tool call into a blocking hook
# error. This uniformly normalizes all 4 call sites to non-blocking, a
# deliberate recorded plan-review decision (SMI-5813). That decision still
# holds and is now trivially satisfied: since SMI-6724 Wave 1 there is no
# downstream process whose failure could be surfaced or suppressed.
set -u
umask 077

HOOK_NAME="${1:-unknown}"
IDENTIFIER="${2:-}"
# Any further arguments are ignored. Before SMI-6724 they were shifted off
# and forwarded to ruflo, and PROJECT_DIR located that binary; with the
# invocation gone both the shifts and PROJECT_DIR had no reader, so they are
# removed rather than left as dead code that implies a consumer. Trailing
# arguments (including a `--` separator) remain harmless -- the wrapper
# simply does not read them.
LOG_RETENTION_DAYS="${SKILLSMITH_HOOK_LOG_RETENTION_DAYS:-14}"
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

# SMI-6724 Wave 1: the ruflo invocation is removed. Measured before removal:
# `ruflo hooks post-command` blocked for the wrapper's FULL watchdog timeout
# on every Bash tool call -- 1.05s / 3.06s / 10.06s at timeouts of 1/3/10s,
# so the cost tracked the timeout, not the work. It recorded the shell no-op
# `true` rather than the real command, because `--success true` (space form)
# is parsed as a boolean flag whose trailing "true" falls through to a
# positional, and @claude-flow/cli's hooks.js prefers `ctx.args[0]` over the
# explicit `--command` flag. Result: 53,605 rows holding ONE distinct value.
#
# Nothing read them. The `commands` namespace has exactly two references in
# @claude-flow/cli and both are write sites, and `access_count` -- which IS
# incremented on every point-get -- is 0 across all ~60,000 rows.
#
# The JSONL log below is deliberately KEPT. It records the real command text
# and is what made that diagnosis possible: 2,667 distinct commands in a
# single day against the store's 1. It costs one shell append.
#
# Full evidence: SMI-6724.
EXIT_CODE=0
STDERR_OUT=""
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
