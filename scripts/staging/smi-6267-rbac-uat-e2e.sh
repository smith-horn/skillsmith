#!/bin/sh
# smi-6267-rbac-uat-e2e.sh -- staging invocation wrapper for
# scripts/staging/smi-6267-rbac-uat-e2e.sql (SMI-6267: synthetic E2E UAT of the SMI-6200
# Enterprise RBAC permission model, Waves 1-2 = SMI-6202 / SMI-6203).
#
# Structure and both prod-safety gates are taken from
# scripts/staging/smi-5949-approval-gate-rls-boundary.sh, which established them for this
# same database. The reasons are restated rather than referenced because they are the
# reason this file exists at all.
#
# Usage: ./scripts/staging/smi-6267-rbac-uat-e2e.sh
# (works from any cwd -- paths below are resolved relative to this script's own location,
# not the caller's cwd). Requires the skillsmith-dev-1 container to be running:
# pooler-psql.sh is a host tool that `docker exec`s into it purely for the psql binary.
#
# EXPECTED EXIT STATUS: ZERO. Every assertion expects the post-fix state, so a clean run
# prints only NOTICE lines and exits 0, and ANY non-zero exit is a real finding.
#
# ---------------------------------------------------------------------------
# WHY THIS WRAPPER EXISTS, and not a bare `pooler-psql.sh -f <path>`
# ---------------------------------------------------------------------------
#   1. `./scripts/pooler-psql.sh -f <path>` does not work. The script `docker exec`s into
#      skillsmith-dev-1, so a `-f` path resolves INSIDE the container's /app -- and from a
#      worktree, skillsmith-dev-1 is the MAIN checkout's container (SMI-5559), where this
#      file does not exist at all. The supported form is to pipe the file in on stdin.
#   2. Nothing about the default invocation points at staging. `pooler-psql.sh` builds its
#      connection from SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD, which in .env are the
#      PROD values (CLAUDE.md, Supabase Edge Functions section). The .sql file INSERTs
#      fixture rows into auth.users, profiles, teams, team_members and
#      private_registry_skills, so both this wrapper AND the .sql file refuse to run
#      unless the ref is literally staging (ovhcifugwqnzoebwfuku) -- two independent
#      gates:
#        (a) this wrapper refuses unless STAGING_SUPABASE_PROJECT_REF is set, and
#            overrides SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD with the STAGING_*
#            values for the duration of this call only, passing the ref through again as
#            :confirm_ref;
#        (b) the .sql file refuses unless :confirm_ref is BOTH set AND equal to the
#            staging ref. A bare `cat file | ./scripts/pooler-psql.sh` (skipping this
#            wrapper) leaves :confirm_ref unset and stops at gate (b).
#   3. THE SHIM SPLICE (the reason this wrapper does more than the SMI-5949 one). See
#      below.
#
# ---------------------------------------------------------------------------
# THE WAVE 2 SHIM SPLICE
# ---------------------------------------------------------------------------
# As of authoring, staging is at schema_version 102 -- only Wave 1 Step 1
# (20260827000000_team_permission_grants.sql) is applied. The two grant-write RPCs the
# harness exercises do not exist there, and the SMI-6242 security fix is not applied.
#
# Postgres DDL is transactional, so the harness runs inside one transaction that ends in
# ROLLBACK, and this wrapper splices the REAL merged SQL for the missing functions into
# that transaction at the harness's `-- @@WAVE2_SHIM@@` marker. After the rollback the
# functions are gone again and staging is byte-identical to before the run.
#
# THE SPLICED TEXT IS EXTRACTED FROM THE MIGRATION FILE ITSELF, never copy-pasted -- so
# there is no second copy of the function bodies to drift out of sync. The extraction
# window is bounded by two stable section-header comment lines in that migration; if
# either marker ever disappears (a refactor, a rename), the awk below yields text that
# fails the sanity checks and this wrapper REFUSES rather than running a harness that
# would silently assert nothing.
#
# All three spliced statements are CREATE OR REPLACE, so the splice is a harmless no-op
# against a database that already has Wave 2 applied. The harness's own P0 block runs
# BEFORE the splice and is the only thing that reports deployed state.
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SQL_FILE="$REPO_ROOT/scripts/staging/smi-6267-rbac-uat-e2e.sql"
MIGRATION="$REPO_ROOT/supabase/migrations/20260828000000_rbac_grant_writes.sql"

# POSIX sh has no `pipefail`, and `set -e` does not apply to a non-final pipeline element
# -- so if a `cat` failed silently, psql would read empty (or truncated) stdin and exit 0,
# and this wrapper would report success having asserted nothing. Every input is therefore
# checked for existence AND for expected content BEFORE any pipeline is built.
if [ ! -f "$SQL_FILE" ]; then
  echo "REFUSING: $SQL_FILE not found." >&2
  exit 1
fi
if [ ! -f "$MIGRATION" ]; then
  echo "REFUSING: $MIGRATION not found (needed for the Wave 2 shim splice)." >&2
  exit 1
fi
if ! grep -q '^-- @@WAVE2_SHIM@@$' "$SQL_FILE"; then
  echo "REFUSING: $SQL_FILE has no '-- @@WAVE2_SHIM@@' marker line. Without the splice the" >&2
  echo "          harness would call functions that do not exist and fail for the wrong reason." >&2
  exit 1
fi

# The migration is git-crypt encrypted at rest. If the repo is locked, the file on disk is
# ciphertext and awk would extract nothing -- caught by the sanity checks below, but say so
# explicitly here so the operator gets the real remediation instead of a puzzling refusal.
if ! head -c 64 "$MIGRATION" | grep -q 'SMI-6203'; then
  echo "REFUSING: $MIGRATION does not begin with readable SQL -- the repo is probably" >&2
  echo "          git-crypt LOCKED. Unlock first:" >&2
  echo "          varlock run -- sh -c 'git-crypt unlock \"\${GIT_CRYPT_KEY_PATH/#~/\$HOME}\"'" >&2
  exit 1
fi

SHIM_FILE=$(mktemp -t smi6267shim)
# Sections 1-4 of the migration: the SMI-6242 default_role_permission fix,
# set_team_role_permission, reset_team_role_permission, and their GRANT/REVOKE block.
# Bounded by the section-1 header and the section-5 (smoke block) header, so the extract
# deliberately EXCLUDES the migration's own BEGIN/COMMIT, its smoke block, and its
# schema_version bump -- all three of which would be wrong to run here.
awk '/^-- SECTION 1 \(SMI-6242 SECURITY FIX\)/{f=1} /^-- SECTION 5: SMOKE BLOCK/{f=0} f' \
  "$MIGRATION" > "$SHIM_FILE"

# Sanity-check the extract before trusting it. Each of these has actually failed at some
# point during development of this harness; none is theoretical.
shim_fail() {
  echo "REFUSING: the Wave 2 shim extraction from $MIGRATION looks wrong -- $1" >&2
  echo "          The migration's section headers may have been renamed. Fix the awk" >&2
  echo "          markers in this wrapper rather than running an unverified harness." >&2
  rm -f "$SHIM_FILE"
  exit 1
}
[ -s "$SHIM_FILE" ] || shim_fail "the extract is EMPTY"
[ "$(grep -c '^CREATE OR REPLACE FUNCTION' "$SHIM_FILE")" = "3" ] \
  || shim_fail "expected exactly 3 CREATE OR REPLACE FUNCTION statements"
grep -q 'FUNCTION default_role_permission'    "$SHIM_FILE" || shim_fail "no default_role_permission"
grep -q 'FUNCTION set_team_role_permission'   "$SHIM_FILE" || shim_fail "no set_team_role_permission"
grep -q 'FUNCTION reset_team_role_permission' "$SHIM_FILE" || shim_fail "no reset_team_role_permission"
[ "$(grep -c '^GRANT EXECUTE' "$SHIM_FILE")" = "2" ] \
  || shim_fail "expected exactly 2 GRANT EXECUTE statements"
# A stray transaction-control statement in the extract would COMMIT the harness's fixtures
# to staging instead of rolling them back. This is the single most dangerous drift mode.
#
# Anchored at column 0 with a trailing semicolon, and deliberately EXCLUDING `END` -- this
# has to distinguish top-level transaction control from PL/pgSQL block structure inside the
# dollar-quoted function bodies we are extracting. A plpgsql `BEGIN` never carries a
# semicolon, while a plpgsql block terminator `END;` always does, so an over-broad pattern
# matches four harmless block terminators in the two RPC bodies and refuses every run.
if grep -qE '^(BEGIN|COMMIT|ROLLBACK);[[:space:]]*$' "$SHIM_FILE"; then
  shim_fail "the extract contains a top-level transaction-control statement
          (BEGIN;/COMMIT;/ROLLBACK;), which would break the harness's rollback guarantee
          and could COMMIT fixture rows to staging"
fi
# The SMI-6242 fix must actually be present in what we splice, or T5 would pass vacuously
# against a still-buggy definition.
#
# Comment lines are stripped first: the migration's own Section 1 header prose says
# "Removes the ('admin', 'team:manage_rbac') and ('admin', 'team:manage_sso') rows Wave 1
# shipped", which a naive content grep matches and misreads as the bug still being present.
# Only the actual VALUES list matters here.
SHIM_CODE=$(mktemp -t smi6267code)
grep -v '^[[:space:]]*--' "$SHIM_FILE" > "$SHIM_CODE"
grep -q "'admin', 'registry:approve'" "$SHIM_CODE" \
  || { rm -f "$SHIM_CODE"; shim_fail "no corrected default matrix in the extracted code"; }
if grep -q "'admin', 'team:manage_rbac'" "$SHIM_CODE"; then
  rm -f "$SHIM_CODE"
  shim_fail "the extracted default_role_permission STILL grants admin team:manage_rbac --
          the SMI-6242 fix is not in the migration this wrapper is reading"
fi
rm -f "$SHIM_CODE"

COMPOSED=$(mktemp -t smi6267sql)
# Replace the marker line with the extracted DDL. awk (not sed) because the inserted text
# contains characters sed would treat as replacement metacharacters.
awk -v shim="$SHIM_FILE" '
  /^-- @@WAVE2_SHIM@@$/ {
    print "-- >>> BEGIN spliced from supabase/migrations/20260828000000_rbac_grant_writes.sql"
    while ((getline line < shim) > 0) print line
    close(shim)
    print "-- <<< END spliced Wave 2 shim"
    next
  }
  { print }
' "$SQL_FILE" > "$COMPOSED"
rm -f "$SHIM_FILE"

if ! grep -q 'BEGIN spliced from' "$COMPOSED"; then
  echo "REFUSING: the splice did not take -- composed file has no spliced block." >&2
  rm -f "$COMPOSED"
  exit 1
fi

# Note the `sh -c '...'` wrapper: `VAR="$SUPABASE_..."` on the outer shell would expand to
# EMPTY, because those variables only exist inside `varlock run --`'s child environment.
varlock run -- sh -c '
  set -eu
  if [ "${STAGING_SUPABASE_PROJECT_REF:-}" = "" ]; then
    echo "REFUSING: STAGING_SUPABASE_PROJECT_REF is not set." >&2; exit 1
  fi
  if [ "${STAGING_SUPABASE_DB_PASSWORD:-}" = "" ]; then
    # Without this check the override below would pass an EMPTY password through to
    # pooler-psql.sh, whose own `: "${SUPABASE_DB_PASSWORD:?...}"` guard would then fire
    # with a message naming the PROD variable -- misleading operators into "fixing" the
    # wrong secret.
    echo "REFUSING: STAGING_SUPABASE_DB_PASSWORD is not set." >&2; exit 1
  fi
  # Belt and braces: refuse if the staging ref somehow equals the prod ref.
  if [ "$STAGING_SUPABASE_PROJECT_REF" = "vrcnzpmndtroqxxoqkzy" ]; then
    echo "REFUSING: STAGING_SUPABASE_PROJECT_REF is set to the PROD ref." >&2; exit 1
  fi
  cat "$1" \
    | SUPABASE_PROJECT_REF="$STAGING_SUPABASE_PROJECT_REF" \
      SUPABASE_DB_PASSWORD="$STAGING_SUPABASE_DB_PASSWORD" \
      "$2"/scripts/pooler-psql.sh -v ON_ERROR_STOP=1 \
                                  -v confirm_ref="$STAGING_SUPABASE_PROJECT_REF"
' _ "$COMPOSED" "$REPO_ROOT"
STATUS=$?
rm -f "$COMPOSED"
exit $STATUS
