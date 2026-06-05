-- Rollback for 20260519000003_search_metrics_partitioned_table.sql
-- SMI-4968
--
-- Drops the search_metrics partitioned table, all its monthly partitions,
-- the composite index, and the RLS policy. CASCADE handles partitions and
-- dependent objects.
--
-- !! DATA LOSS WARNING !!
-- This destroys all telemetry rows in search_metrics. Before running:
--   1. Confirm the edge-function writers (skills-search, events) have been
--      rolled back to write audit_logs again — otherwise their inserts will
--      start failing with "relation search_metrics does not exist".
--   2. Take a backup if any telemetry needs to be retained.
-- This rollback must NOT be run while the retention cron (...0004) still
-- references the table — roll back ...0004 FIRST.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP TABLE IF EXISTS search_metrics CASCADE;

COMMIT;
