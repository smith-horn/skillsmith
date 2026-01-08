# Phase 6A Implementation Plan: Critical Path to Live

**Date:** January 7, 2026
**Infrastructure:** Supabase + Vercel
**Execution Model:** Sequential waves with Claude Code swarms

---

## Overview

This plan organizes Phase 6A into 6 waves that can be executed in separate terminal sessions. Each wave is designed to fit within a single context window and operate independently once prerequisites are met.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     PHASE 6A EXECUTION WAVES                         │
├─────────────────────────────────────────────────────────────────────┤
│  Wave 0: Manual Prerequisites (Human)           ~30 min            │
│     └── API keys, CLI installs, account setup                       │
├─────────────────────────────────────────────────────────────────────┤
│  Wave 1: Infrastructure Setup (Claude)          ~15K tokens         │
│     └── SMI-1179: Supabase project + schema                         │
├─────────────────────────────────────────────────────────────────────┤
│  Wave 2: Database Migration (Claude)            ~25K tokens         │
│     └── SMI-1181: Migrate 9,717 skills to Supabase                  │
├─────────────────────────────────────────────────────────────────────┤
│  Wave 3: API Development (Claude)               ~50K tokens         │
│     └── SMI-1180: Create Edge Functions for API                     │
├─────────────────────────────────────────────────────────────────────┤
│  Wave 4: Integration (Claude)                   ~40K tokens         │
│     └── SMI-1182 + SMI-1183: Domain + npm packages                  │
├─────────────────────────────────────────────────────────────────────┤
│  Wave 5: Observability (Claude)                 ~30K tokens         │
│     └── SMI-1184 + SMI-1185: Telemetry + Indexer                    │
├─────────────────────────────────────────────────────────────────────┤
│  Wave 6: Release (Claude)                       ~15K tokens         │
│     └── SMI-1186: Version bump + publish v0.2.0                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Token Estimates

| Wave | Issues | Est. Tokens | Context % | Parallel Agents |
|------|--------|-------------|-----------|-----------------|
| 0 | Manual | N/A | N/A | Human |
| 1 | SMI-1179 | ~15K | 15% | 1 (infra) |
| 2 | SMI-1181 | ~25K | 25% | 2 (db-migration, validator) |
| 3 | SMI-1180 | ~50K | 50% | 3 (api-dev, tester, reviewer) |
| 4 | SMI-1182, SMI-1183 | ~40K | 40% | 2 (infra, npm-integrator) |
| 5 | SMI-1184, SMI-1185 | ~30K | 30% | 2 (telemetry, indexer) |
| 6 | SMI-1186 | ~15K | 15% | 1 (release) |

**Total Estimated Tokens:** ~175K (across 6 Claude sessions)

---

## Wave 0: Manual Prerequisites

**Executor:** Human
**Duration:** ~30 minutes
**Purpose:** Set up accounts and gather credentials before automation

### Checklist

#### 1. Supabase Setup
- [ ] Create account at [supabase.com](https://supabase.com)
- [ ] Create new project named `skillsmith-registry`
- [ ] Note the following credentials:
  - [ ] `SUPABASE_URL` (Project URL)
  - [ ] `SUPABASE_ANON_KEY` (anon/public key)
  - [ ] `SUPABASE_SERVICE_ROLE_KEY` (service_role key - keep secret)
  - [ ] `SUPABASE_DB_URL` (Connection string → URI)

#### 2. Vercel Setup
- [ ] Create account at [vercel.com](https://vercel.com) (if not exists)
- [ ] Install Vercel CLI: `npm i -g vercel`
- [ ] Login: `vercel login`
- [ ] Note: `VERCEL_TOKEN` (Settings → Tokens)

#### 3. PostHog Setup (Telemetry)
- [ ] Create account at [posthog.com](https://posthog.com)
- [ ] Create new project named `skillsmith`
- [ ] Note: `POSTHOG_API_KEY` (Project API Key)
- [ ] Note: `POSTHOG_HOST` (usually `https://app.posthog.com`)

#### 4. Supabase CLI
- [ ] Install: `npm i -g supabase`
- [ ] Login: `supabase login`

#### 5. Domain Configuration (Cloudflare/DNS)
- [x] Add CNAME record: `api.skillsmith.app` → `cname.vercel-dns.com` (Proxy ON)
- [x] Vercel API proxy deployed at `apps/api-proxy/`
- [x] See [ADR-016](/skillsmith/docs/adr/016-vercel-api-proxy.md) for architecture decision
- Note: Using Vercel proxy instead of Supabase custom domains ($0 vs $10/mo)

#### 6. Environment File
Create `/skillsmith/.env.phase6a`:
```bash
# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_DB_URL=postgresql://postgres:xxxxx@db.xxxxx.supabase.co:5432/postgres

# Vercel
VERCEL_TOKEN=xxxxx

# PostHog
POSTHOG_API_KEY=phc_xxxxx
POSTHOG_HOST=https://app.posthog.com

# GitHub (for indexer)
GITHUB_TOKEN=ghp_xxxxx
```

### Verification
```bash
# Test Supabase connection
supabase projects list

# Test Vercel
vercel whoami

# Test PostHog (optional)
curl -X POST $POSTHOG_HOST/capture/ \
  -H "Content-Type: application/json" \
  -d '{"api_key": "'$POSTHOG_API_KEY'", "event": "test", "distinct_id": "test"}'
```

---

## Wave 1: Infrastructure Setup

**Issue:** SMI-1179
**Est. Tokens:** ~15K
**Agents:** 1 (infrastructure specialist)

### Swarm Prompt

```
Execute SMI-1179: Deploy Supabase project for skill registry

## Context
Phase 6A is deploying Skillsmith to production with Supabase + Vercel.
The Supabase project has been created manually (Wave 0).
Environment variables are in /skillsmith/.env.phase6a

## Tasks
1. Read the existing SQLite schema from @skillsmith/core
2. Create a Supabase migration file with the PostgreSQL equivalent
3. Configure Row Level Security (RLS) for public read access
4. Create indexes for full-text search
5. Test the schema deployment with Supabase CLI

## Files to Read
- /skillsmith/packages/core/src/db/schema.ts
- /skillsmith/packages/core/src/repositories/*.ts

## Files to Create
- /skillsmith/supabase/migrations/001_initial_schema.sql
- /skillsmith/supabase/config.toml

## Acceptance Criteria
- [ ] Migration file creates skills table with all columns
- [ ] RLS policy allows anonymous SELECT
- [ ] Full-text search index on name + description
- [ ] Migration runs successfully via `supabase db push`

## Commands to Run
```bash
cd /skillsmith
supabase init  # if not exists
supabase link --project-ref <project-id>
supabase db push
```

Mark SMI-1179 as Done when complete.
```

### Agent Configuration

```javascript
// Wave 1 - Single infrastructure agent
{
  agent: "infrastructure-specialist",
  capabilities: ["database", "supabase", "sql", "migrations"],
  tools: ["Read", "Write", "Bash", "Grep"],
  context_files: [
    "/skillsmith/packages/core/src/db/schema.ts",
    "/skillsmith/.env.phase6a"
  ]
}
```

---

## Wave 2: Database Migration

**Issue:** SMI-1181
**Est. Tokens:** ~25K
**Agents:** 2 (db-migration, validator)

### Swarm Prompt

```
Execute SMI-1181: Migrate skills database to Supabase

## Context
Wave 1 created the Supabase schema. Now we need to migrate the 9,717 skills
from the local SQLite database to Supabase PostgreSQL.

## Tasks
1. Export skills from SQLite to JSON/CSV
2. Transform data for PostgreSQL compatibility (if needed)
3. Batch insert into Supabase (handle rate limits)
4. Verify row counts match
5. Test sample queries

## Agent Roles

### Agent 1: db-migration
- Export SQLite data
- Write migration script
- Execute batch inserts

### Agent 2: validator
- Verify row counts
- Run sample queries
- Check data integrity

## Files to Read
- /skillsmith/packages/core/src/db/schema.ts
- /skillsmith/packages/core/src/repositories/SkillRepository.ts
- /skillsmith/supabase/migrations/001_initial_schema.sql

## Files to Create
- /skillsmith/scripts/migrate-to-supabase.ts
- /skillsmith/scripts/validate-migration.ts

## Data Location
SQLite database: ~/.skillsmith/skills.db (or SKILLSMITH_DB_PATH)

## Acceptance Criteria
- [ ] All 9,717 skills migrated
- [ ] No data loss (compare source vs target counts)
- [ ] Sample queries return expected results
- [ ] Quality scores preserved
- [ ] Trust tiers preserved

## Commands
```bash
# Export
npx tsx /skillsmith/scripts/migrate-to-supabase.ts

# Validate
npx tsx /skillsmith/scripts/validate-migration.ts
```

Mark SMI-1181 as Done when complete.
```

### Agent Configuration

```javascript
// Wave 2 - Migration agents
[
  {
    agent: "db-migration",
    capabilities: ["sqlite", "postgresql", "data-migration", "typescript"],
    tools: ["Read", "Write", "Bash", "Grep"],
    primary: true
  },
  {
    agent: "validator",
    capabilities: ["sql", "data-validation", "testing"],
    tools: ["Read", "Bash"],
    role: "verify migration results"
  }
]
```

---

## Wave 3: API Development

**Issue:** SMI-1180
**Est. Tokens:** ~50K
**Agents:** 3 (api-dev, tester, reviewer)

### Swarm Prompt

```
Execute SMI-1180: Create skill registry API endpoints

## Context
Database is migrated to Supabase (Wave 2). Now create the API layer
using Supabase Edge Functions.

## API Endpoints Required

### GET /v1/skills/search
```typescript
Query: { query: string, category?: string, trust_tier?: string, limit?: number }
Response: Skill[]
```

### GET /v1/skills/:id
```typescript
Params: { id: string }
Response: Skill | { error: string }
```

### POST /v1/skills/recommend
```typescript
Body: { stack: string[], project_type?: string }
Response: Skill[]
```

### POST /v1/events (telemetry)
```typescript
Body: { event: string, skill_id?: string, anonymous_id: string }
Response: { ok: boolean }
```

## Agent Roles

### Agent 1: api-dev (primary)
- Create Edge Functions structure
- Implement all endpoints
- Add error handling and validation
- Configure CORS

### Agent 2: tester
- Write integration tests
- Test each endpoint
- Verify error cases

### Agent 3: reviewer
- Review code quality
- Check security (no SQL injection)
- Verify CORS configuration

## Files to Create
- /skillsmith/supabase/functions/skills-search/index.ts
- /skillsmith/supabase/functions/skills-get/index.ts
- /skillsmith/supabase/functions/skills-recommend/index.ts
- /skillsmith/supabase/functions/events/index.ts
- /skillsmith/supabase/functions/_shared/cors.ts
- /skillsmith/supabase/functions/_shared/supabase.ts
- /skillsmith/tests/api/integration.test.ts

## Acceptance Criteria
- [ ] All 4 endpoints functional
- [ ] CORS allows requests from any origin
- [ ] Error responses are JSON with appropriate status codes
- [ ] Rate limiting headers present
- [ ] Integration tests pass

## Commands
```bash
# Deploy functions
supabase functions deploy skills-search
supabase functions deploy skills-get
supabase functions deploy skills-recommend
supabase functions deploy events

# Test locally
supabase functions serve

# Run tests
npm test -- --grep "API"
```

Mark SMI-1180 as Done when complete.
```

### Agent Configuration

```javascript
// Wave 3 - API development team
[
  {
    agent: "api-dev",
    capabilities: ["typescript", "deno", "supabase-edge", "rest-api"],
    tools: ["Read", "Write", "Bash", "Grep", "Edit"],
    primary: true
  },
  {
    agent: "tester",
    capabilities: ["testing", "integration-tests", "api-testing"],
    tools: ["Read", "Write", "Bash"],
    role: "write and run tests"
  },
  {
    agent: "reviewer",
    capabilities: ["code-review", "security", "best-practices"],
    tools: ["Read", "Grep"],
    role: "review code quality and security"
  }
]
```

---

## Wave 4: Integration

**Issues:** SMI-1182, SMI-1183
**Est. Tokens:** ~40K
**Agents:** 2 (infra, npm-integrator)

### Swarm Prompt

```
Execute SMI-1182 and SMI-1183: Domain configuration and npm package integration

## Context
API endpoints are deployed (Wave 3). Now configure the custom domain
and update npm packages to use the live API.

## Tasks

### SMI-1182: Configure api.skillsmith.app
1. ~~Configure custom domain in Supabase dashboard~~ → Using Vercel API proxy (see ADR-016)
2. Deploy `apps/api-proxy/` to Vercel with rewrites to Supabase
3. Configure DNS CNAME: `api` → `cname.vercel-dns.com` (Proxy ON)
4. Verify SSL certificate is provisioned via Vercel
5. Test API access via custom domain: `curl https://api.skillsmith.app/health`

### SMI-1183: Update npm packages
1. Add API client module to @skillsmith/core
2. Configure API_BASE_URL with fallback
3. Implement caching layer (24h TTL)
4. Update MCP server to use API client
5. Add offline fallback to local data

## Agent Roles

### Agent 1: infra
- Deploy Vercel API proxy (`apps/api-proxy/`)
- Configure custom domain in Vercel
- Update DNS documentation
- Verify SSL and connectivity via Vercel

### Agent 2: npm-integrator
- Create API client in @skillsmith/core
- Update @skillsmith/mcp-server
- Add caching and error handling
- Update types if needed

## Files to Create/Modify
- /skillsmith/packages/core/src/api/client.ts (new)
- /skillsmith/packages/core/src/api/cache.ts (new)
- /skillsmith/packages/core/src/api/types.ts (new)
- /skillsmith/packages/core/src/index.ts (export API client)
- /skillsmith/packages/mcp-server/src/context.ts (use API)
- /skillsmith/packages/mcp-server/src/tools/*.ts (update to use API)

## Environment Variables
```
SKILLSMITH_API_URL=https://api.skillsmith.app (default)
SKILLSMITH_OFFLINE_MODE=false (fallback to local)
```

## Acceptance Criteria
- [ ] api.skillsmith.app resolves and returns API responses
- [ ] SSL certificate valid
- [ ] npm packages use live API by default
- [ ] Offline fallback works when API unavailable
- [ ] Cache reduces API calls

## Commands
```bash
# Test health endpoint
curl https://api.skillsmith.app/health

# Test Supabase proxy
curl https://api.skillsmith.app/rest/v1/skills?select=count -H "apikey: $SUPABASE_ANON_KEY"

# Build packages
npm run build -w @skillsmith/core
npm run build -w @skillsmith/mcp-server

# Test integration
npm test
```

Mark SMI-1182 and SMI-1183 as Done when complete.
```

### Agent Configuration

```javascript
// Wave 4 - Integration team
[
  {
    agent: "infra",
    capabilities: ["dns", "ssl", "supabase", "domains"],
    tools: ["Bash", "WebFetch"],
    role: "domain configuration"
  },
  {
    agent: "npm-integrator",
    capabilities: ["typescript", "npm", "api-clients", "caching"],
    tools: ["Read", "Write", "Edit", "Bash", "Grep"],
    primary: true
  }
]
```

---

## Wave 5: Observability

**Issues:** SMI-1184, SMI-1185
**Est. Tokens:** ~30K
**Agents:** 2 (telemetry, indexer)

### Swarm Prompt

```
Execute SMI-1184 and SMI-1185: Telemetry and GitHub indexer

## Context
npm packages are integrated with live API (Wave 4). Now add telemetry
for validation metrics and deploy the GitHub indexer.

## Tasks

### SMI-1184: Add basic telemetry with PostHog
1. Create telemetry module in @skillsmith/core
2. Implement opt-out mechanism (SKILLSMITH_TELEMETRY=false)
3. Track events: search, view_skill, install_skill, uninstall_skill, error
4. Generate anonymous user ID (no PII)
5. Document what data is collected

### SMI-1185: Deploy GitHub indexer
1. Create Supabase Edge Function or GitHub Action for indexer
2. Configure daily schedule (cron)
3. Handle rate limits gracefully
4. Log indexing results
5. Update existing skills, add new ones

## Agent Roles

### Agent 1: telemetry
- Create PostHog integration
- Implement opt-out
- Add to npm packages
- Document privacy approach

### Agent 2: indexer
- Deploy indexer as scheduled job
- Configure GitHub API integration
- Handle incremental updates

## Files to Create/Modify

### Telemetry
- /skillsmith/packages/core/src/telemetry/posthog.ts (new)
- /skillsmith/packages/core/src/telemetry/events.ts (new)
- /skillsmith/packages/core/src/telemetry/index.ts (new)
- /skillsmith/packages/core/src/index.ts (export telemetry)
- /skillsmith/packages/mcp-server/src/tools/*.ts (add telemetry calls)
- /skillsmith/docs/PRIVACY.md (document data collection)

### Indexer
- /skillsmith/.github/workflows/daily-index.yml (new)
- /skillsmith/scripts/scheduled-index.ts (new)

## Environment Variables
```
SKILLSMITH_TELEMETRY=true (default, set false to disable)
POSTHOG_API_KEY=phc_xxxxx
POSTHOG_HOST=https://app.posthog.com
```

## Acceptance Criteria
- [ ] Telemetry events sent to PostHog
- [ ] Opt-out works via environment variable
- [ ] No PII collected (verify in PostHog dashboard)
- [ ] Indexer runs on schedule
- [ ] New skills added, existing skills updated

## Commands
```bash
# Test telemetry
POSTHOG_API_KEY=xxx npm test -- --grep "telemetry"

# Test indexer manually
npx tsx /skillsmith/scripts/scheduled-index.ts --dry-run

# Deploy indexer workflow
git add .github/workflows/daily-index.yml
git commit -m "Add daily indexer workflow"
git push
```

Mark SMI-1184 and SMI-1185 as Done when complete.
```

### Agent Configuration

```javascript
// Wave 5 - Observability team
[
  {
    agent: "telemetry",
    capabilities: ["posthog", "analytics", "privacy", "typescript"],
    tools: ["Read", "Write", "Edit", "Bash"],
    primary: true
  },
  {
    agent: "indexer",
    capabilities: ["github-api", "cron", "data-sync"],
    tools: ["Read", "Write", "Bash"],
    role: "deploy scheduled indexer"
  }
]
```

---

## Wave 6: Release

**Issue:** SMI-1186
**Est. Tokens:** ~15K
**Agents:** 1 (release-manager)

### Swarm Prompt

```
Execute SMI-1186: Publish v0.2.0 to npm with live API

## Context
All infrastructure is deployed (Waves 1-5). Now bump versions,
update documentation, and publish v0.2.0.

## Tasks
1. Bump version to 0.2.0 in all packages
2. Update CHANGELOG with live API feature
3. Update READMEs with new usage (live API)
4. Run full test suite
5. Create git tag v0.2.0
6. Trigger npm publish workflow
7. Verify packages published successfully
8. Smoke test: install from npm and search

## Pre-Publish Checklist
- [ ] All tests passing
- [ ] API endpoints responding
- [ ] Telemetry verified in PostHog
- [ ] Documentation updated

## Files to Modify
- /skillsmith/packages/core/package.json (version)
- /skillsmith/packages/core/src/index.ts (VERSION constant)
- /skillsmith/packages/mcp-server/package.json (version)
- /skillsmith/packages/mcp-server/src/index.ts (version)
- /skillsmith/packages/cli/package.json (version)
- /skillsmith/packages/cli/src/index.ts (CLI_VERSION)
- /skillsmith/CHANGELOG.md (add v0.2.0 section)
- /skillsmith/packages/*/README.md (update for live API)

## Acceptance Criteria
- [ ] Version 0.2.0 in all packages
- [ ] CHANGELOG documents live API feature
- [ ] npm publish workflow succeeds
- [ ] Packages visible on npmjs.com
- [ ] Smoke test passes from clean install

## Commands
```bash
# Verify tests
cd /skillsmith && npm test

# Create and push tag
git add -A
git commit -m "chore: bump version to 0.2.0 for live API release"
git tag v0.2.0
git push origin main --tags

# Monitor workflow
gh run watch

# Smoke test
npm create vite@latest test-skillsmith -- --template vanilla
cd test-skillsmith
npm i @skillsmith/mcp-server
npx skillsmith search testing
```

Mark SMI-1186 as Done when complete.
Update Linear with project update for Phase 6A completion.
```

### Agent Configuration

```javascript
// Wave 6 - Release manager
{
  agent: "release-manager",
  capabilities: ["npm", "versioning", "git", "documentation"],
  tools: ["Read", "Write", "Edit", "Bash", "Grep"],
  primary: true
}
```

---

## Execution Commands

### Start Each Wave

```bash
# Wave 0: Manual (no command - follow checklist above)

# Wave 1: Infrastructure
claude --prompt "$(cat /docs/implementation/wave-1-prompt.md)"

# Wave 2: Migration
claude --prompt "$(cat /docs/implementation/wave-2-prompt.md)"

# Wave 3: API Development
claude --prompt "$(cat /docs/implementation/wave-3-prompt.md)"

# Wave 4: Integration
claude --prompt "$(cat /docs/implementation/wave-4-prompt.md)"

# Wave 5: Observability
claude --prompt "$(cat /docs/implementation/wave-5-prompt.md)"

# Wave 6: Release
claude --prompt "$(cat /docs/implementation/wave-6-prompt.md)"
```

### Quick Reference

| Wave | Command | Est. Time | Dependencies |
|------|---------|-----------|--------------|
| 0 | Manual | 30 min | None |
| 1 | `wave-1-prompt.md` | 15 min | Wave 0 complete |
| 2 | `wave-2-prompt.md` | 30 min | Wave 1 complete |
| 3 | `wave-3-prompt.md` | 60 min | Wave 2 complete |
| 4 | `wave-4-prompt.md` | 45 min | Wave 3 complete |
| 5 | `wave-5-prompt.md` | 30 min | Wave 4 complete |
| 6 | `wave-6-prompt.md` | 20 min | Wave 5 complete |

**Total Estimated Time:** ~4 hours

---

## Rollback Plan

If any wave fails:

1. **Wave 1 (Schema):** Delete Supabase project, recreate
2. **Wave 2 (Migration):** Truncate tables, re-run migration
3. **Wave 3 (API):** `supabase functions delete <name>`, redeploy
4. **Wave 4 (Integration):** Revert npm package changes, keep local mode
5. **Wave 5 (Telemetry):** Disable telemetry env var, remove workflow
6. **Wave 6 (Release):** Delete git tag, unpublish npm (within 72h)

---

## Success Criteria

### Wave-Level Gates

| Wave | Gate Criteria |
|------|---------------|
| 1 | `supabase db push` succeeds |
| 2 | Row count matches (9,717) |
| 3 | All endpoints return 200 |
| 4 | api.skillsmith.app responds |
| 5 | Events visible in PostHog |
| 6 | npm packages published |

### Final Validation

```bash
# Install fresh
npm i @skillsmith/mcp-server@0.2.0

# Test search
npx skillsmith search "testing"
# Expected: Returns skills from live API

# Verify in PostHog
# Expected: search event visible
```

---

## Linear Issue Updates

After each wave, update Linear:

```bash
# Mark issues done
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done SMI-1179
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done SMI-1180
# ... etc

# Create project update
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts create-project-update \
  "Skillsmith Phase 6A: Critical Path to Live" \
  "Wave X complete. [Details]"
```

---

## Appendix: File Structure After Phase 6A

```
/skillsmith
├── supabase/
│   ├── config.toml
│   ├── functions/
│   │   ├── skills-search/index.ts
│   │   ├── skills-get/index.ts
│   │   ├── skills-recommend/index.ts
│   │   ├── events/index.ts
│   │   └── _shared/
│   │       ├── cors.ts
│   │       └── supabase.ts
│   └── migrations/
│       └── 001_initial_schema.sql
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── api/
│   │       │   ├── client.ts
│   │       │   ├── cache.ts
│   │       │   └── types.ts
│   │       └── telemetry/
│   │           ├── posthog.ts
│   │           ├── events.ts
│   │           └── index.ts
│   ├── mcp-server/
│   │   └── src/
│   │       └── (updated to use API)
│   └── cli/
│       └── src/
│           └── (updated to use API)
├── scripts/
│   ├── migrate-to-supabase.ts
│   ├── validate-migration.ts
│   └── scheduled-index.ts
├── .github/
│   └── workflows/
│       ├── publish.yml (existing)
│       └── daily-index.yml (new)
├── .env.phase6a
├── CHANGELOG.md
└── docs/
    └── PRIVACY.md
```
