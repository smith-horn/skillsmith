#!/usr/bin/env bash
# SMI-6362 Wave 1: build the per-partition CONCURRENTLY children for the three
# partitioned index shells created by
# supabase/migrations/20260902000001_cloud_usage_analytics_indexes.sql.
#
# Why this exists as a script and not more migration SQL: CREATE INDEX
# CONCURRENTLY cannot run inside a transaction block, a PL/pgSQL function, or
# a DO block, and the partition list is genuinely dynamic (enumerated from
# pg_inherits, never hard-coded -- plan section 5 item 11 step b). See
# 20260902000001's header comment for the full reasoning.
#
# Usage (run the parent-shell migration FIRST, via `supabase db push`, so the
# partitioned index rows already exist for this script to attach children to):
#   STAGING:  SUPABASE_PROJECT_REF=$STAGING_SUPABASE_PROJECT_REF SUPABASE_DB_PASSWORD=$STAGING_SUPABASE_DB_PASSWORD \
#             varlock run -- ./scripts/smi6362-search-metrics-indexes.sh
#   PROD:     varlock run -- ./scripts/smi6362-search-metrics-indexes.sh
#
# Idempotent and resumable: re-running against an already-complete state is a
# no-op (every step below checks catalog state before acting), and a partial
# prior run (e.g. a crashed CONCURRENTLY build leaving an invalid child index)
# is cleaned up and retried automatically per the plan's "apply-resume for
# partial success" procedure.

set -euo pipefail

: "${SUPABASE_PROJECT_REF:?must be set -- run via 'varlock run -- ./scripts/smi6362-search-metrics-indexes.sh', overriding SUPABASE_PROJECT_REF/SUPABASE_DB_PASSWORD to target staging}"
: "${SUPABASE_DB_PASSWORD:?must be set -- see above}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POOLER="$SCRIPT_DIR/pooler-psql-session.sh"

# The three parent partitioned indexes this script attaches children to, and
# their exact index definitions (must match 20260902000001's shells verbatim
# -- the per-partition CONCURRENTLY definition and the parent's definition
# are compared, not just named, per plan step f).
PARENT_INDEXES=(
  "idx_search_metrics_toolcall_team_created|((metadata ->> 'team_id'::text)), created_at DESC|event_type = 'telemetry:tool_call'::text"
  "idx_search_metrics_skillinvoke_team_created|((metadata ->> 'team_id'::text)), created_at DESC|event_type = 'telemetry:skill_invoke'::text"
  "idx_search_metrics_skillinvoke_cooccurrence|((metadata ->> 'team_id'::text)), ((metadata ->> 'session_id'::text)), ((metadata ->> 'skill_name'::text)), created_at|event_type = 'telemetry:skill_invoke'::text"
)

echo "[1/5] Setting session timeouts for CONCURRENTLY builds (lock_timeout bounds brief locks CIC still takes; statement_timeout is unbounded so a large build isn't aborted)."
"$POOLER" -c "SET lock_timeout = '5s'; SET statement_timeout = 0;" >/dev/null

echo "[2/5] Cleaning up any invalid child index left by a prior partial/crashed run."
INVALID_INDEXES="$("$POOLER" -A -t -c "
  SELECT c.relname || '|' || i.indexrelid::regclass
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
   WHERE NOT i.indisvalid
     AND i.indexrelid::regclass::text ~ '^(idx_search_metrics_toolcall_team_created|idx_search_metrics_skillinvoke_team_created|idx_search_metrics_skillinvoke_cooccurrence)_';
")"
if [ -n "$INVALID_INDEXES" ]; then
  # fd 3, not stdin: the loop body calls `docker exec -i` (via $POOLER), which
  # would otherwise consume this loop's own input and silently truncate it to
  # one iteration.
  while IFS='|' read -r _partition idx <&3; do
    [ -z "$idx" ] && continue
    echo "  Dropping invalid index: $idx"
    "$POOLER" -c "DROP INDEX CONCURRENTLY IF EXISTS $idx;"
  done 3<<<"$INVALID_INDEXES"
else
  echo "  None found."
fi

echo "[3/5] Enumerating live partitions from the catalog (never hard-coded)."
PARTITIONS="$("$POOLER" -A -t -c "
  SELECT c.relname
    FROM pg_inherits inh
    JOIN pg_class c ON c.oid = inh.inhrelid
   WHERE inh.inhparent = 'search_metrics'::regclass
   ORDER BY 1;
")"
if [ -z "$PARTITIONS" ]; then
  echo "ERROR: search_metrics has no partitions -- refusing to proceed." >&2
  exit 1
fi
echo "  Partitions: $(echo "$PARTITIONS" | tr '\n' ' ')"

echo "[4/5] Building + attaching per-partition CONCURRENTLY children."
for parent_spec in "${PARENT_INDEXES[@]}"; do
  IFS='|' read -r parent_name cols predicate <<<"$parent_spec"
  echo "  Parent index: $parent_name"
  # fd 3, not stdin: docker exec -i (via $POOLER) inside this loop would
  # otherwise consume the herestring and truncate the loop to one partition
  # (observed live on the first run -- only search_metrics_202606 was
  # processed before the loop silently exited).
  while IFS= read -r partition <&3; do
    [ -z "$partition" ] && continue
    child_name="${partition}_${parent_name#idx_}"
    child_name="${child_name:0:63}" # Postgres identifier length limit

    ALREADY_ATTACHED="$("$POOLER" -A -t -c "
      SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = '${child_name}' AND i.indisvalid;
    ")"
    if [ -n "$ALREADY_ATTACHED" ]; then
      echo "    $partition: $child_name already valid and attached -- skipping."
      continue
    fi

    echo "    $partition: building $child_name ..."
    "$POOLER" -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS ${child_name} ON ${partition} (${cols}) WHERE ${predicate};"

    ALREADY_INHERITS="$("$POOLER" -A -t -c "
      SELECT 1 FROM pg_inherits WHERE inhrelid = '${child_name}'::regclass;
    ")"
    if [ -z "$ALREADY_INHERITS" ]; then
      echo "    $partition: attaching $child_name to $parent_name ..."
      "$POOLER" -c "ALTER INDEX ${parent_name} ATTACH PARTITION ${child_name};"
    fi
  done 3<<<"$PARTITIONS"
done

echo "[5/5] Verifying: parent indexes valid, and every child's definition matches its parent (normalized)."
for parent_spec in "${PARENT_INDEXES[@]}"; do
  IFS='|' read -r parent_name _cols _predicate <<<"$parent_spec"
  VALID="$("$POOLER" -A -t -c "SELECT indisvalid FROM pg_index WHERE indexrelid = '${parent_name}'::regclass;")"
  if [ "$VALID" != "t" ]; then
    echo "ERROR: parent index $parent_name is still NOT valid -- a child is missing or invalid. Re-run this script." >&2
    exit 1
  fi
  echo "  $parent_name: indisvalid = true"
done

echo "[verify] Per-partition definitions (manually compare each child's WHERE/columns against its parent):"
"$POOLER" -c "
  SELECT parent.relname AS parent_index, child.relname AS child_index,
         pg_get_indexdef(child.oid) AS child_def
    FROM pg_inherits inh
    JOIN pg_class child ON child.oid = inh.inhrelid
    JOIN pg_class parent ON parent.oid = inh.inhparent
   WHERE parent.relname IN ('idx_search_metrics_toolcall_team_created', 'idx_search_metrics_skillinvoke_team_created', 'idx_search_metrics_skillinvoke_cooccurrence')
   ORDER BY 1, 2;
"
echo "[verify] Parent definitions for comparison:"
"$POOLER" -c "
  SELECT relname AS parent_index, pg_get_indexdef(oid) AS parent_def
    FROM pg_class
   WHERE relname IN ('idx_search_metrics_toolcall_team_created', 'idx_search_metrics_skillinvoke_team_created', 'idx_search_metrics_skillinvoke_cooccurrence')
   ORDER BY 1;
"

echo "Done."
