# SMI-1179: Supabase Schema Deployment Guide

## Quick Deploy via Dashboard (Recommended)

1. Open the Supabase SQL Editor:
   https://supabase.com/dashboard/project/vrcnzpmndtroqxxoqkzy/sql/new

2. Copy the entire contents of `supabase/migrations/001_initial_schema.sql`

3. Paste into the SQL Editor and click "Run"

4. Verify tables were created:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public';
   ```

## Alternative: CLI with Database Password

If you have the database password:

```bash
# Set the password (get from Dashboard → Settings → Database)
export SUPABASE_DB_PASSWORD="your-password-here"

# Run the migration
cd skillsmith
supabase db push --linked
```

## Verify Deployment

After running the migration, verify:

```sql
-- Check tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

-- Expected tables:
-- audit_logs, cache, categories, schema_version,
-- skill_categories, skills, sources

-- Check RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public';

-- Check full-text search works
SELECT * FROM search_skills('testing', 10, 0);

-- Insert a test skill
INSERT INTO skills (name, description, author, trust_tier)
VALUES ('test-skill', 'A test skill', 'test-author', 'experimental');

-- Verify it's searchable
SELECT * FROM skills WHERE name = 'test-skill';

-- Clean up test data
DELETE FROM skills WHERE name = 'test-skill';
```

## Environment Variables

After deployment, ensure these are set in `.env`:

```bash
SUPABASE_PROJECT_REF=vrcnzpmndtroqxxoqkzy
SUPABASE_URL=https://vrcnzpmndtroqxxoqkzy.supabase.co
SUPABASE_ANON_KEY=<from Dashboard → Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<from Dashboard → Settings → API>
```

## Troubleshooting

### "relation already exists" errors
These are safe to ignore - the schema uses `IF NOT EXISTS` clauses.

### "permission denied" errors
Ensure you're using the service_role key for admin operations.

### Full-text search not working
The `search_vector` column is auto-generated. If issues persist:
```sql
-- Regenerate search vectors
UPDATE skills SET updated_at = NOW();
```

## Schema Overview

| Table | Description |
|-------|-------------|
| `skills` | Main skill registry with FTS |
| `sources` | Discovery sources (GitHub, etc.) |
| `categories` | Hierarchical skill categories |
| `skill_categories` | Junction table |
| `cache` | API response cache |
| `audit_logs` | Security audit trail |
| `schema_version` | Migration tracking |

## RLS Policies

- **skills**: Public read, authenticated write
- **sources**: Public read only
- **categories**: Public read only
- **cache**: Public read only
- **audit_logs**: Authenticated read only
