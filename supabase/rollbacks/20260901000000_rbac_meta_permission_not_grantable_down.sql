-- Rollback for 20260901000000_rbac_meta_permission_not_grantable.sql
-- SMI-6319 (found during SMI-6312 UAT of the SMI-6200 E3 RBAC+SSO surface)
--
-- Drops the team_permission_grants_meta_permission_not_grantable CHECK constraint and
-- restores set_team_role_permission() to its pre-SMI-6319 body (gates 1-5, no gate 4b).
-- Safe to apply via `supabase db execute --file`.
--
-- ============================================================================
-- WARNING -- READ BEFORE RUNNING
-- ============================================================================
--
-- THIS REOPENS A CONFIRMED, LIVE PRIVILEGE ESCALATION. Once rolled back, a team owner can
-- again grant `team:manage_rbac` or `team:manage_sso` to the `admin` or `member` role:
--
--   POST /rest/v1/rpc/set_team_role_permission
--        {p_team_id, p_role:"member", p_permission:"team:manage_rbac", p_effect:"allow"} -> 204
--   SELECT has_team_permission(TEAM, 'team:manage_rbac');                                -> true
--
-- A non-owner holding team:manage_rbac can rewrite the permission matrix and change other
-- members' roles. A non-owner holding team:manage_sso can register an attacker-controlled
-- IdP, claim the team's email domain, and then authenticate AS THE OWNER -- a one-way door:
-- once they hold owner authority they can grant themselves anything, permanently, and
-- rolling this migration forward again will not undo it.
--
-- DATA: this rollback does NOT restore the meta-permission ALLOW grant rows the migration's
-- Section 1 removed. That deletion was deliberate -- those rows WERE the vulnerability, and
-- re-creating them would re-grant live escalated authority to whoever held it. Each removed
-- row is recorded in audit_logs with
--   event_type = 'rbac:meta_permission_grant_purged'
--   actor      = 'migration:20260901000000'
--   metadata   = {team_id, role, permission, effect, granted_by, granted_at, reason}
-- Recover an individual grant from that trail only on an explicit, documented owner decision.
--
-- Only run this as part of a full revert of the migration, never in isolation, and only if
-- the migration itself is the cause of an unrelated outage.
--
-- ============================================================================
-- LOCK PROFILE
-- ============================================================================
--   DROP CONSTRAINT           -> ACCESS EXCLUSIVE on team_permission_grants (no table scan)
--   CREATE OR REPLACE FUNCTION -> ACCESS EXCLUSIVE on the pg_proc row only
-- team_permission_grants is a small, cold table (one row per configured team x role x
-- permission override). lock_timeout = 3s bounds acquisition.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- ----------------------------------------------------------------------------
-- 1. Drop the table-level invariant.
-- ----------------------------------------------------------------------------
ALTER TABLE team_permission_grants
  DROP CONSTRAINT IF EXISTS team_permission_grants_meta_permission_not_grantable;

-- ----------------------------------------------------------------------------
-- 2. Restore set_team_role_permission()'s pre-SMI-6319 body.
--
-- Reproduced verbatim from supabase/migrations/20260828000000_rbac_grant_writes.sql
-- Section 2 -- the only other definition of this function in the migration history -- minus
-- gate 4b. Gates 1, 2, 3, 4 and 5, the INSERT and the audit write are byte-identical to what
-- that migration shipped.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_team_role_permission(
  p_team_id TEXT, p_role TEXT, p_permission TEXT, p_effect TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_role TEXT;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'role must be admin or member (got %)', p_role USING ERRCODE = '22023';
  END IF;

  IF p_permission IS NULL OR p_permission NOT IN (
    'registry:approve', 'registry:deprecate', 'team:manage_rbac', 'team:manage_sso'
  ) THEN
    RAISE EXCEPTION 'permission must be one of registry:approve, registry:deprecate, '
      'team:manage_rbac, team:manage_sso (got %)', p_permission USING ERRCODE = '22023';
  END IF;

  IF p_effect IS NULL OR p_effect NOT IN ('allow', 'deny') THEN
    RAISE EXCEPTION 'effect must be allow or deny (got %)', p_effect USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM teams WHERE teams.id = p_team_id) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  IF NOT has_team_permission(p_team_id, 'team:manage_rbac') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  SELECT team_members.role INTO v_caller_role
    FROM team_members
   WHERE team_members.team_id = p_team_id
     AND team_members.user_id = auth.uid()
   LIMIT 1;

  IF p_permission IN ('team:manage_rbac', 'team:manage_sso')
     AND v_caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the team owner can change who holds the "%" permission.', p_permission
      USING ERRCODE = '42501';
  END IF;

  IF p_effect = 'allow'
     AND (v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'Only owners and admins can widen a role''s permissions. You can review '
      'permissions and remove grants, but not add an allow.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO team_permission_grants (team_id, role, permission, effect, created_by)
  VALUES (p_team_id, p_role, p_permission, p_effect, auth.uid())
  ON CONFLICT (team_id, role, permission)
  DO UPDATE SET effect = EXCLUDED.effect, created_by = EXCLUDED.created_by, created_at = now();

  BEGIN
    INSERT INTO audit_logs (event_type, actor, resource, action, result, metadata)
    VALUES (
      'rbac:set_role_permission',
      auth.uid()::text,
      'team_permission_grants/' || p_team_id || '/' || p_role || '/' || p_permission,
      'upsert',
      'success',
      jsonb_build_object(
        'team_id', p_team_id,
        'role', p_role,
        'permission', p_permission,
        'effect', p_effect,
        'caller_role', v_caller_role
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'set_team_role_permission: audit_logs insert failed for %/%/%: %',
      p_team_id, p_role, p_permission, SQLERRM;
  END;
END;
$$;

COMMENT ON FUNCTION set_team_role_permission(TEXT, TEXT, TEXT, TEXT) IS
  'SMI-6203 Wave 2 (SMI-6319 gate 4b ROLLED BACK -- meta-permissions are delegable again, '
  'which is a known live privilege escalation; see '
  'supabase/rollbacks/20260901000000_rbac_meta_permission_not_grantable_down.sql). Writes '
  '(or overwrites) one team_permission_grants row.';

-- ----------------------------------------------------------------------------
-- 3. Re-state the REVOKE/GRANT triple.
--
-- REQUIRED after CREATE OR REPLACE even on an unchanged signature: Postgres adds an implicit
-- PUBLIC EXECUTE grant, and Supabase's ALTER DEFAULT PRIVILEGES separately auto-grants
-- anon/authenticated. Omitting this is the two-leak pattern documented in
-- 20260704000001_lockdown_definer_grant_audit.sql's header.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION set_team_role_permission(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_team_role_permission(TEXT, TEXT, TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION set_team_role_permission(TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

DELETE FROM schema_version WHERE version = 111;

COMMIT;
