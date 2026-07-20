#!/usr/bin/env bash
# scripts/tests/needle-dispatch.test.sh — smoke tests for
# scripts/needle/dispatch.sh, including its missing-binary contract (case 0,
# original SMI-5668 test) and the SMI-5700 false-success detection logic
# (cases 1-5, added when that fix landed).
#
# Cases 1-5 fake out 'needle'/'bf'/'codex' with scripted shell stand-ins
# (real 'git'/'jq' are used as-is) so the full dispatch.sh flow — including
# its background-poll loop and outcome classification — runs deterministically
# without needing the real NEEDLE/bead-forge/Codex CLIs or a live Codex
# session installed. Unlike scripts/agent-evals/*.sh (real harness binaries,
# genuinely maintainer-run-only), this file needs nothing beyond bash/git/jq/
# openssl — all present on ubuntu-latest — so it IS CI-wired (SMI-5771,
# validate-needle-dispatch.yml). dispatch.sh's real-dispatch path (actually
# invoking needle/bf/codex) remains maintainer-machine-only; see
# scripts/needle/README.md.
#
# Usage: ./scripts/tests/needle-dispatch.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DISPATCH="$REPO_ROOT/scripts/needle/dispatch.sh"

FAIL_COUNT=0

# ---- Case 0 (original SMI-5668 test): missing-binary contract ----
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
    echo "FAIL (case 0): expected exit 2 (check_binary contract) with no binaries on PATH, got $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 0): dispatch.sh exits 2 when needle/bf/codex/jq are missing from PATH"
fi

# ---- Cases 1-5 (SMI-5700): false-success detection ----

FAKE_BIN_DIR="$(mktemp -d)"
FAKE_OUTCOME_FILE="$(mktemp)"
export FAKE_OUTCOME_FILE
# GIT_WORKTREE_DIR/GIT_SCRATCH_DIR/NONGIT_SCRATCH_DIR are defined later, but
# this trap body is single-quoted (deferred expansion at fire-time, not
# registration-time), so referencing them here before they're set is safe as
# long as they exist by the time the trap actually fires. Covers early exit
# under set -euo pipefail (e.g. a FAIL branch), not just normal completion —
# without this, an early exit leaks the worktree directory on disk (a plain
# rm -rf of GIT_SCRATCH_DIR only removes the scratch repo's own .git, not
# the separate linked-worktree directory next to it).
trap '
    git -C "$GIT_SCRATCH_DIR" worktree remove --force "$GIT_WORKTREE_DIR" 2>/dev/null || true
    rm -rf "$FAKE_BIN_DIR" "$FAKE_OUTCOME_FILE" "$GIT_SCRATCH_DIR" "$GIT_WORKTREE_DIR" "$NONGIT_SCRATCH_DIR" 2>/dev/null || true
' EXIT

# Fake 'codex' — only --version is ever invoked directly by dispatch.sh
# (the real dispatch happens inside the faked 'needle run' below).
cat > "$FAKE_BIN_DIR/codex" << 'FAKE_CODEX'
#!/usr/bin/env bash
case "${1:-}" in
    --version) echo "codex-fake 1.0.0"; exit 0 ;;
    *) exit 0 ;;
esac
FAKE_CODEX
chmod +x "$FAKE_BIN_DIR/codex"

# Fake 'bf' — init/create/show, matching the exact invocations dispatch.sh
# makes (see scripts/needle/dispatch.sh's "Ensure a bead-forge workspace
# exists" / "Create the bead" / bead-state-lookup sections).
cat > "$FAKE_BIN_DIR/bf" << 'FAKE_BF'
#!/usr/bin/env bash
set -euo pipefail
sub="${1:-}"; shift || true
workspace=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    if [[ "${args[$i]}" == "--workspace" ]]; then
        workspace="${args[$((i + 1))]}"
    fi
done
case "$sub" in
    init)
        mkdir -p "$workspace/.beads"
        exit 0
        ;;
    create)
        mkdir -p "$workspace/.beads"
        echo "test-bead-1"
        exit 0
        ;;
    show)
        echo '[{"status":"done"}]'
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
FAKE_BF
chmod +x "$FAKE_BIN_DIR/bf"

# Fake 'needle' — 'run' simulates a completed dispatch by writing NEEDLE's
# own per-bead trace layout (.beads/traces/<bead-id>/{stderr.txt,trace.jsonl})
# per FAKE_SCENARIO/FAKE_TOUCH_FILE, then records the outcome.classified
# event to FAKE_OUTCOME_FILE (a global, not workspace-scoped, scratch file —
# matching how 'needle logs' itself takes no --workspace flag in the real
# invocation) for 'logs' to serve back. Both env vars are set fresh by each
# case below.
cat > "$FAKE_BIN_DIR/needle" << 'FAKE_NEEDLE'
#!/usr/bin/env bash
set -euo pipefail
sub="${1:-}"; shift || true
case "$sub" in
    run)
        workspace=""
        args=("$@")
        for ((i = 0; i < ${#args[@]}; i++)); do
            if [[ "${args[$i]}" == "--workspace" ]]; then
                workspace="${args[$((i + 1))]}"
            fi
        done
        bead_id="test-bead-1"
        trace_dir="$workspace/.beads/traces/$bead_id"
        mkdir -p "$trace_dir"
        if [[ "${FAKE_SCENARIO:-clean}" == "rejected" ]]; then
            echo 'ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings' > "$trace_dir/stderr.txt"
        else
            echo "" > "$trace_dir/stderr.txt"
        fi
        echo '{"trace":"fake"}' > "$trace_dir/trace.jsonl"
        if [[ "${FAKE_TOUCH_FILE:-0}" == "1" ]]; then
            echo "codex made a real change" > "$workspace/codex-output.txt"
        fi
        echo '{"event_type":"outcome.classified","data":{"outcome":"success"}}' > "$FAKE_OUTCOME_FILE"
        exit 0
        ;;
    logs)
        if [[ -s "$FAKE_OUTCOME_FILE" ]]; then
            cat "$FAKE_OUTCOME_FILE"
        else
            echo "No matching events found."
        fi
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
FAKE_NEEDLE
chmod +x "$FAKE_BIN_DIR/needle"

TEST_PATH="$FAKE_BIN_DIR:$PATH"
BODY_FILE="$(mktemp)"
echo "test prompt body" > "$BODY_FILE"

# Git-based scratch workspace: dispatch.sh refuses to target a git repo's
# own primary checkout (git-dir == git-common-dir, tripped by a plain
# 'git init' scratch repo too, not just this repo's own root) — a genuine
# linked worktree of a throwaway scratch repo is required to exercise the
# git-workspace path at all.
GIT_SCRATCH_DIR="$(mktemp -d)"
git -C "$GIT_SCRATCH_DIR" -c user.email=test@example.com -c user.name=test init -q
git -C "$GIT_SCRATCH_DIR" -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m init
GIT_WORKTREE_DIR="$GIT_SCRATCH_DIR-worktree"
git -C "$GIT_SCRATCH_DIR" worktree add -q "$GIT_WORKTREE_DIR" -b needle-dispatch-test-branch

NONGIT_SCRATCH_DIR="$(mktemp -d)"

run_case() {
    local case_num="$1" scenario="$2" touch_file="$3" workspace="$4"
    shift 4
    rm -rf "$workspace/.beads"
    : > "$FAKE_OUTCOME_FILE"
    set +e
    FAKE_SCENARIO="$scenario" FAKE_TOUCH_FILE="$touch_file" PATH="$TEST_PATH" "$DISPATCH" \
        --workspace "$workspace" \
        --title "fixture case $case_num" \
        --body-file "$BODY_FILE" \
        --timeout 5 \
        "$@" \
        >/tmp/needle-dispatch-test-case"$case_num".out 2>&1
    echo $?
    set -e
}

# Case 1: sandbox-rejection stderr signature -> downgraded outcome, exit 1,
# regardless of --expect-write (a rejected write is suspicious on its own).
EXIT_CODE="$(run_case 1 rejected 0 "$GIT_WORKTREE_DIR" --expect-write)"
if [[ "$EXIT_CODE" -ne 1 ]] || ! grep -q "outcome=blocked-by-sandbox" /tmp/needle-dispatch-test-case1.out; then
    echo "FAIL (case 1): expected exit 1 and outcome=blocked-by-sandbox, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case1.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 1): sandbox-rejection stderr signature downgrades outcome"
fi

# Case 2: --expect-write + no diff -> flagged, exit 1.
EXIT_CODE="$(run_case 2 clean 0 "$GIT_WORKTREE_DIR" --expect-write)"
if [[ "$EXIT_CODE" -ne 1 ]] || ! grep -q "outcome=no-diff-despite-expected-write" /tmp/needle-dispatch-test-case2.out; then
    echo "FAIL (case 2): expected exit 1 and outcome=no-diff-despite-expected-write, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case2.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 2): --expect-write with no workspace diff is flagged"
fi

# Case 3: --expect-write + real diff -> success, exit 0.
EXIT_CODE="$(run_case 3 clean 1 "$GIT_WORKTREE_DIR" --expect-write)"
if [[ "$EXIT_CODE" -ne 0 ]] || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case3.out; then
    echo "FAIL (case 3): expected exit 0 and outcome=success, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case3.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 3): --expect-write with a real workspace diff reports success"
fi
rm -f "$GIT_WORKTREE_DIR/codex-output.txt"

# Case 4: analysis-only (no --expect-write) + no diff -> success, no
# regression. This is the exact shape of dispatch that worked correctly
# before SMI-5700 and must keep working identically after it.
EXIT_CODE="$(run_case 4 clean 0 "$GIT_WORKTREE_DIR")"
if [[ "$EXIT_CODE" -ne 0 ]] || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case4.out; then
    echo "FAIL (case 4): expected exit 0 and outcome=success (analysis-only, no regression), got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case4.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 4): analysis-only dispatch (no --expect-write) still reports success — no regression"
fi

# Case 5: non-git --workspace -> diff check is skipped cleanly, no crash,
# even with --expect-write set (the guard must not let an unguarded git
# call abort the script under set -euo pipefail).
EXIT_CODE="$(run_case 5 clean 0 "$NONGIT_SCRATCH_DIR" --expect-write)"
if [[ "$EXIT_CODE" -ne 0 ]] || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case5.out; then
    echo "FAIL (case 5): expected exit 0 and outcome=success (non-git workspace, diff check skipped), got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case5.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 5): non-git --workspace skips the diff check without crashing"
fi

# ---- Cases 6-7 (SMI-5709): secret-scanner compatibility guard ----
# A 50-char hex run (matches [A-Za-z0-9/_-], mirrors a realistic long
# token/path) — distinct characters, not a repeated single char, so "the
# full run never appears in output" is a meaningful assertion rather than
# trivially true/false from repetition.
LONG_RUN="$(openssl rand -hex 25)"
LONG_RUN_BODY_FILE="$(mktemp)"
printf 'some prompt text\n%s\nmore prompt text\n' "$LONG_RUN" > "$LONG_RUN_BODY_FILE"

# Case 6: title contains a 44+ char run -> guard fires before any bf/codex
# invocation, exit 1, output shows a redacted preview (contains the ellipsis
# marker) but never the full matched run.
set +e
PATH="$TEST_PATH" "$DISPATCH" \
    --workspace "$GIT_WORKTREE_DIR" \
    --title "$LONG_RUN" \
    --body-file "$BODY_FILE" \
    --timeout 5 \
    >/tmp/needle-dispatch-test-case6.out 2>&1
EXIT_CODE=$?
set -e
if [[ "$EXIT_CODE" -ne 1 ]] \
    || ! grep -q "…" /tmp/needle-dispatch-test-case6.out \
    || grep -qF "$LONG_RUN" /tmp/needle-dispatch-test-case6.out; then
    echo "FAIL (case 6): expected exit 1, a redacted (…) preview, and the full run absent from output, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case6.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 6): a 44+ char run in the title fails fast with a redacted preview, never the full match"
fi

# Case 7: same long run, but in the body, with the guard disabled via its
# registered opt-out var -> guard is skipped (no redaction message), and
# the dispatch proceeds through the faked bf/needle stack to success.
EXIT_CODE="$(SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE=1 FAKE_SCENARIO=clean FAKE_TOUCH_FILE=0 PATH="$TEST_PATH" "$DISPATCH" \
    --workspace "$GIT_WORKTREE_DIR" \
    --title "fixture case 7" \
    --body-file "$LONG_RUN_BODY_FILE" \
    --timeout 5 \
    >/tmp/needle-dispatch-test-case7.out 2>&1; echo $?)"
if [[ "$EXIT_CODE" -ne 0 ]] \
    || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case7.out \
    || ! grep -q "SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE=1" /tmp/needle-dispatch-test-case7.out; then
    echo "FAIL (case 7): expected exit 0, outcome=success, and the opt-out warning, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case7.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 7): SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE=1 skips the guard and the dispatch proceeds"
fi
rm -f "$LONG_RUN_BODY_FILE"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
    echo "FAILED: $FAIL_COUNT case(s) failed" >&2
    exit 1
fi

echo "PASS: all needle-dispatch.test.sh cases passed"
