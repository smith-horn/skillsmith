#!/bin/sh
# smi-6345-wave1-step2-apply-staging.sh -- staging invocation wrapper for
# supabase/migrations/20260901130000_reconcile_device_lock_and_provenance_restore.sql
# (SMI-6345 Wave 1 Step 2, required staging-verification step before this
# migration can be applied to prod -- it replaces reconcile_device_inventory(),
# a SECURITY DEFINER RPC on the live inventory-push path, with a per-device
# row lock and restored provenance-column threading).
#
# Same wrapper pattern as scripts/staging/smi-5863-apply-staging.sh: this
# worktree's local `supabase start` full-history replay cannot stand up a
# complete local Postgres (a pre-existing, unrelated migration bug), so
# piping just the ONE new migration file through the pooler against staging
# is the real, targeted verification -- and the migration's own structural
# smoke block (asserts the lock clause, its ordering, and all five
# author/license/repository threading sites on the DEPLOYED function body)
# self-checks the apply: a RAISE EXCEPTION rolls back the whole BEGIN/COMMIT
# transaction, so a clean exit IS the verification.
#
# Two-part staging-ref safety, identical to smi-5863-apply-staging.sh:
#   (a) this wrapper refuses unless STAGING_SUPABASE_PROJECT_REF is set, and
#       overrides SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD with the
#       STAGING_* values for the duration of this call only;
#   (b) this migration file has no :confirm_ref gate of its own (it is the
#       real migration file, not a staging-only test script) -- the
#       wrapper-level override is the only gate, so ALWAYS invoke via this
#       script, never a bare `cat <migration> | pooler-psql.sh` (which would
#       silently hit PROD, since SUPABASE_PROJECT_REF defaults to prod in
#       this repo's env).
#
# Prerequisite: Wave 1 Step 1's lock-ordering audit found staging must have
# every migration through 20260901120000 (SMI-6321) applied for this
# migration's pre-flight DO block to pass -- confirm before running.
#
# Usage: ./scripts/staging/smi-6345-wave1-step2-apply-staging.sh (works from
# any cwd -- paths below are resolved relative to this script's own location).
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SQL_FILE="$REPO_ROOT/supabase/migrations/20260901130000_reconcile_device_lock_and_provenance_restore.sql"
if [ ! -f "$SQL_FILE" ]; then
  echo "REFUSING: $SQL_FILE not found." >&2
  exit 1
fi

varlock run -- sh -c '
  set -eu
  if [ "${STAGING_SUPABASE_PROJECT_REF:-}" = "" ]; then
    echo "REFUSING: STAGING_SUPABASE_PROJECT_REF is not set." >&2; exit 1
  fi
  echo "Applying to staging ref: $STAGING_SUPABASE_PROJECT_REF" >&2
  cat "$1" \
    | SUPABASE_PROJECT_REF="$STAGING_SUPABASE_PROJECT_REF" \
      SUPABASE_DB_PASSWORD="$STAGING_SUPABASE_DB_PASSWORD" \
      "$2"/scripts/pooler-psql.sh -v ON_ERROR_STOP=1
' _ "$SQL_FILE" "$REPO_ROOT"
