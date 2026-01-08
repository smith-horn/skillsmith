# Wave 1: Infrastructure Setup (CLI Automated)

**Issue:** SMI-1179 - Deploy Supabase project for skill registry
**Est. Tokens:** ~15K
**Prerequisites:** Wave 0 complete (`.env.registry` exists with `SUPABASE_ACCESS_TOKEN`)

---

## Current Status (Updated January 8, 2026)

### ✅ Wave 0 Infrastructure Complete

| Component | Status | Details |
|-----------|--------|---------|
| Supabase Project | ✅ Created | `skillsmith-registry` (ID: `vrcnzpmndtroqxxoqkzy`) |
| Supabase CLI | ✅ Installed | In Docker container (`skillsmith-dev-1`) |
| Supabase Link | ✅ Connected | Linked to remote project |
| Vercel CLI | ✅ Installed | Authenticated (org: smithhorngroup) |
| PostHog SDK | ✅ Configured | `POSTHOG_KEY` in `.env` |
| Custom Domain | ✅ Live | `api.skillsmith.app` via Vercel proxy |

### ✅ Credentials Stored

- `.env.registry` - Supabase project credentials (Varlock secured)
- `.env` - PostHog, Vercel tokens

### ⏳ Wave 1 Remaining Tasks

- [ ] Create database migration file
- [ ] Deploy schema via `supabase db push`
- [ ] Verify table creation

---

## Objective

Create the Supabase project and database schema using the Supabase CLI, fully automated with Varlock security.

## Wave 0: Manual Prerequisites (Human - 10 min) ✅ COMPLETE

Only TWO manual steps required:

### 1. Generate Supabase Access Token
1. Go to [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
2. Click "Generate New Token"
3. Name it "skillsmith-cli"
4. Copy the token (starts with `sbp_`)

### 2. Create `.env.registry`
```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

cat > .env.registry << 'EOF'
# Supabase CLI Authentication
SUPABASE_ACCESS_TOKEN=sbp_your_token_here

# Will be auto-populated by CLI
SUPABASE_PROJECT_REF=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_PASSWORD=
EOF

# Set secure permissions
chmod 600 .env.registry
```

### 3. Validate Token
```bash
varlock load --env-file .env.registry
# Should show SUPABASE_ACCESS_TOKEN=sbp_***
```

---

## IMPORTANT: Varlock Security

**NEVER expose secrets to terminal or Claude's context!**

### Safe Commands (Use These)
```bash
# Validate environment (masked output)
varlock load --env-file .env.registry

# Run Supabase CLI with token injected
varlock run --env-file .env.registry -- supabase projects list
varlock run --env-file .env.registry -- supabase db push
```

### Unsafe Commands (NEVER Use)
```bash
# NEVER do these - exposes secrets to Claude's context
cat .env.registry                    # Exposes all secrets
echo $SUPABASE_ACCESS_TOKEN          # Exposes to terminal
supabase projects api-keys           # Prints keys to stdout
```

---

## Wave 1 Tasks (Claude Automated)

### Task 1: Verify CLI Authentication

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Test CLI authentication (uses access token)
varlock run --env-file .env.registry -- supabase projects list
```

Expected: List of existing projects (may be empty)

### Task 2: Create Supabase Project

```bash
# Create project with CLI
# Organization ID can be found at: supabase.com/dashboard/org/_/settings
varlock run --env-file .env.registry -- supabase projects create skillsmith-registry \
  --org-id "your-org-id" \
  --db-password "$(openssl rand -base64 24)" \
  --region us-west-1

# Note: The CLI will output the project ref - capture it
```

**Alternative if org-id unknown:**
```bash
# List organizations first
varlock run --env-file .env.registry -- supabase orgs list
```

### Task 3: Capture Project Credentials

After project creation, retrieve and store credentials:

```bash
# Get project ref from creation output, then:
PROJECT_REF="<from-creation-output>"

# Retrieve API keys (these will be printed - redirect to file)
varlock run --env-file .env.registry -- supabase projects api-keys --project-ref $PROJECT_REF > /tmp/keys.tmp

# Parse and append to .env.registry (script does this safely)
# The keys file contains anon and service_role keys
```

**Safer approach - use a script:**
```bash
cat > /tmp/capture-keys.sh << 'SCRIPT'
#!/bin/bash
set -e
PROJECT_REF=$1
KEYS=$(supabase projects api-keys --project-ref $PROJECT_REF 2>/dev/null)
ANON=$(echo "$KEYS" | grep "anon" | awk '{print $NF}')
SERVICE=$(echo "$KEYS" | grep "service_role" | awk '{print $NF}')
echo "SUPABASE_PROJECT_REF=$PROJECT_REF"
echo "SUPABASE_URL=https://$PROJECT_REF.supabase.co"
echo "SUPABASE_ANON_KEY=$ANON"
echo "SUPABASE_SERVICE_ROLE_KEY=$SERVICE"
SCRIPT
chmod +x /tmp/capture-keys.sh

# Run with varlock (output goes to file, not terminal)
varlock run --env-file .env.registry -- /tmp/capture-keys.sh $PROJECT_REF >> .env.registry
```

### Task 4: Initialize Supabase Locally

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Initialize supabase directory structure
supabase init --with-intellij-settings=false

# Link to remote project
varlock run --env-file .env.registry -- sh -c 'supabase link --project-ref $SUPABASE_PROJECT_REF'
```

### Task 5: Create Migration File

```bash
mkdir -p supabase/migrations

cat > supabase/migrations/001_initial_schema.sql << 'SQL'
-- Skills Registry Schema
-- Phase 6A: Supabase PostgreSQL

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Skills table
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,  -- format: author/name
  name TEXT NOT NULL,
  description TEXT,
  author TEXT,
  repository_url TEXT,
  category TEXT,
  trust_tier TEXT DEFAULT 'unknown' CHECK (trust_tier IN ('verified', 'community', 'experimental', 'unknown')),
  quality_score INTEGER DEFAULT 0 CHECK (quality_score >= 0 AND quality_score <= 100),
  install_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Full-text search vector (auto-generated)
ALTER TABLE skills ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(author, '')), 'C')
  ) STORED;

-- Indexes
CREATE INDEX IF NOT EXISTS skills_search_idx ON skills USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS skills_category_idx ON skills (category);
CREATE INDEX IF NOT EXISTS skills_trust_tier_idx ON skills (trust_tier);
CREATE INDEX IF NOT EXISTS skills_quality_score_idx ON skills (quality_score DESC);
CREATE INDEX IF NOT EXISTS skills_author_idx ON skills (author);

-- Enable Row Level Security
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Allow anonymous read access (public registry)
CREATE POLICY "Public read access" ON skills
  FOR SELECT
  USING (true);

-- Allow service role full access (for indexer and admin)
CREATE POLICY "Service role full access" ON skills
  FOR ALL
  USING (auth.role() = 'service_role');

-- Updated at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER skills_updated_at
  BEFORE UPDATE ON skills
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Telemetry events table (for PostHog backup)
CREATE TABLE IF NOT EXISTS telemetry_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_name TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  properties JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS for telemetry (insert only, no read)
ALTER TABLE telemetry_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Insert only for telemetry" ON telemetry_events
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role read telemetry" ON telemetry_events
  FOR SELECT
  USING (auth.role() = 'service_role');
SQL
```

### Task 6: Deploy Schema

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Push migration to remote database
varlock run --env-file .env.registry -- supabase db push

# Verify deployment
varlock run --env-file .env.registry -- supabase db diff
```

### Task 7: Verify Deployment

```bash
# Test query via API (uses anon key, safe to show)
varlock run --env-file .env.registry -- sh -c '
curl -s "https://$SUPABASE_PROJECT_REF.supabase.co/rest/v1/skills?select=count" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY"
'
# Expected: [{"count":0}] or similar empty result
```

---

## Supabase Config File

Create `supabase/config.toml`:

```bash
cat > supabase/config.toml << 'TOML'
[api]
enabled = true
port = 54321
schemas = ["public"]
extra_search_path = ["public"]
max_rows = 1000

[db]
port = 54322
major_version = 15

[studio]
enabled = true
port = 54323

[auth]
enabled = false  # Not using Supabase Auth for Phase 6A

[storage]
enabled = false  # Not using Supabase Storage for Phase 6A

[edge_runtime]
enabled = true
TOML
```

---

## Files Created

| File | Purpose |
|------|---------|
| `supabase/config.toml` | Local Supabase configuration |
| `supabase/migrations/001_initial_schema.sql` | PostgreSQL schema with RLS |
| `.env.registry` | Supabase credentials (Varlock secured) |

---

## Acceptance Criteria

- [x] Supabase project created via CLI ✅ (Jan 8)
- [x] `.env.registry` populated with all credentials ✅ (Jan 8)
- [x] `varlock load --env-file .env.registry` validates successfully ✅ (Jan 8)
- [ ] Migration file creates skills table with all columns
- [ ] RLS policy allows anonymous SELECT
- [ ] Full-text search index created
- [ ] Schema deployed via `supabase db push`
- [ ] Empty table query returns successfully

---

## On Completion

1. Mark SMI-1179 as Done:
   ```bash
   npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done 1179
   ```

2. Verify Gate: `supabase db push` succeeded with no errors

3. Proceed to Wave 2 (Migration)

---

## Troubleshooting

### Supabase CLI Not Found
```bash
npm i -g supabase
```

### Access Token Invalid
```bash
# Regenerate at supabase.com/dashboard/account/tokens
# Update .env.registry with new token
```

### Project Creation Fails
```bash
# Check organization membership
varlock run --env-file .env.registry -- supabase orgs list

# May need to create org first or use existing one
```

### Migration Fails
```bash
# Check migration syntax locally
supabase db lint

# View detailed error
varlock run --env-file .env.registry -- supabase db push --debug
```
