#!/usr/bin/env bash
# Autonomous per-prefix driver for the full-volume backfill rollout (SMI-5334).
#
# Drives the out-of-band `indexer-backfill.yml` workflow one prefix at a time:
# waits for a cron-quiet UTC window, checks the indexer lock is free, VACUUMs,
# dispatches a bounded crawl, waits for it, verifies the result, and repeats
# until this prefix's checkpoint cursor reaches `done` -- then halts so an
# operator can gate the next prefix. NOT wired into CI/hooks/build -- a manual
# operational helper (so not ADR-109-gated).
#
# COLD-START (B1, engine-verified): a NEW prefix has no checkpoint. The engine
# cold-starts only when readLatestCheckpoint returns null. `-f resume_from=` EMPTY
# does NOT do this -- the workflow's `|| 'latest'` falls through to latest, which
# inherits the PRIOR prefix's cursor (if that was `done`, the new prefix silently
# admits 0 and reports done). A resume_from that is a NON-EXISTENT run_id makes
# readLatestCheckpoint filter run_id=<that> -> no row -> null -> fresh crawl
# (scripts/indexer/backfill-checkpoint.ts:369). That is the cold-start here; after
# it we HARD-VERIFY the new checkpoint is not a foreign done cursor. The proper
# engine fix (path-filtered readLatestCheckpoint) is tracked as SMI-5333, which
# would remove the need for the bogus-run_id trick entirely.
#
# TIMEOUT SAFETY: the engine elapsed-time budget guard (max_elapsed_minutes, SMI-5448)
# checkpoints-and-exits at a clean boundary before the 330-min GHA kill, so full
# params are safe (a dense leaf makes forward progress instead of rolling back).
#
# POOLER RESILIENCE: q() captures the varlock/pooler exit code BEFORE the pipe and
# returns EMPTY on failure, so a transient pooler blip hits the retry guard instead
# of feeding an error string into the abort gates (v3 false-aborted 2026-07-07 when
# a dmno error string landed in CPATH and tripped path!=PREFIX).
#
# Usage:
#   scripts/indexer/backfill-rollout-driver.sh <path_prefix>
#   e.g.  scripts/indexer/backfill-rollout-driver.sh .agents/skills
#
# Run detached (survives terminal close; keep a Mac awake for the multi-day run):
#   nohup scripts/indexer/backfill-rollout-driver.sh .agents/skills >>/tmp/backfill-driver.log 2>&1 &
#   caffeinate -is -w $! >/dev/null 2>&1 &   # macOS only
#   # stop: pkill -f backfill-rollout-driver.sh
#
# Prefix order (Golden rule 6 -- one prefix at a time, cold-start each):
#   .claude/skills -> .agents/skills -> .github/skills -> .gemini/skills -> <tail> -> "" (broad)
#
# Tunables (env; defaults are the SMI-5448-era production values):
#   BACKFILL_MAX_RANGES=10   BACKFILL_MAX_SKILLS_PER_REPO=50   BACKFILL_MAX_ELAPSED_MIN=280
#   BACKFILL_COLD_CAP=2000   BACKFILL_RESUME_CAP=5000          BACKFILL_MIN_SIZE_BYTES=1024
#   BACKFILL_MAXDISP=80      BACKFILL_NDB_MAX=50               BACKFILL_REPO=<owner/repo>
#   BACKFILL_BUSY_HOURS=" 0 3 6 7 8 12 13 14 18 19 20 "   (cron-busy UTC hours to avoid)
#
# Requires (host tools, run from any dir inside the repo): git, gh, varlock, and
# scripts/pooler-psql.sh / pooler-psql-session.sh (Docker container up).
set -uo pipefail

PREFIX="${1:-}"
if [ -z "$PREFIX" ]; then
  echo "usage: $(basename "$0") <path_prefix>   e.g. .agents/skills   (empty '' = broad query)" >&2
  exit 2
fi
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "error: not inside a git repo" >&2; exit 2; }
cd "$ROOT" || { echo "error: cannot cd to repo root $ROOT" >&2; exit 2; }

# bogus cold-start run_id derived from the prefix (a non-existent run_id -> null -> fresh crawl)
COLD_RESUME="coldstart-$(printf '%s' "${PREFIX:-broad}" | tr -c 'a-zA-Z0-9' '-')"
REPO="${BACKFILL_REPO:-smith-horn/skillsmith}"
MAXDISP="${BACKFILL_MAXDISP:-80}"
MAX_RANGES="${BACKFILL_MAX_RANGES:-10}"
MAX_SKILLS_PER_REPO="${BACKFILL_MAX_SKILLS_PER_REPO:-50}"
MAX_ELAPSED_MIN="${BACKFILL_MAX_ELAPSED_MIN:-280}"
COLD_CAP="${BACKFILL_COLD_CAP:-2000}"
RESUME_CAP="${BACKFILL_RESUME_CAP:-5000}"
MIN_SIZE_BYTES="${BACKFILL_MIN_SIZE_BYTES:-1024}"
NDB_MAX="${BACKFILL_NDB_MAX:-50}"
busy="${BACKFILL_BUSY_HOURS:- 0 3 6 7 8 12 13 14 18 19 20 }"

say(){ echo "[$(date -u '+%F %H:%M:%SZ')] $*"; }
# q(): capture the varlock/pooler exit code BEFORE any pipe; on failure return EMPTY
# (never the error text) so callers hit the retry guard, not the abort gates.
q(){
  local out rc
  out=$(varlock run -- ./scripts/pooler-psql.sh -t -c "$1" 2>/dev/null); rc=$?
  [ "$rc" -ne 0 ] && return 0
  printf '%s' "$out" | tr -d '[:space:]'
}

say "DRIVER START prefix='$PREFIX' maxdisp=$MAXDISP max_ranges=$MAX_RANGES elapsed=${MAX_ELAPSED_MIN}m pid=$$"
n=0
while [ "$n" -lt "$MAXDISP" ]; do
  H=$((10#$(date -u +%H))); M=$((10#$(date -u +%M)))
  mtb=9999; ready=0
  case "$busy" in
    *" $H "*) ready=0 ;;
    *) for k in 1 2 3 4 5 6 7 8; do hh=$(((H+k)%24)); case "$busy" in *" $hh "*) mtb=$((k*60-M)); break;; esac; done
       [ "$mtb" -ge 80 ] && ready=1 ;;
  esac
  if [ "$ready" != "1" ]; then sleep 300; continue; fi

  CFACET=$(q "SELECT metadata->'cursor'->>'facet' FROM audit_logs WHERE event_type='indexer_backfill_checkpoint' ORDER BY created_at DESC LIMIT 1;")
  CPATH=$(q  "SELECT metadata->'cursor'->>'path'  FROM audit_logs WHERE event_type='indexer_backfill_checkpoint' ORDER BY created_at DESC LIMIT 1;")
  PCKPT=$(q  "SELECT count(*) FROM audit_logs WHERE event_type='indexer_backfill_checkpoint' AND metadata->'cursor'->>'path'='$PREFIX';")
  LOCK=$(q   "SELECT count(*) FROM indexer_lock WHERE locked_at IS NOT NULL;")
  # transient pooler/varlock blip -> any of these comes back empty -> retry, do NOT abort
  if [ -z "$LOCK" ] || [ -z "$PCKPT" ] || [ -z "$CFACET" ] || [ -z "$CPATH" ]; then say "pooler unavailable (empty query result) — retry in 5m"; sleep 300; continue; fi

  # cold-start (no checkpoint for THIS prefix) vs resume vs done
  if [ "$PCKPT" = "0" ]; then
    RESUME="$COLD_RESUME"; CAP="$COLD_CAP"; MODE="COLD-START"
  else
    if [ "$CPATH" != "$PREFIX" ]; then say "ABORT: prefix seeded but latest checkpoint path='$CPATH' != '$PREFIX' — STOP."; break; fi
    if [ "$CFACET" = "done" ]; then say "PREFIX DONE (cursor=done) after $n dispatches — STOP."; break; fi
    RESUME="latest"; CAP="$RESUME_CAP"; MODE="RESUME"
  fi
  if [ "$LOCK" != "0" ]; then sleep 120; continue; fi

  varlock run -- ./scripts/pooler-psql-session.sh -c "VACUUM (ANALYZE) skills;" >/dev/null 2>&1
  COV0=$(q "SELECT count(*) FROM skills WHERE discovery_path LIKE 'subdirectory_search:$PREFIX%';")
  say "DISPATCH #$((n+1)) [$MODE] UTC ${H}:$(printf %02d "$M") mtb=${mtb}m resume=$RESUME cap=$CAP coverage=$COV0 -> launching"
  gh workflow run indexer-backfill.yml --ref main \
     -f dry_run=false -f resume_from="$RESUME" -f path_prefix="$PREFIX" \
     -f min_size_bytes="$MIN_SIZE_BYTES" -f max_ranges="$MAX_RANGES" -f max_skills_per_dispatch="$CAP" \
     -f max_skills_per_repo="$MAX_SKILLS_PER_REPO" -f max_elapsed_minutes="$MAX_ELAPSED_MIN" >/dev/null 2>&1
  sleep 25
  RID=$(gh run list --workflow=indexer-backfill.yml --repo "$REPO" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
  say "  run=$RID waiting..."

  ST=""
  for _ in $(seq 1 420); do
    ST=$(gh run view "$RID" --repo "$REPO" --json status --jq '.status' 2>/dev/null)
    [ "$ST" = "completed" ] && break
    sleep 60
  done
  if [ "$ST" != "completed" ]; then say "  HALT: run=$RID still '$ST' after ~7h."; break; fi
  CC=$(gh run view "$RID" --repo "$REPO" --json conclusion --jq '.conclusion' 2>/dev/null)

  if [ "$CC" != "success" ]; then
    LOCKRACE=$(gh run view "$RID" --repo "$REPO" --log-failed 2>/dev/null | grep -c "lock_held_by_other_run")
    if [ "${LOCKRACE:-0}" -gt 0 ]; then say "  LOCK RACE on run=$RID (benign) — wait 2m + retry."; sleep 120; continue; fi
    say "  HALT: conclusion=$CC (not a lock race)."; break
  fi

  SUMM=$(gh run view "$RID" --repo "$REPO" --log 2>/dev/null | grep -iE "\[Backfill\] Facet crawl" | head -1)
  NDB=$(printf '%s' "$SUMM" | grep -oE "noDefaultBranch=[0-9]+" | grep -oE "[0-9]+$")
  LF=$(printf '%s' "$SUMM" | grep -oE "[0-9]+ license-filtered" | grep -oE "^[0-9]+")
  NFACET=$(q "SELECT metadata->'cursor'->>'facet' FROM audit_logs WHERE event_type='indexer_backfill_checkpoint' ORDER BY created_at DESC LIMIT 1;")
  NPATH=$(q "SELECT metadata->'cursor'->>'path'  FROM audit_logs WHERE event_type='indexer_backfill_checkpoint' ORDER BY created_at DESC LIMIT 1;")
  NFIDX=$(q "SELECT metadata->'cursor'->>'facet_index' FROM audit_logs WHERE event_type='indexer_backfill_checkpoint' ORDER BY created_at DESC LIMIT 1;")
  COV1=$(q "SELECT count(*) FROM skills WHERE discovery_path LIKE 'subdirectory_search:$PREFIX%';")
  say "  run=$RID conclusion=$CC noDefaultBranch=${NDB:-?} license_filtered=${LF:-?} newcursor.path=$NPATH facet=$NFACET fidx=$NFIDX coverage=${COV0}->${COV1} (delta=$((COV1-COV0)))"

  # B1 cold-start footgun guard: a cold-start that inherited the prior prefix's done
  # cursor admits 0 and reports done immediately. A legit tiny prefix that finishes in
  # one dispatch is also done -- but WITH admits. So HALT only on done + zero-admit.
  if [ "$MODE" = "COLD-START" ] && [ "$NFACET" = "done" ] && [ "$COV1" = "$COV0" ]; then
    say "  HALT: COLD-START reports done with 0 admits — foreign-cursor inheritance (B1). resume=$RESUME did not cold-start. STOP + investigate."; break
  fi
  if [ -n "$NDB" ] && [ "$NDB" -gt "$NDB_MAX" ]; then say "  HALT: noDefaultBranch=$NDB > $NDB_MAX (W5 regression)."; break; fi
  if [ -n "$NDB" ] && [ "$NDB" -gt 0 ]; then say "  note: noDefaultBranch=$NDB (<=$NDB_MAX) benign empty-repo skip(s), continuing."; fi
  if [ -n "$LF" ] && [ "$LF" -gt 0 ]; then say "  HALT: license_filtered=$LF > 0 (gate regression)."; break; fi

  n=$((n+1))
  sleep 90
done
say "DRIVER END — $n dispatches. (re-run to resume from the checkpoint.)"
