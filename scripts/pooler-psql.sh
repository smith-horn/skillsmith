#!/bin/sh
# pooler-psql.sh — canonical entry point for psql against the Supabase
# transaction pooler (port 6543). SMI-4380 follow-up.
#
# Why this exists: SUPABASE_POOLER_URL in .env is a template — see
# .env.schema:312-319. The stored value contains `[YOUR-PASSWORD]` as a
# literal placeholder because passwords with URL-special characters
# (@ / : !) break URI parsing. Every caller must build the connection
# from parts via PG env vars. This script is the single canonical place
# that does that, so sessions don't rediscover the pattern every time.
#
# Why the pooler (not db.<ref>.supabase.co:5432): PostgREST aborts
# audit_logs LIKE queries at statement_timeout 8s (error 57014). Transaction
# pooler bypasses that. Do not regress away from this.
#
# Usage:
#   varlock run -- ./scripts/pooler-psql.sh -c 'SELECT version();'
#   echo 'SELECT 1;' | varlock run -- ./scripts/pooler-psql.sh
#   cat query.sql | varlock run -- ./scripts/pooler-psql.sh
#   varlock run -- ./scripts/pooler-psql.sh --help
#
# Requires:
#   - Docker container skillsmith-dev-1 running (provides psql 15+)
#   - `varlock run --` prefix to supply SUPABASE_PROJECT_REF +
#     SUPABASE_DB_PASSWORD without leaking them to the terminal

set -eu

: "${SUPABASE_PROJECT_REF:?must be set — run via 'varlock run -- ./scripts/pooler-psql.sh ...'}"
: "${SUPABASE_DB_PASSWORD:?must be set — run via 'varlock run -- ./scripts/pooler-psql.sh ...'}"

if ! docker inspect skillsmith-dev-1 --format '{{.State.Running}}' 2>/dev/null | grep -q '^true$'; then
  echo "error: skillsmith-dev-1 container is not running. Start it with:" >&2
  echo "  docker compose --profile dev up -d" >&2
  exit 1
fi

exec docker exec -i \
  -e PGHOST="aws-1-us-east-1.pooler.supabase.com" \
  -e PGPORT="6543" \
  -e PGUSER="postgres.${SUPABASE_PROJECT_REF}" \
  -e PGPASSWORD="${SUPABASE_DB_PASSWORD}" \
  -e PGDATABASE="postgres" \
  skillsmith-dev-1 psql "$@"
