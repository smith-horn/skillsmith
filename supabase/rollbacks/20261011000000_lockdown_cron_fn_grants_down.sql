-- Rollback for 20261011000000_lockdown_cron_fn_grants.sql (SMI-7075)
--
-- NOT RECOMMENDED. This re-opens the exposure the migration closed: any holder of the public anon
-- key can again call these eight SECURITY DEFINER functions through /rest/v1/rpc/<name>, including
-- invoke_sso_domain_reverify (which can disable a team's SAML provider) and purge_status_checks
-- (which deletes rows). Use it only if a revoke turns out to break a legitimate caller, and file the
-- caller first: the migration found none.
--
-- Restores the exact measured pre-migration ACL on prod and staging (2026-10-11):
--   {=X/postgres, postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
-- i.e. PUBLIC and authenticated regain EXECUTE; anon regains it through PUBLIC.

BEGIN;

GRANT EXECUTE ON FUNCTION public.invoke_indexer_lock_starvation_monitor() TO PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_release_cadence_heartbeat_monitor() TO PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_scan_coverage_monitor() TO PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_sso_domain_reverify() TO PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_status_check() TO PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_status_checks() TO PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_status_daily_rollups() TO PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.check_scan_coverage(INT) TO PUBLIC, authenticated;

COMMIT;
