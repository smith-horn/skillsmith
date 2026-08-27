#!/usr/bin/env bash
# SMI-6208: detects an `Approve Production Deploy` job (website-deploy-
# staging.yml) that was cancelled while `waiting` for required-reviewer
# approval or while actively mid-deploy -- the exact incident class this
# issue was filed for (PR #2546/SMI-6194's production job was silently
# cancelled by a same-day unrelated push, 2026-08-27, before this fix). The
# concurrency-scoping fix in website-deploy-staging.yml (job-level
# `website-production-deploy-*` group, cancel-in-progress: false) is the
# real root-cause fix -- this script is a backstop in case some other path
# still cancels that job.
#
# NOTE (2026-08-27): a live test proved the original single-job concurrency
# hypothesis wrong -- a `waiting` job WAS cancelled even inside its own
# isolated ref-keyed group. The workflow was split into two jobs:
# `approve-gate` (holds only the human-approval environment, run-ID-keyed)
# and `deploy-production` (does the actual deploy, ref-keyed, still
# mutually exclusive). This monitor now watches `approve-gate` specifically
# -- that's the job that actually sits `waiting` and could be silently
# cancelled; the deploy execution itself is short and already serialized by
# its own ref-keyed group, so it isn't the long-wait target this monitor
# needs to catch.
#
# Detection signature (deliberately narrower than "conclusion == cancelled"
# alone, per plan-review finding #4, and revised again during the round-2
# confirmation review -- see below): a cancelled Deploy to Production job
# where (a) every upstream job (deploy-staging, lighthouse, link-check)
# succeeded -- rules out a job that never had a chance to start because an
# earlier stage failed/was itself cancelled -- AND (b) the job dwelled at
# least DWELL_THRESHOLD_SECONDS between started_at and completed_at.
#
# Round-2 confirmation review finding: the original (b) -- "non-null
# started_at with zero executed steps" -- is INERT. The real SMI-6194
# incident's own `Smoke Test` job (which never ran at all) carries that
# identical signature, so it doesn't actually distinguish "reached the
# approval gate" from "queued but never started." Dwell time does: a job
# cut off by ordinary queue-collapse is superseded before GitHub ever
# assigns it a runner, so started_at and completed_at land within roughly
# the same second; a job that genuinely reached the approval gate (or was
# mid-deploy) dwells minutes to hours. This also makes mid-deploy
# cancellation (nonzero steps) detectable, which the old zero-steps
# requirement had accidentally made unreachable.
#
# This does NOT distinguish an accidental cancellation from an intentional
# one (a reviewer deciding not to ship a commit) -- that residual
# false-positive class is accepted and handled by manual triage per filed
# issue (see the issue body's own checklist), not further automated. See
# Open Question 2 for the shadow-lift criterion this implies.
#
# Usage: ./scripts/prod-deploy-cancel-monitor.sh
#
# Exit codes:
#   0 -- no NEW alert-worthy incident this tick (healthy, shadow-logged-only,
#        or already-deduped) -- deliberately does not stay red across every
#        tick a past incident remains in the lookback window
#   1 -- a new, non-shadow, non-deduped GitHub Issue was actually filed this tick

set -uo pipefail

STABLE_LABEL="prod-deploy-approval-cancelled"
WORKFLOW_FILE="website-deploy-staging.yml"
JOB_NAME="Approve Production Deploy"
UPSTREAM_JOBS=("Deploy to Staging" "Lighthouse CI" "Link Check")
LOOKBACK_HOURS=24
# Round-2 confirmation review: dwell time (completed_at - started_at) is the
# discriminator between "cut off by ordinary queue-collapse" (~0s) and
# "actually reached the approval gate or was mid-deploy" (minutes to
# hours). Calibrated against the real SMI-6194 incident's own job payloads
# (round-3 confirmation review measured these directly): the genuinely
# cancelled `Deploy to Production` job dwelled 8172s; the never-run `Smoke
# Test` job (identical conclusion/steps signature, the false-positive round
# 2 was fixing) dwelled 0s. 60s sits comfortably above that 0s benign
# baseline while staying well below the true-incident range -- round 2's
# original 300s was over-tuned ~5x past what the data supports and opened a
# real false-negative window (a merge train landing two website commits
# under 5 min apart could reproduce the incident with ~240s dwell and be
# silently missed).
DWELL_THRESHOLD_SECONDS=60

# --- Test-seam master switch (mirrors scripts/status-external-probe.sh) ----
MONITOR_TEST="${SKILLSMITH_PROD_DEPLOY_MONITOR_TEST:-}"

# --- 1. Kill switch (checked first) ----------------------------------------
if [ "${SKILLSMITH_PROD_DEPLOY_CANCEL_MONITOR_DISABLE:-}" = "1" ]; then
  echo "[prod-deploy-monitor] skip: disabled (SKILLSMITH_PROD_DEPLOY_CANCEL_MONITOR_DISABLE=1)"
  exit 0
fi

# --- gh wrapper (test seam) --------------------------------------------------
run_gh() {
  if [ "$MONITOR_TEST" = "1" ] && [ -n "${SKILLSMITH_PROD_DEPLOY_MONITOR_GH_CMD:-}" ]; then
    bash "${SKILLSMITH_PROD_DEPLOY_MONITOR_GH_CMD}" "$@"
    return $?
  fi
  gh "$@"
}

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# GNU `date -d` is required below (Linux runner / Docker dev container only
# -- see Testing §2, this script must NOT be dry-run on bare macOS, where
# BSD date's lack of -d would make every run report a false "healthy").
SINCE_EPOCH=$(( $(date -u +%s) - LOOKBACK_HOURS * 3600 ))
REPO="${GITHUB_REPOSITORY:-smith-horn/skillsmith}"

# --- 2. List recent cancelled runs of the target workflow --------------------
RUNS_JSON="$(run_gh run list --workflow "$WORKFLOW_FILE" --status cancelled \
  --json databaseId,headSha,createdAt,url -L 50 2>/dev/null || echo "[]")"

NEW_ALERT=0

while IFS=$'\t' read -r RUN_ID HEAD_SHA CREATED_AT RUN_URL; do
  [ -z "$RUN_ID" ] && continue

  # Skip runs older than the lookback window. Dedup below is stateless
  # (issue-search, not a persisted cursor) -- deliberately simple, since
  # re-scanning the same window every 30 min and dedup-by-search is
  # idempotent and needs no watermark file to keep in sync.
  CREATED_EPOCH="$(date -u -d "$CREATED_AT" +%s 2>/dev/null || echo 0)"
  [ "$CREATED_EPOCH" -lt "$SINCE_EPOCH" ] && continue

  # --- 3. Did THIS run's "${JOB_NAME}" job get cancelled after reaching
  #        the approval gate (not before, via ordinary supersede)? ---
  JOBS_JSON="$(run_gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" 2>/dev/null || echo '{"jobs":[]}')"

  # (a) require every upstream job to have actually succeeded on this run
  ALL_UPSTREAM_OK=1
  for UP_NAME in "${UPSTREAM_JOBS[@]}"; do
    UP_CONCLUSION="$(echo "$JOBS_JSON" | jq -r --arg name "$UP_NAME" '.jobs[] | select(.name == $name) | .conclusion // empty' | head -1)"
    [ "$UP_CONCLUSION" != "success" ] && ALL_UPSTREAM_OK=0 && break
  done
  [ "$ALL_UPSTREAM_OK" -eq 0 ] && continue

  # (b) the production job itself: cancelled, but with evidence it actually
  #     dwelled at the approval gate (or mid-deploy) rather than being
  #     evicted almost instantly by ordinary queue-collapse before ever
  #     being scheduled. Dwell time, not "zero steps executed" -- see the
  #     header comment for why the latter is inert (round-2 confirmation
  #     review finding).
  PROD_JOB_JSON="$(echo "$JOBS_JSON" | jq -c --arg name "$JOB_NAME" '.jobs[] | select(.name == $name)' | head -1)"
  [ -z "$PROD_JOB_JSON" ] && continue
  PROD_CONCLUSION="$(echo "$PROD_JOB_JSON" | jq -r '.conclusion // empty')"
  PROD_STARTED_AT="$(echo "$PROD_JOB_JSON" | jq -r '.started_at // empty')"
  PROD_COMPLETED_AT="$(echo "$PROD_JOB_JSON" | jq -r '.completed_at // empty')"

  [ "$PROD_CONCLUSION" != "cancelled" ] && continue
  [ -z "$PROD_STARTED_AT" ] && continue
  [ -z "$PROD_COMPLETED_AT" ] && continue

  PROD_STARTED_EPOCH="$(date -u -d "$PROD_STARTED_AT" +%s 2>/dev/null || echo 0)"
  PROD_COMPLETED_EPOCH="$(date -u -d "$PROD_COMPLETED_AT" +%s 2>/dev/null || echo 0)"
  # Round-3 confirmation review: the `|| echo 0` fallback above is
  # asymmetric -- if ONE of the two timestamps fails to parse while the
  # other succeeds, the subtraction below produces a multi-billion-second
  # "dwell" (completed_epoch minus zero, or zero minus a large epoch),
  # which would guarantee a false positive on every affected row. Skip
  # explicitly rather than let a parse failure masquerade as a huge dwell.
  if [ "$PROD_STARTED_EPOCH" -eq 0 ] || [ "$PROD_COMPLETED_EPOCH" -eq 0 ]; then
    continue
  fi
  DWELL_SECONDS=$(( PROD_COMPLETED_EPOCH - PROD_STARTED_EPOCH ))

  [ "$DWELL_SECONDS" -lt "$DWELL_THRESHOLD_SECONDS" ] && continue

  echo "[prod-deploy-monitor] CONFIRMED: run ${RUN_ID} (commit ${HEAD_SHA}) had a cancelled '${JOB_NAME}' job that dwelled ${DWELL_SECONDS}s (>= ${DWELL_THRESHOLD_SECONDS}s threshold) before cancellation, with all upstream jobs green"

  # --- 4. Dedup: has this run already been reported? -----------------------
  EXISTING="$(run_gh issue list --search "\"run ${RUN_ID}\" in:body" --state all --json number -q '.[0].number' 2>/dev/null || echo "")"
  if [ -n "${EXISTING:-}" ] && [ "$EXISTING" != "null" ]; then
    echo "[prod-deploy-monitor] already reported as issue #${EXISTING}, skipping (not a new alert this tick)"
    continue
  fi

  SHADOW="${SKILLSMITH_PROD_DEPLOY_CANCEL_MONITOR_SHADOW:-1}"
  if [ "$SHADOW" = "1" ]; then
    echo "[prod-deploy-monitor] [shadow] WOULD open issue for run ${RUN_ID} (not a new alert this tick -- shadow mode logs only)"
    continue
  fi

  run_gh label create "$STABLE_LABEL" --color b60205 --force >/dev/null 2>&1 || true

  BODY="## Production deploy job cancelled

A \`${JOB_NAME}\` job in \`${WORKFLOW_FILE}\` was cancelled after reaching
the required-reviewer approval gate (or while actively deploying) -- this
is the exact incident class SMI-6208 was filed for (a silent, undeployed
production regression with no visible symptom other than the live site
staying stale).

- **Run:** ${RUN_URL} (run ${RUN_ID})
- **Commit:** ${HEAD_SHA}
- **Detected:** ${NOW_ISO}

### What to check
1. Was this an intentional manual cancellation (someone decided not to ship
   this commit, e.g. a reviewer correctly declining a superseded run)? If
   so, no action needed -- close this issue. This detector cannot
   distinguish an intentional cancel from an accidental one; that's a
   deliberate, accepted trade-off (see the implementation plan's Testing
   and Open Questions sections) -- triage manually.
2. If NOT intentional: confirm the currently-live production commit is
   actually the latest tested \`main\` commit. If it's stale, re-run
   \`website-deploy-staging.yml\` (\`workflow_dispatch\`) or push a no-op
   commit to re-trigger it.
3. If this recurs, check whether \`website-deploy-staging.yml\`'s
   \`approve-gate\` job-level concurrency group
   (\`website-production-approve-*\`, run-ID-keyed, \`cancel-in-progress:
   false\`) was accidentally reverted or weakened -- that mechanism is what
   should prevent this class of cancellation. See
   docs/internal/implementation/website-deploy-approval-cancel-fix.md.

_Auto-generated by \`scripts/prod-deploy-cancel-monitor.sh\` (SMI-6208)._"

  NEW_URL="$(run_gh issue create --label "$STABLE_LABEL" \
    --title "Production deploy cancelled while pending -- run ${RUN_ID} (commit ${HEAD_SHA:0:7})" \
    --body "$BODY" 2>/dev/null || echo "")"
  echo "[prod-deploy-monitor] created issue: ${NEW_URL:-<failed>}"
  NEW_ALERT=1

done < <(echo "$RUNS_JSON" | jq -r '.[] | [.databaseId, .headSha, .createdAt, .url] | @tsv')

if [ "$NEW_ALERT" -eq 1 ]; then
  exit 1
fi

echo "[prod-deploy-monitor] healthy: no NEW alert-worthy cancelled production-deploy jobs this tick"
exit 0
