#!/usr/bin/env bash
# SMI-7112: the autochain's newest-run fence, run immediately before the dispatch.
#
# The autochain may dispatch the next link ONLY while the TRIGGERING ATTEMPT (run
# COMPLETED_RUN_ID, attempt TRIGGER_RUN_ATTEMPT) is still the newest thing that has
# happened to the indexer-backfill.yml workflow. Anything else means someone else (the
# rollout driver, a handover first link, an operator, a re-run) has already continued
# or forked the chain; dispatching would make two dispatchers.
#
# A run is identified by (id, run_attempt), NOT by id or created_at: a re-run keeps its
# id and created_at but advances run_attempt and run_started_at. So:
#   (d) a workflow_run whose attempt is > 1 never chains (a re-run must not continue the
#       chain automatically). TRIGGER_EVENT=workflow_run only; a manual dispatch names
#       the attempt it resumes and is not refused on attempt alone. A scheduled resume
#       (TRIGGER_EVENT=schedule, SMI-7121) names the attempt its deferral marker recorded
#       and has exactly the workflow_dispatch semantics: (b) and (c) still apply.
#   (b) the triggering run's CURRENT run_attempt, re-read from the API now and again
#       after the scans, must still equal TRIGGER_RUN_ATTEMPT; greater means it was re-run.
#   (c) any OTHER run (id differs) whose created_at >= the triggering run's created_at OR
#       whose run_started_at >= the triggering attempt's run_started_at blocks (>=, so a
#       same-second run counts). Two scans: runs created at/after the trigger (all
#       statuses, all pages), and every non-terminal run (queued, in_progress, waiting,
#       pending, requested; all pages) with NO created filter, because a re-run of an
#       OLDER run keeps its old created_at and would be invisible to a created filter.
#       A re-run of an older run that has already COMPLETED is not seen by either scan,
#       and does not need to be: its own workflow_run has attempt > 1 and (d) refuses it.
#
# Exit codes (BOTH non-zero ones turn the job red; neither dispatches):
#   0  the triggering attempt is the newest: safe to proceed to the dispatch
#   3  a newer run / a re-run / a re-run trigger: skipped LOUDLY (::warning:: and summary)
#   1  the fence could not be evaluated (API error, unparseable or incomplete body,
#      bad input, too many pages): an unread state is never "clear"
#
# Env: GH_TOKEN, GITHUB_REPOSITORY, COMPLETED_RUN_ID, TRIGGER_RUN_ATTEMPT,
#      TRIGGER_EVENT (workflow_run | workflow_dispatch | schedule); GITHUB_STEP_SUMMARY (optional).
# Requires gh and node.
set -uo pipefail

PAGES_MAX=10
fail(){ echo "::error::autochain-newest-run-fence: $* -- refusing to dispatch."; exit 1; }
summary(){ [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; return 0; }
blocked(){ # $1 = message
  echo "::warning::autochain-newest-run-fence: $1"
  summary "### Backfill auto-chain: NOT dispatched" "" "$1" "" "Red on purpose: a skipped link is never silent."
  exit 3
}

REPO="${GITHUB_REPOSITORY:-}"
RID="${COMPLETED_RUN_ID:-}"
ATT="${TRIGGER_RUN_ATTEMPT:-}"
EVT="${TRIGGER_EVENT:-}"
[ -n "$REPO" ] || fail "GITHUB_REPOSITORY is not set"
[ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is not set"
case "$RID" in ''|*[!0-9]*) fail "COMPLETED_RUN_ID '$RID' is not a run id" ;; esac
case "$ATT" in ''|*[!0-9]*|0*) fail "TRIGGER_RUN_ATTEMPT '$ATT' is not a run attempt (a positive integer)" ;; esac
case "$EVT" in workflow_run|workflow_dispatch|schedule) ;; *) fail "TRIGGER_EVENT '$EVT' is not workflow_run, workflow_dispatch or schedule" ;; esac

# Pure JSON helper (node); one body in on stdin, one verdict line out.
js(){ node -e '
const fs=require("fs"),[cmd,a1,a2,a3]=process.argv.slice(1);
let j=null;try{j=JSON.parse(fs.readFileSync(0,"utf8"))}catch(e){}
const iso=(s)=>typeof s==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(s)&&!Number.isNaN(Date.parse(s));
if(cmd==="run"){ // -> "created run_started_at run_attempt" or ERR
  console.log(j&&iso(j.created_at)&&iso(j.run_started_at)&&Number.isInteger(j.run_attempt)&&j.run_attempt>=1?[j.created_at,j.run_started_at,j.run_attempt].join(" "):"ERR")}
else if(cmd==="newer"){ // a1 = trigger created_at, a2 = trigger run_started_at, a3 = trigger id
  if(!j||!Array.isArray(j.workflow_runs)){console.log("ERR")}else{
    const rs=j.workflow_runs;
    if(!rs.every(r=>r!==null&&typeof r==="object"&&Number.isInteger(r.id)&&typeof r.status==="string"&&r.status!==""&&iso(r.created_at)&&iso(r.run_started_at))){console.log("ERR")}else{
      const c=Date.parse(a1),s=Date.parse(a2);
      const n=rs.filter(r=>String(r.id)!==a3&&(Date.parse(r.created_at)>=c||Date.parse(r.run_started_at)>=s));
      console.log((n.length?"NEWER":"NONE")+" "+rs.length+(n.length?" "+n.map(r=>r.id+":"+r.status).join(","):""))}}}
' "$@"; }

read_run(){ # sets CREATED STARTED CUR (or fails)
  local body v
  body=$(gh api "repos/$REPO/actions/runs/$RID" 2>/dev/null) || fail "cannot read run $RID (API error)"
  v=$(printf '%s' "$body" | js run)
  [ "$v" != "ERR" ] || fail "run $RID returned an unreadable body or no valid created_at / run_started_at / run_attempt"
  read -r CREATED STARTED CUR <<< "$v"
}

# (d) a re-run never chains automatically
if [ "$EVT" = "workflow_run" ] && [ "$ATT" -gt 1 ]; then
  blocked "run $RID is attempt $ATT (a re-run); a re-run of a backfill run does NOT continue the chain automatically, so this autochain run does not dispatch. Resume deliberately with the runbook (section 6.2)."
fi

# (b) the triggering run must not have been re-run since the trigger fired
read_run
if [ "$CUR" -gt "$ATT" ]; then
  blocked "run $RID is now attempt $CUR but this autochain run was triggered by attempt $ATT: it was re-run, so another autochain run owns it and this one does NOT dispatch."
fi

# (c) every other run that began at or after the triggering attempt
scan(){ # $1 = query (no page), $2 = label
  local page=1 LIST V verdict cnt ids
  while :; do
    LIST=$(gh api "repos/$REPO/actions/workflows/indexer-backfill.yml/runs?per_page=100&page=$page&$1" 2>/dev/null) \
      || fail "cannot list indexer-backfill.yml runs ($2, page $page, API error)"
    V=$(printf '%s' "$LIST" | js newer "$CREATED" "$STARTED" "$RID")
    read -r verdict cnt ids <<< "$V"
    case "$verdict" in
      NONE) ;;
      NEWER) blocked "indexer-backfill.yml run(s) newer than $RID attempt $ATT already exist ($ids); another dispatcher already continued the chain, so this autochain run does NOT dispatch." ;;
      *) fail "the run list ($2, page $page) was unreadable or had an incomplete entry" ;;
    esac
    [ "${cnt:-0}" -lt 100 ] && break
    page=$((page+1))
    [ "$page" -le "$PAGES_MAX" ] || fail "more than $PAGES_MAX pages of runs ($2); cannot prove $RID attempt $ATT is the newest"
  done
}
scan "created=>=$CREATED" "created at/after the trigger"
for s in queued in_progress waiting pending requested; do scan "status=$s" "status=$s"; done

# (b) again, after the scans: closes the window in which a re-run lands mid-fence
read_run
if [ "$CUR" -gt "$ATT" ]; then
  blocked "run $RID became attempt $CUR while the fence was reading (triggered by attempt $ATT): it was re-run, so this autochain run does NOT dispatch."
fi

echo "Fence passed: run $RID attempt $ATT is the newest indexer-backfill.yml activity."
exit 0
