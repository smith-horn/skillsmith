# ADR-019: SKILL.md Content Validation for GitHub Indexer

**Status**: Accepted
**Date**: 2026-01-16
**Deciders**: Skillsmith Team
**Related Issues**: SMI-1491, SMI-1493, SMI-1496

## Context

The Skillsmith registry had accumulated approximately 5,800 indexed skills from GitHub repositories, but user experience revealed a significant quality problem: only 50-100 of these skills were actually installable. This disparity led to user frustration when the `install_skill` tool failed on skills that appeared in search results.

### Root Cause Analysis

1. **Seed data contamination**: Many indexed entries were from early development seed data, not real skills
2. **Missing SKILL.md files**: Repositories were indexed based on directory structure alone, without validating actual skill content
3. **Empty or stub files**: Some SKILL.md files existed but contained no meaningful content
4. **No quality gates**: The indexer accepted any repository matching the pattern without content validation

### Impact

- Users encountered frequent installation failures (SMI-1491)
- Search results included unusable skills, eroding trust in the platform
- Support burden increased from users reporting "broken" skills
- The skill count metric was misleading (5,800 indexed vs ~100 usable)

## Decision

Implement content validation in the GitHub indexer with configurable quality gates before adding skills to the registry.

### Validation Rules

#### 1. Content Existence (Required)

The SKILL.md file must contain actual content, not be empty or whitespace-only:

```typescript
function validateContentExists(content: string): ValidationResult {
  if (!content || content.trim().length === 0) {
    return { valid: false, reason: 'SKILL.md is empty' };
  }
  return { valid: true };
}
```

#### 2. Minimum Length (Configurable)

Content must meet a minimum character threshold to ensure meaningful documentation:

```typescript
const DEFAULT_MIN_LENGTH = 100;

function validateMinLength(content: string, minLength: number): ValidationResult {
  if (content.trim().length < minLength) {
    return {
      valid: false,
      reason: `SKILL.md too short (${content.trim().length} < ${minLength} chars)`
    };
  }
  return { valid: true };
}
```

#### 3. Title Presence (Required)

SKILL.md must contain at least one markdown heading to indicate proper structure:

```typescript
function validateTitlePresence(content: string): ValidationResult {
  if (!/^#\s+.+/m.test(content)) {
    return { valid: false, reason: 'SKILL.md missing markdown title (# heading)' };
  }
  return { valid: true };
}
```

#### 4. Frontmatter Validation (Strict Mode)

When `strictValidation` is enabled, YAML frontmatter must include required fields:

```typescript
function validateFrontmatter(content: string): ValidationResult {
  const frontmatter = parseFrontmatter(content);

  if (!frontmatter) {
    return { valid: false, reason: 'Missing YAML frontmatter' };
  }

  if (!frontmatter.name) {
    return { valid: false, reason: 'Frontmatter missing required "name" field' };
  }

  if (!frontmatter.description || frontmatter.description.length < 20) {
    return {
      valid: false,
      reason: 'Frontmatter "description" missing or too short (min 20 chars)'
    };
  }

  return { valid: true };
}
```

### Configuration Options

The indexer accepts validation options in the request body:

```typescript
interface IndexerOptions {
  /** Enable strict frontmatter validation (default: false) */
  strictValidation?: boolean;

  /** Minimum content length in characters (default: 100) */
  minContentLength?: number;

  /** Skip validation entirely for trusted sources (default: false) */
  skipValidation?: boolean;
}
```

### Validation Pipeline

```
GitHub Repository
       │
       ▼
┌──────────────────┐
│ Fetch SKILL.md   │
│ via GitHub API   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Content Exists?  │──No──▶ Skip (log warning)
└────────┬─────────┘
         │ Yes
         ▼
┌──────────────────┐
│ Min Length Met?  │──No──▶ Skip (log warning)
└────────┬─────────┘
         │ Yes
         ▼
┌──────────────────┐
│ Title Present?   │──No──▶ Skip (log warning)
└────────┬─────────┘
         │ Yes
         ▼
┌──────────────────┐
│ Strict Mode?     │──No──▶ Index Skill
└────────┬─────────┘
         │ Yes
         ▼
┌──────────────────┐
│ Valid Frontmatter│──No──▶ Skip (log warning)
└────────┬─────────┘
         │ Yes
         ▼
    Index Skill
```

## Consequences

### Positive

- **Higher install success rate**: Only skills with valid content are indexed
- **Improved user experience**: Search results reflect actually usable skills
- **Clear quality criteria**: Skill authors understand requirements for inclusion
- **Better metadata**: Frontmatter extraction improves search relevance and display
- **Reduced support burden**: Fewer reports of "broken" skills
- **Accurate metrics**: Skill count reflects reality

### Negative

- **Reduced total skill count**: Quality over quantity trade-off
- **Some valid skills excluded**: Skills without frontmatter may be excluded in strict mode
- **Additional API calls**: Must fetch SKILL.md content, not just check existence
- **Rate limiting concerns**: More API calls per repository indexed
- **Historical skills affected**: Existing entries remain until re-indexed

### Neutral

- **Configurable validation**: Flexibility to adjust strictness per use case
- **Backward compatible**: Existing clients unaffected; validation is server-side
- **Gradual rollout**: Can enable strict mode incrementally

## Alternatives Considered

### Alternative 1: No Validation (Status Quo)

Continue indexing all repositories matching the skill directory pattern.

- **Pros**: Maximum skill count, no additional API calls
- **Cons**: Poor user experience, misleading metrics, support burden
- **Why rejected**: User frustration from failed installations outweighed quantity benefits

### Alternative 2: Strict-Only Validation

Require full frontmatter validation for all indexed skills.

- **Pros**: Highest quality guarantee, consistent metadata
- **Cons**: Too restrictive for community skills, many valid skills excluded
- **Why rejected**: Would exclude legitimate community contributions without frontmatter

### Alternative 3: Client-Side Validation

Validate SKILL.md content at installation time rather than indexing time.

- **Pros**: No changes to indexer, immediate feedback to users
- **Cons**: Doesn't solve search pollution, wastes user time, still shows unusable skills
- **Why rejected**: Fails to address the core problem of search result quality

### Alternative 4: Manual Curation

Human review of each skill before indexing.

- **Pros**: Highest quality assurance, catches edge cases
- **Cons**: Doesn't scale, delays indexing, requires ongoing human effort
- **Why rejected**: Not sustainable for open community contributions

## Implementation

### Files Modified

| File | Purpose |
|------|---------|
| `supabase/functions/indexer/validation.ts` | Validation module with all validation functions |
| `supabase/functions/indexer/index.ts` | Integration of validation into indexing pipeline |
| `supabase/functions/indexer/types.ts` | TypeScript interfaces for validation options |

### Example Usage

```bash
# Standard validation (content + length + title)
curl -X POST https://api.skillsmith.dev/functions/v1/indexer \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d '{"owner": "anthropics", "repo": "claude-code-skills"}'

# Strict validation (includes frontmatter)
curl -X POST https://api.skillsmith.dev/functions/v1/indexer \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d '{
    "owner": "anthropics",
    "repo": "claude-code-skills",
    "strictValidation": true
  }'

# Custom minimum length
curl -X POST https://api.skillsmith.dev/functions/v1/indexer \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d '{
    "owner": "anthropics",
    "repo": "claude-code-skills",
    "minContentLength": 200
  }'
```

### Migration Plan

1. Deploy validation module to staging
2. Run indexer against known-good skills to verify no false negatives
3. Run indexer against known-bad skills to verify detection
4. Deploy to production with `strictValidation: false` (default)
5. Monitor validation rejection rates and reasons
6. Gradually increase `minContentLength` based on data
7. Consider enabling `strictValidation` for verified tier only

## References

- [SMI-1491: install_skill format resolution](https://linear.app/smith-horn-group/issue/SMI-1491)
- [SMI-1493: Skill Marketplace Quality Curation Initiative](https://linear.app/smith-horn-group/issue/SMI-1493)
- [SMI-1496: Indexer Enhancement](https://linear.app/smith-horn-group/issue/SMI-1496)
- [Indexer Infrastructure Architecture](../architecture/indexer-infrastructure.md)
- [ADR-013: Open Core Licensing](013-open-core-licensing.md)

## Changelog

| Date | Change |
|------|--------|
| 2026-01-16 | Initial decision documenting SKILL.md validation architecture |
