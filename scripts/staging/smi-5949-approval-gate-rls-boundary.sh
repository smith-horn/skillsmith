#!/bin/sh
# smi-5949-approval-gate-rls-boundary.sh -- staging invocation wrapper for
# scripts/staging/smi-5949-approval-gate-rls-boundary.sql (SMI-5949 Wave 1, Step 3).
#
# Plan: docs/internal/implementation/smi-5949-approval-gate.md (Wave 1 Step 3, "Staging RLS
# harness"; and "Smoke vs CI", which explains why this -- not any unit test -- is the real proof
# of the D-4 RLS gate: a mocked Supabase client cannot evaluate a policy, and the two read
# surfaces the gate protects structurally have NO application-code change at all, so their unit
# tests can neither regress nor confirm).
#
# Structure and both prod-safety gates are taken verbatim from
# scripts/staging/smi-5882-private-registry-rls-role-boundary.sh, which established them for this
# same table; the reasons below are restated rather than referenced because they are the reason
# this file exists at all.
#
# Why this wrapper exists, not a bare `pooler-psql.sh -f <path>`:
#   1. `./scripts/pooler-psql.sh -f <path>` does not work. The script `docker exec`s into
#      skillsmith-dev-1, so a `-f` path resolves INSIDE the container's /app -- and from a
#      worktree, skillsmith-dev-1 is the MAIN checkout's container (SMI-5559), where this file
#      does not exist at all. The script's own header documents the supported form: pipe the file
#      in on stdin. That is what this wrapper does.
#   2. Nothing about the default invocation points at staging. `pooler-psql.sh` builds its
#      connection from SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD, which in .env are the PROD
#      values (CLAUDE.md Supabase Edge Functions section). The .sql file INSERTs fixture rows into
#      auth.users, profiles, teams, team_members and private_registry_skills, so both this wrapper
#      AND the .sql file refuse to run unless the ref is literally staging (ovhcifugwqnzoebwfuku)
#      -- two independent gates:
#        (a) this wrapper refuses unless STAGING_SUPABASE_PROJECT_REF is set, and overrides
#            SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD with the STAGING_* values for the
#            duration of this call only, passing the ref through again as :confirm_ref;
#        (b) the .sql file refuses unless :confirm_ref is BOTH set AND equal to the staging ref.
#            A bare `cat file | ./scripts/pooler-psql.sh` (skipping this wrapper) leaves
#            :confirm_ref unset and stops at gate (b).
#
# Usage: ./scripts/staging/smi-5949-approval-gate-rls-boundary.sh
# (works from any cwd -- paths below are resolved relative to this script's own location, not the
# caller's cwd). Requires the skillsmith-dev-1 container to be running: pooler-psql.sh is a host
# tool that `docker exec`s into it purely for the psql client binary.
#
# EXPECTED EXIT STATUS: ZERO. Every assertion expects the post-apply state, so a clean run prints
# only NOTICE lines and exits 0, and ANY non-zero exit is a real finding.
#
# **This file is the POST-APPLY verification for the migration PAIR
# 20260809000000_private_registry_approval_gate.sql (columns, the pending index, trg_prs_approval,
# the RLS policy swap, both review RPCs, and get_skill_update_candidates's approval predicate) and
# 20260809000001_private_registry_approval_gate_smoke.sql (which asserts the same controls from
# the migration owner's privileged vantage point).** Run against a database where those have NOT
# been applied, it is expected to fail loudly at block F2 -- the control that proves
# trg_prs_approval is armed before any "pending is invisible" assertion is trusted. Read the
# NOTICE lines above any ERROR: the first FAIL names the block and the invariant.
#
# WHAT THIS HARNESS PROVES THAT THE MIGRATION'S OWN SMOKE SUITE CANNOT. 20260809000001 runs as the
# migration owner, which bypasses RLS on its own table -- so its RLS assertions are only as good
# as its ability to impersonate `authenticated`, and it degrades to a NOTICE if it cannot. This
# file impersonates for real, through every role the feature has (submitter, plain member, team
# admin, second-tenant member, anon), against a database carrying the full migration history.
#
# Two invocation-safety fixes inherited from SMI-5817's adversarial review, both defending against
# a *silent* false "success" -- this is the one gate that genuinely needs role switching, so a
# silent no-op here means the property is never actually asserted:
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
SQL_FILE="$REPO_ROOT/scripts/staging/smi-5949-approval-gate-rls-boundary.sql"
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
