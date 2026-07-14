#!/usr/bin/env bash
# scripts/tests/needle-dispatch.test.sh — zero-cost smoke test for
# scripts/needle/dispatch.sh's missing-binary contract.
# SMI-5668 (ADR-128 pilot: NEEDLE-based Codex dispatch).
#
# Asserts that dispatch.sh exits 2 (check_binary's documented "harness not
# installed" signal) when 'needle'/'bf'/'codex'/'jq' are absent from PATH,
# rather than crashing. Does NOT require the real binaries to run — same
# "maintainer-run-only, not CI-wired" posture as scripts/agent-evals/*.sh
# (see scripts/needle/README.md).
#
# Usage: ./scripts/tests/needle-dispatch.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DISPATCH="$REPO_ROOT/scripts/needle/dispatch.sh"

# /usr/bin:/bin has bash + coreutils (dirname, basename, date, mktemp, cat)
# on both macOS and Linux, but not needle/bf/codex/jq — those install to
# ~/.cargo/bin, a package manager's bin dir, or an nvm shim, never /usr/bin
# or /bin. This guarantees check_binary fails on all four regardless of
# what's installed on this machine, without needing to fake out bash itself.
MINIMAL_PATH="/usr/bin:/bin"

set +e
PATH="$MINIMAL_PATH" "$DISPATCH" \
    --workspace /tmp \
    --title "smoke test" \
    --body-file "$SCRIPT_DIR/needle-dispatch.test.sh" \
    >/tmp/needle-dispatch-test.out 2>&1
EXIT_CODE=$?
set -e

if [[ "$EXIT_CODE" -ne 2 ]]; then
    echo "FAIL: expected exit 2 (check_binary contract) with no binaries on PATH, got $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test.out >&2
    exit 1
fi

echo "PASS: dispatch.sh exits 2 when needle/bf/codex/jq are missing from PATH"
