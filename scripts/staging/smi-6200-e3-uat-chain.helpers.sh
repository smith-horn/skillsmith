# smi-6200-e3-uat-chain.helpers.sh -- sourced by smi-6200-e3-uat-chain.sh.
#
# Adapted from scripts/staging/smi-6205-sso-uat-e2e.helpers.sh (same mechanics: run_sql,
# rpc, assert_*, jwt_claim, mock_saml_login, ensure_clean_email, create_user,
# password_login) but with THIS scenario's own six-identity fixture cast (SMI-6200 E3 UAT
# matrix, docs/internal/implementation/smi-6200-e3-uat-scenario-matrix.md, section 4) and
# fixture prefix (_e2e_e3_6200_ / e2e-e3-6200-), and deliberately NO trap-based cleanup:
# the C1 chain's whole point is fixtures that survive to be read by later Z/R/U/Q-series
# scenarios in the same matrix, run by a separate session. See the matrix's own cleanup
# discipline note. Use scripts/staging/smi-6200-e3-uat-chain.sh --cleanup to explicitly
# tear down when the entire matrix (not just C1) is done.
set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
# Persistent (not mktemp) workdir so state (tokens, ids) survives across the several
# process invocations the C1 chain runs as (paused at B-CP1/B-CP2/B-CP3 for the browser
# agent). Safe to reuse across days; every write is idempotent / overwrite-in-place.
WORKDIR="${SMI6200_WORKDIR:-$HOME/.skillsmith-uat/smi6200-e3-chain}"
mkdir -p "$WORKDIR"

# ============================================================================
# SAFETY GATES -- identical posture to the SMI-6205 sibling.
# ============================================================================
: "${STAGING_SUPABASE_PROJECT_REF:?REFUSING: STAGING_SUPABASE_PROJECT_REF is not set. Run via 'varlock run -- ./scripts/staging/smi-6200-e3-uat-chain.sh'.}"
: "${STAGING_SUPABASE_URL:?REFUSING: STAGING_SUPABASE_URL is not set.}"
: "${STAGING_SUPABASE_ANON_KEY:?REFUSING: STAGING_SUPABASE_ANON_KEY is not set.}"
: "${STAGING_SUPABASE_SERVICE_ROLE_KEY:?REFUSING: STAGING_SUPABASE_SERVICE_ROLE_KEY is not set.}"
: "${STAGING_SUPABASE_DB_PASSWORD:?REFUSING: STAGING_SUPABASE_DB_PASSWORD is not set.}"
: "${SUPABASE_ACCESS_TOKEN:?REFUSING: SUPABASE_ACCESS_TOKEN is not set (needed for the Management API saml_enabled check).}"

PROD_REF="vrcnzpmndtroqxxoqkzy"
STAGING_REF="ovhcifugwqnzoebwfuku"

if [ "$STAGING_SUPABASE_PROJECT_REF" = "$PROD_REF" ]; then
  echo "REFUSING: STAGING_SUPABASE_PROJECT_REF is set to the PROD ref." >&2
  exit 1
fi
if [ "$STAGING_SUPABASE_PROJECT_REF" != "$STAGING_REF" ]; then
  echo "REFUSING: STAGING_SUPABASE_PROJECT_REF ($STAGING_SUPABASE_PROJECT_REF) is not the known staging ref ($STAGING_REF)." >&2
  exit 1
fi
case "$STAGING_SUPABASE_URL" in
  *"$STAGING_REF"*) : ;;
  *) echo "REFUSING: STAGING_SUPABASE_URL does not contain the staging ref ($STAGING_REF)." >&2; exit 1 ;;
esac
case "$STAGING_SUPABASE_URL" in
  *"$PROD_REF"*) echo "REFUSING: STAGING_SUPABASE_URL contains the PROD ref." >&2; exit 1 ;;
esac

# ============================================================================
# FIXTURE CAST (matrix section 4) -- fixed, greppable, `_e2e_e3_6200_`-prefixed (teams) or
# `e2e-e3-6200-`-prefixed (emails).
# ============================================================================
TEAM_ID="_e2e_e3_6200_team"
OWNER_EMAIL="e2e-e3-6200-owner@smithhorn-test.invalid"
ADMIN_EMAIL="e2e-e3-6200-admin@smithhorn-test.invalid"
LEGACY_EMAIL="e2e-e3-6200-legacy@example.com"
SSO_EMAIL="e2e-e3-6200-ssouser@example.com"
OUTSIDER_EMAIL="e2e-e3-6200-outsider@smithhorn-test.invalid"
SAML_DOMAIN="example.com"
SAML_METADATA_URL="https://mocksaml.com/api/saml/metadata"

PASS=0
FAIL=0
UNCOVERED=0
CHARACTERIZED=0
ok()  { PASS=$((PASS+1)); printf '[PASS] %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '[FAIL] %s\n' "$1" >&2; }
uncov() { UNCOVERED=$((UNCOVERED+1)); printf '[UNCOVERED] %s\n' "$1"; }
charz() { CHARACTERIZED=$((CHARACTERIZED+1)); printf '[CHARACTERIZED] %s\n' "$1"; }

run_sql() {
  SUPABASE_PROJECT_REF="$STAGING_SUPABASE_PROJECT_REF" \
  SUPABASE_DB_PASSWORD="$STAGING_SUPABASE_DB_PASSWORD" \
    "$REPO_ROOT/scripts/pooler-psql.sh" -v ON_ERROR_STOP=1 -t -A "$@"
}
run_sql_aligned() {
  SUPABASE_PROJECT_REF="$STAGING_SUPABASE_PROJECT_REF" \
  SUPABASE_DB_PASSWORD="$STAGING_SUPABASE_DB_PASSWORD" \
    "$REPO_ROOT/scripts/pooler-psql.sh" -v ON_ERROR_STOP=1 "$@"
}

rpc() {
  local fn="$1" token_file="$2" body="$3"
  local token; token=$(cat "$token_file")
  curl -s -o "$WORKDIR/last_body.json" -w '%{http_code}' \
    -X POST "$STAGING_SUPABASE_URL/rest/v1/rpc/$fn" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    --data-raw "$body"
}
last_body() { cat "$WORKDIR/last_body.json"; }

assert_status() {  # expected actual label
  if [ "$1" = "$2" ]; then ok "$3 (HTTP $2)"; else bad "$3 -- expected HTTP $1, got $2 (body: $(last_body))"; fi
}
assert_jq_eq() {  # jq_path expected label
  local actual
  actual=$(jq -r "$1" "$WORKDIR/last_body.json" 2>/dev/null || echo '<parse-error>')
  if [ "$actual" = "$2" ]; then ok "$3 (got $actual)"; else bad "$3 -- expected '$2', got '$actual' (body: $(last_body))"; fi
}
assert_jq_in() {  # jq_path space_separated_expected_set label
  local actual
  actual=$(jq -r "$1" "$WORKDIR/last_body.json" 2>/dev/null || echo '<parse-error>')
  local ok_found=0 e
  for e in $2; do [ "$actual" = "$e" ] && ok_found=1; done
  if [ "$ok_found" = "1" ]; then ok "$3 (got $actual)"; else bad "$3 -- expected one of [$2], got '$actual' (body: $(last_body))"; fi
}

ensure_clean_email() {
  local email="$1"
  local uids
  uids=$(curl -s "$STAGING_SUPABASE_URL/auth/v1/admin/users?filter=$email" \
    -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    | jq -r --arg e "$email" '.users[] | select(.email == $e) | .id')
  for uid in $uids; do
    echo "  (self-heal) deleting leftover auth.users row for $email ($uid)"
    # Fixed (SMI-6200 UAT re-run, 2026-08-31, live finding): a leftover device_codes row
    # from a prior run's C1.8 device-login flow FK-blocks the auth.users delete
    # (device_codes_user_id_fkey), and the DELETE below used to discard both body and
    # status via `-o /dev/null` with no `-w` capture -- so a failed delete printed the
    # SAME "(self-heal) deleting..." success-looking line as a real one. This silently
    # left the OLD row in place every run, which is what C1.9's "expected exactly 1 row,
    # got 2" shadow-account check was actually catching -- a harness cleanup gap, not the
    # SMI-6206 regression the check's own comment guesses at. Clear device_codes first,
    # then verify the actual DELETE status instead of swallowing it. (Second fix, same
    # session: the device_codes DELETE itself still discarded body+status via `-o
    # /dev/null` -- inconsistent with the fix this comment describes, flagged by NEEDLE's
    # second-opinion review of the resulting UAT report. Now checked the same way.)
    local dc_status
    dc_status=$(curl -s -o "$WORKDIR/self_heal_device_codes_body.json" -w '%{http_code}' \
      -X DELETE "$STAGING_SUPABASE_URL/rest/v1/device_codes?user_id=eq.$uid" \
      -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY")
    case "$dc_status" in
      2*) : ;;
      *)
        echo "REFUSING: self-heal device_codes cleanup for $email ($uid) failed (HTTP $dc_status): $(cat "$WORKDIR/self_heal_device_codes_body.json")" >&2
        exit 1
        ;;
    esac
    local del_status
    del_status=$(curl -s -o "$WORKDIR/self_heal_delete_body.json" -w '%{http_code}' \
      -X DELETE "$STAGING_SUPABASE_URL/auth/v1/admin/users/$uid" \
      -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY")
    case "$del_status" in
      2*) : ;;
      *)
        echo "REFUSING: self-heal delete of $email ($uid) failed (HTTP $del_status): $(cat "$WORKDIR/self_heal_delete_body.json")" >&2
        exit 1
        ;;
    esac
  done
}

create_user() {  # email password_out_file -> prints new user id
  local email="$1" pw_file="$2"
  local pw; pw=$(openssl rand -base64 24)
  echo "$pw" > "$pw_file"
  local resp
  resp=$(curl -s -X POST "$STAGING_SUPABASE_URL/auth/v1/admin/users" \
    -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    --data-raw "$(jq -n --arg e "$email" --arg p "$pw" '{email:$e,password:$p,email_confirm:true}')")
  local uid; uid=$(echo "$resp" | jq -r '.id // empty')
  if [ -z "$uid" ]; then
    echo "REFUSING: admin-createUser failed for $email: $resp" >&2
    exit 1
  fi
  echo "$uid"
}

password_login() {  # email password_file out_token_file
  local email="$1" pw; pw=$(cat "$2")
  curl -s -X POST "$STAGING_SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    --data-raw "$(jq -n --arg e "$email" --arg p "$pw" '{email:$e,password:$p}')" \
    | jq -r '.access_token' > "$3"
  if [ ! -s "$3" ] || [ "$(cat "$3")" = "null" ]; then
    echo "REFUSING: password login failed for $email" >&2
    exit 1
  fi
}

jwt_claim() {
  local token="$1" path="$2"
  local payload; payload=$(printf '%s' "$token" | cut -d. -f2 | tr -- '-_' '+/')
  case $(( ${#payload} % 4 )) in
    2) payload="${payload}==" ;;
    3) payload="${payload}=" ;;
  esac
  printf '%s' "$payload" | base64 -d 2>/dev/null | jq -r "$path"
}

mock_saml_login() {
  local login_email="$1" out_token_file="$2"

  local init_headers="$WORKDIR/sso_init_headers.txt"
  curl -sD "$init_headers" -o /dev/null -X POST "$STAGING_SUPABASE_URL/auth/v1/sso" \
    -H "apikey: $STAGING_SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    --data-raw "$(jq -n --arg d "$SAML_DOMAIN" '{domain:$d,redirect_to:"https://ovhcifugwqnzoebwfuku.supabase.co/sso-e2e-landing"}')"
  local mocksaml_sso_url
  mocksaml_sso_url=$(grep -i '^location:' "$init_headers" | sed 's/^[Ll]ocation: //' | tr -d '\r')
  [ -n "$mocksaml_sso_url" ] || { echo "REFUSING: /auth/v1/sso did not return a Location header." >&2; exit 1; }

  local login_page_url
  login_page_url=$(curl -sL -c "$WORKDIR/mocksaml_cookies.txt" -o /dev/null \
    -w '%{url_effective}' "$mocksaml_sso_url")

  local id audience acsurl relaystate
  read -r id audience acsurl relaystate < <(python3 - "$login_page_url" <<'PYEOF'
import sys, urllib.parse
q = urllib.parse.parse_qs(urllib.parse.urlparse(sys.argv[1]).query)
print(q['id'][0], q['audience'][0], q['acsUrl'][0], q['relayState'][0])
PYEOF
)
  [ -n "${id:-}" ] || { echo "REFUSING: could not parse Mock SAML login page query params." >&2; exit 1; }

  local auth_body="$WORKDIR/mocksaml_auth_response.html"
  curl -s -X POST "https://mocksaml.com/api/saml/auth" \
    -H "Content-Type: application/json" \
    -b "$WORKDIR/mocksaml_cookies.txt" \
    --data-raw "$(jq -n --arg e "$login_email" --arg id "$id" --arg aud "$audience" \
                        --arg acs "$acsurl" --arg rs "$relaystate" \
      '{email:$e,id:$id,audience:$aud,acsUrl:$acs,providerName:"undefined",relayState:$rs}')" \
    -o "$auth_body"

  python3 - "$auth_body" "$WORKDIR/saml_response.txt" "$WORKDIR/relay_state.txt" <<'PYEOF'
import re, sys
html = open(sys.argv[1]).read()
open(sys.argv[2], 'w').write(re.search(r'name="SAMLResponse" value="([^"]+)"', html).group(1))
open(sys.argv[3], 'w').write(re.search(r'name="RelayState" value="([^"]+)"', html).group(1))
PYEOF

  local acs_headers="$WORKDIR/acs_headers.txt"
  curl -sD "$acs_headers" -o /dev/null -X POST "$acsurl" \
    --data-urlencode "SAMLResponse@$WORKDIR/saml_response.txt" \
    --data-urlencode "RelayState@$WORKDIR/relay_state.txt"

  local final_location
  final_location=$(grep -i '^location:' "$acs_headers" | sed 's/^[Ll]ocation: //' | tr -d '\r')
  case "$final_location" in
    *access_token=*) : ;;
    *)
      echo "REFUSING: Mock SAML login did not yield an access_token. Location: $final_location" >&2
      exit 1
      ;;
  esac

  python3 - "$final_location" "$out_token_file" <<'PYEOF'
import sys, urllib.parse
frag = sys.argv[1].split('#', 1)[1]
params = urllib.parse.parse_qs(frag)
open(sys.argv[2], 'w').write(params['access_token'][0])
PYEOF

  jwt_claim "$(cat "$out_token_file")" '.sub'
}

# ============================================================================
# G-2 procedure (matrix section 5) -- service-role patch of auth.identities.identity_data
# to substitute a mapped groups claim, THEN verify the patch landed. Never call this AFTER
# a login without also re-calling record_sso_login() immediately -- see the matrix's
# re-priming rule. This function only does steps 2 (patch) + verification; step 1 (login)
# and step 3 (record_sso_login call) are the caller's responsibility, per-step, since the
# caller needs the token from step 1 to make step 3's call.
# ============================================================================
g2_patch_and_verify() {  # user_id
  local uid="$1"
  run_sql -c "
    UPDATE auth.identities
       SET identity_data = jsonb_set(
             identity_data, '{custom_claims,groups}', '[\"skillsmith-admins\"]'::jsonb, true)
     WHERE user_id = '$uid' AND provider LIKE 'sso:%';
  " >/dev/null
  local landed
  landed=$(run_sql -c "
    SELECT identity_data->'custom_claims'->'groups' FROM auth.identities
     WHERE user_id = '$uid' AND provider LIKE 'sso:%';
  ")
  if [ "$landed" = '["skillsmith-admins"]' ]; then
    ok "G-2 patch verified landed for $uid (identity_data.custom_claims.groups=$landed)"
  else
    bad "G-2 patch did NOT land for $uid -- got '$landed', expected [\"skillsmith-admins\"]"
    return 1
  fi
}

# ============================================================================
# Checkpoint/sentinel pause protocol (matrix section 12, "Checkpoint protocol").
#
# At B-CP1 (after C1.10), B-CP2 (after C1.12), and B-CP3 (after C1.14) the C1 chain must
# stop and hand off to a real browser session (mcp__claude-in-chrome__*) that exercises
# the U-series scenarios the matrix's section-12 table lists, before the chain is allowed
# to continue -- several browser assertions observe state a later C1 step destroys. A
# prior run of this harness went straight through C1 into the Z-series and Q-series
# without ever stopping for that browser verification; this function is the fix.
#
# It implements the protocol section 12 specifies literally: "prints a
# `=== CHECKPOINT <id>: paused ===` banner with the fixture UUIDs and the current session
# tokens, writes them to $WORKDIR/checkpoint-<id>.json, and blocks on a sentinel file
# (`until [ -f $WORKDIR/go-<id> ]; do sleep 2; done`). The browser agent does its work,
# then touches the sentinel."
#
# JSON SHAPE -- section 12 names WHAT must be written (fixture UUIDs + session tokens)
# but not an exact schema. This is this harness's own choice, recorded here rather than
# left implicit:
#   {
#     "checkpoint_id":         "B-CP1" | "B-CP2" | "B-CP3",
#     "written_at":            ISO-8601 UTC timestamp,
#     "fires_after":           the matrix's own "Fires after" cell (which C1 step, and why),
#     "browser_work":          the matrix's own "Browser work" cell (which U-scenarios to run),
#     "state_handed_off_note": the matrix's own "State handed off" cell, verbatim, so the
#                               browser agent can cross-check this file's actual contents
#                               against what the matrix promised it would receive,
#     "fixtures":              { team_id, owner_id, admin_id, legacy_id, sso_user_id,
#                                 outsider_id } -- whichever of these exist on disk yet,
#     "session_tokens":        { <name>_token / sso_token1|2|3 : <raw JWT> } -- only
#                               tokens actually live at this point in the chain are
#                               included (e.g. only sso_token1 exists at B-CP1; both
#                               sso_token1 AND sso_token2 exist at B-CP2, matching the
#                               matrix's own B-CP2 note "the SAME tokens -- deliberately"),
#     "keys":                  whatever license_keys ids/tiers are already known at this
#                               point (e.g. key_a_id/key_b_id/key_b_tier),
#     "sentinel_file":         absolute path the browser agent must `touch` to resume,
#     "timeout_seconds":       this invocation's configured ceiling (see --timeout / the
#                               SMI6200_CHECKPOINT_TIMEOUT_SECONDS env var)
#   }
#
# SENTINEL: $WORKDIR/go-<id> -- an empty marker file. The browser agent (or a human)
# touches it once the listed browser work is complete; this function polls for it every
# 2 seconds (matching the matrix's own literal loop) up to the configured timeout, then
# REFUSES (exit 1) instead of hanging forever -- the safety valve the checkpoint protocol
# text does not itself specify but any unattended/background invocation needs.
#
# DESIGN CHOICE (undocumented by the matrix, recorded here): a stale sentinel left over
# from an EARLIER invocation is deleted at the top of every call, so a re-run of a phase
# always blocks for a fresh `touch` rather than instantly passing through on old state --
# this is deliberately the more conservative reading, given the exact failure this
# function exists to prevent (a run silently skipping the pause).
# ============================================================================
CHECKPOINT_TIMEOUT_SECONDS="${SMI6200_CHECKPOINT_TIMEOUT_SECONDS:-1800}"

checkpoint_pause() {  # id fires_after_desc browser_work_desc state_handed_off_desc
  local id="$1" fires_after="$2" browser_work="$3" state_handed_off="$4"
  local cp_file="$WORKDIR/checkpoint-$id.json"
  local sentinel="$WORKDIR/go-$id"
  local timeout="${CHECKPOINT_TIMEOUT_SECONDS}"

  rm -f "$sentinel"

  local fixtures_json tokens_json keys_json
  fixtures_json=$(jq -n \
    --arg team_id "$TEAM_ID" \
    --arg owner_id "$(cat "$WORKDIR/owner_id" 2>/dev/null || echo '')" \
    --arg admin_id "$(cat "$WORKDIR/admin_id" 2>/dev/null || echo '')" \
    --arg legacy_id "$(cat "$WORKDIR/legacy_id" 2>/dev/null || echo '')" \
    --arg sso_user_id "$(cat "$WORKDIR/sso_user_id" 2>/dev/null || echo '')" \
    --arg outsider_id "$(cat "$WORKDIR/outsider_id" 2>/dev/null || echo '')" \
    '{team_id:$team_id, owner_id:$owner_id, admin_id:$admin_id, legacy_id:$legacy_id,
      sso_user_id:$sso_user_id, outsider_id:$outsider_id}
     | with_entries(select(.value != ""))')

  tokens_json=$(jq -n \
    --arg owner_token "$(cat "$WORKDIR/owner_token.txt" 2>/dev/null || echo '')" \
    --arg admin_token "$(cat "$WORKDIR/admin_token.txt" 2>/dev/null || echo '')" \
    --arg legacy_token "$(cat "$WORKDIR/legacy_token.txt" 2>/dev/null || echo '')" \
    --arg outsider_token "$(cat "$WORKDIR/outsider_token.txt" 2>/dev/null || echo '')" \
    --arg sso_token1 "$(cat "$WORKDIR/sso_token1.txt" 2>/dev/null || echo '')" \
    --arg sso_token2 "$(cat "$WORKDIR/sso_token2.txt" 2>/dev/null || echo '')" \
    --arg sso_token3 "$(cat "$WORKDIR/sso_token3.txt" 2>/dev/null || echo '')" \
    '{owner_token:$owner_token, admin_token:$admin_token, legacy_token:$legacy_token,
      outsider_token:$outsider_token, sso_token1:$sso_token1, sso_token2:$sso_token2,
      sso_token3:$sso_token3}
     | with_entries(select(.value != ""))')

  keys_json=$(jq -n \
    --arg key_a_id "$(cat "$WORKDIR/key_a_id" 2>/dev/null || echo '')" \
    --arg key_b_id "$(cat "$WORKDIR/key_b_id" 2>/dev/null || echo '')" \
    --arg key_b_tier "$(cat "$WORKDIR/key_b_tier" 2>/dev/null || echo '')" \
    '{key_a_id:$key_a_id, key_b_id:$key_b_id, key_b_tier:$key_b_tier}
     | with_entries(select(.value != ""))')

  jq -n \
    --arg checkpoint_id "$id" \
    --arg written_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg fires_after "$fires_after" \
    --arg browser_work "$browser_work" \
    --arg state_handed_off_note "$state_handed_off" \
    --argjson fixtures "$fixtures_json" \
    --argjson session_tokens "$tokens_json" \
    --argjson keys "$keys_json" \
    --arg sentinel_file "$sentinel" \
    --argjson timeout_seconds "$timeout" \
    '{checkpoint_id:$checkpoint_id, written_at:$written_at, fires_after:$fires_after,
      browser_work:$browser_work, state_handed_off_note:$state_handed_off_note,
      fixtures:$fixtures, session_tokens:$session_tokens, keys:$keys,
      sentinel_file:$sentinel_file, timeout_seconds:$timeout_seconds}' \
    > "$cp_file"

  echo "=== CHECKPOINT $id: paused ==="
  echo "  wrote $cp_file"
  echo "  fires after: $fires_after"
  echo "  browser work: $browser_work"
  echo "  state handed off (per matrix sec.12): $state_handed_off"
  echo "  waiting for sentinel: $sentinel  (touch it to resume; timeout ${timeout}s, poll every 2s)"

  local waited=0
  until [ -f "$sentinel" ]; do
    sleep 2
    waited=$((waited + 2))
    if [ "$waited" -ge "$timeout" ]; then
      echo "REFUSING: checkpoint $id timed out after ${timeout}s waiting for $sentinel" >&2
      echo "  Either the browser work is still in progress -- re-run this phase with a" >&2
      echo "  larger --timeout=<seconds> (or export SMI6200_CHECKPOINT_TIMEOUT_SECONDS)" >&2
      echo "  -- or touch $sentinel manually once you have confirmed the browser-side" >&2
      echo "  work in the matrix's section-12 table is actually done." >&2
      exit 1
    fi
  done
  echo "  sentinel found after ${waited}s -- resuming chain past $id"
}

echo "PASS=$PASS FAIL=$FAIL UNCOVERED=$UNCOVERED CHARACTERIZED=$CHARACTERIZED (helpers loaded)"
