#!/bin/sh
# pooler-psql-session.sh — canonical entry point for psql against the Supabase
# SESSION pooler (port 5432). Sibling of pooler-psql.sh. SMI-4999.
#
# When to use this vs pooler-psql.sh:
#   ./scripts/pooler-psql.sh         (port 6543, transaction pooler)
#     — ad-hoc queries, single-statement DDL, short writes. Each statement
#       is its own transaction at the pooler level.
#   ./scripts/pooler-psql-session.sh (port 5432, session pooler)         <-- here
#     — long-running maintenance. Use when ANY of:
#         * VACUUM, REINDEX CONCURRENTLY (or any operation past a few seconds)
#         * Stored procedure with COMMIT between batches (CREATE PROCEDURE
#           ... LANGUAGE plpgsql AS $$ ... LOOP ... COMMIT; ... END LOOP $$;
#           called via CALL — transaction-pooler mode rejects COMMIT inside
#           a CALL because each transaction may swap server connections)
#         * The transaction pooler returns FATAL: (ECHECKOUTTIMEOUT) — i.e.
#           its server-connection budget is exhausted by your workload
#         * You need a multi-statement session bound to one server connection
#
# Why the choice exists at all: the transaction pooler is sized for short
# statements and aggressively reuses server connections per transaction; the
# session pooler holds a dedicated server connection for the client's whole
# session, which is what long-running maintenance needs.
#
# Both poolers route through aws-1-us-east-1.pooler.supabase.com. PostgREST
# also runs at this hostname and aborts long queries at statement_timeout=8s
# (error 57014); both poolers bypass that. The choice between ports is purely
# transaction-mode vs session-mode (PgBouncer / Supavisor mode).
#
# Provenance: SMI-4968 prod runbook — a 6M-row search:metrics purge from
# audit_logs and a follow-up REINDEX CONCURRENTLY repeatedly hit
# ECHECKOUTTIMEOUT on the transaction pooler. The same workload ran cleanly
# as a procedure with `SET statement_timeout = 0` and COMMIT per batch via
# this session pooler. See docs/internal/implementation/smi-4968-supabase-disk-io.md
# for the full retro and exact statement shapes.
#
# Usage:
#   varlock run -- ./scripts/pooler-psql-session.sh -c 'CALL my_proc();'
#   varlock run -- ./scripts/pooler-psql-session.sh -f maintenance.sql
#   echo 'VACUUM (ANALYZE) my_table;' | varlock run -- ./scripts/pooler-psql-session.sh
#   varlock run -- ./scripts/pooler-psql-session.sh --help
#
# Requires:
#   - Docker container skillsmith-dev-1 running (provides psql 15+)
#   - `varlock run --` prefix to supply SUPABASE_PROJECT_REF +
#     SUPABASE_DB_PASSWORD without leaking them to the terminal

set -eu

: "${SUPABASE_PROJECT_REF:?must be set — run via 'varlock run -- ./scripts/pooler-psql-session.sh ...'}"
: "${SUPABASE_DB_PASSWORD:?must be set — run via 'varlock run -- ./scripts/pooler-psql-session.sh ...'}"

if ! docker inspect skillsmith-dev-1 --format '{{.State.Running}}' 2>/dev/null | grep -q '^true$'; then
  echo "error: skillsmith-dev-1 container is not running. Start it with:" >&2
  echo "  docker compose --profile dev up -d" >&2
  exit 1
fi

exec docker exec -i \
  -e PGHOST="aws-1-us-east-1.pooler.supabase.com" \
  -e PGPORT="5432" \
  -e PGUSER="postgres.${SUPABASE_PROJECT_REF}" \
  -e PGPASSWORD="${SUPABASE_DB_PASSWORD}" \
  -e PGDATABASE="postgres" \
  skillsmith-dev-1 psql "$@"
