# Migration Review Checklist

**Version**: 1.0
**Status**: Active
**Reference**: [Engineering Standards](../architecture/standards.md)

---

## Instructions

Use this checklist to review database migrations before deployment. This ensures safety, idempotency, and maintainability of schema changes.

1. Copy this template to your review notes
2. Fill in each section as you review
3. Run the Quick Validation Commands
4. Get sign-off before deploying to production

---

## Migration Info

### File Information

**File name**: `NNN_description.sql`

**SMI reference**: SMI-XXXX

**Reviewer**: _______________

**Review date**: _______________

### Purpose

<!-- Brief description of what this migration does -->



---

## Pre-Review Checks

### Naming & Documentation

- [ ] File naming follows `NNN_description.sql` format
- [ ] Header includes SMI reference (e.g., `-- SMI-1234: Description`)
- [ ] Header includes creation date (e.g., `-- Created: 2026-01-29`)
- [ ] Purpose clearly documented in header comments
- [ ] Migration number (NNN) is sequential and unique

### File Structure

- [ ] Sections clearly separated with comment blocks
- [ ] Each section has a descriptive header
- [ ] Complex logic includes inline comments
- [ ] Schema version updated at end of file

---

## Idempotency Checks

### ALTER Operations

- [ ] All `ALTER TABLE` operations wrapped in `DO $$` blocks
- [ ] Uses `IF EXISTS` checks before modifications
- [ ] Uses `IF NOT EXISTS` for additions
- [ ] Exception handling present for expected failures

**Example pattern:**
```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'my_table') THEN
    ALTER TABLE my_table ADD COLUMN IF NOT EXISTS new_col TEXT;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not add column: %', SQLERRM;
END $$;
```

### INSERT/UPDATE Operations

- [ ] Uses `ON CONFLICT` clauses for upsert patterns
- [ ] Uses `INSERT ... ON CONFLICT DO NOTHING` where appropriate
- [ ] Conditional updates check for existing data

### DROP Operations

- [ ] Uses `DROP ... IF EXISTS` for all drop statements
- [ ] Cascade effects explicitly documented
- [ ] Dependent objects handled appropriately

### Loop Operations

- [ ] Exception handling in `FOR ... LOOP` blocks
- [ ] Transaction behavior documented
- [ ] Failure handling doesn't break entire migration

---

## Security Checks

### Function Security

- [ ] All functions have explicit `SET search_path` configuration
- [ ] `SECURITY DEFINER` usage justified and documented
- [ ] `SECURITY INVOKER` used for views (PG 15+)
- [ ] Function permissions (GRANT/REVOKE) explicitly defined

**Expected pattern:**
```sql
CREATE OR REPLACE FUNCTION my_func()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
BEGIN
  -- function body
END $$;
```

### Row Level Security (RLS)

- [ ] RLS implications documented for affected tables
- [ ] RLS policies reviewed for security holes
- [ ] Service role policies explicitly created where needed
- [ ] Public access implications considered

### Permissions & Access

- [ ] `GRANT` statements reviewed for appropriate roles
- [ ] `REVOKE` statements don't break existing functionality
- [ ] Public schema access controlled appropriately
- [ ] Anonymous access justified and documented

### Data Safety

- [ ] No hardcoded secrets or API keys
- [ ] Sensitive data handling documented
- [ ] Encryption requirements considered
- [ ] PII handling complies with requirements

---

## Impact Analysis

### Breaking Changes

- [ ] Breaking changes clearly identified and documented
- [ ] Impact on existing queries documented
- [ ] API compatibility assessed
- [ ] Application code changes required (if any) listed

### CASCADE Effects

- [ ] All `CASCADE` operations documented
- [ ] Affected dependent objects listed
- [ ] Foreign key constraints impact assessed
- [ ] Trigger implications considered

### Dependent Objects

**List objects that depend on changes:**

| Object Type | Object Name | Impact |
|-------------|-------------|--------|
| View | `v_example` | Needs recreation |
| Function | `get_data()` | May need update |
| Trigger | `trg_audit` | Check compatibility |

### Performance Impact

- [ ] Query performance impact assessed
- [ ] Index changes reviewed
- [ ] Lock duration estimated
- [ ] Migration runtime estimated
- [ ] High-traffic tables identified
- [ ] Downtime requirements documented

---

## Verification Checks

### Verification Queries

- [ ] Verification queries included in migration
- [ ] Success criteria clearly defined
- [ ] Row count checks for data migrations
- [ ] Constraint validation queries included

**Example pattern:**
```sql
DO $$
DECLARE
  result_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO result_count FROM my_table WHERE condition;
  IF result_count = 0 THEN
    RAISE WARNING 'Expected data not found';
  ELSE
    RAISE NOTICE 'Verification passed: % rows', result_count;
  END IF;
END $$;
```

### Schema Version

- [ ] Schema version update present
- [ ] Version number correct and sequential
- [ ] Uses `ON CONFLICT DO NOTHING` pattern

```sql
INSERT INTO schema_version (version) VALUES (NNN) ON CONFLICT DO NOTHING;
```

### Testing Checklist

- [ ] Tested on local development database
- [ ] Tested with empty database (greenfield)
- [ ] Tested with existing data (migration scenario)
- [ ] Re-run tested for idempotency
- [ ] Rollback tested (if applicable)

---

## Rollback Readiness

### Rollback Script

- [ ] Rollback section present in migration file or separate file
- [ ] Rollback operations documented
- [ ] Rollback tested locally
- [ ] Data preservation strategy documented

**Rollback file location**: `supabase/rollbacks/NNN_description_down.sql`

### Data Backup Strategy

- [ ] Backup requirements identified
- [ ] Critical data backup plan documented
- [ ] Point-in-time recovery considerations documented
- [ ] Large table backup strategy defined

### Rollback Safety

- [ ] Rollback won't cause data loss
- [ ] Dependent objects handled in rollback
- [ ] Rollback order documented for multi-step migrations
- [ ] Emergency rollback procedure documented

---

## Quick Validation Commands

Run these queries in `psql` to validate the migration:

### Check for Functions Without search_path

```sql
SELECT
  p.oid::regprocedure AS function_sig,
  p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND (p.proconfig IS NULL OR NOT (
    p.proconfig::text[] @> ARRAY['search_path=public']
    OR p.proconfig::text[] @> ARRAY['search_path=public, extensions']
  ))
ORDER BY p.proname;
```

### Check for Tables Without RLS

```sql
SELECT
  schemaname,
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND rowsecurity = false
ORDER BY tablename;
```

### Check for SECURITY DEFINER Views

```sql
SELECT
  viewname,
  definition
FROM pg_views
WHERE schemaname = 'public'
  AND definition ILIKE '%security definer%';
```

### List Policies on Table

```sql
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE tablename = 'your_table_name';
```

### Check Schema Version

```sql
SELECT version, created_at
FROM schema_version
ORDER BY version DESC
LIMIT 5;
```

### Verify Migration Idempotency

```sql
-- Run the migration twice and verify:
-- 1. No errors on second run
-- 2. Same result in both runs
-- 3. Schema version only inserted once
```

---

## Additional Review Notes

### Risks Identified

<!-- List any risks or concerns found during review -->

| Risk | Severity | Mitigation |
|------|----------|------------|
| Example risk | High/Medium/Low | Mitigation strategy |

### Questions for Author

<!-- Questions that need clarification -->

1.
2.
3.

### Recommendations

<!-- Suggestions for improvement -->

-
-
-

---

## Sign-off

| Role | Name | Date | Approved |
|------|------|------|----------|
| Migration Author | | | ☐ |
| Code Reviewer | | | ☐ |
| Security Reviewer | | | ☐ |
| DBA (if required) | | | ☐ |

---

## Related Documents

- [Engineering Standards](../architecture/standards.md)
- [Migration Examples](../../supabase/migrations/)
- [ADR-012: Native Module Version Management](../adr/012-native-module-version-management.md)

---

*Template version 1.0 - For migration best practices, see existing migrations in `supabase/migrations/` directory*
