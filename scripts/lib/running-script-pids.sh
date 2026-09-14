#!/bin/sh
# scripts/lib/running-script-pids.sh
# SMI-6614 (ADR-158, change 5c / R3-2): a shared helper for "is script X
# currently running", used by both scripts/regen-lockfile.sh (refuses while
# a host native repair is running) and scripts/retrieval-autoheal.sh's
# foreign_install_running() (defers while a lockfile refresh is running).
#
# A bare `pgrep -f <name>` matches ANY process whose argv contains that
# substring — an editor with the script path open, a `grep` invocation
# naming it, or a decoy process that merely mentions the path all match.
# This validates each candidate PID with `ps -o args= -p <pid>`:
#   1. argv[0]'s basename must be `sh` or `bash`.
#   2. The REST of the args string (everything after argv[0] and its
#      separating whitespace) must be the script invocation itself: it ends
#      with "/<name>" (a path ending in the script), EQUALS "<name>" (bare,
#      no further args), CONTAINS "/<name> " (a path, followed by more argv
#      elements), or STARTS WITH "<name> " (bare, followed by more argv
#      elements).
#
# Step 2 matches against the REST AS A WHOLE STRING via `case` glob
# patterns — never word-split. A word-split on IFS would misparse a script
# invoked from a directory whose path contains spaces (e.g. "sh /My
# Documents/scripts/regen-lockfile.sh" splitting into "/My", "Documents/...")
# and wrongly reject it. Only argv[0] itself is ever extracted as "the first
# token" (via `${var%% *}`), which is safe: a shell interpreter's own path
# (sh, bash, or /usr/bin/bash) never contains a space.
#
# [MEASURED 2026-09-14, macOS BSD ps]: `bash ./scripts/regen-lockfile.sh` and
# `bash regen-lockfile.sh` both matched; a `perl -e '$0="vim
# scripts/regen-lockfile.sh"; sleep 30'` decoy did not (argv[0] basename is
# `perl`, not `sh`/`bash`).
#
# Usage: running_script_pids <script-basename> [<script-basename> ...]
# Prints matching PIDs, one per line, to stdout. Excludes $$ (the caller's
# own PID) and $PPID (the caller's parent) so a caller never matches itself
# mid-invocation. `pgrep` and `ps` are each required — missing EITHER prints
# a one-line warning to stderr (symmetric: neither tool's absence is any
# quieter than the other's) and returns 1 with no output, so a caller
# checking only stdout still fails open exactly like the pre-existing
# pgrep-unavailable degrade path elsewhere in this repo.
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

running_script_pids() {
    if ! command -v pgrep >/dev/null 2>&1; then
        echo "running_script_pids: pgrep unavailable — cannot detect running scripts" >&2
        return 1
    fi
    if ! command -v ps >/dev/null 2>&1; then
        echo "running_script_pids: ps unavailable — cannot detect running scripts" >&2
        return 1
    fi

    _rsp_exclude1="$$"
    _rsp_exclude2="${PPID:-}"

    for _rsp_name in "$@"; do
        _rsp_candidates="$(pgrep -f "$_rsp_name" 2>/dev/null || true)"
        for _rsp_pid in $_rsp_candidates; do
            [ "$_rsp_pid" = "$_rsp_exclude1" ] && continue
            [ -n "$_rsp_exclude2" ] && [ "$_rsp_pid" = "$_rsp_exclude2" ] && continue
            _rsp_args="$(ps -o args= -p "$_rsp_pid" 2>/dev/null || true)"
            [ -n "$_rsp_args" ] || continue

            # argv[0] is safe to extract as "the first whitespace-delimited
            # token" — a shell interpreter's own path never contains a
            # space. `${var%% *}` removes the longest " *" suffix, i.e.
            # everything from the first space onward.
            _rsp_argv0="${_rsp_args%% *}"
            _rsp_argv0_base="$(basename "$_rsp_argv0")"
            case "$_rsp_argv0_base" in
                sh | bash) ;;
                *) continue ;;
            esac

            # Only reached when _rsp_args contained a space (else argv0 ==
            # the whole string and this "rest" extraction would be a no-op
            # duplicate of argv0 — which then fails every pattern below
            # anyway, correctly rejecting a bare interpreter with no script
            # argument at all).
            _rsp_rest="${_rsp_args#* }"
            case "$_rsp_rest" in
                *"/$_rsp_name") ;;
                "$_rsp_name") ;;
                *"/$_rsp_name "*) ;;
                "$_rsp_name "*) ;;
                *) continue ;;
            esac

            printf '%s\n' "$_rsp_pid"
        done
    done
    return 0
}
