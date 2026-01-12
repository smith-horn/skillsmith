# Phase 4.5: Large-Scale Performance Testing Plan

**Date**: December 31, 2025
**Status**: Planning
**Goal**: Validate Skillsmith performance and edge cases with 400-4000 skills before Phase 5
**Security**: All execution in Docker on GitHub Codespaces (never local)

---

## Executive Summary

Before proceeding to Phase 5, we need to stress-test Skillsmith with a realistic dataset. Currently we have 15 skills. This phase expands to 400-4000 skills from multiple sources, all tested in isolated Docker containers on GitHub Codespaces to mitigate security risks from untrusted skill code.

**Key Constraints**:
- **NO local execution** - All skills run only in Codespaces Docker containers
- **Security isolation** - Skills may contain malicious code; never execute locally
- **Performance validation** - Must meet latency targets at scale
- **Edge case coverage** - Test malformed, large, and adversarial skill definitions

---

## 1. Data Sources (Identified from Research)

### Primary Sources

| Source | Est. Skills | Method | Priority | Rate Limit |
|--------|-------------|--------|----------|------------|
| **GitHub API** | 500-2000 | REST API search | P0 | 5K/hr with token |
| **SkillsMP.com** | 25,000+ | API/Scraping | P1 | Respectful rate |
| **claude-plugins.dev** | 8,400+ | API | P1 | 10 req/min |
| **MCP Registry** | 10,000+ | REST API | P2 | TBD |
| **Awesome Lists** | 100-500 | GitHub raw files | P2 | Standard GitHub |

### GitHub API Search Queries

```bash
# Primary skill discovery queries
topic:claude-skill           # ~200-500 repos
topic:mcp-server             # ~1000+ repos
filename:SKILL.md            # ~300-800 files
topic:anthropic-skills       # ~50-100 repos
topic:claude-code            # ~200-400 repos
topic:claude-plugin          # ~100-200 repos
```

### Source Priority Strategy

**Target: 400-4000 skills**

| Tier | Source | Target Count | Rationale |
|------|--------|--------------|-----------|
| Tier 1 | GitHub SKILL.md files | 300-500 | Official format, verified structure |
| Tier 2 | SkillsMP API | 200-1000 | Pre-aggregated, quality filtered |
| Tier 3 | claude-plugins.dev | 100-500 | Community vetted |
| Tier 4 | Awesome lists | 50-200 | Curated, high quality |
| Tier 5 | MCP Registry | 100-500 | Official registry |
| Buffer | Additional GitHub search | 50-1300 | Fill remaining quota |

---

## 2. Codespaces Security Architecture

### Why Codespaces + Docker

1. **Skill Code Isolation**: Skills may contain arbitrary code (scripts, commands)
2. **Network Sandboxing**: Prevent exfiltration of local secrets
3. **Disposable Environment**: Destroy after testing, no persistence
4. **No Local Risk**: Zero chance of compromising developer machine

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   GitHub Codespaces                          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                 Docker Container                         │ │
│  │  ┌─────────────────────────────────────────────────────┐│ │
│  │  │           Skillsmith Test Environment               ││ │
│  │  │                                                      ││ │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          ││ │
│  │  │  │ Database │  │ Indexer  │  │ Tests    │          ││ │
│  │  │  │ (SQLite) │  │          │  │          │          ││ │
│  │  │  └──────────┘  └──────────┘  └──────────┘          ││ │
│  │  │                                                      ││ │
│  │  │  ┌──────────────────────────────────────────────┐   ││ │
│  │  │  │         Skill Data (Read-Only)               │   ││ │
│  │  │  │  • No execution of skill scripts            │   ││ │
│  │  │  │  • Metadata parsing only                    │   ││ │
│  │  │  │  • Security scanner validation              │   ││ │
│  │  │  └──────────────────────────────────────────────┘   ││ │
│  │  └─────────────────────────────────────────────────────┘│ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  Network: Outbound only (GitHub API, data sources)           │
│  Storage: Ephemeral (destroyed after tests)                  │
└─────────────────────────────────────────────────────────────┘
```

### Security Controls

| Control | Implementation | Purpose |
|---------|---------------|---------|
| Docker isolation | `docker compose --profile test` | Container boundary |
| No script execution | Parse SKILL.md only, skip scripts/ | Prevent code execution |
| Read-only skill data | Mount as read-only volume | Prevent modification |
| Network egress only | No inbound connections | Prevent reverse shells |
| Ephemeral storage | No volume persistence | No data exfiltration |
| Security scanner | Run on all imported skills | Detect malicious patterns |
| Resource limits | CPU/memory caps in Docker | Prevent resource exhaustion |

---

## 3. Import Pipeline

### Phase 1: Data Collection (Codespaces)

```bash
# Create Codespace
gh codespace create --repo wrsmith108/skillsmith --branch main --machine basicLinux32gb

# SSH into Codespace
gh codespace ssh -c <codespace-id>

# Start Docker container
cd /workspaces/skillsmith
docker compose --profile dev up -d

# Run data collection inside Docker
docker exec skillsmith-dev-1 npm run import:github -- \
  --topics "claude-skill,mcp-server,anthropic-skills" \
  --max 1000 \
  --output /app/data/github-skills.json

docker exec skillsmith-dev-1 npm run import:skillsmp -- \
  --max 1000 \
  --min-stars 2 \
  --output /app/data/skillsmp-skills.json

docker exec skillsmith-dev-1 npm run import:plugins -- \
  --max 500 \
  --output /app/data/plugins-skills.json
```

### Phase 2: Data Validation

```bash
# Validate and deduplicate
docker exec skillsmith-dev-1 npm run validate:skills -- \
  --input "/app/data/*.json" \
  --output /app/data/validated-skills.json \
  --report /app/data/validation-report.json

# Security scan all skills
docker exec skillsmith-dev-1 npm run security:scan -- \
  --input /app/data/validated-skills.json \
  --output /app/data/security-report.json \
  --reject-malicious
```

### Phase 3: Database Population

```bash
# Import validated skills to database
docker exec skillsmith-dev-1 npm run db:import -- \
  --input /app/data/validated-skills.json \
  --db /app/data/skills.db

# Verify import
docker exec skillsmith-dev-1 npm run db:stats -- \
  --db /app/data/skills.db
```

---

## 4. Test Categories

### 4.1 Performance Tests

| Test | Target | Metric | Threshold |
|------|--------|--------|-----------|
| Search latency (100 skills) | p95 response time | < 100ms |
| Search latency (1000 skills) | p95 response time | < 200ms |
| Search latency (4000 skills) | p95 response time | < 500ms |
| Concurrent searches (10) | All complete | < 1s |
| Concurrent searches (50) | All complete | < 3s |
| Memory usage (idle) | Heap size | < 100MB |
| Memory usage (search) | Peak heap | < 300MB |
| Database size (4000 skills) | File size | < 50MB |
| FTS5 index rebuild | Duration | < 30s |
| Cold start | Time to first query | < 2s |

### 4.2 Edge Case Tests

| Category | Test Case | Expected Behavior |
|----------|-----------|-------------------|
| **Malformed Data** | Missing required fields | Graceful skip, log warning |
| | Invalid JSON in SKILL.md | Parse error, skip skill |
| | Extremely long descriptions | Truncate to 10KB |
| | Unicode/emoji in names | Proper encoding |
| | Control characters | Sanitize or reject |
| **Large Data** | 50KB SKILL.md file | Parse with memory limit |
| | 100+ dependencies | Handle without timeout |
| | 1000+ tags | Limit to first 50 |
| | 10MB skill package | Reject with size error |
| **Adversarial** | SQL injection in name | Parameterized queries |
| | XSS in description | HTML escape output |
| | Path traversal in ID | Sanitize paths |
| | Prototype pollution | Object.create(null) |
| | Command injection in scripts | Never execute scripts |
| **Duplicates** | Same skill, multiple sources | Deduplicate by repo URL |
| | Forks with same name | Distinguish by author |
| | Version conflicts | Latest version wins |
| **Network** | GitHub rate limit | Backoff and retry |
| | Timeout on fetch | 30s timeout, skip |
| | Partial response | Retry or skip |

### 4.3 Search Quality Tests

| Test | Query | Expected Top Result | Relevance Check |
|------|-------|--------------------|--------------------|
| Exact match | "jest-helper" | jest-helper skill | Exact name match |
| Keyword | "testing" | Testing-related skills | Category match |
| Semantic | "write unit tests" | Test frameworks | Intent match |
| Typo tolerance | "gest helper" | jest-helper | Fuzzy match |
| Empty results | "xyznonexistent123" | Empty array | No false positives |
| Multi-word | "git commit message" | Git commit skills | Multi-term ranking |
| Category filter | category:testing | Only testing skills | Filter accuracy |
| Trust filter | trust:verified | Only verified skills | Filter accuracy |

### 4.4 Data Quality Validation

| Check | Criteria | Action if Fail |
|-------|----------|----------------|
| Name present | Non-empty string | Reject skill |
| Author present | Non-empty string | Use repo owner |
| Description present | Non-empty string | Use first 100 chars of content |
| Valid ID format | `author/name` pattern | Generate from repo |
| No duplicate IDs | Unique constraint | Keep higher quality |
| Quality score valid | 0-100 range | Recalculate |
| Trust tier valid | Enum value | Default to 'unknown' |

---

## 5. Implementation Scripts

### 5.1 Create Import Scripts

```typescript
// scripts/import/github-import.ts
import { GitHubSourceAdapter } from '@skillsmith/core'

async function importFromGitHub(options: ImportOptions): Promise<void> {
  const adapter = new GitHubSourceAdapter({
    token: process.env.GITHUB_TOKEN,
    rateLimit: { requestsPerHour: 4000 },
  })

  const topics = options.topics.split(',')
  const allSkills: Skill[] = []

  for (const topic of topics) {
    console.log(`Searching topic: ${topic}`)
    const skills = await adapter.searchByTopic(topic, {
      maxResults: options.max / topics.length,
    })
    allSkills.push(...skills)
  }

  // Deduplicate
  const unique = deduplicateByRepoUrl(allSkills)

  // Write output
  await fs.writeFile(options.output, JSON.stringify(unique, null, 2))
  console.log(`Imported ${unique.length} skills`)
}
```

### 5.2 Performance Test Suite

```typescript
// packages/core/tests/performance/large-scale.perf.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { SearchService } from '../src/services/SearchService'
import { loadTestDatabase } from './fixtures/load-test-db'

describe('Large-Scale Performance Tests', () => {
  let searchService: SearchService
  let skillCount: number

  beforeAll(async () => {
    const db = await loadTestDatabase()
    searchService = new SearchService(db)
    skillCount = await db.prepare('SELECT COUNT(*) as count FROM skills').get().count
    console.log(`Testing with ${skillCount} skills`)
  })

  it('search latency < 200ms for 1000+ skills', async () => {
    const start = performance.now()
    const results = await searchService.search({ query: 'testing', limit: 20 })
    const duration = performance.now() - start

    expect(duration).toBeLessThan(200)
    expect(results.items.length).toBeGreaterThan(0)
  })

  it('handles 50 concurrent searches', async () => {
    const queries = Array(50).fill(null).map((_, i) =>
      searchService.search({ query: `test${i % 10}`, limit: 10 })
    )

    const start = performance.now()
    const results = await Promise.all(queries)
    const duration = performance.now() - start

    expect(duration).toBeLessThan(3000)
    expect(results.every(r => Array.isArray(r.items))).toBe(true)
  })

  it('memory usage stays under 300MB during search', async () => {
    const before = process.memoryUsage().heapUsed

    // Run 100 searches
    for (let i = 0; i < 100; i++) {
      await searchService.search({ query: `query${i}`, limit: 50 })
    }

    const after = process.memoryUsage().heapUsed
    const heapMB = after / 1024 / 1024

    expect(heapMB).toBeLessThan(300)
  })
})
```

---

## 6. Execution Plan

### Day 1: Setup and Data Collection

```bash
# 1. Create Codespace (8-core machine for faster processing)
gh codespace create --repo wrsmith108/skillsmith --branch main --machine standardLinux

# 2. Start Docker environment
gh codespace ssh -c <id> -- "cd /workspaces/skillsmith && docker compose --profile dev up -d"

# 3. Build project
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm install && npm run build"

# 4. Run GitHub import (target: 1000 skills)
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm run import:github -- --max 1000"

# 5. Run SkillsMP import (target: 500 skills)
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm run import:skillsmp -- --max 500"
```

### Day 2: Validation and Import

```bash
# 1. Validate collected data
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm run validate:skills"

# 2. Security scan
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm run security:scan"

# 3. Import to database
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm run db:import"

# 4. Verify counts
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm run db:stats"
```

### Day 3: Performance Testing

```bash
# 1. Run full test suite
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm test"

# 2. Run performance tests specifically
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm test -- packages/core/tests/performance/"

# 3. Run edge case tests
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm test -- packages/core/tests/edge-cases/"

# 4. Generate performance report
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 npm run report:performance"
```

### Day 4: Analysis and Cleanup

```bash
# 1. Export test results
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 cat /app/reports/performance.json" > performance-results.json

# 2. Export validation report
gh codespace ssh -c <id> -- "docker exec skillsmith-dev-1 cat /app/reports/validation.json" > validation-results.json

# 3. Delete Codespace (IMPORTANT: security cleanup)
gh codespace delete -c <id> --force
```

---

## 7. Success Criteria

### Functional Requirements

| Requirement | Metric | Target | Status |
|-------------|--------|--------|--------|
| Skills indexed | Count | 400-4000 | ⬜ |
| Data sources used | Count | ≥ 3 | ⬜ |
| Search works at scale | Queries return results | 100% | ⬜ |
| No security incidents | Malicious skill execution | 0 | ⬜ |
| All tests pass | Test suite | 100% green | ⬜ |

### Performance Requirements

| Requirement | Metric | Target | Status |
|-------------|--------|--------|--------|
| Search latency (1000) | p95 | < 200ms | ⬜ |
| Search latency (4000) | p95 | < 500ms | ⬜ |
| Concurrent (50 queries) | Duration | < 3s | ⬜ |
| Memory usage | Peak heap | < 300MB | ⬜ |
| Database size | File size | < 50MB | ⬜ |

### Quality Requirements

| Requirement | Metric | Target | Status |
|-------------|--------|--------|--------|
| Edge cases handled | Test coverage | 100% | ⬜ |
| Malformed data rejected | Validation rate | > 95% | ⬜ |
| Duplicates removed | Dedup accuracy | 100% | ⬜ |
| Security scan pass | No high/critical | 0 issues | ⬜ |

---

## 8. Risk Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Malicious skill code | Security breach | Medium | Docker + Codespaces isolation |
| GitHub rate limiting | Slow import | High | Token rotation, incremental sync |
| Codespaces cost | Budget overrun | Low | Use ephemeral, delete after tests |
| Data quality issues | Poor test coverage | Medium | Multiple validation passes |
| Performance regression | Missed targets | Medium | Benchmarks with thresholds |
| Network failures | Incomplete import | Medium | Retry logic, resume capability |

---

## 9. Post-Testing Actions

### If All Tests Pass

1. Document performance baselines in `docs/performance/baselines.md`
2. Archive validated dataset for regression testing
3. Create Phase 5 readiness report
4. Proceed to Phase 5: Production Launch

### If Tests Fail

1. Categorize failures (performance vs. functionality vs. edge case)
2. Create Linear issues for each failure category
3. Prioritize fixes based on severity
4. Re-run tests after fixes
5. Iterate until all criteria met

---

## 10. Appendix: Import Script Templates

### GitHub Import Command

```bash
docker exec skillsmith-dev-1 npx tsx scripts/import/github-import.ts \
  --topics "claude-skill,mcp-server,claude-code,anthropic-skills" \
  --max 2000 \
  --min-stars 1 \
  --require-skill-md true \
  --output /app/data/github-skills.json \
  --token "$GITHUB_TOKEN"
```

### SkillsMP Import Command

```bash
docker exec skillsmith-dev-1 npx tsx scripts/import/skillsmp-import.ts \
  --max 1000 \
  --min-quality 50 \
  --output /app/data/skillsmp-skills.json
```

### Database Import Command

```bash
docker exec skillsmith-dev-1 npx tsx scripts/import/db-import.ts \
  --input "/app/data/*-skills.json" \
  --db /app/data/skills.db \
  --dedupe-by repo_url \
  --validate true
```

---

## 11. Linear Issues to Create

| Issue | Title | Priority | Estimate |
|-------|-------|----------|----------|
| SMI-8XX | Create GitHub import script for large-scale testing | P0 | 4h |
| SMI-8XX | Create SkillsMP import script | P1 | 3h |
| SMI-8XX | Create performance test suite | P0 | 4h |
| SMI-8XX | Create edge case test suite | P1 | 3h |
| SMI-8XX | Run large-scale tests on Codespaces | P0 | 4h |
| SMI-8XX | Document performance baselines | P1 | 2h |
| SMI-8XX | Create Phase 5 readiness report | P1 | 2h |

**Total Estimated Effort**: ~22 hours

---

*Plan created: December 31, 2025*
*Next action: Create Codespace and begin data collection*
