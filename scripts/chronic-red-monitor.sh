#!/usr/bin/env bash
# SMI-4974: detect workflows that have failed THRESHOLD consecutive runs
# on main AND are NOT in the explicit required-backing allowlist below.
# Post one alert-notify per chronic-red workflow.
set -euo pipefail

: "${THRESHOLD:=3}"
: "${SUPABASE_URL:?required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?required}"

REPO="${GITHUB_REPOSITORY:-smith-horn/skillsmith}"

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
    curl -s -X POST \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "$SUPABASE_URL/functions/v1/alert-notify" || true
    alerts=$((alerts + 1))
  fi
done <<< "$all_workflows"

echo "Chronic-red monitor finished: $alerts alert(s) posted"
