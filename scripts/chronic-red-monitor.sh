#!/usr/bin/env bash
# SMI-4974: detect workflows that have failed THRESHOLD consecutive runs
# on main AND are NOT in the explicit required-backing allowlist below.
# Post one alert-notify per chronic-red workflow.
#
# SMI-5005: cross-run alert dedup via GHA artifact-backed state file.
# At workflow start, the chronic-red-monitor.yml workflow restores the
# most-recent non-expired `chronic-red-state` artifact via `gh api`
# (cross-run fetch — `actions/download-artifact` can only fetch within
# the same run). The state file maps workflow file names to the SHA of
# the last failure we alerted on. If the current failing SHA matches the
# stored SHA, we skip the alert. Otherwise we alert AND update the
# stored SHA — BUT only if alert-notify returned 2xx (M-2 fix: a
# transient Supabase outage must NOT permanently suppress future
# alerts).
set -euo pipefail

: "${THRESHOLD:=3}"
: "${SUPABASE_URL:?required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?required}"

REPO="${GITHUB_REPOSITORY:-smith-horn/skillsmith}"

# SMI-5005: state-file path. The workflow restores the prior run's
# artifact into $STATE_DIR before invoking this script. Defaults to
# /tmp for ad-hoc local testing.
STATE_DIR="${STATE_DIR:-/tmp}"
STATE_FILE="$STATE_DIR/state.json"
mkdir -p "$STATE_DIR"
[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

stored_sha_for() {
  # `// ""` (clearer than `// empty` under set -euo pipefail).
  jq -r --arg w "$1" '.[$w] // ""' "$STATE_FILE"
}

update_stored_sha() {
  local w="$1" sha="$2" tmp
  tmp=$(mktemp)
  jq --arg w "$w" --arg sha "$sha" '. + {($w): $sha}' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

# Required-backing workflow files — i.e., workflows whose jobs ARE in
# branch-protection.json's required_status_checks.contexts. Maintained
# explicitly because `gh api` returns context names (job-level `name:`)
# while `gh run list --workflow` requires file names; no direct mapping.
# Confirmed 2026-05-19 by grep over .github/workflows/*.yml job names:
#   - ci.yml provides: Secret Scan, Classify Changes, Package Validation,
#     PR Validation (Node/Shell), Quality Checks, plus Build, Build Docker
#     Image, Security Audit, Test (root), Test (root colocated), Markdown
#     Lint (10+ of 12 required contexts)
#   - docs-only.yml provides: Secret Scan + Markdown Lint for docs-only PRs
# Adding a new required workflow? Add its file name here.
REQUIRED_BACKING_FILES=("ci.yml" "docs-only.yml")

is_required_backing() {
  local f="$1"
  for r in "${REQUIRED_BACKING_FILES[@]}"; do
    [ "$f" = "$r" ] && return 0
  done
  return 1
}

# All active workflow file names (H-1 fix: pass file name to `gh run list`,
# not display name — display names are silently rejected by gh CLI).
all_workflows=$(gh api "repos/${REPO}/actions/workflows" --paginate \
  -q '.workflows[] | select(.state == "active") | .path | ltrimstr(".github/workflows/")')

echo "::group::Required-backing allowlist (${#REQUIRED_BACKING_FILES[@]} entries)"
printf '  %s\n' "${REQUIRED_BACKING_FILES[@]}"
echo "::endgroup::"

alerts=0
skipped_dup=0
while IFS= read -r workflow; do
  [ -z "$workflow" ] && continue
  if is_required_backing "$workflow"; then
    continue
  fi
  # Last N main-branch run conclusions for this workflow.
  conclusions=$(gh run list --workflow "$workflow" --branch main --limit "$THRESHOLD" --json conclusion -q '.[].conclusion' 2>/dev/null || true)
  # `grep -c` returns exit 1 when zero matches → would abort under `set -e`.
  # `|| true` guards both lines. Counts: total entries vs failure entries.
  count=$(echo "$conclusions" | grep -cv '^$' || true)
  fails=$(echo "$conclusions" | grep -c '^failure$' || true)
  if [ "$count" -eq "$THRESHOLD" ] && [ "$fails" -eq "$THRESHOLD" ]; then
    # SMI-5005: dedup check — fetch the current failing run's headSha
    # and compare with the stored SHA for this workflow.
    current_sha=$(gh run list --workflow "$workflow" --branch main --limit 1 \
      --json headSha -q '.[0].headSha' 2>/dev/null || true)
    stored=$(stored_sha_for "$workflow")

    if [ -z "$current_sha" ]; then
      # M-1: emit warning when dedup is bypassed (API blip / no main runs)
      echo "::warning::$workflow: could not fetch headSha, alerting without dedup"
    elif [ "$current_sha" = "$stored" ]; then
      echo "::notice::$workflow still failing at SHA $current_sha (already alerted) — skipping"
      skipped_dup=$((skipped_dup + 1))
      continue
    fi

    # Most recent failing run for the alert URL.
    run_info=$(gh run list --workflow "$workflow" --branch main --limit 1 --json databaseId,url -q '.[0]')
    run_id=$(echo "$run_info" | jq -r .databaseId)
    run_url=$(echo "$run_info" | jq -r .url)
    msg="\"$workflow\" has failed $THRESHOLD consecutive runs on main"
    body=$(jq -n \
      --arg msg "$msg" \
      --arg wf "$workflow" \
      --arg rid "$run_id" \
      --arg url "$run_url" \
      '{type:"chronic_red", message:$msg, workflow:$wf, runId:$rid, runUrl:$url}')
    echo "::warning::$msg ($run_url)"

    # SMI-5005 M-2: capture HTTP status; only update state on 2xx so a
    # transient Supabase outage doesn't permanently suppress alerts.
    http_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "$SUPABASE_URL/functions/v1/alert-notify" || echo "000")

    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      alerts=$((alerts + 1))
      if [ -n "$current_sha" ]; then
        update_stored_sha "$workflow" "$current_sha"
      fi
    else
      echo "::warning::alert-notify returned HTTP $http_code for $workflow — state not updated; will retry next run"
    fi
  fi
done <<< "$all_workflows"

echo "Chronic-red monitor finished: $alerts alert(s) posted, $skipped_dup dedup skip(s)"
