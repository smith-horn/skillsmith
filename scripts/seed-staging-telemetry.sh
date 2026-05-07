#!/usr/bin/env bash
# seed-staging-telemetry.sh — POST synthetic install + search events to STAGING.
#
# Why: Staging audit_logs has too little real traffic to validate the
# usage-report funnel fix (CLAUDE.md: "low-cadence — data lags prod").
# This script seeds 12 install events + 50 search events so the Wave 1a/1b
# staging smoke checks have a meaningful funnel to assert against.
#
# Safe to re-run; each invocation appends fresh rows. NEVER points at prod
# (refuses if SUPABASE_URL doesn't contain the staging ref).
#
# Usage:
#   varlock run -- ./scripts/seed-staging-telemetry.sh
#   varlock run -- ./scripts/seed-staging-telemetry.sh --installs 24 --searches 100
#
# Requirements:
#   STAGING_SUPABASE_URL  staging URL, e.g. https://ovhcifugwqnzoebwfuku.supabase.co
#   STAGING_SUPABASE_ANON_KEY  anon key for staging (skills-search auth)
#   curl + Node available on host

set -eu

readonly STAGING_REF="ovhcifugwqnzoebwfuku"
readonly DEFAULT_INSTALLS=12
readonly DEFAULT_SEARCHES=50
readonly HMAC_KEY="skillsmith-telemetry-actor:v1"

INSTALLS="$DEFAULT_INSTALLS"
SEARCHES="$DEFAULT_SEARCHES"

while [ $# -gt 0 ]; do
  case "$1" in
    --installs) INSTALLS="$2"; shift 2 ;;
    --searches) SEARCHES="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

: "${STAGING_SUPABASE_URL:?must be set; expected https://${STAGING_REF}.supabase.co}"
: "${STAGING_SUPABASE_ANON_KEY:?must be set}"

case "$STAGING_SUPABASE_URL" in
  *"${STAGING_REF}"*) ;;
  *) echo "refusing: STAGING_SUPABASE_URL does not contain '${STAGING_REF}' (got: ${STAGING_SUPABASE_URL})" >&2; exit 3 ;;
esac

actor_hex() {
  node -e "console.log(require('crypto').createHmac('sha256','${HMAC_KEY}').update(process.argv[1]).digest('hex'))" "$1"
}

post_install() {
  local actor="$1" skill="$2" success="$3" trust="$4"
  local body
  body=$(cat <<EOF
{"event":"skill_install","anonymous_id":"${actor}","metadata":{"skill_id":"${skill}","source":"cli","success":${success},"duration_ms":${RANDOM},"trust_tier":"${trust}"}}
EOF
)
  curl -fsS -X POST "${STAGING_SUPABASE_URL}/functions/v1/events" \
    -H "content-type: application/json" \
    -d "$body" >/dev/null
}

post_search() {
  local query="$1"
  curl -fsS -X POST "${STAGING_SUPABASE_URL}/functions/v1/skills-search" \
    -H "content-type: application/json" \
    -H "apikey: ${STAGING_SUPABASE_ANON_KEY}" \
    -H "authorization: Bearer ${STAGING_SUPABASE_ANON_KEY}" \
    -d "{\"query\":\"${query}\",\"limit\":5}" >/dev/null
}

echo "seeding staging (${STAGING_SUPABASE_URL}): ${INSTALLS} installs + ${SEARCHES} searches"

# Three synthetic "users" — same actor hashes the failing prod report showed,
# so the staging shape mirrors prod's. Each gets installs split across success
# states so the aggregator's three branches all have coverage:
#   - true  → counted as succeeded
#   - false → counted as failed
#   - omitted (post-Wave-1a only matters; pre-fix rows already lack the field)
ACTOR_A=$(actor_hex "seed-staging-actor-a")
ACTOR_B=$(actor_hex "seed-staging-actor-b")
ACTOR_C=$(actor_hex "seed-staging-actor-c")

skills="acme/foo widgetco/bar grommet/baz"
trust_tiers="community verified experimental"

i=0
while [ "$i" -lt "$INSTALLS" ]; do
  case $((i % 3)) in 0) actor="$ACTOR_A" ;; 1) actor="$ACTOR_B" ;; 2) actor="$ACTOR_C" ;; esac
  skill=$(echo "$skills"     | awk -v n=$((i % 3 + 1)) '{print $n}')
  trust=$(echo "$trust_tiers" | awk -v n=$((i % 3 + 1)) '{print $n}')
  # 8 succeed, 3 fail, 1 missing — matches the snapshot fixture in plan §5c.
  if   [ "$i" -lt 8  ]; then post_install "$actor" "$skill" "true"  "$trust"
  elif [ "$i" -lt 11 ]; then post_install "$actor" "$skill" "false" "$trust"
  else
    body="{\"event\":\"skill_install\",\"anonymous_id\":\"${actor}\",\"metadata\":{\"skill_id\":\"${skill}\",\"source\":\"cli\",\"trust_tier\":\"${trust}\"}}"
    curl -fsS -X POST "${STAGING_SUPABASE_URL}/functions/v1/events" \
      -H "content-type: application/json" -d "$body" >/dev/null
  fi
  i=$((i + 1))
done
echo "  installs posted: ${INSTALLS}"

queries="claude-code mcp typescript react testing playwright stripe supabase telemetry observability"
i=0
while [ "$i" -lt "$SEARCHES" ]; do
  q=$(echo "$queries" | awk -v n=$((i % 10 + 1)) '{print $n}')
  post_search "$q"
  i=$((i + 1))
  if [ $((i % 10)) -eq 0 ]; then echo "  searches posted: ${i}"; fi
done

echo "done. verify via:"
echo "  varlock run -- ./scripts/pooler-psql.sh -c \"SELECT event_type, COUNT(*) FROM audit_logs WHERE created_at > NOW() - INTERVAL '5 minutes' GROUP BY event_type\""
