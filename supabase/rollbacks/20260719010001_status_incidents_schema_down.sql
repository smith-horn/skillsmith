-- Rollback for 20260719010001_status_incidents_schema.sql
-- SMI-5751
--
-- Drops the incidents lifecycle schema (incidents, incident_components,
-- incident_updates) and the status-sync trigger/function.
-- DATA LOSS: any incidents declared since Wave 3 (SMI-5753) shipped are
-- permanently lost. Take a backup first if this has been live for any
-- meaningful period.
--
-- Safe to run standalone via:
--   docker exec skillsmith-dev-1 varlock run -- ./scripts/pooler-psql.sh -f supabase/rollbacks/20260719010001_status_incidents_schema_down.sql

BEGIN;

DROP TRIGGER IF EXISTS trigger_incidents_sync_status ON incident_updates;
DROP FUNCTION IF EXISTS sync_incident_status_from_update();
DROP TABLE IF EXISTS incident_updates;
DROP TABLE IF EXISTS incident_components;
DROP TABLE IF EXISTS incidents;

COMMIT;
