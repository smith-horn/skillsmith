# Indexer Infrastructure Architecture

**Created**: January 12, 2026
**Related Issues**: SMI-628, SMI-1406, SMI-1413
**Status**: Production

---

## Overview

The Skillsmith Indexer discovers and indexes skills from GitHub repositories tagged with `claude-code-skill`. It runs as a Supabase Edge Function triggered by GitHub Actions on a daily schedule.

## System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                    INDEXER INFRASTRUCTURE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   GitHub     │───▶│   Supabase   │───▶│    Supabase      │  │
│  │   Actions    │    │ Edge Function│    │    Database      │  │
│  │  (Trigger)   │    │  (Indexer)   │    │    (Skills)      │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│         │                   │                                   │
│         │                   ▼                                   │
│         │            ┌──────────────┐                          │
│         │            │   GitHub     │                          │
│         └───────────▶│     API      │                          │
│                      │  (Search)    │                          │
│                      └──────────────┘                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Authentication

### GitHub App Authentication (Recommended)

The indexer uses GitHub App authentication for higher rate limits (5,000 req/hour vs 60/hour unauthenticated).

**Required Environment Variables**:

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_INSTALLATION_ID` | Installation ID for the repository |
| `GITHUB_APP_PRIVATE_KEY` | RSA private key (PEM format, may be base64-encoded) |

**Authentication Flow**:

1. Create JWT signed with RS256 using App private key
2. Exchange JWT for installation access token
3. Token cached for 55 minutes (5-minute early expiration buffer)
4. Fallback to `GITHUB_TOKEN` (PAT) if App credentials unavailable

**Key Technical Details**:

- Uses Web Crypto API for RS256 signing (no external JWT libraries)
- Handles PKCS#1 to PKCS#8 key format conversion
- Auto-detects and decodes base64-encoded PEM keys
- Normalizes newline escaping in environment variables

### Fallback: Personal Access Token

If GitHub App credentials are not configured, the indexer falls back to `GITHUB_TOKEN` (personal access token) with lower rate limits.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `GITHUB_APP_ID` | No | GitHub App ID (for higher rate limits) |
| `GITHUB_APP_INSTALLATION_ID` | No | GitHub App installation ID |
| `GITHUB_APP_PRIVATE_KEY` | No | GitHub App private key (PEM) |
| `GITHUB_TOKEN` | No | Fallback PAT if App auth unavailable |

### Workflow Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `dry_run` | `false` | Preview mode (no database writes) |
| `max_pages` | `5` | Max pages per topic (7+ causes timeout) |

### Performance Constraints

| Constraint | Value | Notes |
|------------|-------|-------|
| Edge Function timeout | 150 seconds | Supabase limit |
| Optimal max_pages | 5 | ~400 skills, ~1 minute |
| Rate limit (App auth) | 5,000/hour | GitHub App installation token |
| Rate limit (PAT) | 5,000/hour | Authenticated user |
| Rate limit (none) | 60/hour | Unauthenticated |

### Benchmarked Configurations

| max_pages | Skills Indexed | Duration | Status |
|-----------|----------------|----------|--------|
| 2 | ~226 | ~45s | PASS |
| 5 | ~402 | ~1m | PASS (recommended) |
| 7 | - | - | TIMEOUT |
| 10 | - | - | TIMEOUT |

## Indexing Process

### Topics Searched

The indexer searches GitHub for repositories with these topics:

1. `claude-code-skill` (primary)
2. `claude-code`
3. `anthropic-claude`
4. `claude-skill`

### Rate Limiting Strategy

| Operation | Delay |
|-----------|-------|
| Between SKILL.md fetches | 50ms |
| Between search API requests | 150ms |
| Installation token refresh | 55-minute cache TTL |

### Data Flow

1. **Search**: Query GitHub Search API for topics
2. **Filter**: Identify repositories with SKILL.md files
3. **Fetch**: Retrieve SKILL.md content for each repository
4. **Parse**: Extract YAML frontmatter and metadata
5. **Index**: Upsert to Supabase `skills` table
6. **Report**: Return metrics (found, indexed, failed)

## Deployment

### GitHub Actions Workflow

**File**: `.github/workflows/indexer.yml`

**Schedule**: Daily at 2:00 AM UTC

**Manual Trigger**:
```bash
gh workflow run indexer.yml -f dry_run=false -f max_pages=5
```

### GitHub Secrets Required

| Secret | Purpose |
|--------|---------|
| `SUPABASE_URL` | Edge Function endpoint |
| `SUPABASE_SERVICE_ROLE_KEY` | Database authentication |
| `GH_PAT` | Optional fallback token |

## Error Handling

### Graceful Degradation

1. **GitHub App auth fails** → Fall back to PAT
2. **PAT unavailable** → Continue with unauthenticated (60 req/hour)
3. **Individual skill fetch fails** → Log error, continue with others
4. **Rate limit hit** → Report remaining quota, stop gracefully

### Error Response Format

```json
{
  "error": "Rate limit exceeded",
  "data": {
    "found": 100,
    "indexed": 50,
    "failed": 50,
    "errors": ["Rate limit: 0 remaining"]
  }
}
```

## Monitoring

### Success Metrics

| Metric | Expected | Alert If |
|--------|----------|----------|
| Skills indexed | 300-500 | < 200 |
| Failed | < 5 | > 20 |
| Duration | < 2m | > 3m |

### GitHub Actions Summary

Each run produces a summary with:
- Found (total repositories discovered)
- Indexed (skills successfully indexed)
- Failed (skills that failed to index)
- Dry Run (whether database writes occurred)

## References

- [ADR-012: Native Module Version Management](../adr/012-native-module-version-management.md)
- [Code Review: GitHub App Auth](../reviews/2026-01-12-indexer-github-app-auth.md)
- [GitHub App Authentication Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
