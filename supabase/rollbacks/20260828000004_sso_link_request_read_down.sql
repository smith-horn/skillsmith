-- Rollback for 20260828000004_sso_link_request_read.sql
-- SMI-6205 (Wave 4 of SMI-6200)
--
-- Drops the two sso_account_links readers this migration created:
-- get_pending_sso_link_requests() (the LEGACY identity's read path for its own pending SSO
-- identity-link requests) and get_own_sso_link_candidate() (the SSO identity's read of its
-- own candidate, confirmation round N-3/N-4). Adds nothing back: this migration created
-- exactly those two functions and altered no table, so the rollback is two DROPs.
-- Safe to apply via `supabase db execute --file`.
--
-- ============================================================================
-- WARNINGS -- READ BEFORE RUNNING
-- ============================================================================
--
-- 1. THIS MAKES THE IDENTITY-LINK FLOW UNCOMPLETABLE, NOT MERELY DEGRADED. Without the
--    legacy-side reader the legacy identity has no channel to learn a link request exists,
--    and record_sso_link_consent() takes p_sso_user_id as an argument the legacy identity
--    can then no longer obtain. Nothing sets sso_account_links.consented_at, so
--    link_sso_account() refuses every call with link_consent_required -- which reads like
--    a deliberate policy decision rather than a missing read path. Without the SSO-side
--    reader the confirm screen cannot name the account being merged at all. Roll
--    packages/website/src/pages/account/link-sso.astro and
--    packages/website/src/lib/sso-link-consent.ts back in the SAME deploy -- and note that
--    the pre-N-3 version of that page resolved its candidate by calling record_sso_login(),
--    which is the side-effecting login write path; reverting to it reinstates the forged
--    'sso:login_recorded' audit rows and the per-page-view consent-window extension.
--
-- 2. ALREADY-EXECUTED LINKS ARE UNAFFECTED. Neither function ever wrote anything. Rows in
--    sso_account_links, the entitlement moves link_sso_account() performed, and the
--    'sso:link_consented' / 'sso:account_linked' audit_logs rows all survive untouched.
--
-- 3. THE TABLE GRANT IS NOT WIDENED AS COMPENSATION. sso_account_links deliberately holds
--    no client grant (20260828000003 Section 1) because it carries a consent token hash and
--    RLS is row-level, not column-level. If either read path is needed again, restore the
--    function -- do not add a SELECT policy to the table.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION IF EXISTS get_pending_sso_link_requests();
DROP FUNCTION IF EXISTS get_own_sso_link_candidate();

-- schema_version back to 107. Matches the sibling rollback's own final step
-- (20260828000003_sso_member_lifecycle_down.sql:386); `AND TRUE` per this wave's
-- pg_safeupdate convention.
DELETE FROM schema_version WHERE version = 108 AND TRUE;

COMMIT;
