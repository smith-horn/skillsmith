-- Rollback for 051_indexer_health_views.sql
-- Drops views first (they depend on the index's underlying table), then the index.

DROP VIEW IF EXISTS v_refresh_health;
DROP VIEW IF EXISTS v_indexer_health;
DROP INDEX IF EXISTS idx_audit_event_type_created;
