#!/bin/sh
# smi-6345-wave1-step3-apply-staging.sh -- staging invocation wrapper for
# supabase/migrations/20260901140000_device_skills_identity_columns.sql
# (SMI-6345 Wave 1 Step 3, required staging-verification step before this
# migration can be applied to prod -- adds device_skills' four evidence-
# qualified identity columns and the device_skills_identity_audit table).
#
# Same wrapper pattern as scripts/staging/smi-5863-apply-staging.sh and this
# wave's own Step 2 wrapper. The migration's own two smoke blocks (structural:
# CHECK shapes, audit_id type, erasure cascade, RLS posture; data-driven:
# constraint refusal/acceptance fixtures, always rolled back) self-check the
# apply the same way -- a RAISE EXCEPTION rolls back the whole transaction.
#
# MUST run AFTER smi-6345-wave1-step2-apply-staging.sh: this migration's
# pre-flight DO block requires device_skills.author/license/repository to
# already exist (20260629000001) and device_skills_device_owner_fk to exist
# (20260626000001) -- both already on staging per SMI-5863's own prerequisite
# note -- but does not itself depend on Step 2's lock; the ORDERING
# requirement here is Wave 1's own deployment order (Step 2 before Step 3),
# not a hard technical dependency of this file alone.
#
# Same two-part staging-ref safety as the sibling wrappers:
#   (a) refuses unless STAGING_SUPABASE_PROJECT_REF is set, overrides
#       SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD with STAGING_* for the
#       duration of this call only;
#   (b) this migration file has no :confirm_ref gate of its own -- the
#       wrapper-level override is the only gate, so ALWAYS invoke via this
#       script, never a bare `cat <migration> | pooler-psql.sh`.
#
# Usage: ./scripts/staging/smi-6345-wave1-step3-apply-staging.sh (works from
# any cwd -- paths below are resolved relative to this script's own location).
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SQL_FILE="$REPO_ROOT/supabase/migrations/20260901140000_device_skills_identity_columns.sql"
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
