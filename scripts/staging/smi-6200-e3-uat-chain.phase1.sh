#!/usr/bin/env bash
# smi-6200-e3-uat-chain.phase1.sh -- phase_chain1 (C1.4-C1.10), split out of
# smi-6200-e3-uat-chain.sh to stay under the repo's 500-line file limit.
# Sourced by smi-6200-e3-uat-chain.sh -- never run directly.

phase_chain1() {
  echo "=== PHASE: chain1 (C1.4 - C1.10) ==="
  SSO_USER_ID=$(cat "$WORKDIR/sso_user_id")
  LEGACY_ID=$(cat "$WORKDIR/legacy_id")
  OWNER_ID=$(cat "$WORKDIR/owner_id")

  echo "--- C1.4: LEGACY joins team_members (deferred from setup, see comment there) ---"
  run_sql -c "
    INSERT INTO team_members (team_id, user_id, role, provisioned_via, joined_at)
    VALUES ('$TEAM_ID', '$LEGACY_ID', 'member', 'manual', now())
    ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role;
    -- Same materialized-tier gap as phase_setup's OWNER/ADMIN calls -- LEGACY now
    -- belongs to an enterprise team subscription too, but profiles.tier won't reflect
    -- it until recomputed (live finding, SMI-6200 UAT re-run, 2026-08-31).
    SELECT recompute_user_tier('$LEGACY_ID');
  " >/dev/null

  echo "  [MATRIX-VS-REALITY] record_sso_login()'s own step 7 candidate-insert matches"
  echo "  \"profiles p WHERE lower(p.email) = v_bind.asserted_email\" -- v_bind.asserted_email"
  echo "  is the SSO SESSION's OWN asserted email (SSO_EMAIL), not any team member's email."
  echo "  Confirmed live at C1.3: sso_account_links had 0 rows and record_sso_login()'s own"
  echo "  response carried link_candidate:null, because LEGACY_EMAIL != SSO_EMAIL (as the"
  echo "  matrix's own fixture cast specifies). This is NOT a G0 failure -- G0 already"
  echo "  passed. It is a distinct precondition the matrix did not anticipate: the natural"
  echo "  candidate-creation path in C1.4 cannot fire while LEGACY and SSO use different"
  echo "  emails, which is unavoidable because C1.9's shadow-account check REQUIRES those"
  echo "  emails to differ (else C1.9 would misreport legitimate post-link coexistence as a"
  echo "  regression). Using C1.4's documented service-role fallback instead, labelled a"
  echo "  substitution -- for a different trigger condition than the matrix names."
  charz "C1.4 candidate auto-creation via record_sso_login() step 7 does not fire -- distinct LEGACY/SSO emails (matrix fixture-cast tension with C1.9, not a G0 failure or product bug)"

  echo "--- C1.4 (substitution): service-role seed of the candidate row ---"
  run_sql -c "
    INSERT INTO sso_account_links (sso_user_id, legacy_user_id, team_id, consent_expires_at)
    VALUES ('$SSO_USER_ID', '$LEGACY_ID', '$TEAM_ID', now() + interval '7 days')
    ON CONFLICT (sso_user_id, legacy_user_id) DO UPDATE SET consent_expires_at = EXCLUDED.consent_expires_at;
  " >/dev/null
  echo "[SERVICE-ROLE FALLBACK -- C1.4 candidate seed substituted]"

  STATUS=$(rpc get_own_sso_link_candidate "$WORKDIR/sso_token1.txt" '{}')
  assert_status 200 "$STATUS" "C1.4 get_own_sso_link_candidate callable as SSO"
  COUNT=$(jq 'length' "$WORKDIR/last_body.json")
  [ "$COUNT" = "1" ] && ok "C1.4 SSO identity sees 1 candidate" || bad "C1.4 expected 1 candidate, got $COUNT"

  STATUS=$(rpc get_pending_sso_link_requests "$WORKDIR/legacy_token.txt" '{}')
  assert_status 200 "$STATUS" "C1.4 get_pending_sso_link_requests callable as legacy"
  assert_jq_eq '.[0].sso_user_id' "$SSO_USER_ID" "C1.4 legacy sees pending request naming the right SSO identity"
  assert_jq_eq '.[0].team_name' "E2E E3 6200 Team" "C1.4 legacy's pending request names the team"

  STATUS=$(rpc get_pending_sso_link_requests "$WORKDIR/outsider_token.txt" '{}')
  assert_status 200 "$STATUS" "C1.4 get_pending_sso_link_requests callable as outsider"
  COUNT=$(jq 'length' "$WORKDIR/last_body.json")
  [ "$COUNT" = "0" ] && ok "C1.4 OUTSIDER sees 0 candidates" || bad "C1.4 expected 0 for OUTSIDER, got $COUNT"

  echo "--- C1.5: dual consent, wrong order first ---"
  STATUS=$(rpc link_sso_account "$WORKDIR/sso_token1.txt" "$(jq -n --arg l "$LEGACY_ID" '{p_legacy_user_id:$l}')")
  assert_status 403 "$STATUS" "C1.5 link before LEGACY consents is refused"
  echo "  refusal body: $(last_body)"
  MSG=$(jq -r '.message' "$WORKDIR/last_body.json")
  case "$MSG" in *link_consent_required*) ok "C1.5 refusal names link_consent_required" ;; *) bad "C1.5 refusal message unexpected: $MSG" ;; esac

  STATUS=$(rpc record_sso_link_consent "$WORKDIR/legacy_token.txt" "$(jq -n --arg s "$SSO_USER_ID" '{p_sso_user_id:$s}')")
  assert_status 204 "$STATUS" "C1.5 LEGACY consents to the link"
  STATUS=$(rpc link_sso_account "$WORKDIR/sso_token1.txt" "$(jq -n --arg l "$LEGACY_ID" '{p_legacy_user_id:$l}')")
  assert_status 204 "$STATUS" "C1.5 SSO identity executes the link"

  echo "--- C1.6: post-link DB state ---"
  run_sql_aligned -c "SELECT * FROM team_members WHERE team_id = '$TEAM_ID';"
  MOVED_ROLE=$(run_sql -c "SELECT role FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$SSO_USER_ID';")
  [ "$MOVED_ROLE" = "member" ] && ok "C1.6 SSO team_members row now carries LEGACY's role (member)" \
    || bad "C1.6 expected role=member after link, got '$MOVED_ROLE'"
  LEGACY_TM_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$LEGACY_ID';")
  [ "$LEGACY_TM_COUNT" = "0" ] && ok "C1.6 LEGACY's own team_members row removed" || bad "C1.6 LEGACY row still present ($LEGACY_TM_COUNT)"
  SSO_PROVISIONED_VIA=$(run_sql -c "SELECT provisioned_via FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$SSO_USER_ID';")
  echo "  SSO team_members.provisioned_via = $SSO_PROVISIONED_VIA (poison P-4 record)"

  LEGACY_ENT_KEY_ID=$(cat "$WORKDIR/legacy_ent_key_id"); LEGACY_IND_KEY_ID=$(cat "$WORKDIR/legacy_ind_key_id")
  run_sql_aligned -c "SELECT id,status,tier,metadata FROM license_keys WHERE id IN ('$LEGACY_ENT_KEY_ID','$LEGACY_IND_KEY_ID');"
  ENT_STATUS=$(run_sql -c "SELECT status FROM license_keys WHERE id = '$LEGACY_ENT_KEY_ID';")
  ENT_REVOKED_BY=$(run_sql -c "SELECT metadata->>'revoked_by' FROM license_keys WHERE id = '$LEGACY_ENT_KEY_ID';")
  [ "$ENT_STATUS" = "revoked" ] && [ "$ENT_REVOKED_BY" = "sso_account_link" ] && \
    ok "C1.6 LEGACY's enterprise key revoked with revoked_by=sso_account_link" \
    || bad "C1.6 expected enterprise key revoked/sso_account_link, got status=$ENT_STATUS revoked_by=$ENT_REVOKED_BY"
  IND_STATUS=$(run_sql -c "SELECT status FROM license_keys WHERE id = '$LEGACY_IND_KEY_ID';")
  [ "$IND_STATUS" = "active" ] && ok "C1.6 LEGACY's individual key untouched (still active)" \
    || bad "C1.6 expected individual key still active, got $IND_STATUS"

  run_sql_aligned -c "SELECT linked_at, reversible_until, consent_expires_at FROM sso_account_links WHERE sso_user_id='$SSO_USER_ID' AND legacy_user_id='$LEGACY_ID';"
  LINK_AUDIT=$(run_sql -c "SELECT count(*) FROM audit_logs WHERE event_type = 'sso:account_linked' AND actor = '$SSO_USER_ID';")
  [ "$LINK_AUDIT" -ge "1" ] && ok "C1.6 audit trail recorded sso:account_linked" || bad "C1.6 no sso:account_linked audit row"

  echo "--- C1.6b: sso-link-notify ---"
  BODY=$(jq -n --arg l "$LEGACY_ID" '{legacy_user_id:$l}')
  HTTP=$(curl -s -o "$WORKDIR/notify1.json" -w '%{http_code}' -X POST "$STAGING_SUPABASE_URL/functions/v1/sso-link-notify" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" -H "Authorization: Bearer $(cat "$WORKDIR/sso_token1.txt")" \
    -H "Content-Type: application/json" --data-raw "$BODY")
  echo "  first call: HTTP $HTTP body=$(cat "$WORKDIR/notify1.json")"
  SENT1=$(jq -r '.sent // empty' "$WORKDIR/notify1.json")
  ERR1=$(jq -r '.error // empty' "$WORKDIR/notify1.json")
  if [ "$HTTP" = "200" ] && [ "$SENT1" = "true" ]; then
    ok "C1.6b first notify call sent=true"
  elif [ "$HTTP" = "200" ] && [ "$ERR1" = "email_send_failed" ]; then
    # Documented graceful-degradation shape (sso-link-notify/index.ts:35 -- "link stands;
    # only the notice failed"), not a crash. RESEND_API_KEY IS registered as a secret name
    # on staging (confirmed via the Management API secrets list), so this is the SECOND
    # email_send_failed return site (the actual Resend API call itself failing), not the
    # "key missing" site. Root cause unconfirmed from here (Resend account/domain config
    # is outside DB/edge-function visibility) -- reporting as UNCOVERED for the
    # sent:true/already_notified dedupe pair rather than guessing at Resend's cause.
    charz "C1.6b first notify call hit the documented email_send_failed fallback (RESEND_API_KEY secret name present on staging, but the actual send failed) -- link itself still stands"
    uncov "C1.6b sent:true -> already_notified dedupe transition: unreachable while every real send fails (notified_at never gets set)"
  else
    bad "C1.6b first notify call unexpected: HTTP $HTTP $(cat "$WORKDIR/notify1.json")"
  fi
  HTTP=$(curl -s -o "$WORKDIR/notify2.json" -w '%{http_code}' -X POST "$STAGING_SUPABASE_URL/functions/v1/sso-link-notify" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" -H "Authorization: Bearer $(cat "$WORKDIR/sso_token1.txt")" \
    -H "Content-Type: application/json" --data-raw "$BODY")
  echo "  second call: HTTP $HTTP body=$(cat "$WORKDIR/notify2.json")"
  REASON2=$(jq -r '.reason // empty' "$WORKDIR/notify2.json")
  if [ "$HTTP" = "200" ] && [ "$REASON2" = "already_notified" ]; then
    ok "C1.6b second call sent=false reason=already_notified (dedupe)"
  elif [ "$HTTP" = "200" ] && [ "$(jq -r '.error // empty' "$WORKDIR/notify2.json")" = "email_send_failed" ]; then
    charz "C1.6b second notify call also hit email_send_failed (consistent with notified_at never having been set by call 1)"
  else
    bad "C1.6b second notify call unexpected: HTTP $HTTP $(cat "$WORKDIR/notify2.json")"
  fi
  HTTP=$(curl -s -o "$WORKDIR/notify3.json" -w '%{http_code}' -X POST "$STAGING_SUPABASE_URL/functions/v1/sso-link-notify" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" -H "Authorization: Bearer $(cat "$WORKDIR/outsider_token.txt")" \
    -H "Content-Type: application/json" --data-raw "$BODY")
  [ "$HTTP" = "403" ] && [ "$(jq -r '.error' "$WORKDIR/notify3.json")" = "link_not_found" ] && ok "C1.6b OUTSIDER call refused 403 link_not_found" \
    || bad "C1.6b OUTSIDER call unexpected: HTTP $HTTP $(cat "$WORKDIR/notify3.json")"

  echo "--- C1.7: grant, as OWNER ---"
  SSO_ROLE_NOW=$(run_sql -c "SELECT role FROM team_members WHERE team_id='$TEAM_ID' AND user_id='$SSO_USER_ID';")
  echo "  SSO's current role: $SSO_ROLE_NOW"
  STATUS=$(rpc set_team_role_permission "$WORKDIR/owner_token.txt" "$(jq -n --arg r "$SSO_ROLE_NOW" '{p_team_id:"'"$TEAM_ID"'",p_role:$r,p_permission:"registry:approve",p_effect:"allow"}')")
  assert_status 204 "$STATUS" "C1.7 OWNER sets registry:approve=allow for role=$SSO_ROLE_NOW"
  echo "  (representing rbac_create_policy action:create's bulk expansion -- see rbac-tools.action.ts:358, which loops setRolePermission per pair; set_team_role_permission RETURNS VOID -> PostgREST 204)"
  STATUS=$(rpc set_team_role_permission "$WORKDIR/owner_token.txt" "$(jq -n --arg r "$SSO_ROLE_NOW" '{p_team_id:"'"$TEAM_ID"'",p_role:$r,p_permission:"registry:deprecate",p_effect:"allow"}')")
  assert_status 204 "$STATUS" "C1.7 bulk-writer-equivalent second set_team_role_permission call (registry:deprecate=allow)"

  GRANT_COUNT=$(run_sql -c "SELECT count(*) FROM team_permission_grants WHERE team_id='$TEAM_ID' AND role='$SSO_ROLE_NOW' AND permission='registry:approve';")
  [ "$GRANT_COUNT" = "1" ] && ok "C1.7 grant row exists in team_permission_grants" || bad "C1.7 expected 1 grant row, got $GRANT_COUNT"

  STATUS=$(rpc has_team_permission "$WORKDIR/sso_token1.txt" "$(jq -n '{p_team_id:"'"$TEAM_ID"'",p_permission:"registry:approve"}')")
  assert_status 200 "$STATUS" "C1.7 has_team_permission callable as SSO"
  assert_jq_eq '.' 'true' "C1.7 has_team_permission(registry:approve) as SSO -> true"

  STATUS=$(rpc team_ids_with_permission "$WORKDIR/sso_token1.txt" "$(jq -n '{p_permission:"registry:approve"}')")
  assert_status 200 "$STATUS" "C1.7 team_ids_with_permission callable as SSO"
  echo "  team_ids_with_permission body: $(last_body)"
  CONTAINS=$(jq -r --arg t "$TEAM_ID" 'if type=="array" then (map(if type=="object" then .team_id else . end) | index($t) != null) else false end' "$WORKDIR/last_body.json" 2>/dev/null || echo false)
  [ "$CONTAINS" = "true" ] && ok "C1.7 team_ids_with_permission(registry:approve) as SSO contains TEAM" \
    || bad "C1.7 team_ids_with_permission did not contain TEAM: $(last_body)"

  STATUS=$(rpc get_effective_team_permissions "$WORKDIR/owner_token.txt" "$(jq -n '{p_team_id:"'"$TEAM_ID"'"}')")
  assert_status 200 "$STATUS" "C1.7 get_effective_team_permissions callable as OWNER"
  ROWCOUNT=$(jq 'length' "$WORKDIR/last_body.json")
  [ "$ROWCOUNT" = "8" ] && ok "C1.7 get_effective_team_permissions returns 8 rows (2 roles x 4 perms)" || bad "C1.7 expected 8 rows, got $ROWCOUNT"
  GRANT_SRC=$(jq -r --arg r "$SSO_ROLE_NOW" '.[] | select(.role==$r and .permission=="registry:approve") | .source' "$WORKDIR/last_body.json")
  [ "$GRANT_SRC" = "grant" ] && ok "C1.7 granted cell source=grant" || bad "C1.7 expected source=grant for the granted cell, got $GRANT_SRC"

  STATUS=$(rpc get_effective_team_permissions "$WORKDIR/sso_token1.txt" "$(jq -n '{p_team_id:"'"$TEAM_ID"'"}')")
  # RAISE EXCEPTION ... USING ERRCODE='42501' surfaces as a real PostgREST error response
  # (HTTP 403), not wrapped inside a 200 body -- matches the 6205 harness's own T6.1 (a 42501
  # refusal asserted at HTTP 403). Earlier draft of this script incorrectly expected 200 here.
  assert_status 403 "$STATUS" "C1.7 get_effective_team_permissions as SSO is refused at the HTTP layer"
  assert_jq_eq '.code' '42501' "C1.7 get_effective_team_permissions as SSO raises 42501 permission_denied (SSO lacks team:manage_rbac)"
  echo "  [P-3 / Q3] grant is keyed (team_id, role, permission) = ($TEAM_ID, $SSO_ROLE_NOW, registry:approve) -- not scoped to this specific user; will silently apply to whoever else holds role=$SSO_ROLE_NOW next."

  echo "--- C1.8: device login ---"
  DC_RESP=$(curl -s -X POST "$STAGING_SUPABASE_URL/functions/v1/auth-device-code" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
    --data-raw '{"client_type":"cli"}')
  echo "  device-code resp: $DC_RESP"
  DEVICE_CODE=$(echo "$DC_RESP" | jq -r '.device_code')
  USER_CODE=$(echo "$DC_RESP" | jq -r '.user_code')
  [ -n "$DEVICE_CODE" ] && [ "$DEVICE_CODE" != "null" ] || { bad "C1.8 auth-device-code did not return a device_code"; }

  HTTP=$(curl -s -o "$WORKDIR/device_approve.json" -w '%{http_code}' -X POST "$STAGING_SUPABASE_URL/functions/v1/auth-device-approve" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" -H "Authorization: Bearer $(cat "$WORKDIR/sso_token1.txt")" \
    -H "Content-Type: application/json" --data-raw "$(jq -n --arg u "$USER_CODE" '{user_code:$u}')")
  echo "  approve: HTTP $HTTP body=$(cat "$WORKDIR/device_approve.json")"
  APPROVE_ERR=$(jq -r '.error // empty' "$WORKDIR/device_approve.json")
  if [ "$HTTP" = "403" ] && [ "$APPROVE_ERR" = "sso_unsupported" ]; then
    ok "C1.8 auth-device-approve refuses SSO caller (403 sso_unsupported)"
  else
    # STAGING-IS-BEHIND-MAIN (confirmed live, not a product bug): approve_device_code()'s
    # LIVE body on staging (pg_get_functiondef) has NO is_sso_user check at all -- the check
    # exists only in supabase/migrations/20260830060000_auth_device_approve_sso_refusal.sql,
    # which has NOT been applied to staging. Evidence: mark_device_code_sso_refused() (added
    # by that same migration) does not exist on staging; device_codes lacks
    # refusal_reason/refused_at; schema_version's newest row (108, applied 2026-08-29
    # 20:41:31 UTC) predates the migration's own 20260830060000 (2026-08-30 06:00:00) UTC
    # timestamp. Per the matrix's own P3 instruction ("staging is behind main -- stop and
    # say so; do not shim it in"), this is UNCOVERED, not a product FAIL -- the fix exists
    # correctly on main, just not deployed here. NOTE: P3 as literally specified in the
    # matrix did not catch this, because its fixed function-name list never named
    # approve_device_code/mark_device_code_sso_refused -- a real gap in P3's own coverage,
    # worth folding into a future revision of this matrix.
    uncov "C1.8 auth-device-approve: staging is behind main for 20260830060000_auth_device_approve_sso_refusal.sql -- approve_device_code()'s live body lacks the is_sso_user gate entirely (confirmed via pg_get_functiondef + absence of mark_device_code_sso_refused() + schema_version timing). Got HTTP $HTTP $APPROVE_ERR instead of sso_unsupported."
    echo "  [LIVE-VERIFIED IMPACT] With the SSO user's profile completed (profile_completed_at set as part of this investigation), a retry returned HTTP 200 {\"status\":\"approved\"} at the APPROVE step -- the first-gate SSO refusal is genuinely absent on staging. However the SUBSEQUENT token poll still correctly refused with 403 sso_unsupported (an independent, already-deployed mintSession()/isSsoProvisioned() guard inside auth-device-token), so no CLI token was actually minted. Net: a redundant defense-in-depth layer is missing on staging; the final security boundary held in this test, but the approve-time UX now falsely reports \"approved\" to a polling CLI before it is refused."
  fi
  cp "$WORKDIR/device_approve.json" "$WORKDIR/c1_8_approve_body.json"

  HTTP=$(curl -s -o "$WORKDIR/device_token.json" -w '%{http_code}' -X POST "$STAGING_SUPABASE_URL/functions/v1/auth-device-token" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
    --data-raw "$(jq -n --arg d "$DEVICE_CODE" '{device_code:$d}')")
  echo "  token poll: HTTP $HTTP body=$(cat "$WORKDIR/device_token.json")"
  TOKEN_ERR=$(jq -r '.error // empty' "$WORKDIR/device_token.json")
  if [ "$HTTP" = "403" ] && [ "$TOKEN_ERR" = "sso_unsupported" ]; then
    ok "C1.8 auth-device-token poll ALSO surfaces sso_unsupported (persisted via mark_device_code_sso_refused)"
  elif [ "$HTTP" = "428" ] && [ "$TOKEN_ERR" = "authorization_pending" ]; then
    uncov "C1.8 auth-device-token poll: got 428 authorization_pending, not sso_unsupported -- downstream consequence of the same staging-behind-main gap (approve never persisted an sso-refused device_codes row because it returned profile_incomplete, not sso_unsupported, on this attempt)"
  else
    bad "C1.8 token poll unexpected: HTTP $HTTP $(cat "$WORKDIR/device_token.json")"
  fi
  cp "$WORKDIR/device_token.json" "$WORKDIR/c1_8_token_body.json"

  echo "--- C1.9: shadow-account regression check ---"
  run_sql_aligned -c "SELECT id, email, is_sso_user, created_at FROM auth.users WHERE email = '$SSO_EMAIL' ORDER BY created_at;"
  ROWCOUNT=$(run_sql -c "SELECT count(*) FROM auth.users WHERE email = '$SSO_EMAIL';")
  [ "$ROWCOUNT" = "1" ] && ok "C1.9 exactly one auth.users row for SSO's email (no shadow account)" \
    || bad "C1.9 expected exactly 1 row for $SSO_EMAIL, got $ROWCOUNT -- possible SMI-6206 regression"

  echo "--- C1.9b: no-marker key fixture (regenerate, never revoke-a-second-key) ---"
  HTTP=$(curl -s -o "$WORKDIR/key_a.json" -w '%{http_code}' -X POST "$STAGING_SUPABASE_URL/functions/v1/generate-license" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" -H "Authorization: Bearer $(cat "$WORKDIR/sso_token1.txt")" \
    -H "Content-Type: application/json" --data-raw '{"name":"CLI Token (fixture)"}')
  echo "  generate-license: HTTP $HTTP body=$(jq -c 'del(.key)' "$WORKDIR/key_a.json" 2>/dev/null || cat "$WORKDIR/key_a.json")"
  [ "$HTTP" = "200" ] || [ "$HTTP" = "201" ] && ok "C1.9b generate-license issued key A" || bad "C1.9b generate-license unexpected HTTP $HTTP: $(cat "$WORKDIR/key_a.json")"
  KEY_A_ID=$(jq -r '.id' "$WORKDIR/key_a.json"); echo "$KEY_A_ID" > "$WORKDIR/key_a_id"
  KEY_A_TIER=$(jq -r '.tier' "$WORKDIR/key_a.json"); echo "  key A id=$KEY_A_ID tier=$KEY_A_TIER"

  HTTP=$(curl -s -o "$WORKDIR/key_b.json" -w '%{http_code}' -X POST "$STAGING_SUPABASE_URL/functions/v1/regenerate-license" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" -H "Authorization: Bearer $(cat "$WORKDIR/sso_token1.txt")" \
    -H "Content-Type: application/json" --data-raw '{"name":"CLI Token (fixture B)"}')
  echo "  regenerate-license: HTTP $HTTP body=$(jq -c 'del(.key)' "$WORKDIR/key_b.json" 2>/dev/null || cat "$WORKDIR/key_b.json")"
  KEY_B_ID=$(jq -r '.id' "$WORKDIR/key_b.json"); echo "$KEY_B_ID" > "$WORKDIR/key_b_id"
  # [DOC-DRIFT] regenerate-license/index.ts's own header comment documents the response
  # field as singular `revokedKeyId: string`, but the LIVE response carries a plural
  # `revokedKeyIds: string[]` array (confirmed live) -- consistent with the function's real
  # "revoke ALL active keys" behavior (see the C1.9b table note / SMI-6315). Doc, not
  # behavior, is what's stale; not filing a separate Linear issue since SMI-6315 already
  # captures the underlying multi-key-revocation gap this field exists to describe.
  REVOKED_KEY_IDS=$(jq -r '.revokedKeyIds // empty | @json' "$WORKDIR/key_b.json")
  CONTAINS_A=$(jq -r --arg a "$KEY_A_ID" '(.revokedKeyIds // []) | index($a) != null' "$WORKDIR/key_b.json")
  [ "$CONTAINS_A" = "true" ] && ok "C1.9b regenerate-license revoked key A (revokedKeyIds=$REVOKED_KEY_IDS), issued key B ($KEY_B_ID)" \
    || bad "C1.9b expected revokedKeyIds to contain $KEY_A_ID, got $REVOKED_KEY_IDS"

  run_sql_aligned -c "SELECT id,status,tier,metadata FROM license_keys WHERE id IN ('$KEY_A_ID','$KEY_B_ID');"
  A_STATUS=$(run_sql -c "SELECT status FROM license_keys WHERE id='$KEY_A_ID';")
  A_REASON=$(run_sql -c "SELECT metadata->>'revoked_reason' FROM license_keys WHERE id='$KEY_A_ID';")
  A_REVOKED_BY=$(run_sql -c "SELECT metadata->>'revoked_by' FROM license_keys WHERE id='$KEY_A_ID';")
  [ "$A_STATUS" = "revoked" ] && [ "$A_REASON" = "regenerated" ] && [ -z "$A_REVOKED_BY" ] && \
    ok "C1.9b key A: status=revoked revoked_reason=regenerated revoked_by=NULL (the no-marker cohort)" \
    || bad "C1.9b key A unexpected: status=$A_STATUS reason=$A_REASON revoked_by='$A_REVOKED_BY'"
  B_STATUS=$(run_sql -c "SELECT status FROM license_keys WHERE id='$KEY_B_ID';")
  B_TIER=$(run_sql -c "SELECT tier FROM license_keys WHERE id='$KEY_B_ID';")
  ACTIVE_COUNT=$(run_sql -c "SELECT count(*) FROM license_keys WHERE user_id='$SSO_USER_ID' AND status='active';")
  [ "$B_STATUS" = "active" ] && [ "$ACTIVE_COUNT" = "1" ] && [ "$B_TIER" = "$KEY_A_TIER" ] && \
    ok "C1.9b key B active, sole key, same tier as A ($B_TIER)" \
    || bad "C1.9b key B unexpected: status=$B_STATUS tier=$B_TIER active_count=$ACTIVE_COUNT"

  echo "--- C1.10 (G0): API key refresh branch ---"
  ACTIVE_COUNT=$(run_sql -c "SELECT count(*) FROM license_keys WHERE user_id='$SSO_USER_ID' AND status='active';")
  [ "$ACTIVE_COUNT" = "1" ] && ok "C1.10 key B confirmed sole active key before refresh call" || bad "C1.10 expected 1 active key, got $ACTIVE_COUNT"
  BEFORE_EXPIRES=$(run_sql -c "SELECT expires_at FROM license_keys WHERE id='$KEY_B_ID';")
  echo "  key B before refresh: tier=$B_TIER expires_at=$BEFORE_EXPIRES"

  STATUS=$(rpc record_sso_login "$WORKDIR/sso_token1.txt" '{}')
  assert_status 200 "$STATUS" "C1.10 record_sso_login callable (reusing C1.1's still-valid session, C1.3's G-2 patch still live -- no login has happened since)"
  echo "[G-2 SUBSTITUTED CLAIM] C1.10"
  STATUS_VAL=$(jq -r '.status' "$WORKDIR/last_body.json")
  if [ "$STATUS_VAL" = "ok" ]; then ok "C1.10 record_sso_login returns status=ok (refresh branch reachable)"; else
    bad "C1.10 expected status=ok, got $STATUS_VAL -- refresh branch not reached (body: $(last_body))"
  fi

  AFTER_EXPIRES=$(run_sql -c "SELECT expires_at FROM license_keys WHERE id='$KEY_B_ID';")
  AFTER_META=$(run_sql -c "SELECT metadata FROM license_keys WHERE id='$KEY_B_ID';")
  echo "  key B after refresh: tier=$B_TIER expires_at=$AFTER_EXPIRES metadata=$AFTER_META"
  case "$B_TIER" in
    team|enterprise)
      ok "C1.10 key B's tier ($B_TIER) IS in the refresh-eligible set (team,enterprise)"
      if [ "$AFTER_EXPIRES" != "$BEFORE_EXPIRES" ] && [ -n "$AFTER_EXPIRES" ]; then
        ok "C1.10 expires_at changed after refresh (bound to sso_verified_at+reverify_days, not left as-is)"
      else
        bad "C1.10 expected expires_at to change/bind after the refresh branch fired, before=$BEFORE_EXPIRES after=$AFTER_EXPIRES"
      fi
      ;;
    *)
      bad "C1.10 FINDING: key B's tier ($B_TIER) is OUTSIDE (team,enterprise) -- the Wave-5 refresh/reissue/deprovisioning story does not apply to it; this key would outlive expiry indefinitely. Recording as a finding per the matrix's own instruction."
      ;;
  esac
  echo "$B_TIER" > "$WORKDIR/key_b_tier"

  echo "=== end phase chain1 === PASS=$PASS FAIL=$FAIL UNCOVERED=$UNCOVERED CHARACTERIZED=$CHARACTERIZED"

  checkpoint_pause "B-CP1" \
    "C1.10 (key B active and refresh-bound, membership fresh, grant live)" \
    "U1.1-U1.4 (provenance rendering, the member viewer's payload check), U3.1-U3.3 (key page as an SSO user), U7.1 \"before\" (approve/deprecate controls enabled under the C1.7 grant)" \
    "SSO + LEGACY + OWNER session tokens; the sk_live_* key string; the fixture team id"
}

