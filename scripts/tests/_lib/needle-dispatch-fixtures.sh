#!/usr/bin/env bash
# scripts/tests/_lib/needle-dispatch-fixtures.sh — shared fixture setup for
# scripts/tests/needle-dispatch.test.sh (case 0, SMI-5700/5709 cases 1-7) and
# scripts/tests/needle-dispatch.bead-lifecycle.test.sh (SMI-5847 cases 8-14).
# Split out of a single over-500-line test file (SMI-5847) so each half stays
# under this repo's per-file line limit; this file itself is pure fixture
# setup, sourced (not executed) by both, and is deliberately outside
# scripts/tests/**/*.test.ts's glob (SMI-1780) so vitest never tries to run
# it directly — matches scripts/tests/_lib/git-fixture-env.ts's existing
# convention for shared bash-test fixtures.
#
# All cases fake out 'needle'/'bf'/'codex' with scripted shell stand-ins
# (real 'git'/'jq' are used as-is) so the full dispatch.sh flow — including
# its background-poll loop, outcome classification, pre-flight guard, and
# bead-close call — runs deterministically without needing the real
# NEEDLE/bead-forge/Codex CLIs or a live Codex session installed. Unlike
# scripts/agent-evals/*.sh (real harness binaries, genuinely
# maintainer-run-only), this needs nothing beyond bash/git/jq/openssl, all
# present on ubuntu-latest — so it IS CI-wired (SMI-5771,
# validate-needle-dispatch.yml). dispatch.sh's real-dispatch path (actually
# invoking needle/bf/codex) remains maintainer-machine-only; see
# scripts/needle/README.md.
#
# SMI-5847 rewrote the fake 'bf' from a stateless stub (a hardcoded
# 'bf show' -> [{"status":"done"}], a catch-all '*) exit 0' swallowing
# unknown subcommands) to a STATEFUL, file-backed fake covering
# create/update/claim/show/close/count/list — a no-op bead close would have
# passed the old fixture invisibly, which is exactly what happened in
# production for 66/66 real dispatches. This file also isolates its
# results-log writes into a scratch directory via SKILLSMITH_NEEDLE_RESULTS_DIR
# (scripts/needle/lib.sh) instead of the operator's real
# scripts/needle/results/ log, which the pre-fix version of this file
# polluted with 12 fake rows (including fabricated "outcome=success
# bead_state=done" lines) that masked a 100% real-dispatch orphan rate for
# days.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DISPATCH="$REPO_ROOT/scripts/needle/dispatch.sh"

# ---- SMI-5847: results-log isolation (Wave 3 Step 3). Set before ANY
# dispatch.sh invocation (including case 0) so every fake dispatch writes
# into a scratch directory, never the operator's real
# scripts/needle/results/ log. A before/after snapshot of the real
# directory (byte counts, not just a file listing, so a same-named-file
# content change is still caught) is each consuming file's own regression
# assertion at the end of its own run. ----
NEEDLE_TEST_RESULTS_DIR="$(mktemp -d)"
export SKILLSMITH_NEEDLE_RESULTS_DIR="$NEEDLE_TEST_RESULTS_DIR"
LOG_FILE="$NEEDLE_TEST_RESULTS_DIR/codex-$(date +%Y-%m-%d 2>/dev/null || echo unknown-date).log"
REAL_RESULTS_DIR="$REPO_ROOT/scripts/needle/results"
snapshot_real_results_dir() {
    if [[ -d "$REAL_RESULTS_DIR" ]]; then
        find "$REAL_RESULTS_DIR" -type f -exec wc -c {} \; | sort
    fi
}
# shellcheck disable=SC2034 # read by needle-dispatch.test.sh and
# needle-dispatch.bead-lifecycle.test.sh, which source this file, for their
# own end-of-run isolation assertion — shellcheck can't see cross-file use.
REAL_RESULTS_SNAPSHOT_BEFORE="$(snapshot_real_results_dir)"

# last_log_block — print the most recent "=== DISPATCH: ... ===" block from
# the (isolated) results log. Blocks are appended in order, one per
# dispatch, separated by a blank line; each consuming file shares ONE
# calendar-day log file across all its own cases (never reset between
# cases, unlike each case's own .beads/ workspace), so a case-specific
# assertion must isolate its own block rather than grep the whole
# cumulative file (which would false-positive/false-negative against an
# EARLIER case's entry with the same bead id, e.g. every case that resets
# .beads starts back at "test-bead-1"). Safe because cases run strictly
# sequentially.
last_log_block() {
    awk '/^=== DISPATCH:/{block=""} {block = block $0 "\n"} END{printf "%s", block}' "$LOG_FILE" 2>/dev/null || true
}

FAKE_BIN_DIR="$(mktemp -d)"
FAKE_OUTCOME_FILE="$(mktemp)"
FAKE_BF_CALL_LOG="$(mktemp)"
export FAKE_OUTCOME_FILE
export FAKE_BF_CALL_LOG
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
    rm -rf "$FAKE_BIN_DIR" "$FAKE_OUTCOME_FILE" "$FAKE_BF_CALL_LOG" "$GIT_SCRATCH_DIR" "$GIT_WORKTREE_DIR" "$NONGIT_SCRATCH_DIR" "$NEEDLE_TEST_RESULTS_DIR" 2>/dev/null || true
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

# Fake 'bf' — SMI-5847: a STATEFUL, file-backed fake covering every
# subcommand dispatch.sh (and each consuming file's own pre-seeding steps)
# call: init/create/update/claim/show/close/count/list. One state file per
# bead (its status word only) under <workspace>/.beads/fake-state/<id>.status
# — living inside .beads/ itself so `rm -rf "$workspace/.beads"` (each
# case's own reset) tears it down exactly like real bead-forge state would
# be torn down by deleting the real store.
#
# Every invocation is appended to FAKE_BF_CALL_LOG so a case can assert
# "bf create was never reached" (case 10) — the pre-fix fixture's catch-all
# '*) exit 0' swallowed unknown subcommands silently, which is exactly how
# a no-op bead close passed invisibly in production.
cat > "$FAKE_BIN_DIR/bf" << 'FAKE_BF'
#!/usr/bin/env bash
set -euo pipefail
FAKE_BF_CALL_LOG="${FAKE_BF_CALL_LOG:-/dev/null}"
sub="${1:-}"; shift || true
echo "bf $sub $*" >> "$FAKE_BF_CALL_LOG"

workspace=""
status_filter=""
limit=""
pos_id=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[$i]}" in
        --workspace) workspace="${args[$((i + 1))]}" ;;
        --status) status_filter="${args[$((i + 1))]}" ;;
        --limit) limit="${args[$((i + 1))]}" ;;
    esac
done
# The ID is always the first positional (non-flag) token on the real bf's
# update/show/close subcommands (matches every dispatch.sh/test call site).
if [[ ${#args[@]} -gt 0 ]] && [[ "${args[0]}" != --* ]]; then
    pos_id="${args[0]}"
fi
state_dir="$workspace/.beads/fake-state"

case "$sub" in
    init)
        mkdir -p "$workspace/.beads"
        exit 0
        ;;
    create)
        mkdir -p "$state_dir"
        n=0
        for f in "$state_dir"/*.status; do
            [[ -e "$f" ]] || continue
            n=$((n + 1))
        done
        bead_id="test-bead-$((n + 1))"
        echo "open" > "$state_dir/$bead_id.status"
        echo "$bead_id"
        exit 0
        ;;
    update)
        mkdir -p "$state_dir"
        if [[ -n "$pos_id" ]] && [[ -n "$status_filter" ]]; then
            echo "$status_filter" > "$state_dir/$pos_id.status"
        fi
        exit 0
        ;;
    claim)
        # 'bf claim --assignee <worker> --workspace <W>' — real bf prints
        # the bare claimed bead id (verified live) or "No beads available
        # to claim" (exit 0 either way). Picks the first OPEN bead found —
        # sufficient fidelity here since at most one open bead ever exists
        # at claim time in these fixtures (an already in_progress
        # pre-seeded stale bead, cases 10/11, is correctly never claimed).
        mkdir -p "$state_dir"
        claimed=""
        for f in "$state_dir"/*.status; do
            [[ -e "$f" ]] || continue
            if [[ "$(cat "$f")" == "open" ]]; then
                claimed="$(basename "$f" .status)"
                echo "in_progress" > "$f"
                break
            fi
        done
        if [[ -n "$claimed" ]]; then
            echo "$claimed"
        else
            echo "No beads available to claim"
        fi
        exit 0
        ;;
    show)
        f="$state_dir/$pos_id.status"
        if [[ -f "$f" ]]; then
            echo "[{\"status\":\"$(cat "$f")\"}]"
        else
            echo '[{"status":"unknown"}]'
        fi
        exit 0
        ;;
    close)
        f="$state_dir/$pos_id.status"
        if [[ ! -f "$f" ]]; then
            echo "Error: Bead not found: $pos_id" >&2
            exit 1
        fi
        if [[ "${FAKE_CLOSE_FAIL:-0}" == "1" ]]; then
            echo "Error: simulated close failure (FAKE_CLOSE_FAIL=1)" >&2
            exit 1
        fi
        echo "closed" > "$f"
        echo "Closed bead $pos_id"
        exit 0
        ;;
    count)
        # Real bf rejects --format on 'count' (verified live:
        # "error: unexpected argument '--format' found", exit 2) — mirror
        # that failure mode exactly, since needle_count_beads() (lib.sh)
        # depends on this NEVER being used with --format.
        for a in "$@"; do
            if [[ "$a" == "--format" ]]; then
                echo "error: unexpected argument '--format' found" >&2
                exit 2
            fi
        done
        n=0
        for f in "$state_dir"/*.status; do
            [[ -e "$f" ]] || continue
            if [[ "$(cat "$f")" == "$status_filter" ]]; then
                n=$((n + 1))
            fi
        done
        echo "$n"
        exit 0
        ;;
    list)
        # JSONL, one object per line, NO array wrapper — mirrors real bf's
        # actual --format json shape (confirmed live: 'jq -r .[]' over it
        # fails, exit 5).
        shown=0
        for f in "$state_dir"/*.status; do
            [[ -e "$f" ]] || continue
            id="$(basename "$f" .status)"
            st="$(cat "$f")"
            if [[ -n "$status_filter" ]] && [[ "$st" != "$status_filter" ]]; then
                continue
            fi
            if [[ -n "$limit" ]] && [[ "$shown" -ge "$limit" ]]; then
                continue
            fi
            printf '{"id":"%s","status":"%s","created_at":"fake-created-%s"}\n' "$id" "$st" "$id"
            shown=$((shown + 1))
        done
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
FAKE_BF
chmod +x "$FAKE_BIN_DIR/bf"

# Fake 'needle' — 'run' simulates a completed dispatch. It claims the just-
# created bead via the (fake) 'bf claim' — not a hardcoded bead id — so it
# correctly discovers whichever bead dispatch.sh's own 'bf create' call
# just made even when a pre-seeded, already in_progress stale bead also
# exists in the same workspace (cases 10/11: 'bf claim' only ever picks an
# OPEN bead). It then writes NEEDLE's own per-bead trace layout
# (.beads/traces/<bead-id>/{stderr.txt,trace.jsonl,stdout.txt}) per
# FAKE_SCENARIO/FAKE_TOUCH_FILE/FAKE_NO_AGENT_MESSAGE, then records the
# outcome.classified event to FAKE_OUTCOME_FILE (a global, not
# workspace-scoped, scratch file — matching how 'needle logs' itself takes
# no --workspace flag in the real invocation) for 'logs' to serve back. All
# three env vars are set fresh by each case that uses them.
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

        bead_id="$(bf claim --assignee fake-worker --workspace "$workspace")"

        if [[ "${FAKE_SCENARIO:-clean}" == "no_outcome" ]]; then
            # Simulate a worker that exited/crashed before ever classifying
            # an outcome (dispatch.sh's own poll-loop comment: "Worker
            # process already exited on its own ... stop polling, fall
            # through to the failure path"). No outcome.classified event is
            # ever recorded. This exercises dispatch.sh's fast kill-0-based
            # exit branch, not a literal TIMEOUT+60s wall-clock wait (that
            # +60s floor is fixed regardless of --timeout, so a literal
            # deadline-expiry reproduction would make this one case take
            # over a minute for no additional coverage — both branches
            # converge on the exact same OUTCOME_EVENT="" -> OUTCOME=
            # "failure" state dispatch.sh's close call site reacts to
            # identically; see needle-dispatch.bead-lifecycle.test.sh's
            # case 13 comment for the full reasoning).
            exit 0
        fi

        trace_dir="$workspace/.beads/traces/$bead_id"
        mkdir -p "$trace_dir"
        if [[ "${FAKE_SCENARIO:-clean}" == "rejected" ]]; then
            echo 'ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings' > "$trace_dir/stderr.txt"
        else
            echo "" > "$trace_dir/stderr.txt"
        fi
        echo '{"trace":"fake"}' > "$trace_dir/trace.jsonl"

        # stdout.txt — the trace file that actually holds the agent's final
        # answer (SMI-5847 correcting dispatch.sh/README's earlier, wrong
        # assumption that it only lives under ~/.codex/sessions/).
        # FAKE_NO_AGENT_MESSAGE=1 simulates a run that exited 0 having
        # emitted only command_execution items (e.g. killed mid-turn, or
        # the SMI-5678 transform-failure class) — Wave 2 Step 3's
        # zero-agent_message downgrade.
        if [[ "${FAKE_NO_AGENT_MESSAGE:-0}" == "1" ]]; then
            echo '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}' > "$trace_dir/stdout.txt"
        else
            echo '{"type":"item.completed","item":{"type":"agent_message","text":"fake final answer"}}' > "$trace_dir/stdout.txt"
        fi

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
    : > "$FAKE_BF_CALL_LOG"
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
