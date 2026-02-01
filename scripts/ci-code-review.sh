#!/bin/bash
# CI Code Review Script (SMI-1826)
#
# Runs the standards audit and outputs results to JSON format for CI artifacts.
# Exit codes:
#   0 - Passed (no errors, warnings allowed)
#   1 - Failed (errors found)
#
# Usage: ./scripts/ci-code-review.sh [output-file]
#   Default output: audit-report.json

set -o pipefail

# Environment Detection (SMI-1831)
# This script runs in two contexts:
#   1. GitHub Actions CI - Already inside a Docker container, use npm directly
#   2. Local development - Must use docker exec per governance standards
#
# Detection priority:
#   1. CI/GITHUB_ACTIONS env vars (explicit CI context)
#   2. docker command not found (inside container without env vars)
#   3. Default to docker exec (local development)
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

OUTPUT_FILE="${1:-audit-report.json}"
TEMP_OUTPUT=$(mktemp)

echo "Running standards audit..."

# Run the audit and capture output
$NPM_CMD run audit:standards 2>&1 | tee "$TEMP_OUTPUT"
AUDIT_EXIT_CODE=${PIPESTATUS[0]}

# Strip ANSI color codes for parsing
CLEAN_OUTPUT=$(sed 's/\x1b\[[0-9;]*m//g' "$TEMP_OUTPUT")

# Parse results from output using portable grep/sed
PASSED=$(echo "$CLEAN_OUTPUT" | grep -E '^Passed:' | sed 's/[^0-9]//g' || echo "0")
WARNINGS=$(echo "$CLEAN_OUTPUT" | grep -E '^Warnings:' | sed 's/[^0-9]//g' || echo "0")
FAILED=$(echo "$CLEAN_OUTPUT" | grep -E '^Failed:' | sed 's/[^0-9]//g' || echo "0")
SCORE=$(echo "$CLEAN_OUTPUT" | grep -E 'Compliance Score:' | sed 's/[^0-9]//g' || echo "0")

# Default to 0 if empty
PASSED=${PASSED:-0}
WARNINGS=${WARNINGS:-0}
FAILED=${FAILED:-0}
SCORE=${SCORE:-0}

# Generate timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Determine status
if [ "$AUDIT_EXIT_CODE" -eq 0 ]; then
  STATUS="passed"
else
  STATUS="failed"
fi

# Escape output for JSON (replace special characters)
# Using node for reliable JSON escaping
ESCAPED_OUTPUT=$(node -e "
  const fs = require('fs');
  const content = fs.readFileSync('$TEMP_OUTPUT', 'utf8');
  console.log(JSON.stringify(content));
")

# Generate JSON report
cat > "$OUTPUT_FILE" << EOF
{
  "timestamp": "$TIMESTAMP",
  "summary": {
    "passed": $PASSED,
    "warnings": $WARNINGS,
    "failed": $FAILED,
    "compliance_score": $SCORE
  },
  "status": "$STATUS",
  "exit_code": $AUDIT_EXIT_CODE,
  "output": $ESCAPED_OUTPUT
}
EOF

# Cleanup
rm -f "$TEMP_OUTPUT"

echo ""
echo "Report generated: $OUTPUT_FILE"
echo "Summary: passed=$PASSED, warnings=$WARNINGS, failed=$FAILED, score=$SCORE%"

# Exit with same code as audit
exit $AUDIT_EXIT_CODE
