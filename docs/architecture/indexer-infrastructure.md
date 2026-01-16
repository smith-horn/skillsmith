# Indexer Infrastructure Architecture

**Created**: January 12, 2026
**Updated**: January 16, 2026
**Related Issues**: SMI-628, SMI-1406, SMI-1413
**Status**: Production

**Features**: GitHub App authentication, SKILL.md validation, high-trust authors, quality gates

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

### Request Options

The indexer accepts additional configuration options via the request body:

```typescript
{
  topics?: string[]           // GitHub topics to search (default: see below)
  maxPages?: number           // Max pages per topic (default: 5)
  dryRun?: boolean            // Preview mode - no database writes
  strictValidation?: boolean  // Require YAML frontmatter (default: true)
  minContentLength?: number   // Minimum SKILL.md length (default: 100)
}
```

**Example Request**:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/indexer" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topics": ["claude-code-skill"],
    "maxPages": 3,
    "strictValidation": true,
    "minContentLength": 200
  }'
```

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
4. **Validate**: Apply quality gates (content length, frontmatter)
5. **Parse**: Extract YAML frontmatter and metadata
6. **Index**: Upsert to Supabase `skills` table
7. **Report**: Return metrics (found, indexed, failed, skipped)

## SKILL.md Validation

The indexer validates SKILL.md files before indexing to ensure quality and consistency. Validation occurs between fetch and parse stages.

### Validation Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    Fetch     │────▶│   Validate   │────▶│    Index     │
│  SKILL.md    │     │   Content    │     │  to Database │
└──────────────┘     └──────────────┘     └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │   Skip if    │
                     │   Invalid    │
                     └──────────────┘
```

### Quality Gates

Skills must pass the following quality gates to be indexed:

| Gate | Default | Description |
|------|---------|-------------|
| Content Length | 100 chars | Minimum SKILL.md file size |
| Title Present | Required | Must have H1 heading or frontmatter title |
| Frontmatter Valid | Required* | YAML frontmatter must parse without errors |

*Strict validation mode (default: enabled) requires valid frontmatter.

### Validation Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `strictValidation` | boolean | `true` | Require valid YAML frontmatter |
| `minContentLength` | number | `100` | Minimum content length in characters |

### Validation Results

Skills that fail validation are tracked in the response:

```json
{
  "found": 500,
  "indexed": 450,
  "failed": 10,
  "skipped": 40,
  "validationErrors": [
    { "repo": "user/skill-repo", "error": "Content too short (45 chars)" },
    { "repo": "org/test-skill", "error": "Invalid YAML frontmatter" }
  ]
}
```

## Validation Module

The validation logic is encapsulated in `validation.ts` with the following exports:

### parseYamlFrontmatter()

Extracts YAML frontmatter from SKILL.md content.

```typescript
function parseYamlFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
  error?: string;
}
```

**Behavior**:
- Detects `---` delimiters at start of file
- Parses YAML between delimiters
- Returns body content without frontmatter
- Returns `null` frontmatter if none present
- Returns error string if YAML is malformed

### validateSkillMdContent()

Validates SKILL.md content against quality gates.

```typescript
function validateSkillMdContent(
  content: string,
  options?: {
    strictValidation?: boolean;
    minContentLength?: number;
  }
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  metadata: {
    contentLength: number;
    hasFrontmatter: boolean;
    hasTitle: boolean;
  };
}
```

**Checks Performed**:
1. Content length meets minimum threshold
2. Title extraction (H1 heading or frontmatter `name`/`title`)
3. Frontmatter parsing (strict mode)
4. Description presence (warning if missing)

### passesQualityGate()

Quick pass/fail check for validation.

```typescript
function passesQualityGate(
  content: string,
  options?: ValidationOptions
): boolean
```

**Usage**:
```typescript
if (!passesQualityGate(skillContent, { minContentLength: 200 })) {
  console.log('Skill does not meet quality requirements');
  continue;
}
```

## High-Trust Authors

Certain organizations are designated as high-trust authors and receive automatic elevated trust tiers.

### Configured High-Trust Authors

| Organization | Trust Tier | Notes |
|--------------|------------|-------|
| `anthropics` | verified | Official Anthropic skills |
| `huggingface` | verified | HuggingFace ML skills |
| `vercel-labs` | verified | Vercel/Next.js skills |

### Trust Tier Assignment

```typescript
const HIGH_TRUST_AUTHORS = ['anthropics', 'huggingface', 'vercel-labs'];

function determineTrustTier(owner: string, hasVerifiedBadge: boolean): TrustTier {
  if (HIGH_TRUST_AUTHORS.includes(owner.toLowerCase())) {
    return 'verified';
  }
  if (hasVerifiedBadge) {
    return 'community';
  }
  return 'experimental';
}
```

### License Compliance

High-trust authors still must comply with license requirements:

| License | Indexable | Notes |
|---------|-----------|-------|
| MIT | Yes | Permissive |
| Apache-2.0 | Yes | Permissive |
| BSD-2-Clause | Yes | Permissive |
| BSD-3-Clause | Yes | Permissive |
| ISC | Yes | Permissive |
| GPL-3.0 | No | Copyleft - not indexed |
| AGPL-3.0 | No | Copyleft - not indexed |
| Unlicense | Yes | Public domain |
| No license | Warning | Indexed with warning |

### Adding High-Trust Authors

To add a new high-trust author, update the configuration in the indexer:

```typescript
// supabase/functions/indexer/config.ts
export const HIGH_TRUST_AUTHORS = [
  'anthropics',
  'huggingface',
  'vercel-labs',
  // Add new organizations here
];
```

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

### Internal Documentation
- [ADR-012: Native Module Version Management](../adr/012-native-module-version-management.md)
- [ADR-013: Open Core Licensing](../adr/013-open-core-licensing.md)
- [Code Review: GitHub App Auth](../reviews/2026-01-12-indexer-github-app-auth.md)

### Validation Module
- Source: `supabase/functions/indexer/validation.ts`
- Tests: `supabase/functions/indexer/validation.test.ts`

### External References
- [GitHub App Authentication Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Claude Code Skills Specification](https://docs.anthropic.com/claude-code/skills)
