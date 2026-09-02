#!/usr/bin/env bash
# smi-6200-e3-uat-chain.sh -- SMI-6200 E3 UAT scenario matrix, C1 chained lifecycle (Lane A).
# See docs/internal/implementation/smi-6200-e3-uat-scenario-matrix.md section 5.
#
# Usage: varlock run -- ./scripts/staging/smi-6200-e3-uat-chain.sh <phase> [--timeout=<seconds>]
# Phases run in order; state persists across invocations via $WORKDIR (see helpers).
#   setup   -- fixture cast + SAML provider/domain + C1.1 (login) + C1.2 (unmapped) + C1.3 (G0/G-2)
#   chain1  -- C1.4 - C1.10 (link, notify, grant, device-login, shadow check, key fixture, refresh)
#             then PAUSES at checkpoint B-CP1 (matrix sec.12)
#   chain2  -- C1.11 - C1.12 (second session, expiry sweep)
#             then PAUSES at checkpoint B-CP2 (matrix sec.12)
#   chain3  -- C1.13 - C1.14 (re-auth from stale/fresh session)
#             then PAUSES at checkpoint B-CP3 (matrix sec.12)
#   chain4  -- C1.15 - C1.16 (seat guard, refusal vocabulary) -- no checkpoint
#
# Checkpoint/sentinel pause protocol (matrix sec.12): chain1/chain2/chain3 each end by
# writing $WORKDIR/checkpoint-<B-CPn>.json (fixture UUIDs + live session tokens + the
# matrix's own "fires after"/"browser work"/"state handed off" text) and then BLOCKING,
# polling every 2s, until a browser agent (or a human) `touch`es the matching
# $WORKDIR/go-<B-CPn> sentinel file. This is what stops the chain from racing straight
# through C1 into the Z-series/Q-series without the required browser verification (see
# smi-6200-e3-uat-chain.helpers.sh's checkpoint_pause() for the exact JSON shape and the
# rationale for each design choice). Each pause has a safety-valve timeout, default 30
# minutes (1800s), configurable via `--timeout=<seconds>` on this invocation or the
# SMI6200_CHECKPOINT_TIMEOUT_SECONDS env var (the flag wins if both are given) -- past
# the timeout the phase REFUSES (exit 1) rather than hanging forever.
set -euo pipefail

# Parse args before sourcing helpers: --timeout, if given, must be exported as
# SMI6200_CHECKPOINT_TIMEOUT_SECONDS before helpers.sh reads it into
# CHECKPOINT_TIMEOUT_SECONDS at source time.
PHASE=""
for arg in "$@"; do
  case "$arg" in
    --timeout=*)
      export SMI6200_CHECKPOINT_TIMEOUT_SECONDS="${arg#--timeout=}"
      ;;
    --timeout)
      echo "usage: --timeout=<seconds> (equals form only, e.g. --timeout=900)" >&2
      exit 2
      ;;
    -*)
      echo "unknown flag: $arg" >&2
      exit 2
      ;;
    *)
      [ -z "$PHASE" ] && PHASE="$arg"
      ;;
  esac
done
: "${PHASE:?usage: smi-6200-e3-uat-chain.sh <setup|chain1|chain2|chain3|chain4> [--timeout=<seconds>]}"

source "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/smi-6200-e3-uat-chain.helpers.sh"

phase_setup() {
  echo "=== PHASE: setup ==="
  echo "--- pre-flight self-heal ---"
  for email in "$OWNER_EMAIL" "$ADMIN_EMAIL" "$LEGACY_EMAIL" "$SSO_EMAIL" "$OUTSIDER_EMAIL"; do
    ensure_clean_email "$email"
  done
  run_sql -c "DELETE FROM teams WHERE id = '$TEAM_ID';" >/dev/null
  LEFTOVER_PROVIDERS=$(curl -s "$STAGING_SUPABASE_URL/auth/v1/admin/sso/providers" \
    -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    | jq -r --arg d "$SAML_DOMAIN" '.items[] | select(.domains[]?.domain == $d) | .id')
  for pid in $LEFTOVER_PROVIDERS; do
    # only remove one WE registered before (tracked in $WORKDIR/saml_provider_id from a
    # prior partial run) -- never blindly delete every provider on example.com, since a
    # DIFFERENT concurrent harness (e.g. smi-6205's own run) could legitimately hold one.
    if [ -f "$WORKDIR/saml_provider_id" ] && [ "$pid" = "$(cat "$WORKDIR/saml_provider_id")" ]; then
      echo "  (self-heal) deleting our own leftover SAML provider $pid"
      curl -s -o /dev/null -X DELETE "$STAGING_SUPABASE_URL/auth/v1/admin/sso/providers/$pid" \
        -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
        -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY"
    fi
  done

  echo "--- setup: fixture cast ---"
  OWNER_ID=$(create_user "$OWNER_EMAIL" "$WORKDIR/owner_pw.txt"); echo "$OWNER_ID" > "$WORKDIR/owner_id"
  ADMIN_ID=$(create_user "$ADMIN_EMAIL" "$WORKDIR/admin_pw.txt"); echo "$ADMIN_ID" > "$WORKDIR/admin_id"
  LEGACY_ID=$(create_user "$LEGACY_EMAIL" "$WORKDIR/legacy_pw.txt"); echo "$LEGACY_ID" > "$WORKDIR/legacy_id"
  OUTSIDER_ID=$(create_user "$OUTSIDER_EMAIL" "$WORKDIR/outsider_pw.txt"); echo "$OUTSIDER_ID" > "$WORKDIR/outsider_id"
  password_login "$OWNER_EMAIL" "$WORKDIR/owner_pw.txt" "$WORKDIR/owner_token.txt"
  password_login "$ADMIN_EMAIL" "$WORKDIR/admin_pw.txt" "$WORKDIR/admin_token.txt"
  password_login "$LEGACY_EMAIL" "$WORKDIR/legacy_pw.txt" "$WORKDIR/legacy_token.txt"
  password_login "$OUTSIDER_EMAIL" "$WORKDIR/outsider_pw.txt" "$WORKDIR/outsider_token.txt"
  echo "  owner=$OWNER_ID admin=$ADMIN_ID legacy=$LEGACY_ID outsider=$OUTSIDER_ID"

  echo "--- setup: team + members + LEGACY's two license keys ---"
  LEGACY_ENT_KEY_ID=$(run_sql -c "SELECT gen_random_uuid()::text;")
  LEGACY_IND_KEY_ID=$(run_sql -c "SELECT gen_random_uuid()::text;")
  run_sql -c "
    INSERT INTO teams (id, name, owner_id, max_members)
    VALUES ('$TEAM_ID', 'E2E E3 6200 Team', '$OWNER_ID', 3)
    ON CONFLICT (id) DO UPDATE SET max_members = EXCLUDED.max_members;

    -- LEGACY is deliberately NOT inserted as a team_members row here. max_members=3 and
    -- OWNER+ADMIN already = 2; if LEGACY joined now the team would already be AT capacity
    -- before C1.3's own SSO JIT provisioning runs, and record_sso_login()'s seat guard
    -- (v_member_count + v_pending_count >= v_max_members) would refuse SSO's own
    -- provisioning with seat_limit_reached -- tripped this live during harness
    -- construction. LEGACY's team_members row is inserted at the start of chain1, AFTER
    -- C1.3/G0 has already succeeded with only 2 members, and BEFORE C1.5's link (which is
    -- what actually needs it, to have a role to move onto the SSO identity).
    INSERT INTO team_members (team_id, user_id, role, provisioned_via, joined_at)
    VALUES
      ('$TEAM_ID', '$OWNER_ID', 'owner', 'manual', now()),
      ('$TEAM_ID', '$ADMIN_ID', 'admin', 'manual', now())
    ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role;

    INSERT INTO license_keys (id, user_id, key_hash, key_prefix, name, tier, status)
    VALUES
      ('$LEGACY_ENT_KEY_ID', '$LEGACY_ID', md5('$LEGACY_ENT_KEY_ID'||'ent'), 'sk_e2e_ent', 'E2E fixture (enterprise)', 'enterprise', 'active'),
      ('$LEGACY_IND_KEY_ID', '$LEGACY_ID', md5('$LEGACY_IND_KEY_ID'||'ind'), 'sk_e2e_ind', 'E2E fixture (individual)', 'individual', 'active')
    ON CONFLICT (id) DO NOTHING;

    -- FIXTURE FIX (found live during harness construction): a real Enterprise SSO team has
    -- an active enterprise subscription -- without one, recompute_user_tier() legitimately
    -- falls back to 'community' for every member (own subs UNION team subs, both filtered to
    -- active/trialing/past_due; NULL teams.subscription_id contributes nothing), which would
    -- make C1.9b/C1.10's issued key land at tier=community -- outside the ('team','enterprise')
    -- set every downstream refresh/reissue/revoke branch is scoped to. This is a fixture gap,
    -- not a product bug: the product's fallback-to-community behavior is correct given no
    -- subscription exists.
    INSERT INTO subscriptions (user_id, tier, status, billing_period, seat_count, current_period_start, current_period_end)
    VALUES ('$OWNER_ID', 'enterprise', 'active', 'monthly', 10, now(), now() + interval '30 days')
    ON CONFLICT DO NOTHING;

    -- Fixed (SMI-6200 UAT re-run, 2026-08-31): the original \gset-based capture of the
    -- just-inserted subscription id doesn't survive run_sql's single -c invocation (psql
    -- returned a plain SQL syntax error on the literal backslash -- run_sql pipes through
    -- pooler-psql.sh non-interactively, which does not parse psql meta-commands the way an
    -- interactive/script session does). Dropped \gset entirely and rely solely on the
    -- subquery fallback below, which already correctly finds the row whether it was just
    -- inserted or pre-existing from a prior run -- the COALESCE's first arm was always
    -- redundant with the second once ON CONFLICT DO NOTHING can no-op.
    UPDATE teams SET subscription_id = (SELECT id FROM subscriptions WHERE user_id = '$OWNER_ID' AND tier='enterprise' LIMIT 1)
     WHERE id = '$TEAM_ID' AND subscription_id IS NULL;

    -- Fixed (SMI-6200 UAT re-run, 2026-08-31, live finding): profiles.tier is a
    -- MATERIALIZED column -- recompute_user_tier() only runs (and only WRITES the new
    -- value) when explicitly called; it is never triggered automatically by an INSERT
    -- into subscriptions or teams. The comment above this block assumed inserting the
    -- subscription would be enough for recompute_user_tier() to '(legitimately) resolve
    -- to enterprise' -- true of the SELECT the function runs, false of profiles.tier
    -- actually reflecting that until this call lands. Without it, OWNER/ADMIN/LEGACY's
    -- own account pages (and C1.9b/C1.10's key issuance) see a stale tier='community'
    -- despite a genuinely active enterprise subscription -- confirmed live via
    -- /account/subscription showing "Community Plan" + a not_team_tier gate banner for
    -- OWNER immediately after this phase, with the DB showing subscription_id correctly
    -- linked and status='active' the whole time. Call it for every member already on the
    -- team at this point (owner+admin here; legacy/sso join later and get their own calls
    -- at their respective join points in chain1).
    SELECT recompute_user_tier('$OWNER_ID');
    SELECT recompute_user_tier('$ADMIN_ID');
  " >/dev/null
  echo "$LEGACY_ENT_KEY_ID" > "$WORKDIR/legacy_ent_key_id"
  echo "$LEGACY_IND_KEY_ID" > "$WORKDIR/legacy_ind_key_id"
  echo "  team ready (max_members=3, 3 members: owner/admin/legacy). legacy keys: ent=$LEGACY_ENT_KEY_ID ind=$LEGACY_IND_KEY_ID"

  echo "--- setup: register Mock SAML provider + SSO settings + verified domain ---"
  PROVIDER_JSON=$(curl -s -X POST "$STAGING_SUPABASE_URL/auth/v1/admin/sso/providers" \
    -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    --data-raw "$(jq -n --arg u "$SAML_METADATA_URL" --arg d "$SAML_DOMAIN" '{type:"saml",metadata_url:$u,domains:[$d]}')")
  SAML_PROVIDER_ID=$(echo "$PROVIDER_JSON" | jq -r '.id')
  [ -n "$SAML_PROVIDER_ID" ] && [ "$SAML_PROVIDER_ID" != "null" ] || {
    echo "REFUSING: SAML provider registration failed: $PROVIDER_JSON" >&2; exit 1; }
  echo "$SAML_PROVIDER_ID" > "$WORKDIR/saml_provider_id"
  echo "  registered SAML provider $SAML_PROVIDER_ID"

  run_sql -c "
    INSERT INTO team_sso_settings (team_id, supabase_provider_id, reverify_days, role_mapping, status, configured_by)
    VALUES ('$TEAM_ID', '$SAML_PROVIDER_ID', 7,
            '{\"admin\":[\"skillsmith-admins\"],\"member\":[\"skillsmith-members\"]}'::jsonb,
            'active', '$OWNER_ID')
    ON CONFLICT (team_id) DO UPDATE SET supabase_provider_id = EXCLUDED.supabase_provider_id,
      status = 'active', role_mapping = EXCLUDED.role_mapping;

    INSERT INTO team_sso_domains (team_id, domain, verification_token, verified_at, last_verified_at)
    VALUES ('$TEAM_ID', '$SAML_DOMAIN', 'e2e-6200-fixture-token', now(), now())
    ON CONFLICT (team_id, domain) DO UPDATE SET verified_at = now(), last_verified_at = now();
  " >/dev/null
  echo "  team_sso_settings + verified domain ready (reverify_days=7)"

  echo "--- C1.1: real Mock SAML login (SSO identity) ---"
  SSO_USER_ID=$(mock_saml_login "$SSO_EMAIL" "$WORKDIR/sso_token1.txt")
  echo "$SSO_USER_ID" > "$WORKDIR/sso_user_id"
  echo "  JIT-provisioned SSO identity: $SSO_USER_ID"
  PROVIDER_CLAIM=$(jwt_claim "$(cat "$WORKDIR/sso_token1.txt")" '.app_metadata.provider')
  AMR_METHOD=$(jwt_claim "$(cat "$WORKDIR/sso_token1.txt")" '.amr[0].method')
  AMR_TS=$(jwt_claim "$(cat "$WORKDIR/sso_token1.txt")" '.amr[0].timestamp')
  SUB_CLAIM=$(jwt_claim "$(cat "$WORKDIR/sso_token1.txt")" '.sub')
  echo "$AMR_TS" > "$WORKDIR/c1_amr_ts"
  echo "  provider=$PROVIDER_CLAIM amr.method=$AMR_METHOD amr.timestamp=$AMR_TS sub=$SUB_CLAIM"
  [ "$PROVIDER_CLAIM" = "sso:$SAML_PROVIDER_ID" ] && ok "C1.1 provider claim equals team_sso_settings.supabase_provider_id" \
    || bad "C1.1 provider claim '$PROVIDER_CLAIM' != expected 'sso:$SAML_PROVIDER_ID'"
  [ "$AMR_METHOD" = "sso/saml" ] && ok "C1.1 amr[0].method == sso/saml" || bad "C1.1 amr[0].method got '$AMR_METHOD'"
  [ "$SUB_CLAIM" = "$SSO_USER_ID" ] && ok "C1.1 sub claim matches JIT-provisioned user id" || bad "C1.1 sub mismatch"

  echo "--- C1.2: record_sso_login() before G-2 patch (groups-claim ceiling) ---"
  STATUS=$(rpc record_sso_login "$WORKDIR/sso_token1.txt" '{}')
  assert_status 200 "$STATUS" "C1.2 record_sso_login callable by real SSO session"
  assert_jq_eq '.status' 'unmapped' "C1.2 first login with no group match returns status=unmapped"
  assert_jq_eq '.team_id' "$TEAM_ID" "C1.2 binding resolved the correct team despite unmapped role"
  TM_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$SSO_USER_ID';")
  [ "$TM_COUNT" = "0" ] && ok "C1.2 no team_members row created for unmapped login" \
    || bad "C1.2 expected 0 team_members rows, got $TM_COUNT"
  AUDIT_EVENT=$(run_sql -c "SELECT event_type FROM audit_logs WHERE actor = '$SSO_USER_ID' ORDER BY created_at DESC LIMIT 1;")
  [ "$AUDIT_EVENT" = "sso:login_unmapped" ] && ok "C1.2 audit newest row is sso:login_unmapped" \
    || bad "C1.2 expected sso:login_unmapped, got '$AUDIT_EVENT'"

  echo "--- C1.3 (G0): G-2 procedure -- patch identity_data, verify, call record_sso_login() with C1.1's token ---"
  g2_patch_and_verify "$SSO_USER_ID"
  STATUS=$(rpc record_sso_login "$WORKDIR/sso_token1.txt" '{}')
  assert_status 200 "$STATUS" "C1.3 record_sso_login callable with G-2 substituted claim"
  echo "[G-2 SUBSTITUTED CLAIM] C1.3"
  G0_STATUS=$(jq -r '.status' "$WORKDIR/last_body.json")
  G0_ROLE=$(jq -r '.role' "$WORKDIR/last_body.json")
  echo "  G0 result: status=$G0_STATUS role=$G0_ROLE"
  if [ "$G0_STATUS" = "ok" ] && { [ "$G0_ROLE" = "admin" ] || [ "$G0_ROLE" = "member" ]; }; then
    ok "G0 PASSED: status=ok role=$G0_ROLE"
  else
    bad "G0 FAILED: status=$G0_STATUS role=$G0_ROLE (body: $(last_body))"
    echo "REFUSING: G0 did not pass -- per the matrix, stop the chain here." >&2
    echo "PASS=$PASS FAIL=$FAIL UNCOVERED=$UNCOVERED CHARACTERIZED=$CHARACTERIZED"
    exit 1
  fi
  TM_ROW=$(run_sql_aligned -c "SELECT role, provisioned_via, sso_verified_at FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$SSO_USER_ID';")
  echo "$TM_ROW"
  TM_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$SSO_USER_ID' AND provisioned_via = 'sso';")
  [ "$TM_COUNT" = "1" ] && ok "C1.3 exactly one team_members row with provisioned_via='sso'" \
    || bad "C1.3 expected exactly 1 sso-provisioned team_members row, got $TM_COUNT"
  echo "$G0_ROLE" > "$WORKDIR/sso_role_after_c13"

  echo "=== end phase setup === PASS=$PASS FAIL=$FAIL UNCOVERED=$UNCOVERED CHARACTERIZED=$CHARACTERIZED"
}


source "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/smi-6200-e3-uat-chain.phase1.sh"
source "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/smi-6200-e3-uat-chain.phase234.sh"

case "$PHASE" in
  setup) phase_setup ;;
  chain1) phase_chain1 ;;
  chain2) phase_chain2 ;;
  chain3) phase_chain3 ;;
  chain4) phase_chain4 ;;
  *) echo "phase $PHASE not yet implemented in this invocation of the script" >&2; exit 2 ;;
esac
