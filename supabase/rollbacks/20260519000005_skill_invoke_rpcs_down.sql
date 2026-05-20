-- SMI-5013 W1.S1 rollback: skill-invocation telemetry foundations
-- Inverts 20260519000005_skill_invoke_rpcs.sql:
--   1. Drops three analytics RPCs (CASCADE — no known dependents at apply
--      time, but CASCADE matches the convention for analytics RPCs).
--   2. Drops `user_telemetry_self_rw` RLS policy.
--   3. Drops `public.user_telemetry_preferences` table.

DROP FUNCTION IF EXISTS public.analytics_skill_cooccurrence(UUID, INT) CASCADE;
DROP FUNCTION IF EXISTS public.analytics_skill_stale(UUID, INT, INT) CASCADE;
DROP FUNCTION IF EXISTS public.analytics_skill_top(UUID, INT) CASCADE;

DROP POLICY IF EXISTS user_telemetry_self_rw ON public.user_telemetry_preferences;

DROP TABLE IF EXISTS public.user_telemetry_preferences;
