# Updating the Skills Database

**Created**: January 14, 2026
**Related**: [Indexer Infrastructure Architecture](../architecture/indexer-infrastructure.md)

---

## Overview

The Skillsmith skills database can be updated through two methods:
1. **Automated** - GitHub Actions runs daily at 2:00 AM UTC
2. **Manual** - CLI scripts for on-demand updates

This guide covers the manual update process.

## Prerequisites

- Docker container running: `docker compose --profile dev up -d`
- GitHub credentials configured in `.env` (via Varlock)

## Quick Start

```bash
# 1. Get current skill count
docker exec skillsmith-dev-1 npx tsx -e "
import Database from 'better-sqlite3';
const db = new Database('data/phase-5-full-import/skills.db');
console.log('Current count:', db.prepare('SELECT COUNT(*) as c FROM skills').get().c);
db.close();
"

# 2. Run GitHub import (uses GITHUB_TOKEN from .env)
varlock run -- sh -c 'docker exec \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  skillsmith-dev-1 npx tsx packages/core/src/scripts/import-github-skills.ts'

# 3. Import to database
docker exec skillsmith-dev-1 npx tsx packages/core/src/scripts/import-to-database.ts \
  data/imported-skills.json \
  --db data/skills-$(date +%Y%m%d).db
```

## Detailed Pipeline

### Step 1: Search GitHub

The import script searches GitHub using 4 queries:

| Query | Description |
|-------|-------------|
| `topic:claude-skill` | Primary skill topic |
| `topic:mcp-server` | MCP server implementations |
| `filename:SKILL.md` | Repositories with SKILL.md |
| `topic:anthropic-skills` | Anthropic-related skills |

**Command:**
```bash
docker exec skillsmith-dev-1 npx tsx packages/core/src/scripts/import-github-skills.ts
```

**Options:**
- `--resume` - Resume from last checkpoint (if interrupted)
- Output: `data/imported-skills.json`

### Step 2: Import to Database

```bash
docker exec skillsmith-dev-1 npx tsx packages/core/src/scripts/import-to-database.ts \
  data/imported-skills.json \
  --db <output-path>
```

**Options:**
- First argument: Input JSON file (default: `./validated-skills.json`)
- `--db <path>`: Output database path

### Step 3: Verify Import

```bash
# Check record count
docker exec skillsmith-dev-1 npx tsx -e "
import Database from 'better-sqlite3';
const db = new Database('data/skills-YYYYMMDD.db');
console.log('Skills:', db.prepare('SELECT COUNT(*) as c FROM skills').get().c);
console.log('FTS entries:', db.prepare('SELECT COUNT(*) as c FROM skills_fts').get().c);
db.close();
"
```

## Authentication

### GitHub App (Recommended)
Higher rate limits (5,000 req/hour). Configure in `.env`:
```
GITHUB_APP_ID=...
GITHUB_APP_INSTALLATION_ID=...
GITHUB_APP_PRIVATE_KEY=...
```

### Personal Access Token
Also 5,000 req/hour when authenticated:
```
GITHUB_TOKEN=ghp_...
```

### Unauthenticated
Limited to 60 req/hour. Sufficient for small updates but may hit rate limits.

## Rate Limiting

The import script handles rate limiting automatically:
- 150ms delay between API requests
- 500ms delay between search queries
- Exponential backoff on 429 responses
- Checkpoint saves allow resuming interrupted imports

## Comparing Databases

To find truly new skills between databases:

```bash
docker exec skillsmith-dev-1 npx tsx -e "
import Database from 'better-sqlite3';

const existingDb = new Database('data/phase-5-full-import/skills.db');
const newDb = new Database('data/skills-new.db');

const existingUrls = new Set(
  existingDb.prepare('SELECT repo_url FROM skills WHERE repo_url IS NOT NULL')
    .all().map((r: any) => r.repo_url?.toLowerCase())
);

const newSkills = newDb.prepare('SELECT repo_url FROM skills').all() as any[];
const newCount = newSkills.filter(s => !existingUrls.has(s.repo_url?.toLowerCase())).length;

console.log('Existing:', existingUrls.size);
console.log('In new import:', newSkills.length);
console.log('Truly new:', newCount);

existingDb.close();
newDb.close();
"
```

## Automated Updates (GitHub Actions)

The indexer runs daily via `.github/workflows/indexer.yml`.

**Manual trigger:**
```bash
gh workflow run indexer.yml -f dry_run=false -f max_pages=5
```

**View status:**
```bash
gh run list --workflow=indexer.yml
```

## Troubleshooting

### Rate limit exhausted
Wait for reset (shown in output) or use `--resume` after reset.

### Schema mismatch
Create a new database instead of importing to an existing one with an older schema.

### No GITHUB_TOKEN warning
Ensure Varlock is loading credentials:
```bash
varlock load  # Should show GITHUB_TOKEN (masked)
```

## References

- [Indexer Infrastructure Architecture](../architecture/indexer-infrastructure.md)
- [ADR-012: Native Module Version Management](../adr/012-native-module-version-management.md)
- [GitHub API Rate Limiting](https://docs.github.com/en/rest/rate-limit)
