#!/bin/sh
# smi-5863-apply-staging.sh -- staging invocation wrapper for
# supabase/migrations/20260727020000_public_arm_bare_name_fallback.sql
# (SMI-5863, required staging-verification step before this migration can
# be applied to prod -- the migration modifies a SECURITY DEFINER RPC
# already hardened twice this initiative, SMI-5817/SMI-5852).
#
# Why this wrapper exists, not a bare `npx supabase db push`: this worktree's
# local `supabase start` full-history replay hits a pre-existing, unrelated
# bug in a May-2026 migration (date-dependent partition creation), so a full
# local Postgres cannot be stood up to test against. Staging already has
# this migration's two dependency migrations applied (20260727000000 /
# SMI-5852, 20260727010000 / SMI-5851, confirmed via a read-only pre-check),
# so piping just the ONE new migration file through the pooler is a real,
# targeted staging verification -- and the migration's own three in-transaction
# smoke blocks (A: regression guards + grant shape, B: behavioral fixtures
# f1-f4, C: P-5 rank-parity f5) self-check the apply: any RAISE EXCEPTION
# rolls back the entire BEGIN/COMMIT transaction, so a clean exit IS the
# verification, mirroring how this migration would behave if piped to prod.
#
# Same two-part staging-ref safety as scripts/staging/smi-5817-rls-role-boundary.sh:
#   (a) this wrapper refuses unless STAGING_SUPABASE_PROJECT_REF is set, and
#       overrides SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD with the
#       STAGING_* values for the duration of this call only;
#   (b) unlike SMI-5817's dedicated fixture script, this migration file has
#       no :confirm_ref gate of its own (it is the real migration file, not
#       a staging-only test script) -- the wrapper-level override is the
#       only gate, so ALWAYS invoke via this script, never a bare
#       `cat <migration> | pooler-psql.sh` (which would silently hit PROD).
#
# Usage: ./scripts/staging/smi-5863-apply-staging.sh (works from any cwd --
# paths below are resolved relative to this script's own location).
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SQL_FILE="$REPO_ROOT/supabase/migrations/20260727020000_public_arm_bare_name_fallback.sql"
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
