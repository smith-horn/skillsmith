-- Rollback for 053_indexer_lock_table.sql
-- Removes the lock table and RPC functions.
-- Note: Does NOT restore advisory lock functions — the indexer code
-- must also be reverted to use advisory locks if rolling back.

DROP FUNCTION IF EXISTS public.release_indexer_lock(text);
DROP FUNCTION IF EXISTS public.try_indexer_lock(text);
DROP TABLE IF EXISTS indexer_lock;

DELETE FROM schema_version WHERE version = 53;
