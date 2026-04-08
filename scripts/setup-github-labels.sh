#!/usr/bin/env bash
#
# setup-github-labels.sh — Bootstrap the canonical Skillsmith label taxonomy on GitHub.
#
# Purpose:
#   GitHub Issue Forms (.github/ISSUE_TEMPLATE/*.yml) reference labels via top-level
#   `labels: [...]` directives. Those labels must already exist on the repo or the
#   form submission fails. This script is a ONE-TIME provisioning helper — run it
#   once at merge time of the issue-templates PR (SMI-XXX), then never again.
#
# Idempotency:
#   Every `gh label create` call is suffixed with `2>/dev/null || true` so re-runs
#   are harmless. Pre-existing labels are preserved (workflows like billing-monitor.yml,
#   linear-drift-audit.yml, security-scan.yml create their own labels on demand and
#   this script must not clobber them).
#
# Color-drift verification (review fix #7):
#   After provisioning, the script diffs `gh label list` against the in-script
#   taxonomy and prints warnings (NOT errors) for any color mismatches on labels
#   that already existed. Operators can then decide whether to manually reconcile.
#
# Canonical source:
#   ~/.claude/skills/linear/docs/labels.md
#
# Usage:
#   ./scripts/setup-github-labels.sh
#
# Requires: gh CLI authenticated to smith-horn/skillsmith
#
set -euo pipefail

REPO="smith-horn/skillsmith"

# ---------------------------------------------------------------------------
# Taxonomy (26 labels total: 5 Type + 13 Domain + 7 Scope + 1 Workflow)
# Format: "<name>|<color-without-hash>|<description>"
# ---------------------------------------------------------------------------
TAXONOMY=(
  # Type (5) — exactly one required per issue
  "feature|A2EEEF|New functionality"
  "bug|D73A4A|Broken behavior"
  "refactor|D4C5F9|Improve code without changing behavior"
  "chore|FEF2C0|Maintenance, deps, tooling"
  "spike|FBCA04|Research or investigation"

  # Domain (13) — 1-2 recommended per issue
  "security|B60205|Auth, encryption, vulnerabilities"
  "performance|0E8A16|Speed, latency, optimization"
  "infrastructure|0052CC|CI/CD, deployment, DevOps"
  "testing|C5DEF5|Tests, coverage, QA"
  "reliability|5319E7|Fault tolerance, consensus"
  "core|1D76DB|Business logic, core features"
  "frontend|BFD4F2|UI, styling, web"
  "backend|006B75|APIs, server, database"
  "integration|F9D0C4|Third-party services"
  "documentation|0075CA|Docs, guides"
  "mcp|7057FF|MCP tools and servers"
  "cli|FBCA04|Command-line tools"
  "neural|E99695|AI/ML components"

  # Scope (7) — 0-2 optional per issue
  "breaking-change|B60205|Breaks backward compatibility"
  "tech-debt|5319E7|Addresses technical debt"
  "blocked|D73A4A|Waiting on dependency"
  "needs-split|FBCA04|Too large, needs breakdown"
  "good-first-issue|7057FF|Good for newcomers"
  "enterprise|7057FF|Enterprise-tier only"
  "soc2|0052CC|Compliance requirement"

  # Workflow (1) — applied automatically by Issue Forms, removed by maintainers after triage
  "needs-triage|E4E669|Awaiting maintainer triage into Linear"
)

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not found. Install from https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh CLI not authenticated. Run: gh auth login" >&2
  exit 1
fi

echo "==> Provisioning ${#TAXONOMY[@]} labels on ${REPO}"
echo

# ---------------------------------------------------------------------------
# Provision labels (idempotent)
# ---------------------------------------------------------------------------
created=0
skipped=0
for entry in "${TAXONOMY[@]}"; do
  name="${entry%%|*}"
  rest="${entry#*|}"
  color="${rest%%|*}"
  description="${rest#*|}"

  if gh label create "$name" --repo "$REPO" --color "$color" --description "$description" 2>/dev/null; then
    echo "  + created: $name (#$color)"
    created=$((created + 1))
  else
    echo "  = exists:  $name"
    skipped=$((skipped + 1))
  fi
done

echo
echo "==> Provisioning summary: $created created, $skipped already existed"
echo

# ---------------------------------------------------------------------------
# Color-drift verification pass (review fix #7)
#
# Fetches the live label set, compares colors against TAXONOMY, and prints
# warnings for mismatches. Does NOT fail — operator decides reconciliation.
# ---------------------------------------------------------------------------
echo "==> Color-drift verification"

if ! live_labels_json=$(gh label list --repo "$REPO" --limit 200 --json name,color 2>/dev/null); then
  echo "  WARNING: could not fetch live label list for drift check (gh list failed)."
  echo "  Skipping drift verification. Provisioning completed successfully above."
  exit 0
fi

drift_count=0
for entry in "${TAXONOMY[@]}"; do
  name="${entry%%|*}"
  rest="${entry#*|}"
  expected_color="${rest%%|*}"

  # jq extracts the live color for this label (empty string if label missing,
  # though the provisioning loop above should have created any missing ones).
  live_color=$(printf '%s' "$live_labels_json" \
    | jq -r --arg n "$name" '.[] | select(.name == $n) | .color // ""')

  if [ -z "$live_color" ]; then
    echo "  ! missing:  $name (expected #$expected_color) — creation may have failed"
    drift_count=$((drift_count + 1))
    continue
  fi

  # GitHub returns colors lowercase without leading #. Normalize for comparison.
  live_upper=$(printf '%s' "$live_color" | tr '[:lower:]' '[:upper:]')
  expected_upper=$(printf '%s' "$expected_color" | tr '[:lower:]' '[:upper:]')

  if [ "$live_upper" != "$expected_upper" ]; then
    echo "  ! drift:    $name — live #$live_upper vs expected #$expected_upper"
    drift_count=$((drift_count + 1))
  fi
done

echo
if [ "$drift_count" -eq 0 ]; then
  echo "==> Drift check: OK (0 mismatches)"
else
  echo "==> Drift check: $drift_count warning(s). Pre-existing labels may have"
  echo "    different colors than the taxonomy. Reconcile manually if desired via:"
  echo "      gh label edit <name> --repo $REPO --color <hex>"
fi

echo
echo "Done. Safe to re-run (idempotent)."
