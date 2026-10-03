-- Rollback for 20260913000000_private_registry_audit_trigger.sql
-- SMI-6114
--
-- Removes the server-side private-registry audit trigger pair and its function. Safe to apply via
-- `supabase db execute --file`.
--
-- ============================================================================
-- WARNING -- READ BEFORE RUNNING
-- ============================================================================
--
-- 1. This restores the state SMI-6114 was filed against: private-registry publish, approve,
--    reject, deprecate and undeprecate commit with NO audit_logs row on every path that lacks a
--    service-role key. That includes every production MCP host and the website dashboard. Treat
--    running this as an incident with a follow-up, not a clean revert.
-- 2. The @skillsmith/mcp-server build carrying SMI-6114 no longer writes client-side success rows
--    for those mutations (the trigger replaced them). Rolling back the database without rolling
--    back that client leaves NO success rows from ANY writer, including hosts that do hold a
--    service-role key.
-- 3. audit_logs rows the trigger already wrote are NOT deleted. They are true records of changes
--    that happened.
--
-- DROP TRIGGER takes ACCESS EXCLUSIVE on private_registry_skills until COMMIT; the table is tiny
-- and Enterprise-only, so the hold is milliseconds.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DROP TRIGGER IF EXISTS trg_prs_audit_truncate ON private_registry_skills;
DROP TRIGGER IF EXISTS trg_prs_audit ON private_registry_skills;
DROP FUNCTION IF EXISTS audit_private_registry_skills_change();

DELETE FROM schema_version WHERE version = 116;

COMMIT;
