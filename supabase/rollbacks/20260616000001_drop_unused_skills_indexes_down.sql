-- Rollback for 20260616000001_drop_unused_skills_indexes.sql
-- SMI-5278
--
-- !! CONCURRENTLY — DO NOT APPLY VIA `supabase db push` OR inside a txn !!
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Run each
-- statement standalone in autocommit via the pooler:
--
--   docker exec skillsmith-dev-1 varlock run -- ./scripts/pooler-psql.sh \
--     -c "<one statement>"
--
-- Recreates the 9 B-tree indexes dropped by the forward runbook step. These were
-- dead at drop time (no live WHERE/ORDER BY predicate — see forward header).
-- Recreate only if a regression shows a real query path depends on one. DDL is
-- the exact `pg_get_indexdef` captured pre-drop (2026-06-16), with CONCURRENTLY
-- + IF NOT EXISTS added. The skills table is small (~7,900 rows) so each build
-- is sub-second.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_repo_updated_at
  ON public.skills USING btree (repo_updated_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_last_scanned
  ON public.skills USING btree (last_scanned_at NULLS FIRST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_publisher
  ON public.skills USING btree (publisher);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_created_at
  ON public.skills USING btree (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_tree_hash_check
  ON public.skills USING btree (repo_url, skill_path)
  INCLUDE (tree_hash, last_tree_hash_check)
  WHERE (tree_hash IS NOT NULL);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_installable
  ON public.skills USING btree (installable)
  WHERE (installable = true);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_security_score
  ON public.skills USING btree (security_score DESC NULLS LAST)
  WHERE (security_score IS NOT NULL);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_license
  ON public.skills USING btree (license)
  WHERE (license IS NOT NULL);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_skills_source_format
  ON public.skills USING btree (source_format)
  WHERE (source_format <> 'skill-md'::text);
