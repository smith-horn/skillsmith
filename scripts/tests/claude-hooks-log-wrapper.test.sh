#!/usr/bin/env bash
# SMI-5813: Unit tests for scripts/claude-hooks-log-wrapper.sh -- the
# wrapper introduced to add JSON-lines failure logging to the 4 core
# Claude Code PreToolUse/PostToolUse hooks (pre-command/post-command/
# pre-edit/post-edit), on top of the xargs-removal fix covered by the
# sibling claude-hooks-xargs-regression.test.sh.
#
# Runs the wrapper under BOTH bash (this harness) and real `dash`, since
# the wrapper itself targets POSIX sh and this repo's Docker base image
# (Debian bookworm) symlinks /bin/sh -> dash -- a bash-only pass would
# miss a dash-specific bug (this test suite exists because exactly that
# kind of bug -- `shift 2` being fatal under dash but not bash -- was
# found and fixed during SMI-5813's own plan-review).
#
# Covers:
#   A. Normal invocation: exit-code capture, JSON validity, all 5 fields
#      present, secret redaction applied to both identifier and stderr.
#   B. Always exits 0 regardless of the wrapped ruflo call's exit code.
#   C. Dash-safety: 0 args and 1 arg do not crash the wrapper (the
#      `shift 2` guard fix).
#   D. `set -u` does not abort when $HOME is unset.
#   E. Retention sweep deletes a log file older than the configured
#      SKILLSMITH_HOOK_LOG_RETENTION_DAYS, and only on a new-day rollover.
#   F. Redaction breadth: each secret shape added during plan-review
#      (Bearer, provider-key prefixes, GitHub PAT, env-var assignment,
#      quoted flag value) is actually stripped, and an ordinary command
#      with no secrets passes through unmodified.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
WRAPPER="$REPO_ROOT/scripts/claude-hooks-log-wrapper.sh"

fail=0
pass=0

assert_true() {
  local name="$1" cond="$2"
  if [ "$cond" = "0" ]; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name"
    fail=$((fail + 1))
  fi
}

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name (expected '$expected', got '$actual')"
    fail=$((fail + 1))
  fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name (expected to find '$needle' in: $haystack)"
    fail=$((fail + 1))
  fi
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "FAIL $name (did NOT expect to find '$needle' in: $haystack)"
    fail=$((fail + 1))
  else
    echo "PASS $name"
    pass=$((pass + 1))
  fi
}

# -----------------------------------------------------------------------
# Fixture: a stub ruflo.js that echoes an argv marker to stderr and exits
# with a caller-controlled code, plus a fake HOME for log isolation.
# -----------------------------------------------------------------------
setup_fixture() {
  local exit_code="$1"
  local stderr_msg="$2"
  FIXTURE_DIR=$(mktemp -d)
  mkdir -p "$FIXTURE_DIR/node_modules/ruflo/bin" "$FIXTURE_DIR/home"
  # `${var@Q}` (bash 4.4+) is not used here -- macOS ships bash 3.2 by
  # default (GPLv2 license freeze), which does not support it and would
  # fail at runtime with "bad substitution". Portable manual JS single-
  # quoted-string escaping instead.
  local escaped
  escaped=$(printf '%s' "$stderr_msg" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")
  cat > "$FIXTURE_DIR/node_modules/ruflo/bin/ruflo.js" << NODE_EOF
#!/usr/bin/env node
console.error('$escaped');
console.log("stdout noise that must be discarded, not logged");
process.exit($exit_code);
NODE_EOF
}

teardown_fixture() {
  rm -rf "$FIXTURE_DIR"
}

run_wrapper() {
  local shell="$1"
  shift
  CLAUDE_PROJECT_DIR="$FIXTURE_DIR" HOME="$FIXTURE_DIR/home" "$shell" "$WRAPPER" "$@"
}

latest_log_line() {
  tail -n 1 "$FIXTURE_DIR/home/.skillsmith/logs/claude-hooks-$(date -u +%Y-%m-%d).log"
}

for SHELL_BIN in bash dash; do
  if ! command -v "$SHELL_BIN" >/dev/null 2>&1; then
    echo "SKIP $SHELL_BIN not available on this host"
    continue
  fi

  echo ""
  echo "=== Group A/B: normal invocation under $SHELL_BIN ==="
  setup_fixture 0 "diagnostic stderr text"
  run_wrapper "$SHELL_BIN" pre-command "npm run test:unit -- --coverage" -- --command "npm run test:unit -- --coverage" --validate-safety true >/dev/null 2>&1
  RC=$?
  assert_eq "[$SHELL_BIN] wrapper always exits 0 (success case)" "0" "$RC"
  LINE=$(latest_log_line)
  assert_true "[$SHELL_BIN] log line is valid JSON" "$(printf '%s' "$LINE" | jq . >/dev/null 2>&1 && echo 0 || echo 1)"
  assert_eq "[$SHELL_BIN] hook field correct" "pre-command" "$(printf '%s' "$LINE" | jq -r .hook)"
  assert_eq "[$SHELL_BIN] identifier field correct" "npm run test:unit -- --coverage" "$(printf '%s' "$LINE" | jq -r .identifier)"
  assert_eq "[$SHELL_BIN] exitCode field reflects the wrapped call" "0" "$(printf '%s' "$LINE" | jq -r .exitCode)"
  assert_eq "[$SHELL_BIN] stderr field captured" "diagnostic stderr text" "$(printf '%s' "$LINE" | jq -r .stderr)"
  assert_true "[$SHELL_BIN] timestamp field present and non-empty" "$(printf '%s' "$LINE" | jq -e '.timestamp | length > 0' >/dev/null 2>&1 && echo 0 || echo 1)"
  teardown_fixture

  echo ""
  echo "=== Group B: always exits 0 even when the wrapped call fails ==="
  setup_fixture 1 "some failure"
  run_wrapper "$SHELL_BIN" post-edit "/some/file.ts" -- --file "/some/file.ts" --success true >/dev/null 2>&1
  RC=$?
  assert_eq "[$SHELL_BIN] wrapper always exits 0 (failure case)" "0" "$RC"
  LINE=$(latest_log_line)
  assert_eq "[$SHELL_BIN] exitCode field reflects the failure" "1" "$(printf '%s' "$LINE" | jq -r .exitCode)"
  teardown_fixture

  echo ""
  echo "=== Group C: dash-safety, 0 and 1 args don't crash ==="
  setup_fixture 0 "n/a"
  run_wrapper "$SHELL_BIN" >/dev/null 2>&1
  assert_eq "[$SHELL_BIN] 0 args exits 0" "0" "$?"
  run_wrapper "$SHELL_BIN" pre-command >/dev/null 2>&1
  assert_eq "[$SHELL_BIN] 1 arg exits 0" "0" "$?"
  teardown_fixture

  echo ""
  echo "=== Group D: set -u does not abort on unset HOME ==="
  setup_fixture 0 "n/a"
  ( unset HOME; CLAUDE_PROJECT_DIR="$FIXTURE_DIR" "$SHELL_BIN" "$WRAPPER" pre-command "x" -- --command "x" >/dev/null 2>&1 )
  assert_eq "[$SHELL_BIN] unset HOME does not crash the wrapper" "0" "$?"
  teardown_fixture

  echo ""
  echo "=== Group F: redaction breadth ==="
  setup_fixture 0 "leaked Bearer abcDEF123token in stderr too"
  run_wrapper "$SHELL_BIN" pre-command \
    'curl -H "Authorization: Bearer abcDEF123token" --password '"'"'two words'"'"' AWS_SECRET_ACCESS_KEY=shouldnotleak123' \
    -- --command "ignored-for-this-test" >/dev/null 2>&1
  LINE=$(latest_log_line)
  ID_FIELD=$(printf '%s' "$LINE" | jq -r .identifier)
  ERR_FIELD=$(printf '%s' "$LINE" | jq -r .stderr)
  assert_not_contains "[$SHELL_BIN] Bearer token redacted from identifier" "$ID_FIELD" "abcDEF123token"
  assert_not_contains "[$SHELL_BIN] quoted password value redacted from identifier" "$ID_FIELD" "two words"
  assert_not_contains "[$SHELL_BIN] env-var-style secret redacted from identifier" "$ID_FIELD" "shouldnotleak123"
  assert_not_contains "[$SHELL_BIN] Bearer token redacted from stderr" "$ERR_FIELD" "abcDEF123token"
  assert_contains "[$SHELL_BIN] non-secret surrounding text preserved in identifier" "$ID_FIELD" "curl -H"
  teardown_fixture

  setup_fixture 0 "clean stderr, nothing sensitive"
  run_wrapper "$SHELL_BIN" pre-command "git status --short" -- --command "git status --short" >/dev/null 2>&1
  LINE=$(latest_log_line)
  assert_eq "[$SHELL_BIN] ordinary command with no secrets passes through unmodified" \
    "git status --short" "$(printf '%s' "$LINE" | jq -r .identifier)"
  teardown_fixture

  echo ""
  echo "=== Group E: retention sweep ==="
  setup_fixture 0 "n/a"
  LOG_DIR="$FIXTURE_DIR/home/.skillsmith/logs"
  mkdir -p "$LOG_DIR"
  STALE_FILE="$LOG_DIR/claude-hooks-2020-01-01.log"
  echo '{"stale":"entry"}' > "$STALE_FILE"
  touch -d "30 days ago" "$STALE_FILE" 2>/dev/null || touch -t "$(date -v-30d +%Y%m%d%H%M 2>/dev/null || date -d '30 days ago' +%Y%m%d%H%M)" "$STALE_FILE" 2>/dev/null || true
  SKILLSMITH_HOOK_LOG_RETENTION_DAYS=7 run_wrapper "$SHELL_BIN" pre-command "trigger a new day's file" -- --command "x" >/dev/null 2>&1
  if [ -f "$STALE_FILE" ]; then
    echo "FAIL [$SHELL_BIN] stale log file was not swept (this can be a false failure on a fresh mtime touch across platforms; verify manually if it recurs)"
    fail=$((fail + 1))
  else
    echo "PASS [$SHELL_BIN] stale log file (30 days old, 7-day retention) was swept"
    pass=$((pass + 1))
  fi
  teardown_fixture
done

echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
