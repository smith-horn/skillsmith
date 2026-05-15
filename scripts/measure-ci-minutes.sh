#!/usr/bin/env bash
# SMI-4908: measure CI-minute delta around a merge SHA.
#
# Usage:
#   ./scripts/measure-ci-minutes.sh <merge-sha> [n=10]
#
# Args:
#   merge-sha  the commit SHA on main where the change merged
#   n          number of merged PRs before/after to sample (default 10)
#
# Output (stdout):
#   markdown table — PR | sha | total_billable_ms | jobs_count
#   plus before/after sums and delta in CI-minutes.
#
# Exit codes:
#   0   success
#   1   fewer than 5 timing samples on either side (insufficient signal)
#   2   missing prerequisites (gh, jq) or bad args
#
# Failure modes:
#   - GHA timing API has retention limits (typically 90 days for billable
#     breakdown). Individual run lookups that 404 print a warning to stderr
#     and skip that PR; full failure only if < 5 valid samples per side.

set -euo pipefail

REPO="${REPO:-Smith-Horn/skillsmith}"
N="${2:-10}"

if [ $# -lt 1 ]; then
  echo "usage: $0 <merge-sha> [n=10]" >&2
  exit 2
fi
SHA="$1"

command -v gh >/dev/null || { echo "missing: gh CLI" >&2; exit 2; }
command -v jq >/dev/null || { echo "missing: jq" >&2; exit 2; }

# Fetch the merge commit's date as the pivot point.
PIVOT_ISO=$(gh api "repos/$REPO/commits/$SHA" --jq .commit.committer.date) || {
  echo "could not resolve commit $SHA in $REPO" >&2
  exit 2
}

# List merged PRs on main, partition before/after by mergedAt.
mapfile -t PR_LINES < <(
  gh pr list --repo "$REPO" --state merged --base main \
    --limit $((N * 5)) \
    --json number,mergeCommit,mergedAt \
    --jq '.[] | [.number, (.mergeCommit.oid // ""), .mergedAt] | @tsv'
)

before=()
after=()
for line in "${PR_LINES[@]}"; do
  IFS=$'\t' read -r pr_num pr_sha pr_merged <<<"$line"
  [ -z "$pr_sha" ] && continue
  [ "$pr_sha" = "$SHA" ] && continue
  if [[ "$pr_merged" < "$PIVOT_ISO" ]]; then
    [ ${#before[@]} -lt "$N" ] && before+=("$pr_num:$pr_sha")
  else
    [ ${#after[@]} -lt "$N" ] && after+=("$pr_num:$pr_sha")
  fi
done

sum_minutes() {
  local label="$1"; shift
  local total_ms=0 valid=0
  echo "## $label"
  printf "| PR | sha | billable_ms | jobs |\n|---|---|---|---|\n"
  for entry in "$@"; do
    pr_num="${entry%%:*}"
    pr_sha="${entry##*:}"
    # Find the most recent ci.yml run for this SHA.
    run_id=$(gh api "repos/$REPO/actions/runs?head_sha=$pr_sha&per_page=20" \
      --jq '.workflow_runs[] | select(.path == ".github/workflows/ci.yml") | .id' \
      | head -1)
    if [ -z "$run_id" ]; then
      echo "warn: PR #$pr_num sha=$pr_sha — no ci.yml run found, skipping" >&2
      continue
    fi
    timing=$(gh api "repos/$REPO/actions/runs/$run_id/timing" 2>/dev/null) || {
      echo "warn: PR #$pr_num run=$run_id — timing unavailable, skipping" >&2
      continue
    }
    ms=$(jq -r '.run_duration_ms // 0' <<<"$timing")
    jobs=$(gh api "repos/$REPO/actions/runs/$run_id/jobs" --jq '.jobs | length' 2>/dev/null || echo 0)
    total_ms=$((total_ms + ms))
    valid=$((valid + 1))
    printf "| #%s | %s | %s | %s |\n" "$pr_num" "${pr_sha:0:8}" "$ms" "$jobs"
  done
  echo ""
  echo "$label: $valid valid samples, total ${total_ms} ms ($(awk "BEGIN{printf \"%.1f\", $total_ms/60000}") min)"
  echo ""
  # Stash for delta calculation.
  echo "$valid:$total_ms" > "/tmp/ci-minutes-$label.txt"
}

sum_minutes "before" "${before[@]}"
sum_minutes "after"  "${after[@]}"

before_data=$(cat /tmp/ci-minutes-before.txt)
after_data=$(cat /tmp/ci-minutes-after.txt)
before_valid="${before_data%%:*}"
before_ms="${before_data##*:}"
after_valid="${after_data%%:*}"
after_ms="${after_data##*:}"

if [ "$before_valid" -lt 5 ] || [ "$after_valid" -lt 5 ]; then
  echo "insufficient samples: before=$before_valid, after=$after_valid (need >=5 each)" >&2
  exit 1
fi

before_avg_min=$(awk "BEGIN{printf \"%.2f\", $before_ms/60000/$before_valid}")
after_avg_min=$(awk "BEGIN{printf \"%.2f\", $after_ms/60000/$after_valid}")
delta_min=$(awk "BEGIN{printf \"%.2f\", $before_avg_min - $after_avg_min}")

echo "## Summary"
echo ""
echo "| Window | PRs | Avg CI-min/PR |"
echo "|---|---|---|"
echo "| before $SHA | $before_valid | $before_avg_min |"
echo "| after  $SHA | $after_valid | $after_avg_min |"
echo "| **delta** | | **$delta_min min/PR saved** |"
