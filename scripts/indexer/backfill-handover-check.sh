#!/usr/bin/env bash
# SMI-7112 (A1): GO/NO-GO helper for handing the backfill dispatcher role from the
# local rollout driver to indexer-backfill-autochain.yml. Exactly ONE dispatcher is
# live per period; this proves nothing from the retiring period can span the swap.
#
# Prints per-check lines, then exactly `GO` (exit 0) or `NO-GO` (exit 1). ANY API
# error is NO-GO -- an unread state is never "clear". It checks:
#   (a) every dispatch intent in the driver's intent log is resolved to a
#       `completed` run, or marked `reconciled_absent`;
#   (b) for BOTH indexer-backfill.yml AND indexer-backfill-autochain.yml, the
#       Actions API reports total_count 0 for each of queued, in_progress,
#       waiting, pending and requested (10 calls);
#   (c) every autochain run created at or after the last intent's completion (the
#       moment a `workflow_run` would have fired) is `completed`.
#
# Usage:
#   scripts/indexer/backfill-handover-check.sh               # checks only
#   scripts/indexer/backfill-handover-check.sh --first-link  # re-check, then dispatch
#
# Procedure (runbook): stop the driver between dispatches; wait N minutes (the
# larger of 15 and 3x the Actions list lag); run this -> GO; then
#   gh variable set BACKFILL_AUTOCHAIN_DISABLE --body 0 --repo <repo>   (never delete)
# then run this again with --first-link. --first-link repeats (a)-(c) and ONLY on GO
# immediately dispatches the first link (resume_from=latest, the driver's last
# path_prefix and cap, a new drv- token logged as an intent BEFORE the dispatch),
# resolves it by token and prints its run id. It does not touch the variable.
#
# Env: BACKFILL_REPO, BACKFILL_DRIVER_INTENTS (same defaults as the driver);
# BACKFILL_MAX_RANGES / _MAX_SKILLS_PER_REPO / _MAX_ELAPSED_MIN / _MIN_SIZE_BYTES.
# TEST SEAM: SKILLSMITH_BACKFILL_DRIVER_TEST=<dir> fakes the clock and sleep and
# redirects the intent log to <dir>/intents.jsonl (see the driver); `gh` is whatever
# is first on PATH. Requires gh and node.
set -uo pipefail

FIRST_LINK=0
case "${1:-}" in
  "") ;;
  --first-link) FIRST_LINK=1 ;;
  *) echo "usage: $(basename "$0") [--first-link]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="${SKILLSMITH_BACKFILL_DRIVER_TEST:-}"
REPO="${BACKFILL_REPO:-smith-horn/skillsmith}"
if [ -n "$TEST_DIR" ]; then
  [ -d "$TEST_DIR" ] && [ -f "$TEST_DIR/clock" ] || { echo "error: test seam needs $TEST_DIR/clock" >&2; exit 2; }
  INTENTS="$TEST_DIR/intents.jsonl"
else
  INTENTS="${BACKFILL_DRIVER_INTENTS:-$HOME/.skillsmith/logs/backfill-driver-intents.jsonl}"
fi
say(){ echo "[$(date -u '+%F %H:%M:%SZ')] $*"; }
# shellcheck source=scripts/indexer/backfill-intents.lib.sh
. "$ROOT/scripts/indexer/backfill-intents.lib.sh"

NOGO=0; LAST_DONE=""; LAST_PARAMS="{}"
nogo(){ say "  NO-GO: $*"; NOGO=1; }
# One small JSON helper (node) so no jq is needed. Subcommands read stdin or a file.
js(){ node -e '
const fs=require("fs"),[cmd,a1]=process.argv.slice(1);
const read=()=>{try{return JSON.parse(fs.readFileSync(0,"utf8"))}catch(e){return null}};
if(cmd==="log"){ // path -> "token state run_id issued_at" per intent, in log order
  const ev=[];for(const l of fs.readFileSync(a1,"utf8").split("\n")){if(!l.trim())continue;try{ev.push(JSON.parse(l))}catch(e){console.log("BAD_LINE");process.exit(0)}}
  const o=[];const by=new Map();
  for(const e of ev){ if(e.event==="intent"){by.set(e.token,{t:e.token,s:"open",r:"-",i:e.issued_at,p:e.params||{}});o.push(e.token)}
    else if(e.event==="resolved"&&by.has(e.token)){const x=by.get(e.token);x.s="resolved";x.r=e.run_id}
    else if(e.event==="reconciled_absent"&&by.has(e.token)){const x=by.get(e.token);if(x.s==="open")x.s="absent"} }
  for(const t of o){const x=by.get(t);console.log([x.t,x.s,x.r,x.i,JSON.stringify(x.p)].join("\t"))}
} else if(cmd==="total"){const j=read();console.log(j&&Number.isInteger(j.total_count)?j.total_count:"ERR")}
else if(cmd==="run"){const j=read();console.log(j&&j.status?[j.status,j.updated_at].join(" "):"ERR")}
else if(cmd==="after"){const j=read();if(!j||!Array.isArray(j.workflow_runs)){console.log("ERR")}else{const bad=j.workflow_runs.filter(r=>String(r.created_at)>=a1&&r.status!=="completed");console.log(bad.length?"OPEN "+bad.map(r=>r.id+":"+r.status).join(","):"CLEAR")}}
' "$@"; }

run_checks() {
  NOGO=0; LAST_DONE=""; LAST_PARAMS="{}"
  say "(a) dispatch intents in $INTENTS"
  if [ ! -f "$INTENTS" ]; then
    say "  no intent log (the driver never dispatched under SMI-7112 hardening): nothing to resolve"
  else
    local rows
    rows=$(js log "$INTENTS") || rows="BAD_LINE"
    if [ "$rows" = "BAD_LINE" ]; then nogo "the intent log has an unparseable line"; rows=""; fi
    local tok st rid iss par
    while IFS=$'\t' read -r tok st rid iss par; do
      [ -z "$tok" ] && continue
      LAST_PARAMS="$par"; LAST_DONE="$iss"
      case "$st" in
        open) nogo "intent $tok is UNRESOLVED (no run matched it, none marked reconciled_absent)" ;;
        absent) say "  $tok reconciled_absent" ;;
        resolved)
          local rj rs
          if ! rj=$(gh api "repos/$REPO/actions/runs/$rid" 2>/dev/null); then nogo "cannot read run $rid for intent $tok (API error)"; continue; fi
          rs=$(printf '%s' "$rj" | js run)
          if [ "$rs" = "ERR" ]; then nogo "run $rid for intent $tok returned an unreadable body"; continue; fi
          if [ "${rs%% *}" != "completed" ]; then nogo "run $rid for intent $tok is '${rs%% *}', not completed"; else say "  $tok -> run $rid completed"; LAST_DONE="${rs#* }"; fi ;;
      esac
    done <<< "$rows"
  fi

  say "(b) non-terminal runs, both workflows x 5 statuses"
  local wf s tj tc
  for wf in indexer-backfill.yml indexer-backfill-autochain.yml; do
    for s in queued in_progress waiting pending requested; do
      if ! tj=$(gh api "repos/$REPO/actions/workflows/$wf/runs?status=$s&per_page=1" 2>/dev/null); then nogo "API error reading $wf status=$s"; continue; fi
      tc=$(printf '%s' "$tj" | js total)
      if [ "$tc" = "ERR" ]; then nogo "$wf status=$s returned an unreadable body"
      elif [ "$tc" != "0" ]; then nogo "$wf has $tc run(s) in status '$s'"; fi
    done
  done

  say "(c) autochain runs created at/after the last completion (${LAST_DONE:-none})"
  local aj ar
  if ! aj=$(gh api "repos/$REPO/actions/workflows/indexer-backfill-autochain.yml/runs?per_page=100" 2>/dev/null); then
    nogo "API error listing autochain runs"
  else
    ar=$(printf '%s' "$aj" | js after "${LAST_DONE:-0}")
    case "$ar" in
      CLEAR) say "  none open" ;;
      ERR) nogo "autochain run list was unreadable" ;;
      *) nogo "autochain run(s) not completed: ${ar#OPEN }" ;;
    esac
  fi
  [ "$NOGO" -eq 0 ]
}

first_link() {
  local path cap tok issued_epoch issued_at out wrc url_id
  path=$(printf '%s' "$LAST_PARAMS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).path_prefix??""))}catch(e){}})')
  cap=$(printf '%s' "$LAST_PARAMS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).max_skills_per_dispatch??5000))}catch(e){process.stdout.write("5000")}})')
  tok="$(new_token)"; issued_epoch="$(now_epoch)"; issued_at="$(iso_from_epoch "$issued_epoch")"
  if ! append_intent "$tok" "$issued_at" "$path" "latest" "$cap" "FIRST-LINK"; then say "HALT: cannot append the dispatch intent to $INTENTS - NOT dispatching."; return 1; fi
  say "FIRST LINK token=$tok path_prefix='$path' resume_from=latest cap=$cap -> dispatching"
  out=$(gh workflow run indexer-backfill.yml --repo "$REPO" --ref main \
    -f dry_run=false -f resume_from=latest -f path_prefix="$path" \
    -f min_size_bytes="${BACKFILL_MIN_SIZE_BYTES:-1024}" -f max_ranges="${BACKFILL_MAX_RANGES:-10}" \
    -f max_skills_per_dispatch="$cap" -f max_skills_per_repo="${BACKFILL_MAX_SKILLS_PER_REPO:-50}" \
    -f max_elapsed_minutes="${BACKFILL_MAX_ELAPSED_MIN:-280}" -f dispatch_token="$tok" 2>&1); wrc=$?
  say "  gh workflow run exit=$wrc ; printed: $(printf '%s' "$out" | tr '\n' ' ')"
  url_id=$(printf '%s' "$out" | sed -n 's#.*/actions/runs/\([0-9][0-9]*\).*#\1#p' | head -1)
  RESOLVED_ID=""; RESOLVED_IDS=""
  resolve_run "$tok" "$(iso_from_epoch $((issued_epoch-120)))"; local rrc=$?
  if [ "$rrc" -ne 0 ]; then say "HALT: token $tok resolved to $([ "$rrc" -eq 1 ] && echo 'no run' || echo "several runs ($RESOLVED_IDS)")."; reconcile_text "$tok"; return 1; fi
  if [ -n "$url_id" ] && [ "$url_id" != "$RESOLVED_ID" ]; then say "HALT: printed run URL id $url_id disagrees with token-resolved run $RESOLVED_ID."; reconcile_text "$tok"; return 1; fi
  append_resolved "$tok" "$RESOLVED_ID" || { say "HALT: cannot record the resolution in $INTENTS."; return 1; }
  say "FIRST-LINK run_id=$RESOLVED_ID token=$tok  (now watch the autochain: C2)"
}

if [ "$FIRST_LINK" -eq 1 ]; then
  say "Re-checking (a)-(c) immediately before the first link..."
  run_checks || { echo "NO-GO"; exit 1; }
  first_link || { echo "NO-GO"; exit 1; }
  echo "GO"; exit 0
fi

if run_checks; then say "all clear"; echo "GO"; exit 0; fi
echo "NO-GO"; exit 1
