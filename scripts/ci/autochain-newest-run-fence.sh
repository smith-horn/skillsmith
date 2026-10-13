#!/usr/bin/env bash
# SMI-7112: the autochain's newest-run fence, run immediately before the dispatch.
#
# The autochain may dispatch the next link ONLY while COMPLETED_RUN_ID is still the
# newest indexer-backfill.yml run. If any run of that workflow, in ANY status, was
# created at or after COMPLETED_RUN_ID's own created_at (and is not that run), someone
# else (the rollout driver, a handover first link, an operator) has already continued
# the chain; dispatching would make two dispatchers. The check-then-act gap this
# closes: a delayed workflow_run for a driver-era completion that fires after the
# handover sees the first link and refuses.
#
# Exit codes (BOTH non-zero ones turn the job red; neither dispatches):
#   0  COMPLETED_RUN_ID is the newest run: safe to proceed to the dispatch
#   3  a newer run exists: skipped LOUDLY (::warning:: and the step summary)
#   1  the fence could not be evaluated (API error, unparseable or incomplete body,
#      bad input, too many pages): an unread state is never "clear"
#
# Env: GH_TOKEN, GITHUB_REPOSITORY, COMPLETED_RUN_ID; GITHUB_STEP_SUMMARY (optional).
# Requires gh and node.
set -uo pipefail

PAGES_MAX=10
fail(){ echo "::error::autochain-newest-run-fence: $* -- refusing to dispatch."; exit 1; }
summary(){ [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; return 0; }

REPO="${GITHUB_REPOSITORY:-}"
RID="${COMPLETED_RUN_ID:-}"
[ -n "$REPO" ] || fail "GITHUB_REPOSITORY is not set"
[ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is not set"
case "$RID" in ''|*[!0-9]*) fail "COMPLETED_RUN_ID '$RID' is not a run id" ;; esac

# Pure JSON helper (node); one body in on stdin, one verdict line out.
js(){ node -e '
const fs=require("fs"),[cmd,a1,a2]=process.argv.slice(1);
let j=null;try{j=JSON.parse(fs.readFileSync(0,"utf8"))}catch(e){}
const iso=(s)=>typeof s==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(s)&&!Number.isNaN(Date.parse(s));
if(cmd==="created"){console.log(j&&iso(j.created_at)?j.created_at:"ERR")}
else if(cmd==="newer"){ // a1 = created_at of the completed run, a2 = its id
  if(!j||!Array.isArray(j.workflow_runs)){console.log("ERR")}else{
    const rs=j.workflow_runs;
    if(!rs.every(r=>r!==null&&typeof r==="object"&&Number.isInteger(r.id)&&typeof r.status==="string"&&r.status!==""&&iso(r.created_at))){console.log("ERR")}else{
      const base=Date.parse(a1);
      const n=rs.filter(r=>String(r.id)!==a2&&Date.parse(r.created_at)>=base);
      console.log((n.length?"NEWER":"NONE")+" "+rs.length+(n.length?" "+n.map(r=>r.id+":"+r.status).join(","):""))}}}
' "$@"; }

BODY=$(gh api "repos/$REPO/actions/runs/$RID" 2>/dev/null) || fail "cannot read run $RID (API error)"
CREATED=$(printf '%s' "$BODY" | js created)
[ "$CREATED" != "ERR" ] || fail "run $RID returned an unreadable body or no valid created_at"

page=1
while :; do
  LIST=$(gh api "repos/$REPO/actions/workflows/indexer-backfill.yml/runs?per_page=100&page=$page&created=>=$CREATED" 2>/dev/null) \
    || fail "cannot list indexer-backfill.yml runs (page $page, API error)"
  V=$(printf '%s' "$LIST" | js newer "$CREATED" "$RID")
  read -r verdict cnt ids <<< "$V"
  case "$verdict" in
    NONE) ;;
    NEWER)
      MSG="indexer-backfill.yml run(s) newer than $RID already exist ($ids); another dispatcher already continued the chain, so this autochain run does NOT dispatch."
      echo "::warning::autochain-newest-run-fence: $MSG"
      summary "### Backfill auto-chain: NOT dispatched (newer run exists)" "" "$MSG" "" "Red on purpose: a skipped link is never silent."
      exit 3 ;;
    *) fail "the run list (page $page) was unreadable or had an incomplete entry" ;;
  esac
  [ "${cnt:-0}" -lt 100 ] && break
  page=$((page+1))
  [ "$page" -le "$PAGES_MAX" ] || fail "more than $PAGES_MAX pages of newer runs; cannot prove $RID is the newest"
done

echo "Fence passed: run $RID is the newest indexer-backfill.yml run ($page page(s) read)."
exit 0
