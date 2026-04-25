#!/usr/bin/env bash
# SMI-4459 — smoke-prod shared helpers.
# Sourced (not executed) by scripts/smoke-prod.sh and per-surface modules.
# Conventions: ASCII-only output, no `set -x` (secret-leak risk), all HTTP
# calls bounded by a 10s timeout, single retry with 2s backoff.

# shellcheck shell=bash

# Per-call HTTP timeout. The orchestrator enforces a separate 60s total
# budget on top of these.
SMOKE_HTTP_TIMEOUT="${SMOKE_HTTP_TIMEOUT:-10}"

# Result accumulators populated by report_pass/report_fail. The orchestrator
# reads these at the end to format the summary table / JSON.
SMOKE_RESULTS_JSON=""
SMOKE_FAIL_COUNT=0
SMOKE_PASS_COUNT=0

# ---- logging -------------------------------------------------------------

smoke_log() {
  # Write to stderr so the orchestrator's stdout stays clean for --json.
  printf '[smoke] %s\n' "$*" >&2
}

smoke_warn() {
  printf '[smoke] WARN: %s\n' "$*" >&2
}

# ---- HTTP helpers --------------------------------------------------------

# http_status METHOD URL [curl-args...]
# Echoes the HTTP status code (or "000" on connection failure) to stdout.
# Discards the body.
http_status() {
  local method="$1"
  local url="$2"
  shift 2
  curl --silent --show-error \
    --max-time "$SMOKE_HTTP_TIMEOUT" \
    --output /dev/null \
    --write-out '%{http_code}' \
    --request "$method" \
    "$@" \
    "$url" 2>/dev/null || echo "000"
}

# http_body METHOD URL [curl-args...]
# Echoes "STATUS\nBODY" to stdout (status on first line, body after).
# Caller separates with `IFS=$'\n' read -d '' status body`.
http_body() {
  local method="$1"
  local url="$2"
  shift 2
  local tmp
  tmp=$(mktemp)
  local status
  status=$(curl --silent --show-error \
    --max-time "$SMOKE_HTTP_TIMEOUT" \
    --output "$tmp" \
    --write-out '%{http_code}' \
    --request "$method" \
    "$@" \
    "$url" 2>/dev/null) || status="000"
  printf '%s\n' "$status"
  cat "$tmp"
  rm -f "$tmp"
}

# with_retry CMD [ARGS...]
# Runs CMD; if the last line of stdout is "000" (connection failure) or the
# command exits non-zero, retries once after 2s.
with_retry() {
  local out
  if out=$("$@" 2>&1); then
    if [[ "$out" != *"000"* ]]; then
      printf '%s' "$out"
      return 0
    fi
  fi
  smoke_log "transient failure, retrying in 2s..."
  sleep 2
  "$@"
}

# ---- assertions ----------------------------------------------------------

assert_eq() {
  # assert_eq ACTUAL EXPECTED LABEL
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    return 0
  fi
  smoke_warn "$label: expected '$expected', got '$actual'"
  return 1
}

assert_contains() {
  # assert_contains HAYSTACK NEEDLE LABEL
  local haystack="$1" needle="$2" label="$3"
  case "$haystack" in
    *"$needle"*) return 0 ;;
    *)
      smoke_warn "$label: expected to find '$needle' in body (truncated 200 chars: ${haystack:0:200})"
      return 1
      ;;
  esac
}

# ---- result reporting ----------------------------------------------------

# report_pass SURFACE CHECK URL [DURATION_MS]
report_pass() {
  local surface="$1" check="$2" url="${3:-}" ms="${4:-0}"
  SMOKE_PASS_COUNT=$((SMOKE_PASS_COUNT + 1))
  smoke_log "PASS $surface :: $check ($url) ${ms}ms"
  _append_result "$surface" "$check" "$url" "" "" "pass" "$ms"
}

# report_fail SURFACE CHECK URL EXPECTED ACTUAL [DURATION_MS]
report_fail() {
  local surface="$1" check="$2" url="${3:-}" expected="${4:-}" actual="${5:-}" ms="${6:-0}"
  SMOKE_FAIL_COUNT=$((SMOKE_FAIL_COUNT + 1))
  smoke_log "FAIL $surface :: $check ($url) expected='$expected' actual='$actual' ${ms}ms"
  _append_result "$surface" "$check" "$url" "$expected" "$actual" "fail" "$ms"
}

# Internal: append a single JSON object to SMOKE_RESULTS_JSON.
_append_result() {
  local surface="$1" check="$2" url="$3" expected="$4" actual="$5" status="$6" ms="$7"
  # JSON-escape values via jq if available; otherwise fall back to a minimal
  # printf escape (sufficient for HTTP statuses and ASCII URLs).
  local entry
  if command -v jq >/dev/null 2>&1; then
    entry=$(jq -nc \
      --arg surface "$surface" \
      --arg check "$check" \
      --arg url "$url" \
      --arg expected "$expected" \
      --arg actual "$actual" \
      --arg status "$status" \
      --argjson ms "$ms" \
      '{surface: $surface, check: $check, url: $url, expected: $expected, actual: $actual, status: $status, ms: $ms}')
  else
    entry=$(printf '{"surface":"%s","check":"%s","url":"%s","expected":"%s","actual":"%s","status":"%s","ms":%d}' \
      "$surface" "$check" "$url" "$expected" "$actual" "$status" "$ms")
  fi
  if [ -z "$SMOKE_RESULTS_JSON" ]; then
    SMOKE_RESULTS_JSON="$entry"
  else
    SMOKE_RESULTS_JSON="${SMOKE_RESULTS_JSON},${entry}"
  fi
}

# now_ms — milliseconds since epoch. Falls back to seconds*1000 when
# `date +%N` is unavailable (BSD date on macOS).
now_ms() {
  local ns
  ns=$(date +%s%N 2>/dev/null || true)
  case "$ns" in
    *N) printf '%d' "$(( $(date +%s) * 1000 ))" ;;
    "") printf '%d' "$(( $(date +%s) * 1000 ))" ;;
    *) printf '%d' "$(( ns / 1000000 ))" ;;
  esac
}
