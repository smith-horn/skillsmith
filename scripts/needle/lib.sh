#!/usr/bin/env bash
# scripts/needle/lib.sh — NEEDLE-specific helpers for scripts/needle/dispatch.sh.
# SMI-5668 (ADR-128 pilot: NEEDLE-based Codex dispatch).
#
# Sources scripts/agent-evals/lib.sh for check_binary rather than duplicating
# it. Bash (not POSIX sh, unlike agent-evals/lib.sh) because dispatch.sh
# itself needs bash's [[ ]]/BASH_SOURCE for its create-worktree.sh-style
# flag parsing — see docs/internal/implementation/smi-5668-needle-codex-dispatch.md § 4.

set -euo pipefail

NEEDLE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../agent-evals/lib.sh
source "$NEEDLE_LIB_DIR/../agent-evals/lib.sh"

# NEEDLE_ALLOWED_MODELS — the Codex models confirmed present in
# ~/.codex/models_cache.json at diligence time (see this doc's § Surface
# Grounding). An explicit allowlist, not passed through unchecked: {model}
# flows into a shell-interpreted invoke_template (codex-adapter.yaml), so an
# unvalidated value reaching it would be a command-injection surface.
NEEDLE_ALLOWED_MODELS="gpt-5.6-sol gpt-5.5 gpt-5.6-luna gpt-5.6-terra"

# needle_model_allowed MODEL — returns 0 if MODEL is in the allowlist above,
# 1 otherwise.
needle_model_allowed() {
  local model="$1" allowed
  for allowed in $NEEDLE_ALLOWED_MODELS; do
    if [[ "$model" == "$allowed" ]]; then
      return 0
    fi
  done
  return 1
}

# needle_results_dir SCRIPT_PATH — print (and ensure) scripts/needle/results/
# next to the calling script, mirroring agent_eval_results_dir's convention
# (results/*.log are gitignored via the repo's blanket *.log rule).
#
# SKILLSMITH_NEEDLE_RESULTS_DIR is a TEST SEAM, not a guard — do not
# register it in docs/internal/process/guards-and-opt-outs.md. It exists so
# scripts/tests/needle-dispatch.test.sh can redirect every fake dispatch's
# results-log write into a scratch directory instead of the operator's real
# scripts/needle/results/ log (SMI-5847: the pre-fix test wrote 12 fake
# rows into that real log, including fabricated "outcome=success
# bead_state=done" lines that masked a 100% real-dispatch orphan rate for
# days).
needle_results_dir() {
  local script_dir results_dir
  results_dir="${SKILLSMITH_NEEDLE_RESULTS_DIR:-}"
  if [[ -z "$results_dir" ]]; then
    script_dir=$(CDPATH="" cd -- "$(dirname -- "$1")" && pwd)
    results_dir="$script_dir/results"
  fi
  mkdir -p "$results_dir"
  echo "$results_dir"
}

# needle_log_path RESULTS_DIR — print today's dispatch summary log path.
needle_log_path() {
  local log_date
  log_date=$(date +%Y-%m-%d 2>/dev/null || echo "unknown-date")
  echo "$1/codex-$log_date.log"
}

# needle_bead_trace_path WORKSPACE BEAD_ID — print the path to NEEDLE's own
# per-bead trace file. Not guaranteed to exist — caller checks before
# reading it.
needle_bead_trace_path() {
  echo "$1/.beads/traces/$2/trace.jsonl"
}

# needle_count_beads STATUS WORKSPACE — print a bead count for STATUS in
# WORKSPACE (SMI-5847 pre-flight stale-bead guard). Uses 'bf count', never
# 'bf list --format json': the latter is JSONL with no array wrapper
# ('jq -r .[]' fails, exit 5, per live verification) and dumps the full
# multi-KB prompt body as 'description' for every matching bead.
#
# Two 'set -euo pipefail' hazards, both verified live and both handled
# here: (1) 'X="$(cmd)"' inherits cmd's own exit status, so a bare 'bf
# count' failure (e.g. a not-yet-'bf init'-ed workspace) would otherwise
# abort the caller under set -e — the trailing '|| true' absorbs that;
# (2) '[[ "abc" -gt 0 ]]' dies with "bash: abc: unbound variable" under
# set -u if $n ever ended up empty — '${n:-0}' guarantees a numeric string.
#
# Fail-open hazard: 'bf count --status bogus' returns "0" and exits 0 (a
# typo'd status literal silently reports "clean", not an error). Only pass
# a verified literal: open, in_progress, closed (confirmed live against
# 'bf show --format json's own .status values).
needle_count_beads() {
  local n
  n="$(bf count --status "$1" --workspace "$2" 2>/dev/null | tr -dc '0-9' || true)"
  echo "${n:-0}"
}

# needle_close_bead BEAD_ID OUTCOME WORKSPACE — close BEAD_ID via 'bf
# close', recording OUTCOME in the close reason, then re-read via 'bf show'
# to confirm (never trust 'bf close's own exit code alone — SMI-5569 class:
# a silent no-op close would otherwise pass invisibly). Prints "yes" or
# "no" on stdout depending on whether the bead is now actually closed; the
# caller (scripts/needle/dispatch.sh) is responsible for surfacing a loud
# warning on "no" — this helper only reports the fact.
#
# The 'bf close ... || true' is load-bearing: under set -euo pipefail, a
# bare 'bf close' failure (e.g. an already-deleted bead, or any other 'bf'
# error) would abort THIS script *after* the caller's outcome has already
# been computed but *before* its results-log line is written — the
# dispatch would vanish from the record entirely and this script would
# exit 1, which the queen reads as "re-dispatch". That is strictly worse
# than the orphaning bug this function exists to fix, so a close failure
# must never propagate — it only ever downgrades BEAD_CLOSED to "no".
#
# Verified live: 'bf close' on an already-closed bead exits 0 (idempotent —
# load-bearing for SMI-5701 forward-compatibility, see the implementation
# doc); 'bf close' on an unknown ID exits 1 with "Error: Bead not found".
needle_close_bead() {
  local bead_id="$1" outcome="$2" workspace="$3" status
  bf close "$bead_id" --reason "dispatch.sh: outcome=$outcome" --workspace "$workspace" >/dev/null 2>&1 || true
  status="$(bf show "$bead_id" --format json --workspace "$workspace" 2>/dev/null | jq -r '.[0].status // "unknown"' 2>/dev/null || echo unknown)"
  if [[ "$status" == "closed" ]]; then
    echo "yes"
  else
    echo "no"
  fi
}

# ---- SMI-5709: secret-scanner compatibility guard ----
#
# `bf create` (invoked by dispatch.sh) runs its own secret scanner over
# --title and --description before a dispatch ever reaches Codex. That
# scanner has a generic heuristic — labeled "Azure Key" in its own output,
# confirmed via `strings $(which bf)` in a prior investigation — that flags
# any unbroken run of 44+ characters from [A-Za-z0-9/_-]. Ordinary long
# file/worktree paths in a title or prompt body trip this constantly; it
# has nothing to do with real secrets. Left unguarded, that surfaces as an
# opaque "secret detected: ... [Azure Key]" failure deep inside `bf
# create`, after dispatch.sh has already committed to the dispatch. This
# function scans the exact raw bytes that will be passed to `bf create` and
# fails fast, before any `bf`/`codex` process is touched, with actionable
# guidance instead of bf's own opaque error.
#
# The character class ([A-Za-z0-9/_-]) intentionally reproduces bf's own
# broad heuristic exactly, as confirmed against the actual compiled rule in
# a prior investigation — this is deliberately NOT a smarter/narrower
# filter. Do not "improve" this into a tighter pattern later; that would
# desync this guard from what bf actually rejects and defeat the entire
# point of a compatibility pre-check.
#
# Matching runs in grep's default per-line mode only, never a
# multiline/slurp mode — a match must never be allowed to span a newline
# (44 path-safe characters split across two lines are two separate short
# runs in the real content, not one long one that should trip anything).
#
# Separate, related fact (also from a prior investigation, not re-verified
# here): bf additionally supports a `secret_protection.allowlist` key in a
# workspace's `.beads/config.yaml`, and — as observed behavior against the
# bf version in use at the time of that investigation, not an unconditional
# guarantee for every future bf release — the scanner consults it with
# substring-match semantics against the *entire* scanned field's content:
# a pattern anchored at both ends (^...$) can only match a field whose
# entire content equals the pattern; a pattern anchored at only one end can
# only match at that corresponding boundary; an unanchored pattern must
# match text embedded anywhere within a longer field.
#
# IMPORTANT: this guard has no knowledge of that allowlist — it is a pure
# compatibility pre-check and cannot tell whether bf would actually accept
# a given match. Allowlisting a pattern in bf's own config does NOT get you
# past THIS guard; use SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE=1 for that
# (see docs/internal/process/guards-and-opt-outs.md). Note bf's own
# scanner still runs after this guard is skipped, so the allowlist entry is
# still required for the dispatch to actually succeed end-to-end.
#
# Scope note: this pattern is verified against ordinary long file/worktree
# paths (its actual purpose) — it has not been verified against bf's real
# rule for base64-shaped secrets (which may include `+`/`=`, outside this
# class), so a real base64 credential could in principle still slip past
# this guard and hit bf's own rejection instead. That's an acceptable gap:
# this guard exists to fail fast on the common path-false-positive case,
# not to be a complete re-implementation of bf's scanner.
#
# needle_secret_scan_guard TITLE BODY_FILE — calls needle_error() (defined
# by dispatch.sh, the only caller) and exits 1 on a match; a caller wanting
# a different failure mode would need its own needle_error.
needle_secret_scan_guard() {
  local title="$1" body_file="$2"

  if [[ "${SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE:-0}" == "1" ]]; then
    echo "[needle-dispatch] WARNING: SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE=1 — skipping the SMI-5709 secret-scanner compatibility guard. bf's own scanner still runs on 'bf create' below and may still reject this dispatch." >&2
    return 0
  fi

  local pattern='[A-Za-z0-9/_-]{44,}'
  local findings=() entry field lineinfo m rest head tail redacted
  local report="" shown=0 total

  while IFS= read -r m; do
    [[ -z "$m" ]] && continue
    findings+=("title||$m")
  done < <(printf '%s\n' "$title" | grep -oE "$pattern" || true)

  local line_match lineno
  while IFS= read -r line_match; do
    [[ -z "$line_match" ]] && continue
    lineno="${line_match%%:*}"
    m="${line_match#*:}"
    findings+=("body|$lineno|$m")
  done < <(grep -n -oE "$pattern" "$body_file" || true)

  total=${#findings[@]}
  if [[ "$total" -eq 0 ]]; then
    return 0
  fi

  for entry in "${findings[@]}"; do
    shown=$((shown + 1))
    if [[ $shown -gt 5 ]]; then
      continue
    fi
    field="${entry%%|*}"
    rest="${entry#*|}"
    lineinfo="${rest%%|*}"
    m="${rest#*|}"
    head="${m:0:10}"
    tail="${m: -4}"
    redacted="${head}…${tail}"
    if [[ "$field" == "body" ]]; then
      report+="  - body (line $lineinfo): $redacted (${#m} chars)"$'\n'
    else
      report+="  - title: $redacted (${#m} chars)"$'\n'
    fi
  done
  if [[ "$total" -gt 5 ]]; then
    report+="  ... and $((total - 5)) more match(es) not shown"$'\n'
  fi

  needle_error "Title/body contains $total unbroken run(s) of 44+ characters from [A-Za-z0-9/_-] — bf create's own secret scanner will very likely reject this dispatch with a 'secret detected: ... [Azure Key]' error before Codex is ever invoked.

$report
Most matches like this are ordinary long file/worktree paths, not real
secrets — but this guard (matching bf's own heuristic on purpose) can't
tell the difference, and neither can bf. Fix: state any long directory
prefix ONCE in prose (e.g. 'files under scripts/needle/') and refer to
bare filenames afterward instead of repeating a full path in every
reference."
}

# ---- SMI-5847: pre-flight stale-bead refusal. A 'needle run' worker
# drains the ENTIRE ready queue for the workspace oldest-first, not just
# the bead a dispatch is about to create (see README's "Known behavior"
# section) -- a workspace already holding open/in_progress beads from an
# earlier interrupted or orphaned dispatch gets re-claimed and re-run at
# real Codex cost, ahead of this dispatch's own bead, and eats this
# dispatch's own poll budget before its own bead is even touched. Caller
# (dispatch.sh) must call this after 'bf init' (so a fresh workspace counts
# 0) and before 'bf create' (or it would count the bead about to be
# created).
#
# Uses needle_count_beads() above, never 'bf list --format json', which is
# JSONL with no array wrapper ('jq -r .[]' fails, exit 5) and dumps the
# full multi-KB prompt body as 'description'.
#
# Refuses with exit 2, not 1: exit 1 means "dispatched and failed -- the
# queen re-routes to Claude-tier" (see dispatch.sh's usage() epilogue); a
# pre-flight refusal means "nothing was dispatched, clean the workspace and
# retry" and must never trigger a Claude re-dispatch.
#
# bf's claim_ttl_minutes (30) is shorter than dispatch.sh's own
# DEFAULT_TIMEOUT (3600s), so a legitimately long-running CONCURRENT
# dispatch into the same workspace can also trip this guard, not only a
# genuinely-stale leftover -- the message below names both causes so the
# operator doesn't reach for the opt-out when the real fix is "wait for the
# other dispatch". No-op on a workspace with no stale beads (including a
# brand-new .beads/ just created by 'bf init').
#
# needle_stale_bead_preflight WORKSPACE TIMEOUT — exits 2 directly (this
# is sourced into dispatch.sh's own shell, so exiting from here exits the
# whole script) when stale beads are found and the guard isn't disabled.
needle_stale_bead_preflight() {
  local workspace="$1" timeout="$2"

  if [[ "${SKILLSMITH_NEEDLE_STALE_BEAD_GUARD_DISABLE:-0}" == "1" ]]; then
    echo "[needle-dispatch] WARNING: SKILLSMITH_NEEDLE_STALE_BEAD_GUARD_DISABLE=1 -- skipping the SMI-5847 stale-bead pre-flight guard. Any open/in_progress beads already in this workspace will be drained by this dispatch's worker ahead of the bead it's about to create." >&2
    return 0
  fi

  local stale_open_count stale_in_progress_count stale_total
  stale_open_count="$(needle_count_beads open "$workspace")"
  stale_in_progress_count="$(needle_count_beads in_progress "$workspace")"
  stale_total=$((stale_open_count + stale_in_progress_count))
  if [[ "$stale_total" -gt 0 ]]; then
    # Show up to 5 stale beads (id/status/created-timestamp only -- never
    # 'description', which is the full prompt body), same truncation
    # precedent as the SMI-5709 secret-scan guard above.
    local stale_report="" stale_shown=0 stale_id stale_status stale_created
    while IFS=$'\t' read -r stale_id stale_status stale_created; do
      [[ -z "$stale_id" ]] && continue
      stale_shown=$((stale_shown + 1))
      if [[ "$stale_shown" -gt 5 ]]; then
        continue
      fi
      stale_report+="  - $stale_id status=$stale_status created=$stale_created"$'\n'
    done < <( { bf list --status open --workspace "$workspace" --format json --limit 5 2>/dev/null
                bf list --status in_progress --workspace "$workspace" --format json --limit 5 2>/dev/null
              } | jq -r '[.id, .status, .created_at] | @tsv' 2>/dev/null || true )
    if [[ "$stale_total" -gt 5 ]]; then
      stale_report+="  ... and $((stale_total - 5)) more not shown"$'\n'
    fi
    echo -e "\033[0;31mError: Refusing to dispatch -- --workspace already holds $stale_total open/in_progress bead(s) ($stale_open_count open, $stale_in_progress_count in_progress):

$stale_report
A 'needle run' worker drains the ENTIRE ready queue for this workspace, not
just the bead this dispatch is about to create -- these will be re-claimed
and re-run at real Codex cost ahead of (and eating the poll budget of) your
own bead. This is either (a) leftover orphans from an earlier interrupted
or crashed dispatch -- close them with 'bf close <id> --workspace $workspace'
and retry -- or (b) a dispatch that is still legitimately running
concurrently into this same workspace (bf's claim_ttl_minutes is 30,
shorter than this script's own ${timeout}s timeout, so a long dispatch's
own claim can expire mid-flight and look stale here) -- wait for it to
finish, then retry. To dispatch anyway (draining the stale beads first, at
their cost), set SKILLSMITH_NEEDLE_STALE_BEAD_GUARD_DISABLE=1.\033[0m" >&2
    exit 2
  fi
}
