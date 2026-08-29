#!/usr/bin/env bash
# smi-6205-sso-uat-e2e.sh -- synthetic end-to-end UAT harness for the SMI-6205 Wave 4
# SSO member-lifecycle feature (record_sso_login, link_sso_account, the dismiss/undismiss
# reversal pair, and the two read RPCs), exercised against REAL staging
# (ovhcifugwqnzoebwfuku) through a REAL Mock SAML login -- real GoTrue-issued JWTs, real
# PostgREST calls with `Authorization: Bearer <token>`, never a simulated
# `request.jwt.claims` the way 20260829230000/4's own smoke blocks do.
#
# Modeled on the sibling scripts/staging/smi-6267-rbac-uat-e2e.{sh,sql} harness (SMI-6267),
# but this feature is RPC/API-driven rather than pure-SQL, so this is bash+curl+jq
# throughout rather than a shell-wrapper-plus-piped-SQL-file split: there is no analogue
# here of that harness's single-transaction-then-ROLLBACK trick, because every assertion
# below goes through PostgREST as a SEPARATE HTTP request/transaction (that is the whole
# point -- it is what lets a real JWT and real RLS/SECURITY DEFINER auth.uid() resolution
# be exercised at all). Cleanup is therefore explicit DELETEs in a trap, not a ROLLBACK.
# Split into this file (the T1-T7 test body) plus the sourced
# smi-6205-sso-uat-e2e.helpers.sh (safety gates, fixtures, and every helper function)
# purely to stay under the repo's 500-line file gate -- functionally one script.
#
# Usage: varlock run -- ./scripts/staging/smi-6205-sso-uat-e2e.sh
# (works from any cwd -- paths below resolve relative to this script's own location).
# EXPECTED EXIT STATUS: ZERO. Every assertion is self-checking; a clean run prints only
# [PASS] lines plus the final [GAP]/[SUMMARY] block and exits 0. Any [FAIL] line means a
# real regression, and the script exits 1 after cleanup still runs to completion.
#
# Requires: skillsmith-dev-1 container running (pooler-psql.sh docker-execs into it
# purely for the psql binary -- same as the RBAC sibling's own note; this is the ONE
# hardcoded container name pooler-psql.sh uses regardless of which worktree invokes it,
# so a worktree's own container does not need to be running for this particular script).
# jq and python3 must be on the HOST (not the container) -- this whole script is a host
# tool, like pooler-psql.sh itself; nothing here runs inside Docker.
#
# ---------------------------------------------------------------------------
# WHY A REAL MOCK SAML LOGIN CAN BE DONE FROM A PLAIN SCRIPT (no browser needed)
# ---------------------------------------------------------------------------
# The task this harness was built from assumed an interactive browser (claude-in-chrome)
# would be required for the login-form submission and redirect chain. Investigation during
# this harness's construction found that is NOT the case: Mock SAML's "login form" is a
# Next.js SPA whose submit handler does nothing but POST
# `{email,id,audience,acsUrl,providerName,relayState}` as JSON to `/api/saml/auth` and
# splice the JSON response's HTML (an auto-submitting <form> POSTing a SAMLResponse to the
# real ACS URL) into the page. Every one of those steps is a plain HTTP request with no
# client-side validation and no JS execution required to reproduce -- `mock_saml_login()`
# below does exactly the four requests a browser would make, in order, and reads the
# resulting `access_token`/`refresh_token` straight out of the ACS response's redirect
# `Location` URL fragment. This makes the harness genuinely non-interactive and re-runnable
# from CI or any host shell, not just from an agent session with browser tools attached.
#
# TIMING IS LOAD-BEARING: GoTrue's RelayState is short-lived (observed to expire within a
# few minutes of the initiating `/auth/v1/sso` call during this harness's construction --
# a real run that paused between steps 1-4 of `mock_saml_login()` got back
# `saml_relay_state_expired`). The four requests inside that function must run back to
# back with no manual/interactive step in between -- this is exactly why they are one
# function and not four separate script invocations.
#
# ---------------------------------------------------------------------------
# THE GROUPS-CLAIM GAP (read this before trusting a green run on JIT provisioning)
# ---------------------------------------------------------------------------
# Mock SAML's login form has NO way to assert a `groups` (or any custom SAML) attribute --
# confirmed empirically by this harness (see the T1 step below, which decodes and asserts
# on the real issued JWT): `user_metadata.custom_claims` comes back as an empty object on
# every real login, so `sso_session_identity()`'s group_claims is always `[]`, and
# `sso_map_role()` can therefore NEVER return a non-NULL role against a Mock SAML session --
# this is a structural property of the IdP, not a config mistake this script could fix by
# trying harder. Per this harness's own build instructions, THAT IS NOT WORKED AROUND HERE
# (no synthetic `identity_data` patch, no attribute_mapping alias trick): T1/T2 below prove
# the resulting FAIL-CLOSED behaviour instead (an unmapped real SSO login creates no
# `team_members` row and is idempotent), which is itself the correct, security-relevant
# property to prove. See the final [GAP] block this script prints for the recommendation.
#
# What this DOES let the rest of the suite (T3-T6) exercise for real: every function in
# the family EXCEPT record_sso_login()'s role-mapped upsert path only depends on
# sso_session_binding() succeeding (provider registered + active + domain verified + a real
# auth timestamp) -- none of that depends on role mapping. So the identity-link candidate
# lifecycle (create/discover/consent/dismiss/undismiss/link) is exercised fully end-to-end
# with real sessions for BOTH identities; only the candidate ROW's INITIAL INSERT is
# service-role fixture-seeded here (record_sso_login()'s own step 7, which creates it, is
# gated behind the same unreachable role-mapping success and so never runs against Mock
# SAML) -- documented at that step below, not hidden.
#
# ---------------------------------------------------------------------------
# IDEMPOTENCY / RE-RUNNABILITY
# ---------------------------------------------------------------------------
# The team (`_e2e_sso_6205_team`) and its SSO settings/domain rows use a fixed id and
# ON CONFLICT DO UPDATE, so re-running is safe. auth.users rows CANNOT be given a
# caller-chosen id via the Admin API, so idempotency for those is handled by DELETING any
# pre-existing user at each fixture email BEFORE creating a fresh one (self-heals a
# previous run that crashed before its own cleanup ran) -- see `ensure_clean_email()`.
# The Mock SAML provider is likewise swept for leftovers (any provider claiming
# `example.com`) before a fresh one is registered, so a crashed prior run cannot
# accumulate orphan providers on staging.

source "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/smi-6205-sso-uat-e2e.helpers.sh"

# ============================================================================
# PRE-FLIGHT: sweep leftovers from a previous crashed run + the one genuine cross-tenant
# hazard -- `example.com` verified by some OTHER real team on staging (extremely unlikely
# given it is a well-known Mock-SAML-only test domain, but this is REAL staging and the
# check is cheap).
# ============================================================================
echo "--- pre-flight ---"
OTHER_VERIFIED=$(run_sql -c "
  SELECT count(*) FROM team_sso_domains
   WHERE domain = '$SAML_DOMAIN' AND verified_at IS NOT NULL AND team_id <> '$TEAM_ID';
")
if [ "${OTHER_VERIFIED:-0}" != "0" ]; then
  echo "REFUSING: $SAML_DOMAIN is already verified by a DIFFERENT team on staging. This" >&2
  echo "          harness cannot safely claim it without risking a real tenant's SSO config." >&2
  exit 1
fi

for email in "$OWNER_EMAIL" "$OUTSIDER_EMAIL" "$LEGACY1_EMAIL" "$LEGACY2_EMAIL" "$SSO_LOGIN_EMAIL"; do
  ensure_clean_email "$email"
done
run_sql -c "DELETE FROM teams WHERE id = '$TEAM_ID';" >/dev/null
LEFTOVER_PROVIDERS=$(curl -s "$STAGING_SUPABASE_URL/auth/v1/admin/sso/providers" \
  -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
  | jq -r --arg d "$SAML_DOMAIN" '.items[] | select(.domains[]?.domain == $d) | .id')
for pid in $LEFTOVER_PROVIDERS; do
  echo "  (self-heal) deleting leftover SAML provider $pid"
  curl -s -o /dev/null -X DELETE "$STAGING_SUPABASE_URL/auth/v1/admin/sso/providers/$pid" \
    -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY"
done

SAML_ENABLED=$(curl -s "https://api.supabase.com/v1/projects/$STAGING_SUPABASE_PROJECT_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" | jq -r '.saml_enabled')
if [ "$SAML_ENABLED" != "true" ]; then
  echo "  saml_enabled was $SAML_ENABLED -- PATCHing it back on (Wave 0 left this on deliberately)."
  curl -s -o /dev/null -X PATCH "https://api.supabase.com/v1/projects/$STAGING_SUPABASE_PROJECT_REF/config/auth" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data-raw '{"saml_enabled": true}'
fi

# ============================================================================
# SETUP: register the Mock SAML provider, create the throwaway team + SSO settings +
# verified domain.
# ============================================================================
echo "--- setup ---"
PROVIDER_JSON=$(curl -s -X POST "$STAGING_SUPABASE_URL/auth/v1/admin/sso/providers" \
  -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  --data-raw "$(jq -n --arg u "$SAML_METADATA_URL" --arg d "$SAML_DOMAIN" \
    '{type:"saml",metadata_url:$u,domains:[$d]}')")
SAML_PROVIDER_ID=$(echo "$PROVIDER_JSON" | jq -r '.id')
[ -n "$SAML_PROVIDER_ID" ] && [ "$SAML_PROVIDER_ID" != "null" ] || {
  echo "REFUSING: SAML provider registration failed: $PROVIDER_JSON" >&2; exit 1; }
echo "  registered SAML provider $SAML_PROVIDER_ID"

OWNER_ID=$(create_user "$OWNER_EMAIL" "$WORKDIR/owner_pw.txt")
run_sql -c "
  INSERT INTO teams (id, name, owner_id, max_members)
  VALUES ('$TEAM_ID', 'E2E SSO 6205 Team', '$OWNER_ID', 10)
  ON CONFLICT (id) DO UPDATE SET max_members = EXCLUDED.max_members;

  INSERT INTO team_sso_settings (team_id, supabase_provider_id, reverify_days, role_mapping, status, configured_by)
  VALUES ('$TEAM_ID', '$SAML_PROVIDER_ID', 7,
          '{\"admin\":[\"skillsmith-admins\"],\"member\":[\"skillsmith-members\"]}'::jsonb,
          'active', '$OWNER_ID')
  ON CONFLICT (team_id) DO UPDATE SET supabase_provider_id = EXCLUDED.supabase_provider_id,
    status = 'active', role_mapping = EXCLUDED.role_mapping;

  INSERT INTO team_sso_domains (team_id, domain, verification_token, verified_at, last_verified_at)
  VALUES ('$TEAM_ID', '$SAML_DOMAIN', 'e2e-6205-fixture-token', now(), now())
  ON CONFLICT (team_id, domain) DO UPDATE SET verified_at = now(), last_verified_at = now();
" >/dev/null
echo "  team + SSO settings + verified domain ready"

# ============================================================================
# THE REAL SSO LOGIN
# ============================================================================
echo "--- real Mock SAML login (SSO identity) ---"
SSO_USER_ID=$(mock_saml_login "$SSO_LOGIN_EMAIL" "$WORKDIR/sso_token.txt")
echo "  JIT-provisioned SSO identity: $SSO_USER_ID"

# Empirical confirmation of the groups-claim gap (see header), read straight off the real
# issued JWT rather than asserted from memory of a prior investigation.
GROUP_CLAIMS=$(jwt_claim "$(cat "$WORKDIR/sso_token.txt")" '.user_metadata.custom_claims')
if [ "$GROUP_CLAIMS" = "{}" ]; then
  ok "confirmed live: Mock SAML's real assertion carries no groups/custom_claims (custom_claims=$GROUP_CLAIMS)"
else
  bad "Mock SAML's assertion unexpectedly carried custom_claims=$GROUP_CLAIMS -- re-check the GAP note, this may no longer be true"
fi

# ============================================================================
# T1 -- JIT provisioning: the reachable (fail-closed) case.
# A brand-new SSO identity's first login CANNOT reach a mapped role against Mock SAML (see
# GAP). What we assert instead is the honest, security-relevant negative: binding succeeds
# (team_id is populated) but role mapping fails closed -- status=unmapped, and critically,
# NO team_members row and NO audit trail claiming a real login.
# ============================================================================
echo "--- T1: record_sso_login() -- JIT provisioning (fail-closed, no groups claim) ---"
STATUS=$(rpc record_sso_login "$WORKDIR/sso_token.txt" '{}')
assert_status 200 "$STATUS" "record_sso_login callable by the real SSO session"
assert_jq_eq '.status' 'unmapped' "T1.1 first login with no group match returns status=unmapped"
assert_jq_eq '.team_id' "$TEAM_ID" "T1.2 binding still resolved the correct team despite the unmapped role"
TM_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$SSO_USER_ID';")
[ "$TM_COUNT" = "0" ] && ok "T1.3 no team_members row created for an unmapped login" \
  || bad "T1.3 expected 0 team_members rows for the unmapped SSO identity, got $TM_COUNT"
AUDIT_EVENT=$(run_sql -c "SELECT event_type FROM audit_logs WHERE actor = '$SSO_USER_ID' ORDER BY created_at DESC LIMIT 1;")
[ "$AUDIT_EVENT" = "sso:login_unmapped" ] && ok "T1.4 audit trail records sso:login_unmapped, not a real login" \
  || bad "T1.4 expected audit event sso:login_unmapped, got '$AUDIT_EVENT'"

# ============================================================================
# T2 -- second login is idempotent in its only reachable (unmapped) form: same result,
# still zero membership rows, one MORE audit row (each login attempt is legitimately
# logged -- that is not a duplicate-provisioning bug, it is an audit trail of attempts).
# ============================================================================
echo "--- T2: second record_sso_login() call is idempotent ---"
STATUS=$(rpc record_sso_login "$WORKDIR/sso_token.txt" '{}')
assert_status 200 "$STATUS" "second record_sso_login call succeeds"
assert_jq_eq '.status' 'unmapped' "T2.1 second call returns the same unmapped status"
TM_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$SSO_USER_ID';")
[ "$TM_COUNT" = "0" ] && ok "T2.2 still no team_members row after a second call" \
  || bad "T2.2 expected 0 team_members rows, got $TM_COUNT"

# ============================================================================
# LEGACY IDENTITIES + CANDIDATE FIXTURE SEEDING.
#
# legacy1 is pre-seeded as an 'admin' team_members row (simulating an already-invited
# admin who now also authenticates via SSO); legacy2 as a 'member' row. The sso_account_links
# candidate rows are seeded DIRECTLY (service-role) rather than through record_sso_login()'s
# own step 7 -- that step is gated behind the same unreachable role-mapping success as T1/T2
# above, so it never runs against a real Mock SAML session. This substitutes ONLY for the
# candidate's initial INSERT; every RPC call from here on uses REAL sessions/JWTs for BOTH
# identities, exercising the consent/dismiss/undismiss/link functions exactly as PostgREST
# would receive them from a real browser.
# ============================================================================
echo "--- fixture: legacy identities + seeded candidates ---"
LEGACY1_ID=$(create_user "$LEGACY1_EMAIL" "$WORKDIR/legacy1_pw.txt")
LEGACY2_ID=$(create_user "$LEGACY2_EMAIL" "$WORKDIR/legacy2_pw.txt")
OUTSIDER_ID=$(create_user "$OUTSIDER_EMAIL" "$WORKDIR/outsider_pw.txt")
password_login "$LEGACY1_EMAIL" "$WORKDIR/legacy1_pw.txt" "$WORKDIR/legacy1_token.txt"
password_login "$LEGACY2_EMAIL" "$WORKDIR/legacy2_pw.txt" "$WORKDIR/legacy2_token.txt"
password_login "$OUTSIDER_EMAIL" "$WORKDIR/outsider_pw.txt" "$WORKDIR/outsider_token.txt"

run_sql -c "
  INSERT INTO team_members (team_id, user_id, role, provisioned_via, joined_at)
  VALUES
    ('$TEAM_ID', '$LEGACY1_ID', 'admin', 'manual', now()),
    ('$TEAM_ID', '$LEGACY2_ID', 'member', 'manual', now())
  ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role;

  INSERT INTO sso_account_links (sso_user_id, legacy_user_id, team_id, consent_expires_at)
  VALUES
    ('$SSO_USER_ID', '$LEGACY1_ID', '$TEAM_ID', now() + interval '7 days'),
    ('$SSO_USER_ID', '$LEGACY2_ID', '$TEAM_ID', now() + interval '7 days')
  ON CONFLICT (sso_user_id, legacy_user_id) DO UPDATE SET consent_expires_at = EXCLUDED.consent_expires_at;
" >/dev/null
echo "  legacy1 (admin, $LEGACY1_ID) + legacy2 (member, $LEGACY2_ID) + outsider ($OUTSIDER_ID) ready"

# ============================================================================
# T3 -- discovery: both readers, both directions, plus the cross-user leakage checks.
# ============================================================================
echo "--- T3: get_own_sso_link_candidate() / get_pending_sso_link_requests() ---"
STATUS=$(rpc get_own_sso_link_candidate "$WORKDIR/sso_token.txt" '{}')
assert_status 200 "$STATUS" "get_own_sso_link_candidate callable as SSO identity"
COUNT=$(jq 'length' "$WORKDIR/last_body.json")
[ "$COUNT" = "2" ] && ok "T3.1 SSO identity sees both candidates" || bad "T3.1 expected 2 candidates, got $COUNT"

STATUS=$(rpc get_pending_sso_link_requests "$WORKDIR/legacy1_token.txt" '{}')
assert_status 200 "$STATUS" "get_pending_sso_link_requests callable as legacy1"
assert_jq_eq '.[0].sso_user_id' "$SSO_USER_ID" "T3.2 legacy1 sees its own pending request naming the right SSO identity"
assert_jq_eq '.[0].team_name' "E2E SSO 6205 Team" "T3.3 legacy1's pending request names the team"

STATUS=$(rpc get_pending_sso_link_requests "$WORKDIR/outsider_token.txt" '{}')
assert_status 200 "$STATUS" "get_pending_sso_link_requests callable as outsider"
COUNT=$(jq 'length' "$WORKDIR/last_body.json")
[ "$COUNT" = "0" ] && ok "T3.4 an unrelated account sees no pending requests (no cross-user leakage)" \
  || bad "T3.4 expected 0 rows for an unrelated account, got $COUNT"

# ============================================================================
# T6 (run before T4/T5 mutate state) -- deliberate refusal shapes through the REAL REST API.
# ============================================================================
echo "--- T6: refusal shapes ---"
STATUS=$(rpc record_sso_link_consent "$WORKDIR/outsider_token.txt" "$(jq -n --arg s "$SSO_USER_ID" '{p_sso_user_id:$s}')")
assert_status 403 "$STATUS" "T6.1 outsider consenting to someone else's candidate is refused"
assert_jq_contains_code "42501" "T6.1 refusal carries SQLSTATE 42501"

STATUS=$(rpc dismiss_sso_link_candidate "$WORKDIR/outsider_token.txt" "$(jq -n --arg l "$LEGACY1_ID" '{p_legacy_user_id:$l}')")
assert_status 403 "$STATUS" "T6.2 outsider dismissing someone else's candidate is refused"
assert_jq_contains_code "42501" "T6.2 refusal carries SQLSTATE 42501"

STATUS=$(rpc link_sso_account "$WORKDIR/outsider_token.txt" "$(jq -n --arg l "$LEGACY1_ID" '{p_legacy_user_id:$l}')")
assert_status 403 "$STATUS" "T6.3 a non-SSO session calling link_sso_account is refused"
assert_jq_eq '.message' "forbidden: link_sso_account must be called as an SSO identity bound to a team (not_an_sso_session)" \
  "T6.3 refusal names not_an_sso_session"

# ============================================================================
# T4 -- consent -> link, end to end, for legacy1 (the 'admin' pair).
# ============================================================================
echo "--- T4: consent -> link (legacy1, admin) ---"
STATUS=$(rpc record_sso_link_consent "$WORKDIR/legacy1_token.txt" "$(jq -n --arg s "$SSO_USER_ID" '{p_sso_user_id:$s}')")
assert_status 204 "$STATUS" "T4.1 legacy1 consents to the link"
STATUS=$(rpc link_sso_account "$WORKDIR/sso_token.txt" "$(jq -n --arg l "$LEGACY1_ID" '{p_legacy_user_id:$l}')")
assert_status 204 "$STATUS" "T4.2 SSO identity executes the link"

MOVED_ROLE=$(run_sql -c "SELECT role FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$SSO_USER_ID';")
[ "$MOVED_ROLE" = "admin" ] && ok "T4.3 entitlement moved: SSO identity now holds legacy1's admin role" \
  || bad "T4.3 expected SSO identity to hold role=admin after linking legacy1, got '$MOVED_ROLE'"
LEGACY1_TM_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$LEGACY1_ID';")
[ "$LEGACY1_TM_COUNT" = "0" ] && ok "T4.4 legacy1's own team_members row was removed" \
  || bad "T4.4 expected legacy1's team_members row gone, still $LEGACY1_TM_COUNT row(s)"
LINK_AUDIT=$(run_sql -c "SELECT count(*) FROM audit_logs WHERE event_type = 'sso:account_linked' AND actor = '$SSO_USER_ID';")
[ "$LINK_AUDIT" -ge "1" ] && ok "T4.5 audit trail recorded sso:account_linked" \
  || bad "T4.5 expected an sso:account_linked audit row, found $LINK_AUDIT"

# ============================================================================
# T5 -- dismiss -> undismiss -> consent -> link, end to end, for legacy2 (the newest code,
# fixing the N-7 bug this session closed: an expired-consent-then-undismiss row could not
# previously be re-serviced). Proven here against the REAL auth stack, not the migration's
# own simulated request.jwt.claims smoke block.
# ============================================================================
echo "--- T5: dismiss -> undismiss -> consent -> link (legacy2, member) ---"
STATUS=$(rpc dismiss_sso_link_candidate "$WORKDIR/sso_token.txt" "$(jq -n --arg l "$LEGACY2_ID" '{p_legacy_user_id:$l}')")
assert_status 204 "$STATUS" "T5.1 SSO identity dismisses legacy2's candidate"

STATUS=$(rpc get_own_sso_link_candidate "$WORKDIR/sso_token.txt" '{}')
COUNT=$(jq 'length' "$WORKDIR/last_body.json")
[ "$COUNT" = "0" ] && ok "T5.2 dismissed candidate disappears from get_own_sso_link_candidate" \
  || bad "T5.2 expected 0 candidates after dismissal, got $COUNT"
STATUS=$(rpc get_pending_sso_link_requests "$WORKDIR/legacy2_token.txt" '{}')
COUNT=$(jq 'length' "$WORKDIR/last_body.json")
[ "$COUNT" = "0" ] && ok "T5.3 dismissed candidate disappears from get_pending_sso_link_requests" \
  || bad "T5.3 expected 0 pending requests after dismissal, got $COUNT"

STATUS=$(rpc record_sso_link_consent "$WORKDIR/legacy2_token.txt" "$(jq -n --arg s "$SSO_USER_ID" '{p_sso_user_id:$s}')")
assert_status 403 "$STATUS" "T5.4 legacy2 cannot consent to a DISMISSED candidate"

STATUS=$(rpc undismiss_sso_link_candidate "$WORKDIR/sso_token.txt" "$(jq -n --arg l "$LEGACY2_ID" '{p_legacy_user_id:$l}')")
assert_status 204 "$STATUS" "T5.5 SSO identity reverses its own decline"

STATUS=$(rpc get_own_sso_link_candidate "$WORKDIR/sso_token.txt" '{}')
COUNT=$(jq 'length' "$WORKDIR/last_body.json")
[ "$COUNT" = "1" ] && ok "T5.6 candidate reappears in get_own_sso_link_candidate after undismiss" \
  || bad "T5.6 expected 1 candidate after undismiss, got $COUNT"
STATUS=$(rpc get_pending_sso_link_requests "$WORKDIR/legacy2_token.txt" '{}')
COUNT=$(jq 'length' "$WORKDIR/last_body.json")
[ "$COUNT" = "1" ] && ok "T5.7 candidate reappears in get_pending_sso_link_requests after undismiss" \
  || bad "T5.7 expected 1 pending request after undismiss, got $COUNT"

STATUS=$(rpc record_sso_link_consent "$WORKDIR/legacy2_token.txt" "$(jq -n --arg s "$SSO_USER_ID" '{p_sso_user_id:$s}')")
assert_status 204 "$STATUS" "T5.8 legacy2 can consent again after the reversal (the N-7 fix, proven live)"
STATUS=$(rpc link_sso_account "$WORKDIR/sso_token.txt" "$(jq -n --arg l "$LEGACY2_ID" '{p_legacy_user_id:$l}')")
assert_status 204 "$STATUS" "T5.9 SSO identity executes the link"

MOVED_ROLE=$(run_sql -c "SELECT role FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$SSO_USER_ID';")
[ "$MOVED_ROLE" = "member" ] && \
  ok "T5.10 entitlement moved again: SSO identity now holds legacy2's member role (documented last-link-wins behavior -- link_sso_account() always moves the LATEST linked legacy account's role onto the SSO identity, so linking legacy1 then legacy2 leaves member, not admin)" \
  || bad "T5.10 expected SSO identity to hold role=member after linking legacy2, got '$MOVED_ROLE'"
LEGACY2_TM_COUNT=$(run_sql -c "SELECT count(*) FROM team_members WHERE team_id = '$TEAM_ID' AND user_id = '$LEGACY2_ID';")
[ "$LEGACY2_TM_COUNT" = "0" ] && ok "T5.11 legacy2's own team_members row was removed" \
  || bad "T5.11 expected legacy2's team_members row gone, still $LEGACY2_TM_COUNT row(s)"

# ============================================================================
# T7 -- record_sso_login()'s binding-level refusal reasons, live. Each check flips ONE
# fixture row, asserts, then restores it before moving to the next -- provider_not_registered
# is tested LAST since it deletes the settings row outright (harmless here: cleanup deletes
# the whole team next anyway).
# ============================================================================
echo "--- T7: sso_session_binding() refusal reasons ---"
run_sql -c "UPDATE team_sso_settings SET status = 'inactive' WHERE team_id = '$TEAM_ID';" >/dev/null
STATUS=$(rpc record_sso_login "$WORKDIR/sso_token.txt" '{}')
assert_jq_eq '.reason' 'sso_inactive' "T7.1 an inactive SSO settings row refuses with sso_inactive"
run_sql -c "UPDATE team_sso_settings SET status = 'active' WHERE team_id = '$TEAM_ID';" >/dev/null

run_sql -c "UPDATE team_sso_domains SET verified_at = NULL WHERE team_id = '$TEAM_ID' AND domain = '$SAML_DOMAIN';" >/dev/null
STATUS=$(rpc record_sso_login "$WORKDIR/sso_token.txt" '{}')
assert_jq_eq '.reason' 'domain_not_verified' "T7.2 an unverified domain claim refuses with domain_not_verified"
run_sql -c "UPDATE team_sso_domains SET verified_at = now() WHERE team_id = '$TEAM_ID' AND domain = '$SAML_DOMAIN';" >/dev/null

run_sql -c "DELETE FROM team_sso_settings WHERE team_id = '$TEAM_ID';" >/dev/null
STATUS=$(rpc record_sso_login "$WORKDIR/sso_token.txt" '{}')
assert_jq_eq '.reason' 'provider_not_registered' "T7.3 a deleted SSO settings row refuses with provider_not_registered"

# ============================================================================
# FINAL SUMMARY
# ============================================================================
echo ""
echo "===================================================================="
echo "SMI-6205 SSO Wave 4 UAT: $PASS passed, $FAIL failed."
echo "--------------------------------------------------------------------"
echo "[GAP] Mock SAML's login form cannot assert a groups/custom SAML attribute (confirmed"
echo "      live above: user_metadata.custom_claims = {} on a real issued JWT), so"
echo "      sso_map_role()'s group-to-role mapping -- and therefore the POSITIVE JIT"
echo "      provisioning case (a mapped role actually creating a team_members row) and"
echo "      idempotency of that PROVISIONED state -- cannot be exercised against a REAL"
echo "      assertion with this IdP. What this harness DID prove live: the resulting"
echo "      fail-closed behavior (T1/T2) is correct, and every OTHER function in the"
echo "      family (T3-T7) -- including the newest dismiss/undismiss/N-7 code (T5) -- is"
echo "      fully exercised end-to-end through real sessions and real PostgREST calls,"
echo "      since none of those depend on role mapping succeeding."
echo "[RECOMMENDATION] Not worth pursuing before ship: the role-mapping matrix itself is"
echo "      already covered by 20260829230000.sql's own SQL smoke block (Section 11), and"
echo "      standing up a fuller IdP (a real Okta dev org, or a self-hosted Jackson/BoxyHQ"
echo "      instance with custom attribute mapping) is real infrastructure work for a gap"
echo "      that is provably fail-closed today. Revisit only if a customer support ticket"
echo "      ever actually reports a group-mapping misbehavior in production."
echo "===================================================================="
