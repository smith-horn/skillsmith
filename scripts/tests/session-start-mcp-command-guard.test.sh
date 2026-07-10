#!/usr/bin/env bash
# SMI-5642 — Session-start MCP command guard hook tests.
#
# Mirrors scripts/tests/session-start-audit.test.sh's structure. Validates
# gating (disable var, source!=startup, missing guard script), the fixed
# stdout envelope / stderr-only warning channel discipline, always-exits-0,
# and the fail-soft "python3 missing" regression case for the Edit-4/§2
# reliability fix in mcp-bare-command-guard-hook.md.
#
# Run: bash scripts/tests/session-start-mcp-command-guard.test.sh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
HOOK="$REPO_ROOT/scripts/session-start-mcp-command-guard.sh"

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

assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "FAIL $name: '$needle' WAS in '$haystack' (unexpected)"
    fail=$((fail + 1))
  else
    echo "PASS $name"
    pass=$((pass + 1))
  fi
}

# A throwaway repo whose scripts/lib/mcp-command-guard.mjs we control.
mk_test_repo() {
  local dir
  dir=$(mktemp -d -t skillsmith-mcpguard-test.XXXXXX)
  git -C "$dir" init -q
  mkdir -p "$dir/scripts/lib"
  cp "$HOOK" "$dir/scripts/session-start-mcp-command-guard.sh"
  chmod +x "$dir/scripts/session-start-mcp-command-guard.sh"
  cp "$REPO_ROOT/scripts/lib/mcp-command-guard.mjs" "$dir/scripts/lib/mcp-command-guard.mjs"
  echo "$dir"
}

run_hook() {
  local repo="$1" source="$2"
  local stdout_file stderr_file
  stdout_file=$(mktemp -t skillsmith-mcpguard-stdout.XXXXXX)
  stderr_file=$(mktemp -t skillsmith-mcpguard-stderr.XXXXXX)
  printf '{"source":"%s","cwd":"%s","session_id":"t","transcript_path":""}' "$source" "$repo" \
    | env HOME="$repo/fake-home" "$repo/scripts/session-start-mcp-command-guard.sh" \
        >"$stdout_file" 2>"$stderr_file"
  echo "STDOUT_FILE=$stdout_file"
  echo "STDERR_FILE=$stderr_file"
}

# ----------------------------------------------------------------------
# Test 1: a bare-command .mcp.json entry produces the expected stderr
# warning; stdout is always the fixed empty envelope.
# ----------------------------------------------------------------------
{
  REPO=$(mk_test_repo)
  mkdir -p "$REPO/fake-home"
  cat > "$REPO/.mcp.json" <<'EOF'
{"mcpServers":{"badServer":{"command":"bad-bin"}}}
EOF

  out_lines=$(run_hook "$REPO" startup)
  STDOUT_FILE=$(echo "$out_lines" | grep '^STDOUT_FILE=' | sed 's/STDOUT_FILE=//')
  STDERR_FILE=$(echo "$out_lines" | grep '^STDERR_FILE=' | sed 's/STDERR_FILE=//')
  STDOUT=$(cat "$STDOUT_FILE")
  STDERR=$(cat "$STDERR_FILE")

  assert_contains "stdout-has-hookEventName" '"hookEventName": "SessionStart"' "$STDOUT"
  assert_contains "stdout-has-empty-additionalContext" '"additionalContext": ""' "$STDOUT"
  assert_not_contains "stdout-no-warning-leak" 'badServer' "$STDOUT"
  assert_contains "stderr-has-warning" 'badServer' "$STDERR"
  assert_contains "stderr-has-mcp-guard-prefix" '[mcp-command-guard]' "$STDERR"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
# Test 2: source != 'startup' → silent fast-path.
# ----------------------------------------------------------------------
{
  REPO=$(mk_test_repo)
  mkdir -p "$REPO/fake-home"
  cat > "$REPO/.mcp.json" <<'EOF'
{"mcpServers":{"badServer":{"command":"bad-bin"}}}
EOF

  out_lines=$(run_hook "$REPO" resume)
  STDOUT_FILE=$(echo "$out_lines" | grep '^STDOUT_FILE=' | sed 's/STDOUT_FILE=//')
  STDERR_FILE=$(echo "$out_lines" | grep '^STDERR_FILE=' | sed 's/STDERR_FILE=//')
  STDOUT=$(cat "$STDOUT_FILE")
  STDERR=$(cat "$STDERR_FILE")

  assert_contains "resume-stdout-envelope" '"additionalContext": ""' "$STDOUT"
  assert_not_contains "resume-no-warning" 'badServer' "$STDERR"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
# Test 3: SKILLSMITH_MCP_COMMAND_GUARD_DISABLE=1 → silent fast-path.
# ----------------------------------------------------------------------
{
  REPO=$(mk_test_repo)
  mkdir -p "$REPO/fake-home"
  cat > "$REPO/.mcp.json" <<'EOF'
{"mcpServers":{"badServer":{"command":"bad-bin"}}}
EOF

  STDOUT_FILE=$(mktemp -t skillsmith-mcpguard-stdout.XXXXXX)
  STDERR_FILE=$(mktemp -t skillsmith-mcpguard-stderr.XXXXXX)
  printf '{"source":"startup","cwd":"%s","session_id":"t","transcript_path":""}' "$REPO" \
    | env HOME="$REPO/fake-home" SKILLSMITH_MCP_COMMAND_GUARD_DISABLE=1 \
        "$REPO/scripts/session-start-mcp-command-guard.sh" \
        >"$STDOUT_FILE" 2>"$STDERR_FILE"
  STDOUT=$(cat "$STDOUT_FILE")
  STDERR=$(cat "$STDERR_FILE")

  assert_contains "disabled-stdout-envelope" '"additionalContext": ""' "$STDOUT"
  assert_not_contains "disabled-no-warning" 'badServer' "$STDERR"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
# Test 4: missing guard script → silent fast-path, still exits 0.
# ----------------------------------------------------------------------
{
  REPO=$(mktemp -d -t skillsmith-mcpguard-nolib.XXXXXX)
  git -C "$REPO" init -q
  cp "$HOOK" "$REPO/session-start-mcp-command-guard.sh"
  mkdir -p "$REPO/scripts"
  cp "$HOOK" "$REPO/scripts/session-start-mcp-command-guard.sh"
  chmod +x "$REPO/scripts/session-start-mcp-command-guard.sh"
  # Intentionally do NOT create scripts/lib/mcp-command-guard.mjs.

  STDOUT_FILE=$(mktemp -t skillsmith-mcpguard-stdout.XXXXXX)
  STDERR_FILE=$(mktemp -t skillsmith-mcpguard-stderr.XXXXXX)
  printf '{"source":"startup","cwd":"%s","session_id":"t","transcript_path":""}' "$REPO" \
    | "$REPO/scripts/session-start-mcp-command-guard.sh" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  STDOUT=$(cat "$STDOUT_FILE")

  assert_contains "missing-script-stdout-envelope" '"additionalContext": ""' "$STDOUT"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
# Test 5a: python3 hidden from PATH entirely → still exits 0 with the
# fixed JSON envelope on stdout (via Gate 1's SOURCE-parse-failure
# fallback short-circuit).
# ----------------------------------------------------------------------
FILTERED_PATH=""
IFS=':' read -ra PATH_DIRS <<< "$PATH"
for d in "${PATH_DIRS[@]}"; do
  if [ -x "$d/python3" ] || [ -x "$d/python" ]; then
    continue
  fi
  FILTERED_PATH="${FILTERED_PATH:+$FILTERED_PATH:}$d"
done

{
  REPO=$(mk_test_repo)
  mkdir -p "$REPO/fake-home"

  STDOUT_FILE=$(mktemp -t skillsmith-mcpguard-stdout.XXXXXX)
  STDERR_FILE=$(mktemp -t skillsmith-mcpguard-stderr.XXXXXX)
  set +e
  printf '{"source":"startup","cwd":"%s","session_id":"t","transcript_path":""}' "$REPO" \
    | env -i HOME="$REPO/fake-home" PATH="$FILTERED_PATH" \
        "$REPO/scripts/session-start-mcp-command-guard.sh" \
        >"$STDOUT_FILE" 2>"$STDERR_FILE"
  hook_exit=$?
  set -e
  STDOUT=$(cat "$STDOUT_FILE")

  assert_eq "no-python3-exit-code" "0" "$hook_exit"
  assert_contains "no-python3-stdout-envelope" '"additionalContext": ""' "$STDOUT"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
# Test 5b: the EXACT bug scenario from plan review finding #3 —
# SKILLSMITH_MCP_COMMAND_GUARD_DISABLE=1 (Gate 0, bash-only, never
# touches python3) combined with python3 entirely absent from PATH.
# Gate 0's short-circuit calls emit_empty_and_exit() directly — under
# the pre-fix `python3 -c '...'` implementation, this would have failed
# to emit anything (and, under `set -euo pipefail`, aborted) even though
# the disable var was set specifically to bypass all logic. This test
# fails against that pre-fix version by design.
# ----------------------------------------------------------------------
{
  REPO=$(mk_test_repo)
  mkdir -p "$REPO/fake-home"

  STDOUT_FILE=$(mktemp -t skillsmith-mcpguard-stdout.XXXXXX)
  STDERR_FILE=$(mktemp -t skillsmith-mcpguard-stderr.XXXXXX)
  set +e
  printf '{"source":"startup","cwd":"%s","session_id":"t","transcript_path":""}' "$REPO" \
    | env -i HOME="$REPO/fake-home" PATH="$FILTERED_PATH" SKILLSMITH_MCP_COMMAND_GUARD_DISABLE=1 \
        "$REPO/scripts/session-start-mcp-command-guard.sh" \
        >"$STDOUT_FILE" 2>"$STDERR_FILE"
  hook_exit=$?
  set -e
  STDOUT=$(cat "$STDOUT_FILE")

  assert_eq "disabled-no-python3-exit-code" "0" "$hook_exit"
  assert_contains "disabled-no-python3-stdout-envelope" '"additionalContext": ""' "$STDOUT"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
echo
echo "SUMMARY: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
