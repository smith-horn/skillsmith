-- Rollback for 20260828000002_sso_domain_reverify_pg_cron.sql
-- SMI-6204
--
-- Unschedules the sso-domain-reverify cron and drops the dispatch function.
-- Safe to apply via `supabase db execute --file`.
--
-- WARNING: reverting stops the daily domain-reverify sweep entirely — a
-- domain whose DNS TXT record is removed/changed by its owner will stay
-- "verified" in team_sso_domains, and GoTrue's SAML provider stays live and
-- routing logins, indefinitely. Re-apply the forward migration, or
-- provision the Vault secrets and re-schedule manually, before relying on
-- this reverify sweep again.

BEGIN;

SELECT cron.unschedule('sso-domain-reverify')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sso-domain-reverify');

DROP FUNCTION IF EXISTS public.invoke_sso_domain_reverify();

COMMIT;
