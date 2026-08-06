#!/usr/bin/env bash
# SMI-5941 — session-mcp-disconnect-guard.sh (PostToolUseFailure hook) tests.
#
# Mirrors scripts/tests/session-start-mcp-command-guard.test.sh's structure
# (throwaway env, assert_eq/assert_contains helpers, PASS/FAIL summary).
#
# Runs the REAL hook script from its real location (not a copy) so it
# resolves the real `scripts/mcp-disconnect-state.ts` + `node_modules/.bin/tsx`
# — only state is isolated, via SKILLSMITH_MCP_DISCONNECT_HOME pointing at a
# fresh tmp dir per test.
#
# Run on the HOST, not via `docker exec`/`worktree-docker.sh exec` — this
# hook is a Claude Code `PostToolUseFailure` hook, and Claude Code itself
# always runs on the host, never inside the dev container, so that's the
# only environment this needs to work in. In a git worktree specifically,
# running it through the container will spuriously fail every repo-key
# resolution: a worktree's `.git` file references the main checkout's
# absolute HOST path, which the container's bind-mount doesn't have at that
# path, so `git -C "$CWD" worktree list` returns nothing inside Docker. This
# matches the existing CI wiring (validate-hooks.yml's `hooks-test` job runs
# on plain `ubuntu-latest`, no Docker involved).
#
# Run: bash scripts/tests/session-mcp-disconnect-guard.test.sh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
HOOK="$REPO_ROOT/scripts/session-mcp-disconnect-guard.sh"

if [ ! -x "$HOOK" ]; then
  echo "FAIL: $HOOK is not executable"
  exit 1
fi

fail=0
pass=0

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: expected='$expected' actual='$actual'"
    fail=$((fail + 1))
  fi
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: '$needle' not in '$haystack'"
    fail=$((fail + 1))
  fi
}

assert_empty() {
  local name="$1" actual="$2"
  if [ -z "$actual" ]; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: expected empty, got '$actual'"
    fail=$((fail + 1))
  fi
}

tmp_home() {
  mktemp -d -t skillsmith-mcpdisco-home.XXXXXX
}

# run_hook <tool_name> <error> [extra_env...] — invokes the real hook with a
# synthetic PostToolUseFailure payload; extra args are NAME=value env
# overrides (e.g. SKILLSMITH_MCP_DISCONNECT_DISABLE=1).
run_hook() {
  local tool="$1" error="$2"
  shift 2
  printf '{"tool_name":"%s","error":"%s","cwd":"%s","session_id":"t","hook_event_name":"PostToolUseFailure"}' \
    "$tool" "$error" "$REPO_ROOT" \
    | env "$@" "$HOOK"
}

state_total_count() {
  # Reads totalCount for the given repo-key/server out of the raw state JSON.
  # Uses python3 (already a hard dependency of every other session hook here).
  local state_file="$1" server="$2"
  python3 -c "
import json, sys
try:
    d = json.load(open('$state_file'))
    for repo_entries in d.values():
        e = repo_entries.get('$server')
        if e:
            print(e.get('totalCount', 0))
            sys.exit(0)
    print(0)
except Exception:
    print(0)
"
}

# ----------------------------------------------------------------------
# Test 1-3: each signature-corpus phrase matches (case-insensitive).
# ----------------------------------------------------------------------
for phrase in "transport closed" "Failed to reconnect" "MCP server disconnected"; do
  {
    HOME_DIR=$(tmp_home)
    OUT=$(run_hook "mcp__skillsmith__search" "$phrase" "SKILLSMITH_MCP_DISCONNECT_HOME=$HOME_DIR")
    assert_contains "match-systemMessage:$phrase" '"systemMessage"' "$OUT"
    assert_contains "match-names-server:$phrase" "skillsmith" "$OUT"
    assert_contains "match-reconnect-instruction:$phrase" "/mcp" "$OUT"
    COUNT=$(state_total_count "$HOME_DIR/.skillsmith/mcp-disconnect.state" "skillsmith")
    assert_eq "match-state-written:$phrase" "1" "$COUNT"
    rm -rf "$HOME_DIR"
  }
done

# ----------------------------------------------------------------------
# Test 4-6: non-match fixtures never write state or emit output — including
# the unrelated -32603 message, proving the bare code alone doesn't trigger
# a match now that it's out of the signature corpus.
# ----------------------------------------------------------------------
for fixture in "skill not found: foo/bar" "429 rate limited" "Error -32603: skill validation failed"; do
  {
    HOME_DIR=$(tmp_home)
    OUT=$(run_hook "mcp__skillsmith__search" "$fixture" "SKILLSMITH_MCP_DISCONNECT_HOME=$HOME_DIR")
    assert_empty "non-match-no-output:$fixture" "$OUT"
    if [ -f "$HOME_DIR/.skillsmith/mcp-disconnect.state" ]; then
      COUNT=$(state_total_count "$HOME_DIR/.skillsmith/mcp-disconnect.state" "skillsmith")
    else
      COUNT="0"
    fi
    assert_eq "non-match-no-state:$fixture" "0" "$COUNT"
    rm -rf "$HOME_DIR"
  }
done

# ----------------------------------------------------------------------
# Test 7: empty error is a non-match (empty-result case).
# ----------------------------------------------------------------------
{
  HOME_DIR=$(tmp_home)
  OUT=$(run_hook "mcp__skillsmith__search" "" "SKILLSMITH_MCP_DISCONNECT_HOME=$HOME_DIR")
  assert_empty "empty-error-no-output" "$OUT"
  rm -rf "$HOME_DIR"
}

# ----------------------------------------------------------------------
# Test 8: server-namespace attribution — the doc-retrieval server's disconnect
# is attributed to its OWN key, not "skillsmith"'s.
# ----------------------------------------------------------------------
{
  HOME_DIR=$(tmp_home)
  OUT=$(run_hook "mcp__skillsmith-doc-retrieval__skill_docs_search" "transport closed" "SKILLSMITH_MCP_DISCONNECT_HOME=$HOME_DIR")
  assert_contains "doc-retrieval-names-itself" "skillsmith-doc-retrieval" "$OUT"
  DR_COUNT=$(state_total_count "$HOME_DIR/.skillsmith/mcp-disconnect.state" "skillsmith-doc-retrieval")
  SS_COUNT=$(state_total_count "$HOME_DIR/.skillsmith/mcp-disconnect.state" "skillsmith")
  assert_eq "doc-retrieval-own-counter" "1" "$DR_COUNT"
  assert_eq "doc-retrieval-does-not-bump-skillsmith" "0" "$SS_COUNT"
  rm -rf "$HOME_DIR"
}

# Reciprocal of the above (pr-reviewer PR-12 finding): a skillsmith disconnect
# must not bump the doc-retrieval counter either — both directions, not just one.
{
  HOME_DIR=$(tmp_home)
  OUT=$(run_hook "mcp__skillsmith__search" "transport closed" "SKILLSMITH_MCP_DISCONNECT_HOME=$HOME_DIR")
  SS_COUNT=$(state_total_count "$HOME_DIR/.skillsmith/mcp-disconnect.state" "skillsmith")
  DR_COUNT=$(state_total_count "$HOME_DIR/.skillsmith/mcp-disconnect.state" "skillsmith-doc-retrieval")
  assert_eq "skillsmith-own-counter" "1" "$SS_COUNT"
  assert_eq "skillsmith-does-not-bump-doc-retrieval" "0" "$DR_COUNT"
  rm -rf "$HOME_DIR"
}

# ----------------------------------------------------------------------
# Test 9: kill-switch suppresses everything (no output, no state write).
# ----------------------------------------------------------------------
{
  HOME_DIR=$(tmp_home)
  OUT=$(run_hook "mcp__skillsmith__search" "transport closed" "SKILLSMITH_MCP_DISCONNECT_HOME=$HOME_DIR" "SKILLSMITH_MCP_DISCONNECT_DISABLE=1")
  assert_empty "kill-switch-no-output" "$OUT"
  if [ -f "$HOME_DIR/.skillsmith/mcp-disconnect.state" ]; then
    COUNT=$(state_total_count "$HOME_DIR/.skillsmith/mcp-disconnect.state" "skillsmith")
  else
    COUNT="0"
  fi
  assert_eq "kill-switch-no-state" "0" "$COUNT"
  rm -rf "$HOME_DIR"
}

# ----------------------------------------------------------------------
# Test 10: shadow mode suppresses systemMessage but still records state
# (observability preserved, per the plan).
# ----------------------------------------------------------------------
{
  HOME_DIR=$(tmp_home)
  OUT=$(run_hook "mcp__skillsmith__search" "transport closed" "SKILLSMITH_MCP_DISCONNECT_HOME=$HOME_DIR" "SKILLSMITH_MCP_DISCONNECT_SHADOW=1")
  assert_empty "shadow-no-output" "$OUT"
  COUNT=$(state_total_count "$HOME_DIR/.skillsmith/mcp-disconnect.state" "skillsmith")
  assert_eq "shadow-still-records-state" "1" "$COUNT"
  rm -rf "$HOME_DIR"
}

# ----------------------------------------------------------------------
# Test 11: fail-soft — a state dir that can't be created (a FILE sits where
# the directory needs to go) must not crash the hook or suppress the
# immediate systemMessage; only the durable persistence is allowed to fail.
# ----------------------------------------------------------------------
{
  HOME_DIR=$(tmp_home)
  # Block ~/.skillsmith itself from being created as a directory.
  touch "$HOME_DIR/.skillsmith"
  set +e
  OUT=$(run_hook "mcp__skillsmith__search" "transport closed" "SKILLSMITH_MCP_DISCONNECT_HOME=$HOME_DIR")
  HOOK_EXIT=$?
  set -e
  assert_eq "broken-state-dir-exit-0" "0" "$HOOK_EXIT"
  assert_contains "broken-state-dir-still-warns" '"systemMessage"' "$OUT"
  rm -rf "$HOME_DIR"
}

# ----------------------------------------------------------------------
# Test 12 (pr-reviewer PR-12 finding): fail-soft on a genuine lock-acquisition
# timeout, distinct from Test 11's directory-creation failure -- here the lock
# dir already exists with a live owner (our own PID, guaranteed alive), so
# the guard's underlying `record` call cannot acquire it within the timeout
# and must skip persistence while still emitting systemMessage.
# ----------------------------------------------------------------------
{
  HOME_DIR=$(tmp_home)
  mkdir -p "$HOME_DIR/.skillsmith/mcp-disconnect.state.lock"
  echo "$$" > "$HOME_DIR/.skillsmith/mcp-disconnect.state.lock/owner"
  OUT=$(run_hook "mcp__skillsmith__search" "transport closed" \
    "SKILLSMITH_MCP_DISCONNECT_HOME=$HOME_DIR" \
    "SKILLSMITH_MCP_DISCONNECT_LOCK_ACQUIRE_TIMEOUT_MS=200")
  assert_contains "lock-timeout-still-warns" '"systemMessage"' "$OUT"
  COUNT=$(state_total_count "$HOME_DIR/.skillsmith/mcp-disconnect.state" "skillsmith")
  assert_eq "lock-timeout-does-not-persist" "0" "$COUNT"
  rm -rf "$HOME_DIR"
}

# ----------------------------------------------------------------------
echo
echo "SUMMARY: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
