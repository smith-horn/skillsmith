#!/usr/bin/env bash
# Unit tests for scripts/classify-deploy-mode.sh.
#
# Stubs `git diff --name-only HEAD~1 HEAD` output via a wrapper shim on $PATH,
# invokes the classifier, and asserts stdout matches expected mode/functions.
# Covers all three priority branches + edge cases (mixed-scope, multi-fn,
# non-fn changes).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
CLASSIFIER="$SCRIPT_DIR/classify-deploy-mode.sh"

if [ ! -x "$CLASSIFIER" ]; then
  echo "FAIL: $CLASSIFIER not found or not executable"
  exit 1
fi

fail=0
run_case() {
  local name="$1" diff_output="$2" expected_mode="$3" expected_functions="$4"
  local tmpdir
  tmpdir=$(mktemp -d)

  # Persist the full stubbed diff to a file so the shim can re-read + filter it.
  printf '%s' "$diff_output" > "$tmpdir/all_changed"
  if [ -n "$diff_output" ]; then printf '\n' >> "$tmpdir/all_changed"; fi

  # Shim: `git diff --name-only HEAD~1 HEAD -- <pathspec>` filters the stubbed
  # file list by the pathspec (real git behavior). `git log ...` returns a
  # single parent so the non-squash-merge warning stays quiet. Any other git
  # subcommand falls through to the real binary.
  cat > "$tmpdir/git" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  diff)
    # args: diff --name-only HEAD~1 HEAD -- <pathspec>
    # Extract the pathspec (last arg). We emit lines from the stubbed file
    # that start with the pathspec — mirrors how `git diff -- <pathspec>`
    # restricts output to that path.
    pathspec=""
    for arg in "$@"; do pathspec="$arg"; done
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      case "$line" in
        "$pathspec"*) echo "$line" ;;
      esac
    done < "$(dirname "$0")/all_changed"
    ;;
  log)
    echo 'abc123'
    ;;
  *)
    exec /usr/bin/env -i PATH=/usr/bin:/bin git "$@"
    ;;
esac
SHIM
  chmod +x "$tmpdir/git"

  local actual actual_mode actual_fns
  actual=$(PATH="$tmpdir:$PATH" bash "$CLASSIFIER" 2>/dev/null || true)
  actual_mode=$(echo "$actual" | awk -F= '/^mode=/ {print $2}')
  actual_fns=$(echo "$actual" | awk -F= '/^functions=/ {print $2}')

  if [ "$actual_mode" = "$expected_mode" ] && [ "$actual_fns" = "$expected_functions" ]; then
    echo "PASS $name"
  else
    echo "FAIL $name: got mode='$actual_mode' functions='$actual_fns' expected mode='$expected_mode' functions='$expected_functions'"
    fail=1
  fi
  rm -rf "$tmpdir"
}

# Case 1: _shared/ only → mode=all
run_case "shared_only" \
  "supabase/functions/_shared/cors.ts" \
  "all" ""

# Case 2: specific fn only → mode=changed
run_case "specific_only" \
  "supabase/functions/events/index.ts" \
  "changed" "events"

# Case 3: THE SMI-4372 CASE — mixed _shared/ + specific fn → mode=all
run_case "mixed_scope" \
  "supabase/functions/_shared/cors.ts
supabase/functions/events/index.ts" \
  "all" ""

# Case 4: two specific fns, no _shared/ → mode=changed with both (alphabetized)
run_case "multi_specific" \
  "supabase/functions/events/index.ts
supabase/functions/stats/index.ts" \
  "changed" "events,stats"

# Case 5: nothing relevant → mode=none
run_case "none" "" "none" ""

# Case 6: migration changed but no fn code → mode=none
run_case "migration_only" \
  "supabase/migrations/077_foo.sql" \
  "none" ""

# Case 7: _shared/ subdir file (deeper than first-level) → mode=all
run_case "shared_subdir" \
  "supabase/functions/_shared/auth/jwt.ts" \
  "all" ""

if [ "$fail" -eq 1 ]; then
  echo ""
  echo "FAILURES above"
  exit 1
fi

echo ""
echo "all 7 cases passed"
