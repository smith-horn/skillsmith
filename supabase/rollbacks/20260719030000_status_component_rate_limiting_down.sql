-- Rollback for 20260719030000_status_component_rate_limiting.sql
-- SMI-5768
--
-- Removes the 'rate-limiting' status_components row. Cascades (ON DELETE
-- CASCADE, migration 20260719010000_status_page_schema.sql) to any
-- status_checks/status_daily_rollups rows already accumulated for this
-- component — that history is permanently lost, same tradeoff as the other
-- 6 components' rollback would carry.
--
-- Safe to run standalone via:
--   docker exec skillsmith-dev-1 varlock run -- ./scripts/pooler-psql.sh -f supabase/rollbacks/20260719030000_status_component_rate_limiting_down.sql

DELETE FROM status_components WHERE slug = 'rate-limiting';
