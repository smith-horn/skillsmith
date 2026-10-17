#!/usr/bin/env bash
# SMI-7112 (A1): GO/NO-GO helper for handing the backfill dispatcher role from the
# local rollout driver to indexer-backfill-autochain.yml. Exactly ONE dispatcher is
# live per period; this proves nothing from the retiring period can span the swap.
#
# Prints per-check lines, then exactly `GO` (exit 0) or `NO-GO` (exit 1). ANY API
# error, and any body that parses but is incomplete or malformed, is NO-GO -- an
# unread state is never "clear". It checks:
#   (a) every dispatch intent in the driver's intent log is resolved to a
#       `completed` run (which must carry a valid ISO updated_at), or marked
#       `reconciled_absent`;
#   (b) for BOTH indexer-backfill.yml AND indexer-backfill-autochain.yml, the
#       Actions API reports total_count 0 for each of queued, in_progress,
#       waiting, pending and requested (10 calls);
#   (c) every autochain run created at or after the last intent's completion (the
#       moment a `workflow_run` would have fired) is `completed`. The run list is
#       PAGINATED to the end (every entry needs a valid id, status and created_at) and
#       bounded server-side by creation time (see AUTOCHAIN_LOOKBACK_DAYS).
#
# Usage:
#   scripts/indexer/backfill-handover-check.sh               # checks only
#   scripts/indexer/backfill-handover-check.sh --first-link  # the whole handover
#
# Procedure (runbook): leave BACKFILL_AUTOCHAIN_DISABLE at "1"; stop the driver
# between dispatches; wait N minutes (the larger of 15 and 3x the Actions list
# lag); run this with no flag -> GO; then run it with --first-link. NEVER set the
# variable to 0 yourself -- --first-link does that, last.
#
# --first-link sequence (the variable flips LAST, so there is never a window with
# the autochain enabled and a driver-era completion still able to trigger it):
#   1. BACKFILL_AUTOCHAIN_DISABLE must read EXACTLY "1" (else NO-GO, nothing done);
#   2. re-run checks (a)-(c);
#   3. the LAST intent must carry every dispatch input (path_prefix, resume_from,
#      mode, ref, dry_run, max_ranges, min_size_bytes, max_skills_per_dispatch,
#      max_skills_per_repo, max_elapsed_minutes); a missing or malformed field is
#      NO-GO, never a default;
#   4. dispatch the first link with those inputs replayed exactly (a recorded
#      `coldstart-*` resume_from becomes `latest`: a cold-start id is only valid
#      for the first dispatch of a prefix) and a new drv- token logged as an
#      intent BEFORE the dispatch;
#   5. resolve the run by token and wait until it is queued/in_progress;
#   6. ONLY THEN `gh variable set BACKFILL_AUTOCHAIN_DISABLE --body 0` and read it
#      back as exactly "0".
# A failure at steps 1-5 leaves the variable at "1" (NO-GO). A stale autochain run
# triggered by the driver's last completion, firing after the flip, sees the first
# link as a newer backfill run and refuses (scripts/ci/autochain-newest-run-fence.sh).
#
# FAST FIRST LINK: if the first link is already `completed` when step 5 polls it, it
# finished before the flip, so no autochain run could have chained from it (the variable
# was still 1). The helper keeps the variable at 1, prints NO-GO and the next step, and
# does NOT flip. Re-running --first-link is the recovery: the completed link's intent is
# resolved and carries every input, so checks (a)-(c) pass and the next link is dispatched.
# Before re-running, confirm that link's conclusion was `success` (runbook section 3.4).
#
# Env: BACKFILL_REPO, BACKFILL_DRIVER_INTENTS (same defaults as the driver).
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
LIST_PAGES_MAX=50
# Check (c) lists autochain runs created at or after SINCE = max(last completion, now -
# AUTOCHAIN_LOOKBACK_DAYS), never the whole history (SMI-7121: the resume schedule adds ~24
# runs a day, so an unbounded page-through would pass LIST_PAGES_MAX in months and turn
# every check NO-GO). The bound loses nothing (c) must see:
#   - (c) only judges runs created at or after the last completion (older ones are filtered
#     out client-side anyway), so the server-side `created>=` filter changes nothing when the
#     last completion is within the lookback;
#   - a run created before now - 35 days cannot still be open: GitHub caps a workflow run at
#     35 days (this job's own timeout is 10 minutes, a queued job is cancelled after 24h), so
#     every run the lookback drops is necessarily completed;
#   - any run that IS open, however old, is also counted by check (b)'s status totals.
# At ~50 autochain runs a day (links plus ticks), 35 days is about 18 pages, under the cap.
AUTOCHAIN_LOOKBACK_DAYS=35
say(){ echo "[$(date -u '+%F %H:%M:%SZ')] $*"; }
# shellcheck source=scripts/indexer/backfill-intents.lib.sh
. "$ROOT/scripts/indexer/backfill-intents.lib.sh"

NOGO=0; LAST_DONE=""; LAST_PARAMS=""
nogo(){ say "  NO-GO: $*"; NOGO=1; }
# One small JSON helper (node) so no jq is needed. Subcommands read stdin or a file.
# Every body is validated field by field: syntactically valid but incomplete is ERR.
js(){ node -e '
const fs=require("fs"),[cmd,a1,a2,a3]=process.argv.slice(1);
const read=()=>{try{return JSON.parse(fs.readFileSync(0,"utf8"))}catch(e){return null}};
const iso=(s)=>typeof s==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(s)&&!Number.isNaN(Date.parse(s));
if(cmd==="log"){ // path -> "token state run_id issued_at params" per intent, in log order
  const ev=[];for(const l of fs.readFileSync(a1,"utf8").split("\n")){if(!l.trim())continue;try{ev.push(JSON.parse(l))}catch(e){console.log("BAD_LINE");process.exit(0)}}
  const o=[];const by=new Map();
  for(const e of ev){ if(e===null||typeof e!=="object"){console.log("BAD_LINE");process.exit(0)}
    if(e.event==="intent"){ if(typeof e.token!=="string"||!iso(e.issued_at)){console.log("BAD_LINE");process.exit(0)}
      by.set(e.token,{t:e.token,s:"open",r:"-",i:e.issued_at,p:e.params||{}});o.push(e.token)}
    else if(e.event==="resolved"&&by.has(e.token)){const x=by.get(e.token);x.s="resolved";x.r=e.run_id}
    else if(e.event==="reconciled_absent"&&by.has(e.token)){const x=by.get(e.token);if(x.s==="open")x.s="absent"} }
  for(const t of o){const x=by.get(t);console.log([x.t,x.s,x.r,x.i,JSON.stringify(x.p)].join("\t"))}
} else if(cmd==="total"){const j=read();console.log(j&&Number.isInteger(j.total_count)&&j.total_count>=0?j.total_count:"ERR")}
else if(cmd==="run"){const j=read();console.log(j&&typeof j.status==="string"&&j.status!==""&&(j.status!=="completed"||iso(j.updated_at))?[j.status,j.updated_at].join(" "):"ERR")}
else if(cmd==="status"){const j=read();console.log(j&&typeof j.status==="string"&&j.status!==""?j.status:"ERR")}
else if(cmd==="after"){ // one page of the autochain list -> "VERDICT COUNT [open ids]"
  const j=read();if(!j||!Array.isArray(j.workflow_runs)){console.log("ERR")}else{
    const rs=j.workflow_runs;
    if(!rs.every(r=>r!==null&&typeof r==="object"&&Number.isInteger(r.id)&&typeof r.status==="string"&&r.status!==""&&iso(r.created_at))){console.log("ERR")}else{
      const since=a1==="0"?0:Date.parse(a1);
      const bad=rs.filter(r=>Date.parse(r.created_at)>=since&&r.status!=="completed");
      console.log((bad.length?"OPEN":"CLEAR")+" "+rs.length+(bad.length?" "+bad.map(r=>r.id+":"+r.status).join(","):""))}}}
else if(cmd==="since"){ // a1 = last completion ISO or "", a2 = now (epoch s), a3 = lookback days -> ISO (whole seconds) or ERR
  const lo=Number(a2)*1000-Number(a3)*86400000;const t=a1?Math.max(iso(a1)?Date.parse(a1):NaN,lo):lo;
  console.log(Number.isFinite(t)?new Date(Math.floor(t/1000)*1000).toISOString().replace(/\.000Z$/,"Z"):"ERR")}
else if(cmd==="params"){ // last intent params -> "ERR msg" or k<TAB>v lines
  let p;try{p=JSON.parse(a1)}catch(e){p=null}
  const bad=(m)=>{console.log("ERR "+m);process.exit(0)};
  if(p===null||typeof p!=="object"||Array.isArray(p))bad("the last intent has no params object");
  const S=["path_prefix","resume_from","mode","ref"],N=["max_ranges","min_size_bytes","max_skills_per_dispatch","max_skills_per_repo","max_elapsed_minutes"];
  for(const k of S){if(typeof p[k]!=="string"||/[\r\n]/.test(p[k])||(k!=="path_prefix"&&p[k]===""))bad("the last intent is missing a valid "+k)}
  for(const k of N){if(!Number.isSafeInteger(p[k])||p[k]<0)bad("the last intent is missing a valid "+k)}
  if(typeof p.dry_run!=="boolean")bad("the last intent is missing a valid dry_run");
  for(const k of [...S,...N,"dry_run"])console.log(k+"\t"+p[k]);
}
' "$@"; }

run_checks() {
  NOGO=0; LAST_DONE=""; LAST_PARAMS=""
  say "(a) dispatch intents in $INTENTS"
  if [ ! -f "$INTENTS" ]; then
    say "  no intent log (the driver never dispatched under SMI-7112 hardening): nothing to resolve"
  else
    local rows
    rows=$(js log "$INTENTS") || rows="BAD_LINE"
    if [ "$rows" = "BAD_LINE" ]; then nogo "the intent log has an unparseable or incomplete line"; rows=""; fi
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
          if [ "$rs" = "ERR" ]; then nogo "run $rid for intent $tok returned an unreadable or incomplete body"; continue; fi
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

  local since page=1 aj ar verdict cnt ids
  since=$(js since "${LAST_DONE:-}" "$(now_epoch)" "$AUTOCHAIN_LOOKBACK_DAYS")
  if [ "$since" = "ERR" ] || [ -z "$since" ]; then nogo "cannot compute the autochain list bound from '${LAST_DONE:-}'"; return 1; fi
  say "(c) autochain runs created at/after the last completion (${LAST_DONE:-none}), listed from $since (lookback ${AUTOCHAIN_LOOKBACK_DAYS}d), all pages"
  while :; do
    if ! aj=$(gh api "repos/$REPO/actions/workflows/indexer-backfill-autochain.yml/runs?per_page=100&page=$page&created=>=$since" 2>/dev/null); then
      nogo "API error listing autochain runs (page $page)"; break
    fi
    ar=$(printf '%s' "$aj" | js after "${LAST_DONE:-0}")
    read -r verdict cnt ids <<< "$ar"
    case "$verdict" in
      CLEAR) ;;
      OPEN) nogo "autochain run(s) not completed (page $page): $ids" ;;
      *) nogo "autochain run list page $page was unreadable or had an incomplete entry"; break ;;
    esac
    [ "${cnt:-0}" -lt 100 ] && break
    page=$((page+1))
    if [ "$page" -gt "$LIST_PAGES_MAX" ]; then nogo "autochain run list exceeds $LIST_PAGES_MAX pages; cannot prove none is open"; break; fi
  done
  [ "$NOGO" -eq 0 ] && say "  none open ($page page(s) read)"
  [ "$NOGO" -eq 0 ]
}

flag_reads(){ # $1 = wanted exact value
  local out rc
  out=$(gh variable get BACKFILL_AUTOCHAIN_DISABLE --repo "$REPO" 2>/dev/null); rc=$?
  FLAG_SEEN="rc=$rc value='$out'"
  [ "$rc" -eq 0 ] && [ "$out" = "$1" ]
}

# Dispatch the first link with the last intent's inputs replayed exactly, resolve it
# by token, and wait until it is queued/in_progress. Does NOT touch the variable.
first_link() {
  local pv k v tok issued_epoch issued_at out wrc url_id st
  local PATH_PREFIX="" RESUME_FROM="" MODE="" REF="" DRY_RUN="" MAX_RANGES="" MIN_SIZE="" CAP="" PER_REPO="" ELAPSED=""
  pv=$(js params "$LAST_PARAMS")
  case "$pv" in ERR*) say "NO-GO: ${pv#ERR }; refusing to guess a default."; return 1 ;; esac
  while IFS=$'\t' read -r k v; do
    case "$k" in
      path_prefix) PATH_PREFIX="$v" ;; resume_from) RESUME_FROM="$v" ;; mode) MODE="$v" ;; ref) REF="$v" ;;
      dry_run) DRY_RUN="$v" ;; max_ranges) MAX_RANGES="$v" ;; min_size_bytes) MIN_SIZE="$v" ;;
      max_skills_per_dispatch) CAP="$v" ;; max_skills_per_repo) PER_REPO="$v" ;; max_elapsed_minutes) ELAPSED="$v" ;;
    esac
  done <<< "$pv"
  # A cold-start id (coldstart-*) matches no checkpoint, so replaying it would restart the prefix.
  case "$RESUME_FROM" in coldstart-*) RESUME_FROM="latest" ;; esac
  tok="$(new_token)"; issued_epoch="$(now_epoch)"; issued_at="$(iso_from_epoch "$issued_epoch")"
  if ! append_intent "$tok" "$issued_at" "FIRST-LINK" \
      ref="$REF" dry_run="$DRY_RUN" resume_from="$RESUME_FROM" path_prefix="$PATH_PREFIX" \
      min_size_bytes="$MIN_SIZE" max_ranges="$MAX_RANGES" max_skills_per_dispatch="$CAP" \
      max_skills_per_repo="$PER_REPO" max_elapsed_minutes="$ELAPSED"; then
    say "HALT: cannot append the dispatch intent to $INTENTS - NOT dispatching."; return 1
  fi
  say "FIRST LINK token=$tok mode=$MODE path_prefix='$PATH_PREFIX' resume_from=$RESUME_FROM dry_run=$DRY_RUN cap=$CAP -> dispatching"
  out=$(gh workflow run indexer-backfill.yml --repo "$REPO" --ref "$REF" \
    -f dry_run="$DRY_RUN" -f resume_from="$RESUME_FROM" -f path_prefix="$PATH_PREFIX" \
    -f min_size_bytes="$MIN_SIZE" -f max_ranges="$MAX_RANGES" \
    -f max_skills_per_dispatch="$CAP" -f max_skills_per_repo="$PER_REPO" \
    -f max_elapsed_minutes="$ELAPSED" -f dispatch_token="$tok" 2>&1); wrc=$?
  say "  gh workflow run exit=$wrc ; printed: $(printf '%s' "$out" | tr '\n' ' ')"
  url_id=$(printf '%s' "$out" | sed -n 's#.*/actions/runs/\([0-9][0-9]*\).*#\1#p' | head -1)
  RESOLVED_ID=""; RESOLVED_IDS=""
  resolve_run "$tok" "$(iso_from_epoch $((issued_epoch-120)))"; local rrc=$?
  if [ "$rrc" -ne 0 ]; then say "HALT: token $tok resolved to $([ "$rrc" -eq 1 ] && echo 'no run' || echo "several runs ($RESOLVED_IDS)")."; reconcile_text "$tok"; return 1; fi
  if [ -n "$url_id" ] && [ "$url_id" != "$RESOLVED_ID" ]; then say "HALT: printed run URL id $url_id disagrees with token-resolved run $RESOLVED_ID."; reconcile_text "$tok"; return 1; fi
  append_resolved "$tok" "$RESOLVED_ID" || { say "HALT: cannot record the resolution in $INTENTS."; return 1; }
  # Wait until the first link is visibly live; completed/unreadable means the flip would be unsafe.
  st=""
  for _ in 1 2 3 4 5 6 7 8; do
    st=$(gh api "repos/$REPO/actions/runs/$RESOLVED_ID" 2>/dev/null | js status)
    case "$st" in queued|in_progress) break ;; completed) break ;; esac
    do_sleep 15
  done
  case "$st" in
    queued|in_progress) say "FIRST-LINK run_id=$RESOLVED_ID token=$tok is $st" ;;
    completed)
      say "HALT: first link run $RESOLVED_ID is 'completed', not queued/in_progress; the variable stays 1."
      say "The first link finished before the flip. The variable is still 1, so nothing chained. Run --first-link again to dispatch the next link."
      return 1 ;;
    *) say "HALT: first link run $RESOLVED_ID is '${st:-unreadable}', not queued/in_progress; the variable stays 1. Reconcile before enabling the autochain."; return 1 ;;
  esac
}

if [ "$FIRST_LINK" -eq 1 ]; then
  if ! flag_reads 1; then
    say "BACKFILL_AUTOCHAIN_DISABLE must read exactly 1 before the handover (read $FLAG_SEEN). Set it to 1 and stop the driver first."
    echo "NO-GO"; exit 1
  fi
  say "Variable reads 1. Re-checking (a)-(c) immediately before the first link..."
  run_checks || { echo "NO-GO"; exit 1; }
  first_link || { echo "NO-GO"; exit 1; }
  # LAST step: only now, with the first link live, is the autochain enabled.
  if ! gh variable set BACKFILL_AUTOCHAIN_DISABLE --body 0 --repo "$REPO" >/dev/null 2>&1; then
    say "HALT: 'gh variable set' failed; read the variable before doing anything else (it should still be 1)."
    echo "NO-GO"; exit 1
  fi
  if ! flag_reads 0; then
    say "HALT: BACKFILL_AUTOCHAIN_DISABLE did not read back exactly 0 ($FLAG_SEEN); inspect it by hand."
    echo "NO-GO"; exit 1
  fi
  # The first link was live BEFORE the flip; it may have completed DURING it. A completion in that
  # window fires workflow_run while the variable still read 1, so the autochain stood down and
  # nothing will continue the chain. Re-read the status now that the variable reads 0.
  st2=$(gh api "repos/$REPO/actions/runs/$RESOLVED_ID" 2>/dev/null | js status)
  case "$st2" in
    queued|in_progress) ;;
    *)
      if gh variable set BACKFILL_AUTOCHAIN_DISABLE --body 1 --repo "$REPO" >/dev/null 2>&1 && flag_reads 1; then
        say "HALT: the variable is restored to 1."
      else
        say "HALT: could NOT restore BACKFILL_AUTOCHAIN_DISABLE to 1 ($FLAG_SEEN). It may still read 0: set it to 1 by hand before anything else."
      fi
      if [ "$st2" = "completed" ]; then
        say "First link run $RESOLVED_ID completed while the variable was being flipped, so the autochain may not have continued the chain."
        say "Run --first-link again to dispatch the next link."
        say "(If the autochain did dispatch a successor, the re-run's checks (a)-(c) will refuse until it has completed.)"
      else
        say "First link run $RESOLVED_ID status after the flip is '${st2:-unreadable}', not queued/in_progress; whether the chain continues cannot be confirmed. Reconcile before enabling the autochain."
      fi
      echo "NO-GO"; exit 1 ;;
  esac
  say "BACKFILL_AUTOCHAIN_DISABLE set to 0 after the first link went live; the autochain is now the only dispatcher."
  echo "GO"; exit 0
fi

if run_checks; then say "all clear"; echo "GO"; exit 0; fi
echo "NO-GO"; exit 1
