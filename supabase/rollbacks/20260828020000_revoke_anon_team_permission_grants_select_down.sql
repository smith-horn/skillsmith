-- Rollback for 20260828020000_revoke_anon_team_permission_grants_select.sql
-- SMI-6267
--
-- Re-grants SELECT on team_permission_grants to anon, restoring the exact pre-migration
-- posture. NOT expected to be needed operationally -- the forward migration closes a
-- confirmed-non-exploitable redundant grant (RLS already returns 0 rows to anon on this table)
-- -- provided only for symmetry with this repo's migration/rollback pairing convention.

BEGIN;

GRANT SELECT ON TABLE team_permission_grants TO anon;

COMMIT;
