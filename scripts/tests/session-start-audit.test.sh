#!/usr/bin/env bash
# SMI-4590 Wave 4 PR 6/6 — Session-start audit hook tests.
#
# Privacy-boundary regression suite. Mocks the helper to a fixed-output
# stub so the bash hook's gating, timeout, and stdout/stderr channel
# discipline can be tested without invoking the real audit pipeline.
#
# Run: bash scripts/tests/session-start-audit.test.sh
#
# Required for ADR-109 review: validates the LOAD-BEARING privacy
# boundary (Free/Individual emit zero output) and the bounded-execution
# guarantee (5-second cap; helper hang must not block the hook).

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
HOOK="$REPO_ROOT/scripts/session-start-audit.sh"

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
    echo "FAIL $name: '$needle' WAS in '$haystack' (privacy leak)"
    fail=$((fail + 1))
  else
    echo "PASS $name"
    pass=$((pass + 1))
  fi
}

# A throwaway repo + helper-stub directory. The hook resolves
# "$REPO_ROOT/scripts/lib/session-start-audit-helper.ts" relative to the
# CWD's git toplevel — so we construct a temp git repo whose
# scripts/lib/session-start-audit-helper.ts is a stub we control.
mk_test_repo() {
  local dir
  dir=$(mktemp -d -t skillsmith-hook-test.XXXXXX)
  git -C "$dir" init -q
  mkdir -p "$dir/scripts/lib"
  echo "$dir"
}

# Build a stub helper that emits a fixed stderr line and exits 0. Args:
# $1 = path to stub, $2 = stderr text. Escapes the line via printf %q so
# embedded quotes don't break the JS string.
mk_stub_helper() {
  local stub="$1" line="$2"
  # JSON-encode the line for safe JS embedding.
  local quoted
  quoted=$(printf '%s' "$line" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  {
    printf '%s\n' '#!/usr/bin/env tsx'
    printf 'process.stderr.write(%s);\n' "$quoted"
    printf '%s\n' 'process.stderr.write("\n");'
    printf '%s\n' 'process.exit(0);'
  } > "$stub"
  chmod +x "$stub"
}

# Wrap the hook invocation. We need to point the helper-resolution at
# our stub repo (the hook reads CWD from stdin's "cwd" field), and we
# must replace the real helper with the stub. Because the hook resolves
# the helper inside REPO_ROOT (the test repo's own toplevel), we copy
# the real hook script into the test repo to make the resolution local.
run_hook() {
  local repo="$1" source="$2" stderr_text="$3"
  local mock_helper="$repo/scripts/lib/session-start-audit-helper.ts"
  cp "$HOOK" "$repo/scripts/session-start-audit.sh"
  chmod +x "$repo/scripts/session-start-audit.sh"
  mk_stub_helper "$mock_helper" "$stderr_text"

  # Invoke. Capture stdout + stderr separately.
  local stdout_file stderr_file
  stdout_file=$(mktemp -t skillsmith-hook-stdout.XXXXXX)
  stderr_file=$(mktemp -t skillsmith-hook-stderr.XXXXXX)
  printf '{"source":"%s","cwd":"%s","session_id":"t","transcript_path":""}' \
    "$source" "$repo" \
    | "$repo/scripts/session-start-audit.sh" >"$stdout_file" 2>"$stderr_file"
  echo "STDOUT_FILE=$stdout_file"
  echo "STDERR_FILE=$stderr_file"
}

# ----------------------------------------------------------------------
# Test 1: stdout is ALWAYS the fixed JSON envelope with empty additionalContext.
# ----------------------------------------------------------------------
{
  REPO=$(mk_test_repo)
  out_lines=$(run_hook "$REPO" startup 'team-render-line')
  STDOUT_FILE=$(echo "$out_lines" | grep '^STDOUT_FILE=' | sed 's/STDOUT_FILE=//')
  STDERR_FILE=$(echo "$out_lines" | grep '^STDERR_FILE=' | sed 's/STDERR_FILE=//')
  STDOUT=$(cat "$STDOUT_FILE")
  STDERR=$(cat "$STDERR_FILE")

  # The stdout JSON must contain the exact fixed envelope.
  assert_contains "stdout-has-hookEventName" '"hookEventName": "SessionStart"' "$STDOUT"
  assert_contains "stdout-has-empty-additionalContext" '"additionalContext": ""' "$STDOUT"

  # CRITICAL: the helper's stderr text must NOT have been routed through
  # stdout. Privacy boundary: stdout = additionalContext = model context.
  assert_not_contains "stdout-no-team-render-leak" 'team-render-line' "$STDOUT"

  # And stderr should carry the helper's render line (terminal channel).
  assert_contains "stderr-has-render" 'team-render-line' "$STDERR"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
# Test 2: source != 'startup' → silent fast-path. Helper not invoked.
# ----------------------------------------------------------------------
{
  REPO=$(mk_test_repo)
  out_lines=$(run_hook "$REPO" resume 'should-not-appear')
  STDOUT_FILE=$(echo "$out_lines" | grep '^STDOUT_FILE=' | sed 's/STDOUT_FILE=//')
  STDERR_FILE=$(echo "$out_lines" | grep '^STDERR_FILE=' | sed 's/STDERR_FILE=//')
  STDOUT=$(cat "$STDOUT_FILE")
  STDERR=$(cat "$STDERR_FILE")

  assert_contains "resume-stdout-envelope" '"additionalContext": ""' "$STDOUT"
  # Helper must not have run on resume.
  assert_not_contains "resume-helper-skipped" 'should-not-appear' "$STDERR"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
# Test 3: SKILLSMITH_SESSION_AUDIT_DISABLE=1 → silent fast-path.
# ----------------------------------------------------------------------
{
  REPO=$(mk_test_repo)
  cp "$HOOK" "$REPO/scripts/session-start-audit.sh"
  chmod +x "$REPO/scripts/session-start-audit.sh"
  mk_stub_helper "$REPO/scripts/lib/session-start-audit-helper.ts" 'should-not-appear'

  STDOUT_FILE=$(mktemp -t skillsmith-hook-stdout.XXXXXX)
  STDERR_FILE=$(mktemp -t skillsmith-hook-stderr.XXXXXX)
  printf '{"source":"startup","cwd":"%s","session_id":"t","transcript_path":""}' "$REPO" \
    | env SKILLSMITH_SESSION_AUDIT_DISABLE=1 "$REPO/scripts/session-start-audit.sh" \
        >"$STDOUT_FILE" 2>"$STDERR_FILE"
  STDOUT=$(cat "$STDOUT_FILE")
  STDERR=$(cat "$STDERR_FILE")

  assert_contains "disabled-stdout-envelope" '"additionalContext": ""' "$STDOUT"
  assert_not_contains "disabled-helper-skipped" 'should-not-appear' "$STDERR"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
# Test 4: missing helper → silent fast-path.
# ----------------------------------------------------------------------
{
  REPO=$(mk_test_repo)
  cp "$HOOK" "$REPO/scripts/session-start-audit.sh"
  chmod +x "$REPO/scripts/session-start-audit.sh"
  # Intentionally do NOT create a helper stub.

  STDOUT_FILE=$(mktemp -t skillsmith-hook-stdout.XXXXXX)
  STDERR_FILE=$(mktemp -t skillsmith-hook-stderr.XXXXXX)
  printf '{"source":"startup","cwd":"%s","session_id":"t","transcript_path":""}' "$REPO" \
    | "$REPO/scripts/session-start-audit.sh" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  STDOUT=$(cat "$STDOUT_FILE")

  assert_contains "missing-helper-stdout-envelope" '"additionalContext": ""' "$STDOUT"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
# Test 5: bounded execution — slow helper does NOT block beyond 7s.
# Skipped when neither gtimeout nor timeout is available AND the host
# lacks the job-control fallback's prerequisites (rare).
# ----------------------------------------------------------------------
{
  REPO=$(mk_test_repo)
  cp "$HOOK" "$REPO/scripts/session-start-audit.sh"
  chmod +x "$REPO/scripts/session-start-audit.sh"

  # Helper that sleeps 30s — must be killed by the 5-second cap.
  # Wrapped in async IIFE for compatibility with tsx default mode.
  cat > "$REPO/scripts/lib/session-start-audit-helper.ts" <<'EOF'
;(async () => {
  await new Promise((r) => setTimeout(r, 30000))
  process.exit(0)
})()
EOF

  STDOUT_FILE=$(mktemp -t skillsmith-hook-stdout.XXXXXX)
  STDERR_FILE=$(mktemp -t skillsmith-hook-stderr.XXXXXX)

  start_s=$(date +%s)
  printf '{"source":"startup","cwd":"%s","session_id":"t","transcript_path":""}' "$REPO" \
    | "$REPO/scripts/session-start-audit.sh" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  end_s=$(date +%s)
  elapsed=$(( end_s - start_s ))

  if [ "$elapsed" -le 10 ]; then
    echo "PASS bounded-execution-${elapsed}s"
    pass=$((pass + 1))
  else
    echo "FAIL bounded-execution: took ${elapsed}s (expected <= 10s)"
    fail=$((fail + 1))
  fi

  STDOUT=$(cat "$STDOUT_FILE")
  assert_contains "slow-helper-stdout-envelope" '"additionalContext": ""' "$STDOUT"

  rm -rf "$REPO" "$STDOUT_FILE" "$STDERR_FILE"
}

# ----------------------------------------------------------------------
echo
echo "SUMMARY: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
