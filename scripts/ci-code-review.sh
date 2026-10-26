#!/bin/bash
# CI audit report script (SMI-1826; runs in the Quality Checks job since SMI-7174)
#
# Runs the standards audit, prints its output, and writes a JSON report.
# Exit code: the audit's own exit code, unchanged.
#   0 - Passed (no errors, warnings allowed)
#   non-zero - Failed
#
# Counts come from the audit itself, via the file it writes to AUDIT_SUMMARY_FILE, never
# from log text: the log carries PR-description text (Checks 54 and 58 echo opt-out
# reasons), which must not be able to forge or corrupt the counts (SMI-7174).
#
# Do not add --only here: Check 38 invariant B looks for audit flags only in the
# workflow body, so a flag added in this script would be invisible to it.
#
# Usage: ./scripts/ci-code-review.sh [output-file]
#   Default output: audit-report.json

set -o pipefail

# Environment Detection (SMI-1831)
#   1. CI/GITHUB_ACTIONS env vars: run npm directly (Quality Checks runs on the host runner)
#   2. docker command not found (inside a container): run npm directly
#   3. Otherwise local development: docker exec. The counts file is then written inside
#      the container's tmp, not here, so the local report has summary_found: false.
if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  NPM_CMD="npm"
  echo "ℹ️  CI environment detected, using npm directly"
elif ! command -v docker &> /dev/null; then
  NPM_CMD="npm"
  echo "ℹ️  Docker not found (likely inside container), using npm directly"
else
  NPM_CMD="docker exec skillsmith-dev-1 npm"
  echo "ℹ️  Local development detected, using docker exec"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="${1:-audit-report.json}"
TEMP_OUTPUT=$(mktemp)
SUMMARY_DIR=$(mktemp -d)
SUMMARY_FILE="$SUMMARY_DIR/audit-summary.json"

echo "Running standards audit..."

AUDIT_SUMMARY_FILE="$SUMMARY_FILE" $NPM_CMD run audit:standards 2>&1 | tee "$TEMP_OUTPUT"
# Capture on this line: every later command overwrites PIPESTATUS (SMI-7174).
AUDIT_EXIT_CODE=${PIPESTATUS[0]}

# Build the report. A failure here leaves no report; it never changes the exit code.
AUDIT_EXIT_CODE="$AUDIT_EXIT_CODE" TEMP_OUTPUT="$TEMP_OUTPUT" SUMMARY_FILE="$SUMMARY_FILE" \
  OUTPUT_FILE="$OUTPUT_FILE" node "$SCRIPT_DIR/lib/audit-report.mjs" build \
  || echo "⚠ Could not write $OUTPUT_FILE; the audit's exit code is unaffected."

rm -f "$TEMP_OUTPUT"
rm -rf "$SUMMARY_DIR"

exit "$AUDIT_EXIT_CODE"
