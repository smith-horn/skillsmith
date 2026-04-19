#!/usr/bin/env bash
#
# apply-075-audit-logs-index.sh
#
# SMI-4310 — Apply migration 075 (CREATE INDEX CONCURRENTLY on audit_logs)
# out-of-band via `psql` because CONCURRENTLY cannot run inside a transaction
# and Supabase CLI's `db push` wraps every migration file in BEGIN..COMMIT.
#
# Plan: docs/internal/implementation/smi-4309-4310-migrations-074-075.md
#
# Usage:
#   ./scripts/apply-075-audit-logs-index.sh <staging|prod>
#
# Expected environment (sourced via `varlock run -- ...`):
#   staging: SUPABASE_STAGING_DB_PASSWORD  (target ref: ovhcifugwqnzoebwfuku)
#   prod:    SUPABASE_DB_PASSWORD          (target ref: vrcnzpmndtroqxxoqkzy)
#
# Typical invocation:
#   varlock run -- ./scripts/apply-075-audit-logs-index.sh staging
#   varlock run -- ./scripts/apply-075-audit-logs-index.sh prod
#
# The script does NOT use `supabase db push` for this migration, and NEVER
# uses the `--linked` flag anywhere. `--linked` silently overrides `--db-url`
# by routing to `.supabase/.temp/linked-project.json`, which would mistarget
# environments (see feedback_supabase_db_push_linked_override.md).
#
# Pre-flight checks (all must pass before the index build starts):
#   1. Target environment argument is recognized (staging | prod).
#   2. Required env var is set and non-empty.
#   3. For prod: migration 074 is already recorded in schema_migrations.
#   4. No concurrent CREATE INDEX in progress on any table (pg_stat_progress_create_index).
#   5. No autovacuum currently running against audit_logs.
#   6. The partial predicate (`WHERE metadata ? 'team_id'`) matches > 0 rows
#      (otherwise the index is vacuously useless).

set -euo pipefail

# ----------------------------------------------------------------------------
# Logging helpers
# ----------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[info] $1${NC}"; }
success() { echo -e "${GREEN}[ok]   $1${NC}"; }
warn()    { echo -e "${YELLOW}[warn] $1${NC}" >&2; }
error()   { echo -e "${RED}[err]  $1${NC}" >&2; exit 1; }

# ----------------------------------------------------------------------------
# Argument parsing
# ----------------------------------------------------------------------------
if [[ $# -ne 1 ]]; then
  error "Usage: $0 <staging|prod>"
fi

ENV_TARGET="$1"

case "$ENV_TARGET" in
  staging)
    PROJECT_REF="ovhcifugwqnzoebwfuku"
    PASSWORD_VAR="SUPABASE_STAGING_DB_PASSWORD"
    ;;
  prod)
    PROJECT_REF="vrcnzpmndtroqxxoqkzy"
    PASSWORD_VAR="SUPABASE_DB_PASSWORD"
    ;;
  *)
    error "Unknown environment '$ENV_TARGET'. Must be 'staging' or 'prod'."
    ;;
esac

# Resolve password via indirect expansion (bash-only). Exits if unset/empty.
DB_PASSWORD="${!PASSWORD_VAR:-}"
if [[ -z "$DB_PASSWORD" ]]; then
  error "\$${PASSWORD_VAR} is not set. Run under 'varlock run --' to inject secrets."
fi

# Session-mode pooler (port 5432) works with DDL; Transaction-mode (6543)
# breaks prepared statements inside CREATE INDEX CONCURRENTLY.
URL="postgres://postgres.${PROJECT_REF}:${DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:5432/postgres"

# ----------------------------------------------------------------------------
# File locations (absolute, so the script works from any cwd)
# ----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_FILE="$REPO_ROOT/supabase/migrations/075_audit_logs_team_id_index.sql"

if [[ ! -f "$MIGRATION_FILE" ]]; then
  error "Migration file not found: $MIGRATION_FILE"
fi

# ----------------------------------------------------------------------------
# psql helpers
# ----------------------------------------------------------------------------
# `psql_query`: run a single-row scalar query and print the trimmed result.
psql_query() {
  local sql="$1"
  psql "$URL" -At -c "$sql"
}

# `psql_run`: run a SQL statement/block for side effects, surface exit status.
psql_run() {
  local sql="$1"
  psql "$URL" -v ON_ERROR_STOP=1 -c "$sql"
}

# ----------------------------------------------------------------------------
# Pre-flight checks
# ----------------------------------------------------------------------------
info "Target: $ENV_TARGET ($PROJECT_REF)"
info "Running pre-flight checks..."

# Check: connectivity
if ! psql_query "SELECT 1;" >/dev/null 2>&1; then
  error "Cannot connect to $ENV_TARGET pooler. Check \$${PASSWORD_VAR} and network."
fi
success "Connectivity OK."

# Check: prod-only — migration 074 recorded?
if [[ "$ENV_TARGET" == "prod" ]]; then
  info "Checking migration 074 is applied on prod..."
  count_074=$(psql_query "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '074';")
  if [[ "$count_074" != "1" ]]; then
    error "Migration 074 not found in supabase_migrations.schema_migrations (count=$count_074). Apply 074 first via 'npx supabase db push --db-url \"\$URL\"'."
  fi
  success "Migration 074 recorded on prod."
fi

# Check: no concurrent CREATE INDEX in progress anywhere
info "Checking for concurrent CREATE INDEX activity..."
concurrent_builds=$(psql_query "SELECT count(*) FROM pg_stat_progress_create_index;")
if [[ "$concurrent_builds" != "0" ]]; then
  warn "pg_stat_progress_create_index reports $concurrent_builds active build(s). Details:"
  psql "$URL" -c "SELECT pid, phase, blocks_done, blocks_total FROM pg_stat_progress_create_index;" >&2
  error "Refusing to start a second concurrent build. Wait for the existing one to finish."
fi
success "No concurrent CREATE INDEX builds in progress."

# Check: no autovacuum on audit_logs
info "Checking for autovacuum on audit_logs..."
autovac_count=$(psql_query "SELECT count(*) FROM pg_stat_activity WHERE query ILIKE '%autovacuum%audit_logs%';")
if [[ "$autovac_count" != "0" ]]; then
  warn "Autovacuum appears to be running on audit_logs. CREATE INDEX CONCURRENTLY will wait for it."
  psql "$URL" -c "SELECT pid, query, state FROM pg_stat_activity WHERE query ILIKE '%autovacuum%audit_logs%';" >&2
  error "Refusing to start; re-run when autovacuum completes or schedule a low-traffic window."
fi
success "No autovacuum on audit_logs."

# Check: partial predicate covers > 0 rows
info "Checking partial predicate row count (WHERE metadata ? 'team_id')..."
predicate_rows=$(psql_query "SELECT count(*) FROM audit_logs WHERE metadata ? 'team_id';")
if [[ "$predicate_rows" == "0" ]]; then
  error "Partial predicate WHERE metadata ? 'team_id' matches 0 rows. Index would be vacuously empty. Investigate whether any team-scoped writer actually sets metadata->>'team_id'."
fi
success "Partial predicate matches $predicate_rows row(s)."

# ----------------------------------------------------------------------------
# Confirm before destructive action
# ----------------------------------------------------------------------------
echo
info "About to run: $MIGRATION_FILE"
info "Target:       $ENV_TARGET ($PROJECT_REF)"
info "This is an out-of-band migration apply (not via 'supabase db push')."
echo

# On prod, require an extra confirmation.
if [[ "$ENV_TARGET" == "prod" ]]; then
  read -rp "Type 'APPLY PROD 075' to continue: " confirmation
  if [[ "$confirmation" != "APPLY PROD 075" ]]; then
    error "Confirmation string did not match. Aborted."
  fi
fi

# ----------------------------------------------------------------------------
# Step 1 — run the migration file via psql (autocommit)
# ----------------------------------------------------------------------------
info "Running CREATE INDEX CONCURRENTLY..."
psql "$URL" -v ON_ERROR_STOP=1 -f "$MIGRATION_FILE"
success "Index build complete."

# ----------------------------------------------------------------------------
# Step 2 — verify the index is valid
# ----------------------------------------------------------------------------
info "Verifying idx_audit_logs_team_id is valid..."
is_valid=$(psql_query "SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_audit_logs_team_id'::regclass;")
if [[ "$is_valid" != "t" ]]; then
  warn "Index exists but indisvalid = '$is_valid'. Rollback recommended:"
  echo "    DROP INDEX CONCURRENTLY IF EXISTS idx_audit_logs_team_id;"
  error "Index invalid; aborting before schema_migrations insert."
fi
success "Index is valid."

# ----------------------------------------------------------------------------
# Step 3 — register migration in supabase_migrations.schema_migrations
# ----------------------------------------------------------------------------
# Column order is (version, statements, name) — confirmed from prod backup
# docs/internal/backups/2026-04-14-prod-migration-state-backup.sql:28.
# ON CONFLICT DO NOTHING makes this idempotent across retry runs.
info "Registering migration 075 in supabase_migrations.schema_migrations..."
psql_run "INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES ('075', ARRAY['CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_team_id ON audit_logs ((metadata->>''team_id'')) WHERE metadata ? ''team_id'';'], 'audit_logs_team_id_index') ON CONFLICT (version) DO NOTHING;"
success "Migration 075 registered."

# ----------------------------------------------------------------------------
# Final verification
# ----------------------------------------------------------------------------
info "Final state:"
psql "$URL" -c "SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '075';"
psql "$URL" -c "SELECT pg_size_pretty(pg_relation_size('idx_audit_logs_team_id')) AS index_size;"

success "Done. Migration 075 applied to $ENV_TARGET ($PROJECT_REF)."
