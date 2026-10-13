#!/usr/bin/env bash
# SMI-7112: dispatch-intent helpers shared by backfill-rollout-driver.sh and
# backfill-handover-check.sh. SOURCE this file; do not execute it.
#
# The caller must already define: REPO, INTENTS (the JSONL intent log), TEST_DIR
# (empty outside tests) and say(). Event lines, one JSON object each:
#   {"event":"intent","token":"drv-..","issued_at":"<ISO>","params":{..}}
#   {"event":"resolved","token":"drv-..","run_id":<n>}
#   {"event":"reconciled_absent","token":"drv-..","reason":".."}   (written by hand)
# A dispatch is identified ONLY by its token: it appears in the dispatched run's
# display_title as [tok=<token>], and the Actions API is queried for it. Neither
# `gh run list --limit 1` nor a printed URL is ever accepted as resolution.

RESOLVE_BUDGET="${RESOLVE_BUDGET:-300}"   # seconds to find a run by token

# Real clock/sleep, or faked under the test seam (state dir: clock, seam.log).
if [ -n "${TEST_DIR:-}" ]; then
  now_epoch(){ cat "$TEST_DIR/clock"; }
  do_sleep(){ echo "sleep $1 at=$(now_epoch)" >> "$TEST_DIR/seam.log"; echo $(( $(now_epoch) + $1 )) > "$TEST_DIR/clock"; }
else
  now_epoch(){ date +%s; }
  do_sleep(){ sleep "$1"; }
fi
iso_from_epoch(){ date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }

new_token(){ printf 'drv-%s-%s' "$(now_epoch)" "$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"; }
# append_intent token issued_at mode key=value...   (every input the dispatch passes)
# Numeric inputs are stored as numbers and dry_run as a boolean; the rest as strings.
# backfill-handover-check.sh --first-link replays these EXACTLY, so every input
# `gh workflow run` is given must be recorded here.
append_intent(){
  mkdir -p "$(dirname "$INTENTS")" || return 1
  node -e '
const [t,i,m,...kv]=process.argv.slice(1);
const NUM=new Set(["max_skills_per_dispatch","max_ranges","min_size_bytes","max_skills_per_repo","max_elapsed_minutes"]);
const p={mode:m};
for(const a of kv){const x=a.indexOf("=");const k=a.slice(0,x),v=a.slice(x+1);p[k]=NUM.has(k)?Number(v):k==="dry_run"?v==="true":v}
process.stdout.write(JSON.stringify({event:"intent",token:t,issued_at:i,params:p})+"\n")' "$@" >> "$INTENTS"
}
append_resolved(){ # token run_id
  node -e 'const [t,r]=process.argv.slice(1);process.stdout.write(JSON.stringify({event:"resolved",token:t,run_id:Number(r)})+"\n")' "$@" >> "$INTENTS"
}
# Prints comma-separated ids of dispatched runs whose display_title carries [tok=<token>].
runs_matching_token(){ # token since_iso
  local json
  json=$(gh api "repos/$REPO/actions/workflows/indexer-backfill.yml/runs?event=workflow_dispatch&per_page=100&created=>=$2" 2>/dev/null) || { echo "ERR"; return 0; }
  printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t="[tok="+process.argv[1]+"]";process.stdout.write((JSON.parse(s).workflow_runs||[]).filter(r=>String(r.display_title).includes(t)).map(r=>r.id).join(","))}catch(e){process.stdout.write("ERR")}})' "$1"
}
# Sets RESOLVED_ID / RESOLVED_IDS; returns 0 = exactly one match, 1 = none within budget, 2 = several.
resolve_run(){ # token since_iso
  local deadline m n
  deadline=$(( $(now_epoch) + RESOLVE_BUDGET ))
  while :; do
    m=$(runs_matching_token "$1" "$2")
    if [ -n "$m" ] && [ "$m" != "ERR" ]; then
      n=$(printf '%s' "$m" | awk -F, '{print NF}')
      if [ "$n" -ge 2 ]; then RESOLVED_IDS="$m"; return 2; fi
      RESOLVED_ID="$m"; return 0
    fi
    [ "$(now_epoch)" -ge "$deadline" ] && return 1
    do_sleep 15
  done
}
reconcile_text(){ # token
  say "  RECONCILE intent $1 (left UNRESOLVED in $INTENTS):"
  say "    1. re-query a +-30 min window for [tok=$1]: gh api 'repos/$REPO/actions/workflows/indexer-backfill.yml/runs?event=workflow_dispatch&created=<window>' and match display_title."
  say "    2. a match: append {\"event\":\"resolved\",\"token\":\"$1\",\"run_id\":<id>} to the intent log and wait for that run to complete."
  say "    3. no match and BOTH backfill workflows show zero non-terminal runs for N minutes: append {\"event\":\"reconciled_absent\",\"token\":\"$1\",\"reason\":\"...\"} by hand."
  say "    Multiple matches stay NO-GO until a human resolves them."
}
