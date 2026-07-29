#!/bin/sh
# smi-5882-private-registry-rls-role-boundary.sh -- staging invocation wrapper for
# scripts/staging/smi-5882-private-registry-rls-role-boundary.sql (SMI-5882 Wave 1).
#
# Plan: docs/internal/implementation/smi-5882-redteam-private-registry-privacy-assessment.md
# (Wave 1, "Live-Postgres RLS + privilege harness"; the escape hatch chosen by Wave 0's spike --
# a CI-wired live-Postgres harness is blocked on SMI-5885's fresh-replay migration bug, so
# Wave 1 adapts SMI-5817's staging-ad-hoc pattern instead).
#
# Structure and both prod-safety gates are taken from
# scripts/staging/smi-5817-rls-role-boundary.sh, which established them; the reasons below are
# restated rather than referenced because they are the reason this file exists at all.
#
# Why this wrapper exists, not a bare `pooler-psql.sh -f <path>`:
#   1. `./scripts/pooler-psql.sh -f <path>` does not work. The script `docker exec`s into
#      skillsmith-dev-1, so a `-f` path resolves INSIDE the container's /app -- and from a
#      worktree, skillsmith-dev-1 is the MAIN checkout's container (SMI-5559), where this file
#      does not exist at all. The script's own header documents the supported form: pipe the
#      file in on stdin. That is what this wrapper does.
#   2. Nothing about the default invocation points at staging. `pooler-psql.sh` builds its
#      connection from SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD, which in .env are the PROD
#      values (CLAUDE.md Supabase Edge Functions section). The .sql file INSERTs fixture rows
#      into auth.users AND deliberately attempts a TRUNCATE as its final assertion, so both this
#      wrapper AND the .sql file refuse to run unless the ref is literally staging
#      (ovhcifugwqnzoebwfuku) -- two independent gates:
#        (a) this wrapper refuses unless STAGING_SUPABASE_PROJECT_REF is set, and overrides
#            SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD with the STAGING_* values for the
#            duration of this call only, passing the ref through again as :confirm_ref;
#        (b) the .sql file refuses unless :confirm_ref is BOTH set AND equal to the staging ref.
#            A bare `cat file | ./scripts/pooler-psql.sh` (skipping this wrapper) leaves
#            :confirm_ref unset and stops at gate (b).
#
# Usage: ./scripts/staging/smi-5882-private-registry-rls-role-boundary.sh
# (works from any cwd -- paths below are resolved relative to this script's own location, not
# the caller's cwd). Requires the skillsmith-dev-1 container to be running: pooler-psql.sh is a
# host tool that `docker exec`s into it purely for the psql client binary.
#
# EXPECTED EXIT STATUS (changed in Wave 3): ZERO. Every assertion in the .sql file now expects the
# hardened state, so a clean run prints only NOTICE lines and exits 0, and ANY non-zero exit is a
# real finding rather than a documented one.
#
# This inverts Wave 1's behaviour, where the file's final assertion (T1) attempted a TRUNCATE as
# `authenticated`, succeeded -- staging's relacl granted `authenticated=arwdDxtm`, and `D` is
# TRUNCATE -- and deliberately aborted the transaction with a non-zero exit as the finding.
#
# **This file is the POST-APPLY verification for the migration PAIR
# 20260729000000_private_registry_privilege_hardening.sql (the DDL: trigger, published_by DEFAULT,
# column-scoped grants, anon EXECUTE revokes) and 20260729000001_private_registry_hardening_
# backfill.sql (the content_hash backfill).** Every assertion below targets a control installed by
# the first file; the second matters here only because a database with the first applied but not
# the second can still hold rows whose stored content_hash predates the trigger. Run against a
# database where those migrations have NOT been applied, it is expected to fail (loudly, at
# C1/F2 or earlier). Wave 1's
# pre-apply results are recorded in the plan doc; they are not re-derivable from this file.
# Read the NOTICE lines above any ERROR -- the first FAIL names the block and the invariant.
#
# Two invocation-safety fixes inherited from SMI-5817's adversarial review, both defending
# against a *silent* false "success" -- this is the one gate that genuinely needs role switching,
# so a silent no-op here means the property is never actually asserted:
#   1. A bare relative path only resolves if the caller's cwd happens to be the repo root.
#      Resolved via $0 instead.
#   2. POSIX sh has no `pipefail`, and `set -e` does not apply to a non-final pipeline element --
#      so if `cat` ever failed silently, `psql` would read empty stdin and exit 0, and this
#      wrapper would report success having asserted nothing. Fixed by checking the file exists
#      BEFORE piping, so the cat/psql pipeline can never see a missing file.
#
# Note the `sh -c '...'` wrapper: `VAR="$SUPABASE_..."` on the outer shell would expand to EMPTY,
# because those variables only exist inside `varlock run --`'s child environment.
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SQL_FILE="$REPO_ROOT/scripts/staging/smi-5882-private-registry-rls-role-boundary.sql"
if [ ! -f "$SQL_FILE" ]; then
  echo "REFUSING: $SQL_FILE not found." >&2
  exit 1
fi

varlock run -- sh -c '
  set -eu
  if [ "${STAGING_SUPABASE_PROJECT_REF:-}" = "" ]; then
    echo "REFUSING: STAGING_SUPABASE_PROJECT_REF is not set." >&2; exit 1
  fi
  if [ "${STAGING_SUPABASE_DB_PASSWORD:-}" = "" ]; then
    # Without this check the override below would pass an EMPTY password through to
    # pooler-psql.sh, whose own `: "${SUPABASE_DB_PASSWORD:?...}"` guard would then fire with a
    # message naming the PROD variable -- misleading operators into "fixing" the wrong secret.
    echo "REFUSING: STAGING_SUPABASE_DB_PASSWORD is not set." >&2; exit 1
  fi
  cat "$1" \
    | SUPABASE_PROJECT_REF="$STAGING_SUPABASE_PROJECT_REF" \
      SUPABASE_DB_PASSWORD="$STAGING_SUPABASE_DB_PASSWORD" \
      "$2"/scripts/pooler-psql.sh -v ON_ERROR_STOP=1 \
                                  -v confirm_ref="$STAGING_SUPABASE_PROJECT_REF"
' _ "$SQL_FILE" "$REPO_ROOT"
