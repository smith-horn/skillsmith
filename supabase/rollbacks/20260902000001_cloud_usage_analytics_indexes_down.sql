-- Rollback for 20260902000001_cloud_usage_analytics_indexes.sql
-- SMI-6362 Wave 1
--
-- Drops the three partitioned indexes (parent shells) this migration added.
-- DROP INDEX on a partitioned index cascades to every attached child
-- automatically -- no per-partition DROP needed, unlike the forward
-- migration's per-partition CREATE INDEX CONCURRENTLY.
--
-- Safe to apply via `supabase db execute --file`. DROP INDEX (not
-- CONCURRENTLY) on a partitioned parent takes ACCESS EXCLUSIVE briefly on the
-- parent and cascades a lighter drop to each child; bounded with a short
-- lock_timeout below. If you need a zero-downtime drop instead, use
-- `DROP INDEX CONCURRENTLY <child>` per partition first, then the parent
-- (mirrors scripts/smi6362-search-metrics-indexes.sh's build order in
-- reverse) -- not needed for an index drop under normal write load, but
-- named here in case this runs during a high-traffic window.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

DROP INDEX IF EXISTS public.idx_search_metrics_toolcall_team_created;
DROP INDEX IF EXISTS public.idx_search_metrics_skillinvoke_team_created;
DROP INDEX IF EXISTS public.idx_search_metrics_skillinvoke_cooccurrence;

COMMIT;
