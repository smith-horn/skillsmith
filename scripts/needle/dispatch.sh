#!/usr/bin/env bash
#
# scripts/needle/dispatch.sh - Dispatch a single task to Codex via NEEDLE
#
# SMI-5668 (ADR-128 pilot: NEEDLE-based Codex dispatch). This is the queen's
# only mechanism for shelling out to a separately-authenticated `codex exec`
# process — Codex-tier tasks are never routed through Ruflo or the Agent/Task
# tool (those only spawn Claude-model subagents). See
# docs/internal/implementation/smi-5668-needle-codex-dispatch.md for the full
# design and
# docs/internal/adr/128-harness-of-harnesses-multi-cli-agent-orchestration.md
# for the architecture decision.
#
# One-time personal setup (maintainer-machine-only, never wired into CI — the
# binaries need interactive login / per-seat licensing / a from-source
# build): scripts/needle/README.md
#
# Bypasses NEEDLE's own `needle run` tmux-launch wrapper (buggy on macOS —
# see README) via the documented NEEDLE_INNER=1 direct-invocation form. This
# is the primary/only dispatch mechanism here — tmux is never invoked and is
# not a dependency of this script.
#
# Usage: scripts/needle/dispatch.sh --workspace <dir> --title <title> --body-file <file> [--model gpt-5.6-sol] [--timeout 3600] [--expect-write]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

DEFAULT_MODEL="gpt-5.6-sol"
DEFAULT_TIMEOUT=3600

WORKSPACE=""
TITLE=""
BODY_FILE=""
MODEL="$DEFAULT_MODEL"
TIMEOUT="$DEFAULT_TIMEOUT"
EXPECT_WRITE=false

usage() {
    cat << EOF
Usage: $(basename "$0") --workspace <dir> --title <title> --body-file <file> [--model $DEFAULT_MODEL] [--timeout $DEFAULT_TIMEOUT] [--expect-write]
       $(basename "$0") -h | --help

Dispatch a single task to Codex through NEEDLE + bead-forge, read-only
sandbox, never through Ruflo. See scripts/needle/README.md for the required
one-time personal setup (this fails cleanly with exit 2 if 'needle', 'bf',
'codex', or 'jq' are not installed).

Arguments:
  --workspace <dir>    Worktree/scratch directory Codex will be scoped to
                        (via 'cd {workspace}' in the adapter's invoke_template).
                        Must NOT be the skillsmith repo's own root/main checkout.
  --title <title>       Short bead title (passed to 'bf create --title').
  --body-file <file>    Path to a file containing the task prompt.

Options:
  --model <model>       Codex model to dispatch to (default: $DEFAULT_MODEL).
                         Allowed: $NEEDLE_ALLOWED_MODELS
  --timeout <secs>      Dispatch timeout in seconds (default: $DEFAULT_TIMEOUT).
  --expect-write         Signal that this dispatch is expected to produce a
                         real workspace change (not a pure analysis/review
                         prompt). When set, a dispatch that NEEDLE classifies
                         as "success" but that produced no workspace diff
                         (e.g. Codex's write was silently rejected by the
                         read-only sandbox) is downgraded to a non-success
                         outcome instead of being reported as a false win.
                         Omit for analysis-only prompts — see
                         scripts/needle/README.md's Troubleshooting section.
  -h, --help             Show this help message and exit

Examples:
  $(basename "$0") --workspace .worktrees/smi-1234-thing --title "Draft README section" --body-file /tmp/prompt.txt
  $(basename "$0") --workspace .worktrees/smi-1234-thing --title "second opinion on auth design" --body-file /tmp/prompt.txt --model gpt-5.5 --timeout 1800

dispatch.sh's terminal outcomes: 'success' is FINAL — consume the result,
never re-dispatch, even when the results log also carries an incidental
sandbox_write_rejected=yes note (that's expected steady-state under the
read-only sandbox, not a partial result; see scripts/needle/README.md's
Troubleshooting section). Every other outcome ('blocked-by-sandbox',
'no-diff-despite-expected-write', 'success-without-agent-message', or an
unclassifiable failure) exits non-zero and says so in the result log — the
queen re-dispatches the task through normal Claude-tier routing rather than
treating a Codex-dispatch failure as final (see CLAUDE.md's Default
Execution Model, Codex row). A pre-flight refusal (exit 2 — this
--workspace already holds stale open/in_progress beads, SMI-5847) is NOT a
dispatch failure: clear the stale beads ('bf close <id> --workspace <dir>')
or wait for a legitimately concurrent dispatch to finish, then retry the
identical dispatch rather than falling back to Claude-tier.
EOF
}

needle_error() {
    echo -e "\033[0;31mError: $1\033[0m" >&2
    exit 1
}

# ---- Arg parsing ----
while [[ $# -gt 0 ]]; do
    case "$1" in
        --workspace) WORKSPACE="${2:-}"; shift 2 ;;
        --title) TITLE="${2:-}"; shift 2 ;;
        --body-file) BODY_FILE="${2:-}"; shift 2 ;;
        --model) MODEL="${2:-}"; shift 2 ;;
        --timeout) TIMEOUT="${2:-}"; shift 2 ;;
        --expect-write) EXPECT_WRITE=true; shift ;;
        -h|--help) usage; exit 0 ;;
        *)
            needle_error "Unknown argument: $1

Run '$(basename "$0") --help' for usage information."
            ;;
    esac
done

if [[ -z "$WORKSPACE" ]]; then
    needle_error "Missing required argument: --workspace

Run '$(basename "$0") --help' for usage information."
fi
if [[ -z "$TITLE" ]]; then
    needle_error "Missing required argument: --title

Run '$(basename "$0") --help' for usage information."
fi
if [[ -z "$BODY_FILE" ]]; then
    needle_error "Missing required argument: --body-file

Run '$(basename "$0") --help' for usage information."
fi
if [[ ! -f "$BODY_FILE" ]]; then
    needle_error "--body-file does not exist: $BODY_FILE"
fi

check_binary needle
check_binary bf
check_binary codex
check_binary jq

# Resolve to an absolute, real path so the repo-root refusal check below
# cannot be bypassed by a relative path or a symlink.
RESOLVED_WORKSPACE="$(cd "$WORKSPACE" 2>/dev/null && pwd -P || true)"
if [[ -z "$RESOLVED_WORKSPACE" ]]; then
    needle_error "--workspace does not exist or is not a directory: $WORKSPACE (resolved from cwd: $PWD)

If \$WORKSPACE looks correct but this still fails, your shell's cwd has likely
drifted (e.g. from an earlier 'cd' into a submodule for 'gh pr create') --
'git -C' does not protect a relative --workspace argument from that. Pass an
absolute path, or 'cd' back to a known-good directory first."
fi
WORKSPACE="$RESOLVED_WORKSPACE"

# Refuse the skillsmith repo's own primary/main checkout specifically — not
# every worktree of it (a worktree IS the intended --workspace target; see
# CLAUDE.md's Codex dispatch paragraph). A linked worktree's `git-dir`
# resolves under the primary checkout's `.git/worktrees/<name>`, while its
# `git-common-dir` resolves to the primary checkout's own `.git` — those two
# are equal ONLY for the primary checkout itself, regardless of which
# worktree dispatch.sh is invoked from (an earlier draft compared
# `$WORKSPACE` against `$REPO_ROOT` — i.e. "wherever this script instance
# lives" — which wrongly refused the normal case of dispatching into the
# very worktree the script runs from, and, worse, wrongly ALLOWED a
# workspace that resolved to a *different* checkout's main root; caught via
# a live test against this repo's own main checkout during implementation).
if git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    WORKSPACE_GIT_DIR="$(git -C "$WORKSPACE" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
    WORKSPACE_GIT_COMMON_DIR="$(git -C "$WORKSPACE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [[ -n "$WORKSPACE_GIT_DIR" ]] && [[ "$WORKSPACE_GIT_DIR" == "$WORKSPACE_GIT_COMMON_DIR" ]]; then
        needle_error "Refusing to dispatch against a git repo's own primary/main checkout: $WORKSPACE

Codex dispatch must target a linked worktree or a non-repo scratch
directory, never a primary checkout — this is dispatch.sh's own backstop
against the 'needle init' cwd footgun documented in
scripts/needle/README.md. Pass a worktree path via --workspace instead,
e.g. .worktrees/<name>."
    fi
fi

if ! needle_model_allowed "$MODEL"; then
    needle_error "Unknown --model: $MODEL

Allowed models (see scripts/needle/README.md): $NEEDLE_ALLOWED_MODELS"
fi

RESULTS_DIR=$(needle_results_dir "$0")
LOG=$(needle_log_path "$RESULTS_DIR")
CODEX_VERSION="$(codex --version 2>/dev/null || echo 'unknown')"

echo "[needle-dispatch] workspace=$WORKSPACE model=$MODEL timeout=${TIMEOUT}s codex_version=$CODEX_VERSION"

# ---- SMI-5709: secret-scanner compatibility guard (needle_secret_scan_guard,
# lib.sh) -- `bf create` below runs its own secret scanner over --title and
# --description before this dispatch ever reaches Codex; this pre-check
# fails fast with actionable guidance instead of bf's own opaque error. See
# lib.sh for the full rationale (bf's heuristic, the allowlist interaction,
# and this guard's deliberate scope limits) and
# SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE=1 to bypass.
needle_secret_scan_guard "$TITLE" "$BODY_FILE"

# ---- Ensure a bead-forge workspace exists ----
if [[ ! -d "$WORKSPACE/.beads" ]]; then
    bf init --workspace "$WORKSPACE" >/dev/null
fi

# ---- SMI-5847: pre-flight stale-bead refusal (needle_stale_bead_preflight,
# lib.sh) -- a 'needle run' worker drains the ENTIRE ready queue for the
# workspace oldest-first, not just the bead about to be created, so stale
# open/in_progress beads get re-claimed and re-run at real Codex cost ahead
# of this dispatch's own bead. Must run after 'bf init' above (so a fresh
# workspace counts 0) and before 'bf create' below (or it would count the
# bead about to be created). See lib.sh for the full rationale and
# SKILLSMITH_NEEDLE_STALE_BEAD_GUARD_DISABLE=1 to bypass.
needle_stale_bead_preflight "$WORKSPACE" "$TIMEOUT"

# ---- Create the bead. bf create has no --body-file flag (a discrepancy
# from an earlier draft of the implementation doc, corrected here after
# checking `bf create --help` directly) — the prompt file's content goes in
# via --description. ----
BEAD_ID="$(bf create --title "$TITLE" --description "$(cat "$BODY_FILE")" --workspace "$WORKSPACE")"
if [[ -z "$BEAD_ID" ]]; then
    needle_error "bf create did not return a bead ID"
fi
echo "[needle-dispatch] bead=$BEAD_ID"

WORKER_ID="dispatch-$(date +%s 2>/dev/null || echo unknown)-$$"

# ---- Capture a pre-dispatch git-state baseline when --expect-write is set,
# so the post-dispatch diff check below (SMI-5700) is baseline-relative, not
# an absolute post-dispatch snapshot. A --workspace with pre-existing
# uncommitted changes is a legal target (dispatch.sh doesn't require a clean
# tree) — comparing only the post-dispatch state would reproduce the exact
# false-success bug this is fixing if a real dispatch failure lands on top
# of an already-dirty tree. --workspace may also legitimately be a non-git
# scratch directory (exercised by scripts/tests/needle-dispatch.test.sh,
# which uses /tmp) — the diff check is skipped entirely for those, not
# forced, so an unguarded git call here can't abort the script under
# set -euo pipefail. .beads/ is explicitly pathspec-excluded (':!.beads')
# rather than relied on being gitignored — this repo's own .gitignore has
# it, but an arbitrary --workspace target isn't guaranteed to, and without
# the explicit exclusion bead-forge's own trace-file bookkeeping would
# always register as "a change", defeating this check's whole purpose. ----
IS_GIT_WORKSPACE=false
if git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    IS_GIT_WORKSPACE=true
fi
BASELINE_GIT_STATE=""
if [[ "$EXPECT_WRITE" == true ]] && [[ "$IS_GIT_WORKSPACE" == true ]]; then
    BASELINE_GIT_STATE="$(git -C "$WORKSPACE" status --porcelain -- . ':!.beads'; git -C "$WORKSPACE" diff -- . ':!.beads')"
fi

# ---- Dispatch, backgrounded, as a real subprocess with an argument array
# (never a concatenated/eval'd string). An earlier draft ran this in the
# foreground and relied on a workspace-local .needle.yaml
# (worker.idle_action: exit) to make the worker exit once the one bead was
# done -- confirmed live during implementation that this does NOT work:
# `needle config --get worker.idle_action` errors with "unknown config
# key", and the worker instead enters the strands.knot exhaustion/backoff
# loop (a different subsystem, unrelated to idle_action/idle_timeout) once
# it runs out of beads, sleeping in ~60s increments indefinitely. This
# wrapper therefore owns the worker's lifecycle itself: poll for the bead's
# terminal telemetry event, then terminate the worker process directly,
# rather than trusting NEEDLE to exit on its own. ----
NEEDLE_INNER=1 needle run \
    --workspace "$WORKSPACE" \
    --agent codex \
    --count 1 \
    --identifier "$WORKER_ID" \
    --timeout "$TIMEOUT" &
NEEDLE_PID=$!

# ---- Poll for the bead's terminal outcome. NEEDLE's own outcome.classified
# telemetry event is authoritative — never infer status from this wrapper's
# own process exit code alone (confirmed in diligence: agent.completed
# exit_code=0 and outcome.classified outcome=success are separate,
# independently-emitted events). Poll budget = --timeout plus a fixed grace
# period for NEEDLE's own boot/teardown overhead (observed ~1-2s in
# testing). ----
POLL_DEADLINE=$(( $(date +%s 2>/dev/null || echo 0) + TIMEOUT + 60 ))
OUTCOME_EVENT=""
while [[ "$(date +%s 2>/dev/null || echo 0)" -lt "$POLL_DEADLINE" ]]; do
    # `needle logs` prints the literal line "No matching events found." to
    # stdout (not an empty string, not stderr) when nothing matches --
    # caught live during implementation: an earlier draft treated that
    # sentinel text as a found event (non-empty string), broke the loop on
    # the very first check, killed the worker mid-boot, and then crashed
    # trying to jq-parse the sentinel as JSON. A valid event line always
    # starts with '{'; anything else (the sentinel, a jq/needle error, an
    # empty read) is "not found yet".
    CANDIDATE="$(needle logs --format json --filter "bead_id=$BEAD_ID" --filter "event_type=outcome.classified" 2>/dev/null | tail -1)"
    if [[ "$CANDIDATE" == \{* ]]; then
        OUTCOME_EVENT="$CANDIDATE"
        break
    fi
    if ! kill -0 "$NEEDLE_PID" 2>/dev/null; then
        # Worker process already exited on its own (e.g. crashed before
        # classifying) -- stop polling, fall through to the failure path.
        break
    fi
    sleep 2
done

# The worker has done everything this dispatch needed it for — stop it
# rather than leaving it running in its idle/backoff loop. SIGTERM first,
# SIGKILL if it doesn't exit promptly.
if kill -0 "$NEEDLE_PID" 2>/dev/null; then
    kill -TERM "$NEEDLE_PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$NEEDLE_PID" 2>/dev/null; then
        kill -KILL "$NEEDLE_PID" 2>/dev/null || true
    fi
fi
set +e
wait "$NEEDLE_PID" 2>/dev/null
NEEDLE_EXIT=$?
set -e

BEAD_STATE="$(bf show "$BEAD_ID" --format json --workspace "$WORKSPACE" 2>/dev/null | jq -r '.[0].status // "unknown"' 2>/dev/null || echo "unknown")"
TRACE_PATH="$(needle_bead_trace_path "$WORKSPACE" "$BEAD_ID")"
# TRACE_DIR/STDOUT_PATH are computed unconditionally (not only on the
# success path) -- Step 1 below now needs TRACE_DIR/stderr.txt regardless
# of the current OUTCOME (SANDBOX_WRITE_REJECTED is an audit field, not
# itself a downgrade), and Step 3 needs STDOUT_PATH. stdout.txt is where
# the dispatched agent's final answer actually lives (SMI-5847 correcting
# README's earlier, wrong ~/.codex/sessions/ pointer) -- trace.jsonl
# structurally cannot contain it (tool_call/tool_result/tokens events only).
TRACE_DIR="$(dirname "$TRACE_PATH")"
STDOUT_PATH="$TRACE_DIR/stdout.txt"

OUTCOME="failure"
if [[ -n "$OUTCOME_EVENT" ]]; then
    CLASSIFIED_OUTCOME="$(echo "$OUTCOME_EVENT" | jq -r '.data.outcome // "unknown"' 2>/dev/null || echo "unknown")"
    if [[ "$CLASSIFIED_OUTCOME" == "success" ]]; then
        OUTCOME="success"
    fi
fi

# ---- SMI-5700 (steps 1-2) / SMI-5847 (step 3): NEEDLE's outcome.classified
# is based purely on the dispatched agent process's exit code — it does not
# verify a work product actually exists. Three independent downgrade checks
# below catch the false-success case confirmed via bead bf-1aj's trace
# evidence (Codex's write rejected by the read-only sandbox; Codex exited 0
# anyway; NEEDLE correctly but insufficiently classified that as "success").
# All three checks only ever downgrade an already-"success" outcome — a
# real "failure" from NEEDLE is never overridden back to success. ----

# Step 1: sandbox-rejection stderr signature. SANDBOX_WRITE_REJECTED is an
# independent AUDIT field, always recorded whenever the signature is
# present in stderr.txt -- it is not itself an outcome downgrade. Gated on
# stderr.txt's own existence, not trace.jsonl's (dirname needs no file to
# exist — gating on the wrong file would silently skip this check on a bead
# that wrote stderr.txt but not trace.jsonl for any reason).
#
# SMI-5847: this used to downgrade any "success" outcome unconditionally
# ("a rejected write is suspicious even on an analysis-only dispatch" — now
# FALSIFIED). Under the 'pluck' prompt template's notes/<bead>.md write +
# the permanently read-only sandbox (codex-adapter.yaml, ADR-128 rule 2), a
# rejected write is the EXPECTED steady state on every dispatch that never
# asked for one, not a signal that anything went wrong. The downgrade to
# 'blocked-by-sandbox' below therefore only fires when the caller actually
# signaled a write was required via --expect-write; an analysis-only run
# that hits this same signature stays "success" (see the log-block note
# below) — do not re-dispatch it.
SANDBOX_WRITE_REJECTED=no
if [[ -f "$TRACE_DIR/stderr.txt" ]] && grep -qF "patch rejected:" "$TRACE_DIR/stderr.txt" 2>/dev/null; then
    SANDBOX_WRITE_REJECTED=yes
    if [[ "$EXPECT_WRITE" == true ]] && [[ "$OUTCOME" == "success" ]]; then
        OUTCOME="blocked-by-sandbox"
    fi
fi

# Step 2: workspace-diff check, only when the caller signaled a write was
# expected via --expect-write (an analysis-only dispatch producing no diff
# is expected, not suspicious). Non-git workspaces fall through untouched —
# whatever step 1 already determined stands.
if [[ "$OUTCOME" == "success" ]] && [[ "$EXPECT_WRITE" == true ]] && [[ "$IS_GIT_WORKSPACE" == true ]]; then
    CURRENT_GIT_STATE="$(git -C "$WORKSPACE" status --porcelain -- . ':!.beads'; git -C "$WORKSPACE" diff -- . ':!.beads')"
    if [[ "$CURRENT_GIT_STATE" == "$BASELINE_GIT_STATE" ]]; then
        OUTCOME="no-diff-despite-expected-write"
    fi
fi

# Step 3 (SMI-5847): zero-agent_message downgrade. Steps 1/2 above (and
# NEEDLE's own outcome.classified event) only ever prove the Codex process
# exited 0, or that a real diff landed -- none of them prove the agent
# actually said anything readable. A 'codex exec' that exited 0 having
# emitted only command_execution items (e.g. killed mid-turn, or the
# SMI-5678 transform-failure class) would otherwise silently report success
# with nothing for the operator to consume. Extraction failure (missing or
# corrupt stdout.txt) must never flip OUTCOME or the exit code by itself --
# the trailing '|| true' inside the substitution guarantees ANSWER_CHARS is
# always a plain digit string (defaulting to "0"), the same non-override
# invariant as steps 1/2: this can only ever push an already-"success" run
# to a new failure label, never the reverse.
ANSWER_CHARS="$(jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' \
    "$STDOUT_PATH" 2>/dev/null | wc -c | tr -dc '0-9' || true)"
ANSWER_CHARS="${ANSWER_CHARS:-0}"
if [[ "$OUTCOME" == "success" ]] && [[ "$ANSWER_CHARS" -eq 0 ]]; then
    OUTCOME="success-without-agent-message"
fi

# ---- SMI-5847: close the bead unconditionally on every terminal path
# (including the poll-deadline-expiry failure path above) -- once OUTCOME
# is final (all downgrades above have run) but before the log block, so the
# log's bead_closed= field reflects the real result. Leaving a bead open
# guarantees a paid Codex re-run of work nobody will ever consume: a
# non-success dispatch already tells the queen to re-route to Claude-tier
# (see usage()'s epilogue), so nothing downstream reads this bead's result
# either way. 'bf close' is idempotent (a future SMI-5701 agent-side close
# is therefore harmless) and NOT trusted by exit code alone (re-read via
# 'bf show', SMI-5569 class) -- see needle_close_bead() in lib.sh.
BEAD_CLOSED="$(needle_close_bead "$BEAD_ID" "$OUTCOME" "$WORKSPACE")"
if [[ "$BEAD_CLOSED" != "yes" ]]; then
    echo "[needle-dispatch] WARNING: bead $BEAD_ID is NOT closed — it stays claimable and WILL be re-run (and re-billed) by the next dispatch into this workspace after the 30-minute claim TTL. Close it manually: bf close $BEAD_ID --workspace $WORKSPACE" >&2
fi

# INCIDENTAL_NOTE is non-empty only when a rejected write was incidental to
# an otherwise-successful analysis-only dispatch — used both in the log
# block below and in the final stdout summary line.
INCIDENTAL_NOTE=""
if [[ "$OUTCOME" == "success" ]] && [[ "$SANDBOX_WRITE_REJECTED" == "yes" ]]; then
    INCIDENTAL_NOTE=yes
fi

{
    echo "=== DISPATCH: $BEAD_ID ($(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) UTC) ==="
    echo "workspace=$WORKSPACE model=$MODEL codex_version=$CODEX_VERSION"
    echo "needle_run_exit=$NEEDLE_EXIT bead_state=$BEAD_STATE bead_closed=$BEAD_CLOSED outcome=$OUTCOME expect_write=$EXPECT_WRITE sandbox_write_rejected=$SANDBOX_WRITE_REJECTED"
    echo "trace=$TRACE_PATH"
    echo "stdout=$STDOUT_PATH"
    case "$OUTCOME" in
        success)
            if [[ "$SANDBOX_WRITE_REJECTED" == "yes" ]]; then
                echo "NOTE: an incidental write was rejected by the read-only sandbox (\`patch rejected:\` in the trace), but --expect-write was not set — no write was required for this dispatch to succeed. This is a complete, successful result; do not re-dispatch. See scripts/needle/README.md's Troubleshooting section."
            fi
            ;;
        blocked-by-sandbox)
            echo "CODEX WRITE BLOCKED BY READ-ONLY SANDBOX — NEEDLE reported outcome=success but the trace shows a rejected write, and --expect-write was set (see scripts/needle/README.md's Troubleshooting section). Re-dispatch through normal Claude-tier routing; do not treat this as the task's final outcome." ;;
        no-diff-despite-expected-write)
            echo "NO WORKSPACE CHANGE DESPITE --expect-write — NEEDLE reported outcome=success but the workspace shows no diff since dispatch started (see scripts/needle/README.md's Troubleshooting section). Re-dispatch through normal Claude-tier routing; do not treat this as the task's final outcome." ;;
        success-without-agent-message)
            echo "CODEX EXITED SUCCESSFULLY BUT stdout.txt HAS NO agent_message — nothing readable was produced (killed mid-turn, a transform failure, or similar; see scripts/needle/README.md's Troubleshooting section). Re-dispatch through normal Claude-tier routing; do not treat this as the task's final outcome." ;;
        *)
            echo "FAILED OR UNCLASSIFIABLE — re-dispatch through normal Claude-tier routing (Sonnet by default); do not treat this as the task's final outcome." ;;
    esac
    echo ""
} >> "$LOG"

echo "[needle-dispatch] outcome=$OUTCOME bead_state=$BEAD_STATE${INCIDENTAL_NOTE:+ note=incidental-write-rejected}"
echo "[needle-dispatch] trace: $TRACE_PATH"
echo "[needle-dispatch] stdout: $STDOUT_PATH"
echo "[needle-dispatch] log: $LOG"

if [[ "$OUTCOME" != "success" ]]; then
    exit 1
fi
