# Supabase Migration Safety

Operational playbook for applying migrations to staging and prod Supabase without triggering lock cascades, silent failures, or drift between environments.

**When this guide applies** — any migration that:

- Creates, drops, or alters an RLS policy
- Alters a column type or constraint on a table with active writes
- Touches any table with edge-function write traffic (`audit_logs`, `skills`, `audit_events`, `team_members`, etc.)
- Runs on a Sunday or during the indexer cron windows (`00/06/12/18 UTC`)

For simple additions (new table, new index with `CONCURRENTLY`, function definition that doesn't affect existing queries), the full playbook is overkill — but the apply command (pooler + `--db-url`) still applies.

**Cross-references**

- [Standards — Database](../../docs/internal/architecture/standards-database.md) — RLS patterns, SECURITY DEFINER helpers, test fixtures
- [Standards — Security §4.11](../../docs/internal/architecture/standards-security.md) — secret handling during apply
- [ADR-109](../../docs/internal/adr/109-sparc-plan-review-for-infra-changes.md) — when migration plans require SPARC + plan-review
- [Skill — supabase-migration-reviewer](../skills/supabase-migration-reviewer/SKILL.md) — automated pre-apply review

---

## The three risk classes

### R-Lock — `ACCESS EXCLUSIVE` cascade

**What**: `CREATE POLICY`, `DROP POLICY`, `ALTER TABLE` (most forms), and `CREATE TRIGGER` take `ACCESS EXCLUSIVE` on the target table. Every concurrent reader AND writer blocks until the migration transaction commits.

**What doesn't help**:

- **`service_role` does NOT bypass the lock** — it bypasses RLS *semantics*, not table-level locks. Every stripe-webhook / events / indexer / ops-report / skills-refresh-metadata INSERT still blocks.
- **Session-mode pooler (port 5432) doesn't help either** — same lock semantics at the DB level.

**Cascade shape**: stripe-webhook INSERT blocks → edge function hits 150s timeout → Stripe retries webhook → retry requeues behind same lock → compounding queue.

**Fix**: always set `lock_timeout` inside the transaction. Three seconds is the floor for policy DDL (metadata-only, completes in <500ms on a healthy instance); go higher only for data-rewriting statements.

### R-Silent — `IF EXISTS` drift

**What**: `DROP POLICY IF EXISTS "exact name" ON table` silently no-ops when the policy name has drifted (extra space, wrong casing, unexpected quoting from a past hotfix). The `CREATE POLICY` then runs successfully, producing a **passing migration that did nothing** — both the old policy and the new policy are live, OR semantics apply, original behavior unchanged.

**How it happens**: a past hotfix created the policy via the Supabase dashboard UI or a one-off psql session with slightly different quoting. The dashboard sometimes mangles quote styles; psql with `SHOW standard_conforming_strings = off` rewrites quotes on insert.

**Fix**: **always verify the exact policy name on the live DB before writing the `DROP`** (query in §Pre-apply below). Copy-paste the result verbatim — don't trust the name inferred from the original migration file.

### R-Timing — cron edges + continuous writers

**What**: cron-scheduled edge functions fire at `00/06/12/18 UTC` (indexer), `:30 past each hour` (metadata refresh), `03:00 daily` (expire-complimentary), `09:00 Mondays` (ops-report + billing monitor + analytics + A/B results). `events` is continuously hot from CLI/VS Code telemetry. `stripe-webhook` is low-volume but retry-sensitive.

**Fix**: apply during the quietest window — **Sunday 03:00–05:00 UTC** is ideal (after Saturday indexer run at 00, before Monday morning crons). If urgency forces a weekday apply, hit the gap between hourly `:30` metadata refreshes.

---

## Mandatory template

Every migration touching RLS / policies / triggers / on-write tables **must** match this skeleton:

```sql
-- Migration NNN: <summary> (SMI-xxxx)
-- <1-2 sentence "why" — what breaks without this migration>
--
-- Safety class:
--   R-Lock: <yes/no — does this DDL take ACCESS EXCLUSIVE?>
--   R-Silent: <yes/no — does this DROP something by name?>
--   R-Timing: <any required apply window>
--
-- Prerequisites:
--   - Migration XXX — <what it provides>
--   - Helper function Y — <signature>

BEGIN;

-- Fail fast if a concurrent query holds a lock OR if the DDL itself hangs.
-- Tune to your statement: 3s / 10s for policy DDL (metadata-only).
-- Larger ALTER TABLE operations rewriting data need bigger headroom.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

-- <DDL statements>

COMMIT;

-- Rollback (copy/paste if this migration needs to be reverted under incident):
--   BEGIN;
--   <reverse DDL — do NOT omit this block>
--   COMMIT;
--
-- WARNING: <what reverting this restores — if it re-opens a known bug, say so>
```

The rollback block is non-negotiable — an on-call operator under incident pressure should not have to reconstruct the reverse SQL from older migrations. See migration 074, 075, 077a for reference.

---

## Pre-apply verification (run against the target environment)

Run these **before** `supabase db push`. If any fail, stop and triage — do not proceed.

```sql
-- 1. R-Silent guard: confirm the exact policy name on the live DB
--    Replace the WHERE clause with the table you're touching.
SELECT polname,
       pg_get_expr(polqual, polrelid) AS using_clause,
       pg_get_expr(polwithcheck, polrelid) AS with_check_clause
  FROM pg_policy
 WHERE polrelid = 'audit_logs'::regclass
 ORDER BY polname;
-- Copy the polname verbatim into your DROP POLICY IF EXISTS statement.

-- 2. Prerequisite migrations applied
SELECT version FROM supabase_migrations.schema_migrations
 WHERE version IN ('071','072','074','075','077')
 ORDER BY version;
-- Expect all listed prerequisites present.

-- 3. Helper function signatures
SELECT proname, pg_get_function_identity_arguments(oid) AS args,
       prosecdef AS is_security_definer,
       proconfig AS search_path_config
  FROM pg_proc WHERE proname IN ('user_team_ids','user_admin_team_ids');
-- Expect: SECURITY DEFINER = t, proconfig includes 'search_path=public, pg_temp'.

-- 4. R-Lock holders: current long-running queries on the target table
SELECT pid, state, age(now(), query_start) AS run_time,
       left(query, 100) AS query_preview
  FROM pg_stat_activity
 WHERE query ILIKE '%<target-table>%'
   AND state = 'active'
   AND pid <> pg_backend_pid()
 ORDER BY query_start;
-- Expect empty. If not empty, wait or investigate the long-running query.

-- 5. R-Lock blast radius: write rate over last 5 minutes
SELECT count(*) AS writes_5min,
       count(*) * 12 AS estimated_writes_per_hour
  FROM <target-table>
 WHERE created_at > now() - interval '5 minutes';
-- If >500 writes/hour on the table, defer to a quieter window.

-- 6. Confirm no other migration is being applied concurrently
SELECT pid, state, query_start, left(query, 80)
  FROM pg_stat_activity
 WHERE query ILIKE '%schema_migrations%' AND state = 'active'
   AND pid <> pg_backend_pid();
-- Expect empty.
```

Document the output of each query in the Linear ticket comment before running `supabase db push`.

---

## Apply command

**Hard rules** (known burn history, each item maps to a past incident):

- Use session-mode pooler: host `aws-1-us-east-1.pooler.supabase.com`, port **`5432`** (NEVER `6543` — transaction mode, breaks prepared statements on migration apply, SMI-4299).
- Use `--db-url` with explicit connection string. **NEVER `--linked`** — that flag silently reads `supabase/.temp/linked-project.json` which may point to the wrong ref, SMI-4305.
- Inject secrets via `varlock run --` — never `cat .env` or `echo $SUPABASE_DB_PASSWORD`.
- Verify the URL's project ref matches your target environment. `vrcnzpmndtroqxxoqkzy` = prod. `ovhcifugwqnzoebwfuku` = staging. Confusing these burned a session in April 2026 (SMI-4252).

```bash
# Staging
varlock run -- sh -c 'npx supabase db push \
  --db-url "postgresql://postgres.ovhcifugwqnzoebwfuku:$SUPABASE_DB_PASSWORD_STAGING@aws-1-us-east-1.pooler.supabase.com:5432/postgres"'

# Prod (only after 24h staging soak)
varlock run -- sh -c 'npx supabase db push \
  --db-url "postgresql://postgres.vrcnzpmndtroqxxoqkzy:$SUPABASE_DB_PASSWORD@aws-1-us-east-1.pooler.supabase.com:5432/postgres"'
```

If the migration times out at `lock_timeout` (`55P03`), it rolls back cleanly. Re-run during a quieter window — don't loosen the timeout.

---

## Post-apply verification

Run **immediately after** apply. Catches R-Silent drift (both old and new policies present).

```sql
-- Confirm the old policy is gone and the new one is present
SELECT polname, pg_get_expr(polqual, polrelid) AS using_clause
  FROM pg_policy
 WHERE polrelid = '<target-table>'::regclass
 ORDER BY polname;
-- Expect: ONLY the new policy. If both old + new present → R-Silent fired → rollback.

-- Confirm the migration registered
SELECT version, name, statements[1]
  FROM supabase_migrations.schema_migrations
 ORDER BY inserted_at DESC
 LIMIT 3;
-- Expect the new version at the top.

-- Smoke test with an authenticated JWT (not service_role):
--   Use a test user in your own team. They should see:
--   - Their own actor rows OR their team's rows
--   - NOT other teams' rows
-- Use the Supabase dashboard SQL editor with 'authenticated' role impersonation.
```

---

## Rollout phases

1. **Staging apply** → verify → **24h soak** (minimum, non-negotiable).
2. **Monitor staging** during soak: edge-function logs in Supabase dashboard, alert emails to `support@smithhorn.ca`, `audit_logs` write-rate delta.
3. **Prod apply** → verify → monitor for 1 hour continuous, then 24h casual.
4. If prod verification fails → **rollback immediately** via the inline block. Don't hesitate or debug in place.

---

## Failure modes

| Symptom | Probable cause | Remediation |
|---|---|---|
| `supabase db push` hangs >30s | R-Lock holder not caught in pre-apply; `lock_timeout` missing | Kill the apply, re-run pre-apply §4, wait or investigate holder |
| `ERROR: canceling statement due to lock timeout` | `lock_timeout` fired — migration rolled back cleanly | Re-run during a quieter window; don't loosen the timeout |
| `ERROR: canceling statement due to statement timeout` | `statement_timeout` too tight for an unexpectedly slow statement (usually a backfill or constraint re-validation) | Bump `statement_timeout` only if the slow statement is justified; if not, split into a separate migration |
| Migration reports success but behavior unchanged | R-Silent fired — old policy still present under drifted name | Run post-apply §1 query; if two policies present, rollback + regenerate migration with correct DROP name |
| `supabase db push` succeeds on one env but not another | Migration drift between envs; `schema_migrations` table desync | Run pre-apply §2 on both envs; register missing migrations manually (`INSERT INTO supabase_migrations.schema_migrations`) |
| Edge functions time out after apply | Lock held too long; retry storm in flight | Check `pg_stat_activity` for waiters; if cleared, apply is fine — edge functions will self-heal over 5-10 minutes |
| Prepared-statement cache returns stale plans | Normal — supabase-js in edge functions re-plans over 1-2 queries | No action; self-corrects in <1 minute |

---

## Related incidents (read before your first apply)

- **SMI-4252** (April 2026) — wasted 7 minutes curling staging while deploying to prod. Always verify the ref.
- **SMI-4305** — `supabase db push --linked` silently overrode `$SUPABASE_DB_URL` to a stale ref from `supabase/.temp/linked-project.json`.
- **SMI-4299** — port 6543 (transaction mode) fails mid-push on prepared-statement conflict. Always use 5432 (session mode) for migrations.
- **SMI-4306** — `team_members` inline subquery in RLS caused recursion at query time. Fixed via `user_team_ids()` SECURITY DEFINER helper (migration 071) + consolidation (migration 074).
- **SMI-4353** — `audit_logs` had `USING (true)` on authenticated role for ~2 years — every team's audit trail was readable by every authenticated user in production. The policy-audit check in pre-apply §1 would have caught this earlier.

---

## When in doubt

Invoke the [`supabase-migration-reviewer`](../skills/supabase-migration-reviewer/SKILL.md) skill — it automates the pre-apply review and produces a `HIGH / MEDIUM / LOW` findings report before you touch `supabase db push`.
