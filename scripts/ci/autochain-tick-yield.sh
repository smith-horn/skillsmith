#!/usr/bin/env bash
# SMI-7121 (V3): a scheduled resume tick yields to any live autochain LINK.
#
# Ticks run in their own concurrency group, so a pending link can never be cancelled by a
# newer queued tick. The price is that a tick and a link can now run at the same time; this
# check makes the tick step aside at its start: if any indexer-backfill-autochain.yml run
# whose event is NOT `schedule` (a workflow_run link or a manual dispatch) is queued,
# in_progress, waiting, pending or requested, the link owns the turn and the tick stops
# quietly (skip=true appended to GITHUB_ENV, exit 0). The marker stays open; a later tick
# resumes it. Interleavings after this check are covered by the fence, the claim and the
# live-marker check (see the workflow's concurrency comment).
#
# Exit 0: decided (yield or proceed). Exit 1: the run list could not be read, or a status
# has more runs than one page shows -- an unread state is never "no link", so the tick is
# red rather than racing a link it could not see.
#
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID (this tick, excluded), GITHUB_ENV.
# Requires gh and node.
set -uo pipefail

fail(){ echo "::error::autochain-tick-yield: $* -- not resuming."; exit 1; }

REPO="${GITHUB_REPOSITORY:-}"
SELF="${GITHUB_RUN_ID:-}"
[ -n "$REPO" ] || fail "GITHUB_REPOSITORY is not set"
[ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is not set"
[ -n "${GITHUB_ENV:-}" ] || fail "GITHUB_ENV is not set"
case "$SELF" in ''|*[!0-9]*) fail "GITHUB_RUN_ID '$SELF' is not a run id" ;; esac

LINKS=""
for s in queued in_progress waiting pending requested; do
  body=$(gh api "repos/$REPO/actions/workflows/indexer-backfill-autochain.yml/runs?status=$s&per_page=100" 2>/dev/null) \
    || fail "cannot list autochain runs with status=$s (API error)"
  v=$(printf '%s' "$body" | node -e '
const self=process.argv[1];let j=null;try{j=JSON.parse(require("fs").readFileSync(0,"utf8"))}catch(e){}
const rs=j&&j.workflow_runs;
if(!j||!Number.isInteger(j.total_count)||!Array.isArray(rs)||!rs.every(r=>r&&Number.isInteger(r.id)&&typeof r.event==="string"&&r.event!=="")){console.log("ERR")}
else if(j.total_count>rs.length){console.log("MORE")}
else{console.log("OK "+rs.filter(r=>r.event!=="schedule"&&String(r.id)!==self).map(r=>r.id+":"+r.event).join(","))}
' "$SELF")
  case "$v" in
    ERR) fail "the status=$s run list was unreadable or had an incomplete entry" ;;
    MORE) fail "more status=$s autochain runs exist than one page shows" ;;
    "OK ") ;;
    OK\ *) LINKS="$LINKS${LINKS:+,}${v#OK } ($s)" ;;
    *) fail "unexpected verdict for status=$s" ;;
  esac
done

if [ -n "$LINKS" ]; then
  echo "A live autochain link owns the turn ($LINKS) -- this resume tick stops quietly; the deferral marker stays open."
  echo "skip=true" >> "$GITHUB_ENV"
  exit 0
fi
echo "No live autochain link; the resume tick proceeds."
exit 0
