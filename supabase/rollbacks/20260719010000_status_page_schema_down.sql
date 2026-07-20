-- Rollback for 20260719010000_status_page_schema.sql
-- SMI-5751
--
-- Drops the status-page component registry, check history, and daily rollups.
-- DATA LOSS: any status_checks/status_daily_rollups history accumulated since
-- Wave 2 (SMI-5752) shipped is permanently lost. Take a backup first if this
-- has been live for any meaningful period.
--
-- Safe to run standalone via:
--   docker exec skillsmith-dev-1 varlock run -- ./scripts/pooler-psql.sh -f supabase/rollbacks/20260719010000_status_page_schema_down.sql

BEGIN;

DROP VIEW IF EXISTS v_status_current;
DROP TABLE IF EXISTS status_daily_rollups;
DROP TABLE IF EXISTS status_checks;
DROP TABLE IF EXISTS status_components;

COMMIT;
