#!/usr/bin/env bash
# smi-6200-e3-uat-chain.phase234.sh -- phase_chain2/3/4 (C1.11-C1.16), split out of
# smi-6200-e3-uat-chain.sh to stay under the repo's 500-line file limit.
# Sourced by smi-6200-e3-uat-chain.sh -- never run directly.

phase_chain2() {
  echo "=== PHASE: chain2 (C1.11 - C1.12) ==="
  SSO_USER_ID=$(cat "$WORKDIR/sso_user_id")
  KEY_B_ID=$(cat "$WORKDIR/key_b_id")

  echo "--- C1.11 (G0): second live session ---"
  SSO_USER_ID2=$(mock_saml_login "$SSO_EMAIL" "$WORKDIR/sso_token2.txt")
  [ "$SSO_USER_ID2" = "$SSO_USER_ID" ] && ok "C1.11 second login resolves to the SAME SSO identity" \
    || bad "C1.11 second login resolved to a DIFFERENT user id: $SSO_USER_ID2 != $SSO_USER_ID"
  echo "  [identity_data overwritten by this login -- C1.13's re-prime is NOT optional]"

  for name in sso_token1 sso_token2; do
    HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$STAGING_SUPABASE_URL/rest/v1/profiles?select=id" \
      -H "apikey: $STAGING_SUPABASE_ANON_KEY" -H "Authorization: Bearer $(cat "$WORKDIR/$name.txt")")
    [ "$HTTP" = "200" ] && ok "C1.11 $name still authenticates (HTTP 200 on /profiles)" || bad "C1.11 $name failed to authenticate: HTTP $HTTP"
  done

  echo "--- C1.12 (G0): removal/expiry with a live session present ---"
  run_sql -c "
    UPDATE team_sso_settings SET reverify_days = 1 WHERE team_id = '$TEAM_ID';
    UPDATE team_members SET sso_verified_at = now() - interval '2 days'
     WHERE team_id = '$TEAM_ID' AND user_id = '$SSO_USER_ID';
  " >/dev/null
  echo "  reverify_days=1, sso_verified_at backdated 2 days"

  ELIGIBLE=$(run_sql -c "SELECT sso_expiry_eligible('$TEAM_ID');")
  [ "$ELIGIBLE" = "t" ] && ok "C1.12(b) sso_expiry_eligible(TEAM) = true before sweeping" \
    || bad "C1.12(b) expected sso_expiry_eligible=true, got '$ELIGIBLE'"

  echo "--- P-8 interlude (between C1.12b and C1.12c): the expiry-pause safety valve ---"
  run_sql -c "UPDATE team_sso_settings SET status = 'inactive' WHERE team_id = '$TEAM_ID';" >/dev/null
  ELIGIBLE_PAUSED=$(run_sql -c "SELECT sso_expiry_eligible('$TEAM_ID');")
  [ "$ELIGIBLE_PAUSED" = "f" ] && ok "P-8 sso_expiry_eligible(TEAM) = false once settings.status='inactive' (safety valve engaged)" \
    || bad "P-8 expected sso_expiry_eligible=false with inactive settings, got '$ELIGIBLE_PAUSED'"
  SWEPT_PAUSED=$(run_sql -c "SELECT expire_stale_sso_members();")
  [ "$SWEPT_PAUSED" = "0" ] && ok "P-8 sweep returns 0 while the team's own SSO is broken (paused, not silently expiring everyone)" \
    || bad "P-8 expected sweep to return 0 while paused, got $SWEPT_PAUSED"
  STATUS=$(rpc has_team_permission "$WORKDIR/sso_token2.txt" "$(jq -n '{p_team_id:"'"$TEAM_ID"'",p_permission:"registry:approve"}')")
  assert_status 200 "$STATUS" "P-8 has_team_permission callable as SSO while settings paused"
  PERM_VAL=$(jq -r '.' "$WORKDIR/last_body.json")
  [ "$PERM_VAL" = "false" ] && ok "P-8 has_team_permission still denies the stale member (frozen: denied AND unexpirable) while paused" \
    || charz "P-8 has_team_permission returned $PERM_VAL while paused -- SSO's role is currently 'admin' (re-derived at C1.10, see the P-1 note below), which may hold registry:approve via the unrelated DEFAULT admin grant rather than the C1.7 grant (scoped to role=member, now orphaned) -- recording the live value rather than assuming"
  run_sql -c "UPDATE team_sso_settings SET status = 'active' WHERE team_id = '$TEAM_ID';" >/dev/null
  echo "  restored status='active'"

  echo "  [P-1 LIVE FINDING, discovered at C1.10, relevant here] SSO's role was 'member' right"
  echo "  after C1.6's link (matching LEGACY's role, and what C1.7's grant was scoped to)."
  echo "  C1.10's own record_sso_login() call -- required by the matrix to exercise the key-"
  echo "  refresh branch -- re-derived role from the (G-2 substituted) group mapping and"
  echo "  silently reverted it to 'admin'. This is DOCUMENTED, intentional product design"
  echo "  (20260829230000_sso_member_lifecycle.sql's own comment: \"on an sso-provisioned row"
  echo "  the moved role IS still re-derived from IdP groups at the member's next login... the"
  echo "  IdP is the authority on role\"), not a bug -- but it means poison P-1's real trigger"
  echo "  is broader than the matrix's own text implies: ANY subsequent record_sso_login()"
  echo "  call for an sso-provisioned row re-derives role, not only a SECOND LINK. The C1.7"
  echo "  grant (scoped to role='member') is now orphaned per poison P-3 -- it applies to"
  echo "  nobody, since SSO no longer holds 'member' and nobody else does either."
  charz "P-1's real trigger condition is broader than the matrix's C1.7/P-1 narrative -- any post-link record_sso_login() call re-derives role from current group mapping and can silently orphan a role-scoped grant, not only a second identity-link"
  run_sql_aligned -c "SELECT role, provisioned_via, sso_verified_at FROM team_members WHERE team_id='$TEAM_ID' AND user_id='$SSO_USER_ID';"
  GRANT_STILL_EXISTS=$(run_sql -c "SELECT count(*) FROM team_permission_grants WHERE team_id='$TEAM_ID' AND role='member' AND permission='registry:approve';")
  echo "  team_permission_grants row for (TEAM, member, registry:approve) still exists: $GRANT_STILL_EXISTS (P-3: grant survives, now applies to nobody)"

  echo "--- C1.12(c): sweep, with session 2 still live ---"
  SWEPT=$(run_sql -c "SELECT expire_stale_sso_members();")
  echo "  expire_stale_sso_members() returned: $SWEPT"
  [ "${SWEPT:-0}" -ge "1" ] 2>/dev/null && ok "C1.12(c) sweep returns >=1" || bad "C1.12(c) expected sweep to return >=1, got '$SWEPT'"

  TM_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id='$TEAM_ID' AND user_id='$SSO_USER_ID';")
  [ "$TM_COUNT" = "0" ] && ok "C1.12(c) SSO's team_members row is gone" || bad "C1.12(c) expected 0 team_members rows, got $TM_COUNT"

  STATUS=$(rpc has_team_permission "$WORKDIR/sso_token2.txt" "$(jq -n '{p_team_id:"'"$TEAM_ID"'",p_permission:"registry:approve"}')")
  assert_status 200 "$STATUS" "C1.12(c) has_team_permission callable as SSO (session 2, still valid JWT) after expiry"
  assert_jq_eq '.' 'false' "C1.12(c) has_team_permission denies SSO for registry:approve after expiry"
  for perm in registry:deprecate team:manage_rbac team:manage_sso; do
    STATUS=$(rpc has_team_permission "$WORKDIR/sso_token2.txt" "$(jq -n --arg p "$perm" '{p_team_id:"'"$TEAM_ID"'",p_permission:$p}')")
    assert_status 200 "$STATUS" "C1.12(c) has_team_permission callable for $perm"
    assert_jq_eq '.' 'false' "C1.12(c) has_team_permission denies SSO for $perm after expiry"
  done

  ENT_KEY_STATUS=$(run_sql -c "SELECT status FROM license_keys WHERE id='$KEY_B_ID';")
  ENT_KEY_REVOKED_BY=$(run_sql -c "SELECT metadata->>'revoked_by' FROM license_keys WHERE id='$KEY_B_ID';")
  [ "$ENT_KEY_STATUS" = "revoked" ] && [ "$ENT_KEY_REVOKED_BY" = "sso_expiry" ] && \
    ok "C1.12(c) key B (enterprise) revoked with revoked_by=sso_expiry" \
    || bad "C1.12(c) expected key B revoked/sso_expiry, got status=$ENT_KEY_STATUS revoked_by=$ENT_KEY_REVOKED_BY"

  PURGE_COUNT=$(run_sql -c "SELECT count(*) FROM team_member_inventory_purge_schedule WHERE user_id='$SSO_USER_ID' AND departed_team_id='$TEAM_ID';")
  [ "${PURGE_COUNT:-0}" -ge "1" ] 2>/dev/null && ok "C1.12(c) team_member_inventory_purge_schedule row exists for SSO" \
    || bad "C1.12(c) expected >=1 purge-schedule row, got $PURGE_COUNT"

  AUDIT_COUNT=$(run_sql -c "SELECT count(*) FROM audit_logs WHERE event_type='sso:expired' AND metadata->>'user_id'='$SSO_USER_ID';")
  [ "${AUDIT_COUNT:-0}" -ge "1" ] 2>/dev/null && ok "C1.12(c) sso:expired audit_logs row exists" || bad "C1.12(c) expected an sso:expired audit row, got $AUDIT_COUNT"

  HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$STAGING_SUPABASE_URL/rest/v1/profiles?select=id" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" -H "Authorization: Bearer $(cat "$WORKDIR/sso_token2.txt")")
  [ "$HTTP" = "200" ] && ok "C1.12(c) session 2's JWT STILL authenticates post-expiry (the acknowledged gap -- confirmed to be the ONLY thing that survives)" \
    || bad "C1.12(c) expected session 2 to still authenticate, got HTTP $HTTP"

  echo "  production cadence note: expire_stale_sso_members runs via pg_cron 'daily-expire-stale-sso-members' at 04:25 UTC, deliberately after sso-domain-reverify at 04:07 UTC."

  echo "=== end phase chain2 === PASS=$PASS FAIL=$FAIL UNCOVERED=$UNCOVERED CHARACTERIZED=$CHARACTERIZED"

  checkpoint_pause "B-CP2" \
    "C1.12 (sweep has run; membership gone; key revoked)" \
    "U1.5 (expired member's card gone), U7.1 \"after\" (same controls now disabled), U7.2/U7.3 (unconverted surfaces)" \
    "The same tokens -- deliberately, since the point is that the JWT still authenticates while the membership does not"
}

phase_chain3() {
  echo "=== PHASE: chain3 (C1.13 - C1.14) ==="
  SSO_USER_ID=$(cat "$WORKDIR/sso_user_id")
  LEGACY_ID=$(cat "$WORKDIR/legacy_id")
  KEY_A_ID=$(cat "$WORKDIR/key_a_id")
  KEY_B_ID=$(cat "$WORKDIR/key_b_id")
  LEGACY_ENT_KEY_ID=$(cat "$WORKDIR/legacy_ent_key_id")
  LEGACY_IND_KEY_ID=$(cat "$WORKDIR/legacy_ind_key_id")

  echo "--- C1.13 (G0): re-authentication after expiry, from the stale session (session 2) ---"
  echo "  [TIMING LIMITATION, stated up front] The matrix's C1.13 precondition is a token"
  echo "  'whose amr timestamp predates the sweep'. record_sso_login()'s fresh-INSERT path"
  echo "  (20260829230000_sso_member_lifecycle.sql:1043, step 5) stamps sso_verified_at from"
  echo "  v_bind.authenticated_at -- the JWT's OWN signed amr timestamp, confirmed via source,"
  echo "  NEVER now(). Session 2 (C1.11) authenticated only minutes before this step in a"
  echo "  same-session compressed execution -- its REAL amr timestamp therefore postdates the"
  echo "  artificial backdating this harness applied directly to the team_members ROW for"
  echo "  C1.12's sweep (a raw SQL UPDATE, not a JWT property). A genuinely stale JWT would"
  echo "  require real elapsed time >= reverify_days (minimum 1 day, the column's own CHECK"
  echo "  floor) between C1.11's login and this step, which a single continuous session cannot"
  echo "  produce, and forging a JWT would defeat the whole point of using real GoTrue-issued"
  echo "  tokens. Running the call for real below and reporting the ACTUAL outcome, then"
  echo "  separately reconstructing the P-5 duplicate-purge-row concern via direct backdating"
  echo "  (the same technique C1.12 already used), which does not depend on JWT freshness."
  uncov "C1.13's own headline assertion (member row re-created with a STALE sso_verified_at, producing zero permissions) -- session 2's real amr timestamp is fresh in this compressed execution, not stale; see timing-limitation note"

  g2_patch_and_verify "$SSO_USER_ID"
  STATUS=$(rpc record_sso_login "$WORKDIR/sso_token2.txt" '{}')
  assert_status 200 "$STATUS" "C1.13 record_sso_login callable with session 2's token, re-primed"
  echo "[G-2 SUBSTITUTED CLAIM] C1.13"
  echo "  actual response: $(last_body)"
  C13_STATUS=$(jq -r '.status' "$WORKDIR/last_body.json")
  if [ "$C13_STATUS" = "ok" ]; then ok "C1.13 record_sso_login returns status=ok (re-prime succeeded)"; else
    bad "C1.13 expected status=ok after re-prime, got $C13_STATUS"
  fi
  run_sql_aligned -c "SELECT role, provisioned_via, sso_verified_at FROM team_members WHERE team_id='$TEAM_ID' AND user_id='$SSO_USER_ID';"
  TM_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id='$TEAM_ID' AND user_id='$SSO_USER_ID';")
  [ "$TM_COUNT" = "1" ] && ok "C1.13 a team_members row was re-created for SSO" || bad "C1.13 expected exactly 1 re-created row, got $TM_COUNT"
  STATUS=$(rpc has_team_permission "$WORKDIR/sso_token2.txt" "$(jq -n '{p_team_id:"'"$TEAM_ID"'",p_permission:"registry:approve"}')")
  PERM_NOW=$(jq -r '.' "$WORKDIR/last_body.json")
  echo "  [OBSERVED, not the matrix's expected precondition] has_team_permission(registry:approve) as SSO right after re-creation = $PERM_NOW (expected true here, since sso_verified_at is genuinely fresh in this run -- the mirror image of the matrix's stale-token scenario, still a valid confirmation that the freshness gate reads the real stamp rather than always denying a re-created row)"

  echo "--- P-5 reconstruction: duplicate purge-schedule rows across a SECOND expire cycle ---"
  echo "  Simulating the passage of time directly on the freshly re-created row (same"
  echo "  technique C1.12 used), so this exercises P-5's real concern -- does an"
  echo "  expire -> re-login -> expire cycle produce a SECOND purge-schedule row -- without"
  echo "  depending on a naturally stale JWT."
  run_sql -c "UPDATE team_members SET sso_verified_at = now() - interval '2 days' WHERE team_id='$TEAM_ID' AND user_id='$SSO_USER_ID';" >/dev/null
  SWEPT2=$(run_sql -c "SELECT expire_stale_sso_members();")
  echo "  second sweep returned: $SWEPT2"
  PURGE_COUNT2=$(run_sql -c "SELECT count(*) FROM team_member_inventory_purge_schedule WHERE user_id='$SSO_USER_ID' AND departed_team_id='$TEAM_ID';")
  echo "  team_member_inventory_purge_schedule rows for (SSO,TEAM) after the second sweep: $PURGE_COUNT2"
  if [ "${PURGE_COUNT2:-0}" -gt "1" ] 2>/dev/null; then
    bad "P-5 CONFIRMED: >1 purge-schedule rows for the same (user,team) pair after a second expire cycle ($PURGE_COUNT2 rows) -- expire_stale_sso_members() does not de-duplicate against an existing pending purge-schedule row for the same departure pair"
  else
    ok "P-5 not reproduced: $PURGE_COUNT2 purge-schedule row(s) for (SSO,TEAM) after a second expire cycle"
  fi
  run_sql_aligned -c "SELECT id, scheduled_purge_at, purged_at, cancelled_reason FROM team_member_inventory_purge_schedule WHERE user_id='$SSO_USER_ID' AND departed_team_id='$TEAM_ID' ORDER BY created_at;"

  echo "--- C1.14 (G0): re-authentication after expiry, from a FRESH session ---"
  SSO_USER_ID3=$(mock_saml_login "$SSO_EMAIL" "$WORKDIR/sso_token3.txt")
  [ "$SSO_USER_ID3" = "$SSO_USER_ID" ] && ok "C1.14 fresh login resolves to the same SSO identity" || bad "C1.14 fresh login user id mismatch"
  g2_patch_and_verify "$SSO_USER_ID"
  STATUS=$(rpc record_sso_login "$WORKDIR/sso_token3.txt" '{}')
  assert_status 200 "$STATUS" "C1.14 record_sso_login callable with the fresh session, re-primed"
  echo "[G-2 SUBSTITUTED CLAIM] C1.14"
  C14_STATUS=$(jq -r '.status' "$WORKDIR/last_body.json")
  [ "$C14_STATUS" = "ok" ] && ok "C1.14 record_sso_login returns status=ok" || bad "C1.14 expected status=ok, got $C14_STATUS (body: $(last_body))"

  TIER_AFTER=$(run_sql -c "SELECT tier FROM profiles WHERE id='$SSO_USER_ID';")
  echo "  profiles.tier after C1.14's login: $TIER_AFTER"
  [ "$TIER_AFTER" = "enterprise" ] && ok "C1.14 profiles.tier restored to enterprise via recompute_user_tier()" \
    || bad "C1.14 expected tier=enterprise restored, got $TIER_AFTER"

  KEY_B_STATUS=$(run_sql -c "SELECT status FROM license_keys WHERE id='$KEY_B_ID';")
  KEY_B_REVOKED_BY=$(run_sql -c "SELECT metadata->>'revoked_by' FROM license_keys WHERE id='$KEY_B_ID';")
  [ "$KEY_B_STATUS" = "active" ] && [ -z "$KEY_B_REVOKED_BY" ] && \
    ok "C1.14 key B un-revoked (status=active, revoked_by marker cleared) -- reissue via UPDATE, matched on revoked_by=sso_expiry" \
    || bad "C1.14 expected key B active with revoked_by cleared, got status=$KEY_B_STATUS revoked_by=$KEY_B_REVOKED_BY"

  echo "--- C1.14 three negative assertions (one per revocation-marker cohort) ---"
  LEGACY_ENT_STATUS=$(run_sql -c "SELECT status FROM license_keys WHERE id='$LEGACY_ENT_KEY_ID';")
  LEGACY_ENT_REVOKED_BY=$(run_sql -c "SELECT metadata->>'revoked_by' FROM license_keys WHERE id='$LEGACY_ENT_KEY_ID';")
  [ "$LEGACY_ENT_STATUS" = "revoked" ] && [ "$LEGACY_ENT_REVOKED_BY" = "sso_account_link" ] && \
    ok "C1.14(a) LEGACY's enterprise key STILL revoked (revoked_by=sso_account_link, wrong marker for reissue)" \
    || bad "C1.14(a) expected LEGACY enterprise key still revoked/sso_account_link, got status=$LEGACY_ENT_STATUS revoked_by=$LEGACY_ENT_REVOKED_BY"

  LEGACY_IND_STATUS=$(run_sql -c "SELECT status FROM license_keys WHERE id='$LEGACY_IND_KEY_ID';")
  [ "$LEGACY_IND_STATUS" = "active" ] && ok "C1.14(b) LEGACY's individual key never touched (still active)" \
    || bad "C1.14(b) expected LEGACY individual key still active, got $LEGACY_IND_STATUS"

  KEY_A_STATUS=$(run_sql -c "SELECT status FROM license_keys WHERE id='$KEY_A_ID';")
  KEY_A_REVOKED_BY=$(run_sql -c "SELECT metadata->>'revoked_by' FROM license_keys WHERE id='$KEY_A_ID';")
  [ "$KEY_A_STATUS" = "revoked" ] && [ -z "$KEY_A_REVOKED_BY" ] && \
    ok "C1.14(c) key A (C1.9b's no-marker fixture) STILL revoked, no marker at all -- pinned by id, not 'some revoked key'" \
    || bad "C1.14(c) expected key A still revoked with no revoked_by, got status=$KEY_A_STATUS revoked_by='$KEY_A_REVOKED_BY'"

  echo "=== end phase chain3 === PASS=$PASS FAIL=$FAIL UNCOVERED=$UNCOVERED CHARACTERIZED=$CHARACTERIZED"

  checkpoint_pause "B-CP3" \
    "C1.14 (re-authenticated, tier and key restored)" \
    "U3.4 (revoke via the UI here, not earlier -- this is the last checkpoint, so the revocation lands after C1.14's assertions are already made and cannot corrupt them; note it revokes AND regenerates, per the endpoint's real behavior), U2.x if the link UI is being re-walked" \
    "Fresh post-restore session token; the post-U3.4 key id, since it differs from key B"
}

phase_chain4() {
  echo "=== PHASE: chain4 (C1.15 - C1.16) ==="
  SSO2_EMAIL="e2e-e3-6200-ssouser2@example.com"
  OWNER_ID=$(cat "$WORKDIR/owner_id")

  echo "--- C1.15 (G0): seat guard under real pressure ---"
  MEMBER_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id='$TEAM_ID';")
  echo "  current team_members count: $MEMBER_COUNT (max_members=3)"
  [ "$MEMBER_COUNT" = "3" ] && ok "C1.15 team already at max_members=3 (no artificial pressure needed)" \
    || bad "C1.15 expected team already at capacity (3), got $MEMBER_COUNT"

  ensure_clean_email "$SSO2_EMAIL"
  run_sql -c "
    INSERT INTO team_invitations (team_id, invited_email, role, token, invited_by)
    VALUES ('$TEAM_ID', 'e2e-e3-6200-pending-invite@example.com', 'member',
            encode(gen_random_bytes(32), 'hex'), '$OWNER_ID')
    ON CONFLICT (team_id, invited_email) WHERE status='pending' DO NOTHING;
  " >/dev/null
  PENDING_COUNT=$(run_sql -c "SELECT count(*) FROM team_invitations WHERE team_id='$TEAM_ID' AND status='pending' AND expires_at > now();")
  echo "  pending non-expired invitations: $PENDING_COUNT"

  SSO2_USER_ID=$(mock_saml_login "$SSO2_EMAIL" "$WORKDIR/sso2_token.txt")
  echo "  JIT-attempt identity: $SSO2_USER_ID"
  g2_patch_and_verify "$SSO2_USER_ID"
  STATUS=$(rpc record_sso_login "$WORKDIR/sso2_token.txt" '{}')
  assert_status 200 "$STATUS" "C1.15 record_sso_login callable for the new identity"
  echo "[G-2 SUBSTITUTED CLAIM] C1.15"
  echo "  response: $(last_body)"
  assert_jq_eq '.status' 'refused' "C1.15 new SSO identity refused (seat pressure)"
  assert_jq_eq '.reason' 'seat_limit_reached' "C1.15 refusal reason is seat_limit_reached"
  NEW_TM_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id='$TEAM_ID' AND user_id='$SSO2_USER_ID';")
  [ "$NEW_TM_COUNT" = "0" ] && ok "C1.15 no team_members row created for the refused new identity" || bad "C1.15 expected 0 rows, got $NEW_TM_COUNT"

  echo "  confirming the guard is NEW-member-only: existing SSO identity still refreshes fine under the same pressure"
  STATUS=$(rpc record_sso_login "$WORKDIR/sso_token3.txt" '{}')
  assert_status 200 "$STATUS" "C1.15 existing SSO member's record_sso_login still callable"
  assert_jq_eq '.status' 'ok' "C1.15 existing member refresh NOT refused by the seat guard"

  echo "--- C1.16: closed refusal vocabulary ---"
  echo "--- (a) settings status=inactive -> sso_inactive ---"
  run_sql -c "UPDATE team_sso_settings SET status='inactive' WHERE team_id='$TEAM_ID';" >/dev/null
  STATUS=$(rpc record_sso_login "$WORKDIR/sso_token3.txt" '{}')
  assert_status 200 "$STATUS" "C1.16(a) record_sso_login callable"
  assert_jq_eq '.status' 'refused' "C1.16(a) refused"
  assert_jq_eq '.reason' 'sso_inactive' "C1.16(a) reason=sso_inactive"
  STATUS=$(rpc sso_login_refusal_reason "$WORKDIR/sso_token3.txt" '{}')
  assert_status 200 "$STATUS" "C1.16(a) sso_login_refusal_reason callable"
  assert_jq_eq '.' 'sso_inactive' "C1.16(a) sso_login_refusal_reason() agrees with the RPC's own reason"
  run_sql -c "UPDATE team_sso_settings SET status='active' WHERE team_id='$TEAM_ID';" >/dev/null

  echo "--- (b) domain verified_at=NULL -> domain_not_verified ---"
  run_sql -c "UPDATE team_sso_domains SET verified_at=NULL WHERE team_id='$TEAM_ID' AND domain='$SAML_DOMAIN';" >/dev/null
  STATUS=$(rpc record_sso_login "$WORKDIR/sso_token3.txt" '{}')
  assert_status 200 "$STATUS" "C1.16(b) record_sso_login callable"
  assert_jq_eq '.status' 'refused' "C1.16(b) refused"
  assert_jq_eq '.reason' 'domain_not_verified' "C1.16(b) reason=domain_not_verified"
  STATUS=$(rpc sso_login_refusal_reason "$WORKDIR/sso_token3.txt" '{}')
  assert_jq_eq '.' 'domain_not_verified' "C1.16(b) sso_login_refusal_reason() agrees"
  run_sql -c "UPDATE team_sso_domains SET verified_at=now() WHERE team_id='$TEAM_ID' AND domain='$SAML_DOMAIN';" >/dev/null

  echo "--- (c) team_sso_settings row deleted -> provider_not_registered ---"
  run_sql -c "DELETE FROM team_sso_settings WHERE team_id='$TEAM_ID';" >/dev/null
  STATUS=$(rpc record_sso_login "$WORKDIR/sso_token3.txt" '{}')
  assert_status 200 "$STATUS" "C1.16(c) record_sso_login callable"
  assert_jq_eq '.status' 'refused' "C1.16(c) refused"
  assert_jq_eq '.reason' 'provider_not_registered' "C1.16(c) reason=provider_not_registered"
  STATUS=$(rpc sso_login_refusal_reason "$WORKDIR/sso_token3.txt" '{}')
  assert_jq_eq '.' 'provider_not_registered' "C1.16(c) sso_login_refusal_reason() agrees"
  # restore (temp table does not survive across psql invocations -- reinsert from the values
  # setup already established, rather than depending on the temp table across calls).
  SAML_PROVIDER_ID=$(cat "$WORKDIR/saml_provider_id")
  run_sql -c "
    INSERT INTO team_sso_settings (team_id, supabase_provider_id, reverify_days, role_mapping, status, configured_by)
    VALUES ('$TEAM_ID', '$SAML_PROVIDER_ID', 1,
            '{\"admin\":[\"skillsmith-admins\"],\"member\":[\"skillsmith-members\"]}'::jsonb,
            'active', '$OWNER_ID')
    ON CONFLICT (team_id) DO UPDATE SET supabase_provider_id = EXCLUDED.supabase_provider_id, status='active';
  " >/dev/null

  echo "--- (d) non-SSO session (LEGACY's password token) -> not_an_sso_session ---"
  STATUS=$(rpc record_sso_login "$WORKDIR/legacy_token.txt" '{}')
  assert_status 200 "$STATUS" "C1.16(d) record_sso_login callable as LEGACY"
  assert_jq_eq '.status' 'refused' "C1.16(d) refused"
  assert_jq_eq '.reason' 'not_an_sso_session' "C1.16(d) reason=not_an_sso_session"
  STATUS=$(rpc sso_login_refusal_reason "$WORKDIR/legacy_token.txt" '{}')
  assert_jq_eq '.' 'not_an_sso_session' "C1.16(d) sso_login_refusal_reason() agrees"

  echo "--- (e) no_authentication_timestamp ---"
  uncov "C1.16(e) no_authentication_timestamp is not reachable against Mock SAML -- its amr always carries a real timestamp (per the matrix's own note); recorded as unreached, not silently skipped"

  echo "  confirming the vocabulary re-confirms after full lifecycle (post-restore, real login still works)"
  STATUS=$(rpc record_sso_login "$WORKDIR/sso_token3.txt" '{}')
  assert_status 200 "$STATUS" "C1.16 post-restore record_sso_login callable"
  assert_jq_eq '.status' 'ok' "C1.16 post-restore login succeeds again (settings/domain fully restored)"

  echo "=== end phase chain4 === PASS=$PASS FAIL=$FAIL UNCOVERED=$UNCOVERED CHARACTERIZED=$CHARACTERIZED"
}

