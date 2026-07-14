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
# Usage: scripts/needle/dispatch.sh --workspace <dir> --title <title> --body-file <file> [--model gpt-5.6-sol] [--timeout 3600]

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

usage() {
    cat << EOF
Usage: $(basename "$0") --workspace <dir> --title <title> --body-file <file> [--model $DEFAULT_MODEL] [--timeout $DEFAULT_TIMEOUT]
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
  -h, --help             Show this help message and exit

Examples:
  $(basename "$0") --workspace .worktrees/smi-1234-thing --title "Draft README section" --body-file /tmp/prompt.txt
  $(basename "$0") --workspace .worktrees/smi-1234-thing --title "second opinion on auth design" --body-file /tmp/prompt.txt --model gpt-5.5 --timeout 1800

On a failed or unclassifiable outcome, this script exits non-zero and says
so in the result log — the queen re-dispatches the task through normal
Claude-tier routing rather than treating a Codex-dispatch failure as final
(see CLAUDE.md's Default Execution Model, Codex row).
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
    needle_error "--workspace does not exist or is not a directory: $WORKSPACE"
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

# ---- Ensure a bead-forge workspace exists ----
if [[ ! -d "$WORKSPACE/.beads" ]]; then
    bf init --workspace "$WORKSPACE" >/dev/null
fi

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

OUTCOME="failure"
if [[ -n "$OUTCOME_EVENT" ]]; then
    CLASSIFIED_OUTCOME="$(echo "$OUTCOME_EVENT" | jq -r '.data.outcome // "unknown"' 2>/dev/null || echo "unknown")"
    if [[ "$CLASSIFIED_OUTCOME" == "success" ]]; then
        OUTCOME="success"
    fi
fi

{
    echo "=== DISPATCH: $BEAD_ID ($(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown) UTC) ==="
    echo "workspace=$WORKSPACE model=$MODEL codex_version=$CODEX_VERSION"
    echo "needle_run_exit=$NEEDLE_EXIT bead_state=$BEAD_STATE outcome=$OUTCOME"
    echo "trace=$TRACE_PATH"
    if [[ "$OUTCOME" != "success" ]]; then
        echo "FAILED OR UNCLASSIFIABLE — re-dispatch through normal Claude-tier routing (Sonnet by default); do not treat this as the task's final outcome."
    fi
    echo ""
} >> "$LOG"

echo "[needle-dispatch] outcome=$OUTCOME bead_state=$BEAD_STATE"
echo "[needle-dispatch] trace: $TRACE_PATH"
echo "[needle-dispatch] log: $LOG"

if [[ "$OUTCOME" != "success" ]]; then
    exit 1
fi
