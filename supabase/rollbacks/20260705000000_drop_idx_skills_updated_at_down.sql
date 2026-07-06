-- Rollback for 20260705000000_drop_idx_skills_updated_at.sql
-- SMI-5550
--
-- !! CONCURRENTLY -- DO NOT APPLY VIA `supabase db push` OR inside a txn !!
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Run the
-- statement standalone in autocommit via the pooler (host tool -- the script
-- itself execs psql in the dev container):
--
--   varlock run -- ./scripts/pooler-psql.sh -c "<one statement>"
--
-- Recreates the B-tree index dropped by the forward runbook step. It was
-- dead at drop time (idx_scan=0, idx_tup_read=0 since the 2026-05-21 stats
-- reset -- see forward header) and was KEPT by SMI-5278 on a mistaken
-- consumer trace that this change corrects. Recreate only if a regression
-- shows a real query path now depends on it -- note that recreating it
-- re-defeats HOT for all skills UPDATEs (the reason it was dropped). DDL is
-- the exact `pg_get_indexdef` captured pre-drop (2026-07-04), with
-- CONCURRENTLY + IF NOT EXISTS added. The skills table has ~180,246 live
-- rows (Step 0 measurement) so the build takes seconds.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_updated_at
  ON public.skills USING btree (updated_at DESC);
