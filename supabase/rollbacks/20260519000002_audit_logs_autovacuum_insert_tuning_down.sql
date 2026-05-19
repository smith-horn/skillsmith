-- Rollback for 20260519000002_audit_logs_autovacuum_insert_tuning.sql
-- SMI-4968
--
-- Reverts the audit_logs storage params to their cluster defaults. Safe to
-- apply via `supabase db push` — catalog-only change, brief ACCESS EXCLUSIVE
-- lock on the pg_class row.
--
-- WARNING: reverting re-disables insert-triggered autovacuum on this
-- insert-only table; the visibility map will decay again and read IO will
-- regress. Treat as break-glass only.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE audit_logs RESET (
  autovacuum_vacuum_insert_scale_factor,
  autovacuum_vacuum_insert_threshold
);

COMMIT;
