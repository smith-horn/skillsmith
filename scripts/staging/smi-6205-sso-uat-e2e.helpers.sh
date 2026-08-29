# smi-6205-sso-uat-e2e.helpers.sh -- sourced by smi-6205-sso-uat-e2e.sh (split out to stay
# under the repo's 500-line file gate). Not runnable standalone: it assumes the calling
# script's `$0` and cwd, and its own last line (`trap cleanup EXIT`) only takes effect in
# the process that sources it.
#
# Contents: safety gates + fixture identifiers, then every helper function the T1-T7 test
# body in the main script calls (run_sql, rpc, assert_*, ensure_clean_email, create_user,
# password_login, jwt_claim, mock_saml_login, cleanup), ending with the cleanup trap
# registration itself so it is armed before the main script's pre-flight/body ever runs.
set -euo pipefail

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
WORKDIR=$(mktemp -d -t smi6205ssoe2e)

# ============================================================================
# SAFETY GATES -- same posture as every other scripts/staging/*.sh: this script INSERTs
# fixture auth.users/teams/team_members/sso_account_links rows and registers a real SAML
# provider, so it may only ever run against staging.
# ============================================================================
: "${STAGING_SUPABASE_PROJECT_REF:?REFUSING: STAGING_SUPABASE_PROJECT_REF is not set. Run via 'varlock run -- ./scripts/staging/smi-6205-sso-uat-e2e.sh'.}"
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
  echo "REFUSING: STAGING_SUPABASE_PROJECT_REF ($STAGING_SUPABASE_PROJECT_REF) is not the" >&2
  echo "          known staging ref ($STAGING_REF). This harness inserts fixture rows and" >&2
  echo "          registers a real SAML provider -- it may only run against staging." >&2
  exit 1
fi
case "$STAGING_SUPABASE_URL" in
  *"$STAGING_REF"*) : ;;
  *)
    echo "REFUSING: STAGING_SUPABASE_URL does not contain the staging ref ($STAGING_REF)." >&2
    exit 1
    ;;
esac
case "$STAGING_SUPABASE_URL" in
  *"$PROD_REF"*)
    echo "REFUSING: STAGING_SUPABASE_URL contains the PROD ref." >&2
    exit 1
    ;;
esac

# ============================================================================
# FIXTURE IDENTIFIERS -- fixed, greppable, `_e2e_sso_6205_`-prefixed (teams) or
# `e2e-sso-6205-`-prefixed (emails), so leftovers from an aborted run are trivially
# distinguishable from real customer data (same convention as the RBAC sibling).
# ============================================================================
TEAM_ID="_e2e_sso_6205_team"
OWNER_EMAIL="e2e-sso-6205-owner@smithhorn-test.invalid"
OUTSIDER_EMAIL="e2e-sso-6205-outsider@smithhorn-test.invalid"
LEGACY1_EMAIL="e2e-sso-6205-legacy1@example.com"
LEGACY2_EMAIL="e2e-sso-6205-legacy2@example.com"
SSO_LOGIN_EMAIL="e2e-sso-6205-ssouser@example.com"
SAML_DOMAIN="example.com"   # Mock SAML's login form only accepts example.com/example.org.
SAML_METADATA_URL="https://mocksaml.com/api/saml/metadata"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf '[PASS] %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '[FAIL] %s\n' "$1" >&2; }

# ============================================================================
# run_sql -- wraps pooler-psql.sh with the STAGING_* -> SUPABASE_* override, the same
# per-call override the sibling wrapper uses so a script that ALSO knows the prod
# credentials (they live in the same .env) never talks to prod by accident. Forwards its
# args straight to psql -- every call site below uses `-c '<sql>'`; `-t -A` (unaligned,
# tuples-only) makes a single-column/single-row SELECT capture cleanly into a shell var.
# ============================================================================
run_sql() {
  SUPABASE_PROJECT_REF="$STAGING_SUPABASE_PROJECT_REF" \
  SUPABASE_DB_PASSWORD="$STAGING_SUPABASE_DB_PASSWORD" \
    "$REPO_ROOT/scripts/pooler-psql.sh" -v ON_ERROR_STOP=1 -t -A "$@"
}

# ============================================================================
# rpc -- calls a PostgREST RPC as a given identity's real access token. Writes the response
# body to $WORKDIR/last_body.json and echoes the HTTP status. `--data-raw` is required, not
# `-d`: `-d '{}'` intermittently reached PostgREST as an empty/mismatched body during this
# harness's construction (curl's `-d` does extra @file/urlencode-adjacent handling that
# `--data-raw` does not) and PostgREST answered `PGRST102 Empty or invalid json` -- confirmed
# live, not theoretical.
# ============================================================================
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
assert_jq_contains_code() {  # expected_sqlstate label
  local code
  code=$(jq -r '.code // empty' "$WORKDIR/last_body.json" 2>/dev/null || true)
  if [ "$code" = "$1" ]; then ok "$2 (code $code)"; else bad "$2 -- expected code '$1', got '$code' (body: $(last_body))"; fi
}

# ============================================================================
# ensure_clean_email -- deletes any pre-existing auth.users row at this fixture email
# BEFORE creating a fresh one. Without this, a crashed prior run's leftover user (its own
# cleanup never ran) makes this run's admin-createUser call fail on a duplicate email,
# corrupting the "fixture-collision on a second run should not corrupt state" requirement.
# ============================================================================
ensure_clean_email() {
  # `?email=` is silently IGNORED by GoTrue's admin listUsers endpoint (confirmed live
  # during this harness's construction -- it returned an unrelated, unfiltered page of
  # users). `?filter=` does a real substring match on email/phone, so results are
  # re-checked for an EXACT email match before anything is deleted, and every match (not
  # just the first) is removed, in case more than one leftover exists.
  local email="$1"
  local uids
  uids=$(curl -s "$STAGING_SUPABASE_URL/auth/v1/admin/users?filter=$email" \
    -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    | jq -r --arg e "$email" '.users[] | select(.email == $e) | .id')
  for uid in $uids; do
    echo "  (self-heal) deleting leftover auth.users row for $email ($uid)"
    curl -s -o /dev/null -X DELETE "$STAGING_SUPABASE_URL/auth/v1/admin/users/$uid" \
      -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY"
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

# ============================================================================
# jwt_claim -- base64url-decodes a JWT's payload segment and reads one jq path out of it.
# ============================================================================
jwt_claim() {
  local token="$1" path="$2"
  local payload; payload=$(printf '%s' "$token" | cut -d. -f2 | tr -- '-_' '+/')
  case $(( ${#payload} % 4 )) in
    2) payload="${payload}==" ;;
    3) payload="${payload}=" ;;
  esac
  printf '%s' "$payload" | base64 -d 2>/dev/null | jq -r "$path"
}

# ============================================================================
# mock_saml_login -- the four back-to-back requests documented in the header. Writes the
# resulting access token to out_token_file and echoes the JIT-provisioned auth.users id.
# ============================================================================
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
      echo "          (a 'saml_relay_state_expired' error here means the four requests inside" >&2
      echo "          mock_saml_login() did not run back-to-back fast enough -- see header.)" >&2
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
# CLEANUP -- trap-based, best-effort, runs on ANY exit (success or failure). Every fixture
# is torn down: SAML provider, teams (CASCADEs team_members/team_sso_settings/
# team_sso_domains/sso_account_links's team_id FK... note sso_account_links itself
# CASCADEs off auth.users, not off teams, so it is covered by the user deletes below), and
# every fixture auth.users row (CASCADEs profiles/team_members/sso_account_links).
# ============================================================================
cleanup() {
  local exit_code=$?
  echo ""
  echo "--- cleanup ---"
  if [ -n "${SAML_PROVIDER_ID:-}" ]; then
    curl -s -o /dev/null -w 'delete saml provider: HTTP %{http_code}\n' \
      -X DELETE "$STAGING_SUPABASE_URL/auth/v1/admin/sso/providers/$SAML_PROVIDER_ID" \
      -H "apikey: $STAGING_SUPABASE_SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $STAGING_SUPABASE_SERVICE_ROLE_KEY" || true
  fi
  run_sql -c "DELETE FROM teams WHERE id = '$TEAM_ID';" >/dev/null 2>&1 || true
  for email in "$OWNER_EMAIL" "$OUTSIDER_EMAIL" "$LEGACY1_EMAIL" "$LEGACY2_EMAIL" "$SSO_LOGIN_EMAIL"; do
    ensure_clean_email "$email" || true
  done
  rm -rf "$WORKDIR"
  echo "--- cleanup verified ---"
  run_sql -c "
    SELECT 'teams remaining: ' || count(*) FROM teams WHERE id = '$TEAM_ID'
    UNION ALL
    SELECT 'fixture users remaining: ' || count(*) FROM auth.users WHERE email LIKE 'e2e-sso-6205-%';
  " || true
  echo ""
  echo "PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -gt 0 ] && [ "$exit_code" -eq 0 ]; then exit_code=1; fi
  exit "$exit_code"
}
trap cleanup EXIT
