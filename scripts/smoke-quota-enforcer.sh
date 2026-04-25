#!/usr/bin/env bash
# SMI-4463 Step 8 — Post-deploy production smoke test for monthly quota enforcement.
#
# Runs against PROD after `ENFORCE_COMMUNITY_QUOTA=true` is flipped on the
# skills-search edge function. Synthesizes an over-quota state for a
# pre-provisioned community-tier sentinel user, hits skills-search, and
# expects a 429 with `error: 'monthly_quota_exceeded'`.
#
# Project memory: only `vrcnzpmndtroqxxoqkzy` (prod) is acceptable.
# `ovhcifugwqnzoebwfuku` (staging) is rejected by the precondition check.
#
# Required env (varlock-injected):
#   QUOTA_SMOKE_SENTINEL          — community-tier sentinel user UUID (provisioned out-of-band)
#   SENTINEL_API_KEY              — sk_live_* API key for that user
#   SUPABASE_SERVICE_ROLE_KEY     — service-role key (DDL-bypass for usage upsert + cleanup)
#   SUPABASE_URL                  — must be https://vrcnzpmndtroqxxoqkzy.supabase.co
#   SUPABASE_PROJECT_REF          — vrcnzpmndtroqxxoqkzy
#   SUPABASE_DB_PASSWORD          — for pooler-psql.sh
#
# Usage:
#   varlock run -- ./scripts/smoke-quota-enforcer.sh
#
# Expected output: `PASS: 429 monthly_quota_exceeded`. Non-zero exit on any
# other outcome. Audit trail: query `audit_logs WHERE event_type LIKE 'quota:%'
# AND metadata->>'user_id' = '$QUOTA_SMOKE_SENTINEL'` after the run.

set -euo pipefail

: "${QUOTA_SMOKE_SENTINEL:?QUOTA_SMOKE_SENTINEL required (community-tier sentinel user UUID)}"
: "${SENTINEL_API_KEY:?SENTINEL_API_KEY required (sk_live_* for the sentinel user)}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY required}"
: "${SUPABASE_URL:?SUPABASE_URL required}"

# Hard guard: reject staging URL.
case "$SUPABASE_URL" in
  *vrcnzpmndtroqxxoqkzy*) ;;
  *)
    echo "FAIL: SUPABASE_URL must point at prod (vrcnzpmndtroqxxoqkzy). Refusing to run against $SUPABASE_URL." >&2
    exit 2
    ;;
esac

cleanup() {
  # Delete synthetic usage rows + any dedup-log rows the smoke run produced.
  echo "[cleanup] Removing synthetic rows for sentinel user..."
  varlock run -- ./scripts/pooler-psql.sh -c "
    DELETE FROM public.user_api_usage  WHERE user_id = '$QUOTA_SMOKE_SENTINEL';
    DELETE FROM public.quota_warning_log WHERE user_id = '$QUOTA_SMOKE_SENTINEL';
  " > /dev/null 2>&1 || echo "[cleanup] pooler-psql cleanup non-fatal warning"
}
trap cleanup EXIT

echo "[1/3] Push sentinel usage to 1001/1000..."
varlock run -- ./scripts/pooler-psql.sh -c "
  INSERT INTO public.user_api_usage (user_id, hour_bucket, search_count, get_count, recommend_count)
  VALUES ('$QUOTA_SMOKE_SENTINEL', date_trunc('hour', now()), 1001, 0, 0)
  ON CONFLICT (user_id, hour_bucket) DO UPDATE SET search_count = 1001;
" > /dev/null

echo "[2/3] Hit skills-search with sentinel API key..."
RESP=$(curl -sS -w "\n%{http_code}" \
  -H "X-API-Key: $SENTINEL_API_KEY" \
  "$SUPABASE_URL/functions/v1/skills-search?query=react")
CODE=$(echo "$RESP" | tail -n1)
BODY=$(echo "$RESP" | sed '$d')

echo "[3/3] Asserting 429 monthly_quota_exceeded..."
echo "  HTTP: $CODE"
echo "  Body: $BODY"

if [[ "$CODE" == "429" ]] && echo "$BODY" | jq -e '.error == "monthly_quota_exceeded"' > /dev/null; then
  echo "PASS: 429 monthly_quota_exceeded"
  exit 0
fi

echo "FAIL: expected 429 monthly_quota_exceeded; got code=$CODE body=$BODY" >&2
exit 1
