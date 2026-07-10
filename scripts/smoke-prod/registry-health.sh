#!/usr/bin/env bash
# SMI-5582 — Tier-1 skill drift canary.
#
# Verifies the three Tier-1 auto-install skills (getsentry/skill-writer,
# getsentry/commit, getsentry/code-review) are still resolvable in the registry,
# still marked as 'verified' tier, and still have a repo_url.
#
# If any skill check fails, opens a deduped GitHub issue with label
# 'tier1-skill-drift' (reused across runs).

# shellcheck shell=bash
# shellcheck source=scripts/smoke-prod/lib.sh
SMOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/lib.sh"

# Tier-1 skill IDs to monitor
TIER1_SKILLS=(
  "getsentry/skill-writer"
  "getsentry/commit"
  "getsentry/code-review"
)

# REGISTRY_HEALTH_URL: the tier1 drift canary must read the REAL PROD registry
# that end users query — always prod SUPABASE_URL, independent of the SMI-4755
# staging override (SMOKE_SKILLS_SUPABASE_URL) used by the usage-counter checks.
# Renamed from SMOKE_SKILLS_URL (SMI-5631) so this prod-pinned global can't
# collide with website.sh's staging-routed SMOKE_SKILLS_URL in the shared shell.
REGISTRY_HEALTH_URL="${SUPABASE_URL:-}"

_require_registry_health_creds() {
  if [ -z "$REGISTRY_HEALTH_URL" ]; then
    smoke_warn "SUPABASE_URL not set — failing tier1 drift check"
    return 1
  fi
  if [ -z "${SUPABASE_ANON_KEY:-}" ]; then
    smoke_warn "SUPABASE_ANON_KEY not set — failing tier1 drift check"
    return 1
  fi
  return 0
}

# Helper: Check one Tier-1 skill. Returns 0 if healthy, 1 if drift detected.
_check_tier1_skill() {
  local skill_id="$1"
  local encoded_id="${skill_id/\//%2F}"
  local url="${REGISTRY_HEALTH_URL}/functions/v1/skills-get?id=${encoded_id}"
  local t0 t1 ms resp status body tier repo_url

  t0=$(now_ms)
  # Authenticate to PROD with the anon key (SMI-5631): the `anon_key` auth
  # method (supabase/functions/_shared/auth-middleware.ts) is `authenticated`,
  # so it BYPASSES the per-IP trial limiter that 401s shared GitHub-runner
  # traffic. BOTH headers are required — `apikey:` alone returns 401
  # (live-verified). Do NOT drop either header.
  resp=$(with_retry http_body GET "$url" \
    -H "apikey: ${SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
    -H "Accept: application/json") || true
  t1=$(now_ms)
  ms=$((t1 - t0))

  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  # Parse JSON response. Extract trust_tier and repo_url fields.
  if ! command -v python3 >/dev/null 2>&1; then
    smoke_warn "python3 not available for JSON parsing"
    report_fail "tier1-skill-drift-canary" "check_tier1_skills_available" "$url" "HTTP 200 + verified tier" "python3-unavailable" "$ms"
    return 1
  fi

  # Check HTTP status first
  if [ "$status" != "200" ]; then
    report_fail "tier1-skill-drift-canary" "check_tier1_skills_available" "$url" "200" "$status" "$ms"
    return 1
  fi

  # skills-get wraps the skill in a `{ data: ... }` envelope (see
  # supabase/functions/skills-get/index.ts) — unwrap before reading fields.
  tier=$(printf '%s' "$body" | python3 -c "import sys,json; d=json.load(sys.stdin).get('data') or {}; print(d.get('trust_tier',''))" 2>/dev/null || echo "")
  repo_url=$(printf '%s' "$body" | python3 -c "import sys,json; d=json.load(sys.stdin).get('data') or {}; r=d.get('repo_url'); print(r or '')" 2>/dev/null || echo "")

  # Verify tier is 'verified'
  if [ "$tier" != "verified" ]; then
    report_fail "tier1-skill-drift-canary" "check_tier1_skills_available" "$url" "trust_tier=verified" "trust_tier=${tier:-missing}" "$ms"
    return 1
  fi

  # Verify repo_url is present and non-empty
  if [ -z "$repo_url" ]; then
    report_fail "tier1-skill-drift-canary" "check_tier1_skills_available" "$url" "repo_url present" "repo_url missing/null" "$ms"
    return 1
  fi

  return 0
}

check_tier1_skills_available() {
  _require_registry_health_creds || { report_fail "tier1-skill-drift-canary" "check_tier1_skills_available" "" "SUPABASE_URL+SUPABASE_ANON_KEY" "unset"; return 1; }

  local failed=0
  for skill_id in "${TIER1_SKILLS[@]}"; do
    if ! _check_tier1_skill "$skill_id"; then
      failed=1
    fi
  done

  if [ "$failed" = "1" ]; then
    # Open/update deduped GitHub issue if any skill failed
    _alert_tier1_drift
    return 1
  fi

  # All skills healthy
  report_pass "tier1-skill-drift-canary" "check_tier1_skills_available" "3 tier1 skills verified" "0"
  return 0
}

# Helper: Open or comment on deduped GitHub issue with tier1-skill-drift label
_alert_tier1_drift() {
  STABLE_LABEL="tier1-skill-drift"
  STABLE_TITLE="Tier-1 auto-install skill drift detected"

  BODY="## Tier-1 auto-install skill drift alert

One or more of the Tier-1 auto-install skills is no longer resolvable as 'verified' tier or missing repo_url:
- getsentry/skill-writer
- getsentry/commit
- getsentry/code-review

**Impact:** First-run auto-install will fail for new users / fresh installations.

**Remediation:** Check the registry status at https://www.skillsmith.app/skills and update \`TIER1_SKILLS\` in \`packages/mcp-server/src/onboarding/first-run.ts\` if the skills have been reorganized or deprecated.

_Auto-generated by \`scripts/smoke-prod/registry-health.sh\` (SMI-5582)._"

  # Search for existing open issue (dedup by label)
  EXISTING_ISSUE=$(gh issue list --label "$STABLE_LABEL" --state open --json number -q '.[0].number' 2>/dev/null || echo "")

  if [ -n "${EXISTING_ISSUE:-}" ] && [ "$EXISTING_ISSUE" != "null" ]; then
    smoke_log "tier1-drift: commenting on existing issue #${EXISTING_ISSUE}"
    COMMENT="**Still detecting drift.** See check output above."
    gh issue comment "$EXISTING_ISSUE" --body "$COMMENT" 2>/dev/null \
      || smoke_warn "tier1-drift: gh issue comment failed for #${EXISTING_ISSUE}"
  else
    smoke_log "tier1-drift: creating new issue: ${STABLE_TITLE}"
    NEW_URL=$(gh issue create \
      --label "$STABLE_LABEL" \
      --title "$STABLE_TITLE" \
      --body "$BODY" 2>/dev/null || echo "")
    if [ -n "${NEW_URL:-}" ]; then
      smoke_log "tier1-drift: created issue ${NEW_URL}"
    else
      smoke_warn "tier1-drift: gh issue create failed"
    fi
  fi
}
