# Phase 3: Live Data & User Testing Plan

**Date**: December 29, 2025
**Status**: Planning
**Goal**: Transition from mock data to live skills database and enable initial user testing

---

## Executive Summary

Skillsmith has comprehensive infrastructure in place but MCP tools currently use hardcoded mock data instead of the real SearchService and database. This plan outlines the path from current state to initial user testing with live GitHub skills data.

**Current State**: Infrastructure complete, mock data in production code
**Target State**: Live skills database, end-to-end testing, beta user access

---

## 1. Current Implementation Status

### ✅ Complete & Production-Ready

| Component | Location | Status |
|-----------|----------|--------|
| Database Schema | `packages/core/src/db/schema.ts` | FTS5, indexes, migrations |
| SkillRepository | `packages/core/src/repositories/` | CRUD, search, caching |
| SearchService | `packages/core/src/services/SearchService.ts` | BM25 ranking, filters |
| EmbeddingService | `packages/core/src/embeddings/` | With fallback mode |
| GitHub Import CLI | `packages/cli/src/import.ts` | Rate-limited, batch import |
| Source Adapters | `packages/core/src/sources/` | GitHub, GitLab, Local, URL |
| Security Scanner | `packages/core/src/security/` | SSRF, path traversal, CSP |
| Rate Limiter | `packages/core/src/security/RateLimiter.ts` | Token bucket, metrics |
| CI/CD Pipeline | `.github/workflows/ci.yml` | Docker, parallel checks |
| Session Health | `packages/core/src/session/` | Monitoring, auto-recovery |

### ⚠️ Using Mock Data (Blocking)

| Component | Issue | Fix Required |
|-----------|-------|--------------|
| `search.ts` | `mockSkills[]` array | Wire to SearchService |
| `get-skill.ts` | `mockSkillDatabase{}` | Wire to SkillRepository |
| `compare.ts` | `mockSkillDatabase{}` | Wire to SkillRepository |
| `recommend.ts` | Uses SkillMatcher but no real DB | Connect to populated DB |
| VS Code extension | `mockSkills.ts` | Call MCP server |

### 📋 Backlog (Not Blocking for Initial Testing)

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-597 | Astro static site | P2 |
| SMI-609 | VS Code Marketplace publish | P2 |
| SMI-603 | Gap analysis | P3 |
| SMI-605 | Conflict detection | P3 |
| SMI-775 | Full ONNX embedding model | P3 |

---

## 2. Phase 3 Work Breakdown

### Phase 3a: Wire MCP Tools to Real Services (P0)

**Goal**: Replace all mock data with real database queries

#### SMI-789: Wire search tool to SearchService

```typescript
// Current (mock):
const results = mockSkills.filter(...)

// Target (real):
const searchService = new SearchService(db)
const results = searchService.search({ query, limit, offset })
```

**Files**: `packages/mcp-server/src/tools/search.ts`
**Estimate**: 2 hours
**Dependencies**: Database with skills

#### SMI-790: Wire get-skill tool to SkillRepository

```typescript
// Current (mock):
const skill = mockSkillDatabase[skillId]

// Target (real):
const repo = new SkillRepository(db)
const skill = repo.findById(skillId)
```

**Files**: `packages/mcp-server/src/tools/get-skill.ts`
**Estimate**: 1 hour

#### SMI-791: Wire compare tool to SkillRepository

**Files**: `packages/mcp-server/src/tools/compare.ts`
**Estimate**: 1 hour

#### SMI-792: Add database initialization to MCP server

```typescript
// In packages/mcp-server/src/index.ts
import { createDatabase } from '@skillsmith/core'

const db = createDatabase({ path: getDbPath() })
// Pass db to tool handlers
```

**Files**: `packages/mcp-server/src/index.ts`
**Estimate**: 2 hours

**Phase 3a Total**: ~6 hours

---

### Phase 3b: Populate Database with Live Skills (P0)

**Goal**: Import real skills from GitHub

#### SMI-793: Run initial GitHub import

```bash
# Import skills with claude-skill topic
docker exec skillsmith-dev-1 npx skillsmith import \
  --topic claude-skill \
  --max 500 \
  --db ~/.skillsmith/skills.db \
  --verbose
```

**Estimate**: 1 hour (including rate limit delays)
**Output**: 100-500 skills indexed

#### SMI-794: Add seed data for testing

Create curated seed data for consistent testing:
- 10 verified skills (Anthropic official)
- 20 community skills (popular repos)
- 5 experimental skills (edge cases)

**Files**: `packages/core/tests/fixtures/seed-skills.sql`
**Estimate**: 2 hours

#### SMI-795: Validate import quality

- Verify skill metadata extraction
- Check FTS5 index population
- Test search relevance
- Validate quality scores

**Estimate**: 2 hours

**Phase 3b Total**: ~5 hours

---

### Phase 3c: End-to-End Testing (P1)

**Goal**: Verify complete user flow works

#### SMI-796: E2E test: Search → Get → Install flow

```typescript
describe('E2E: Skill Discovery Flow', () => {
  it('searches, retrieves, and installs a skill', async () => {
    // 1. Search for skills
    const results = await mcpClient.call('search', { query: 'git commit' })
    expect(results.items.length).toBeGreaterThan(0)

    // 2. Get skill details
    const skill = await mcpClient.call('get_skill', { skill_id: results.items[0].id })
    expect(skill.name).toBeDefined()

    // 3. Install skill
    const installed = await mcpClient.call('install_skill', { skill_id: skill.id })
    expect(installed.success).toBe(true)
  })
})
```

**Files**: `packages/mcp-server/tests/e2e/discovery-flow.test.ts`
**Estimate**: 3 hours

#### SMI-797: Performance validation

- Search latency < 500ms (target: < 200ms)
- Concurrent request handling (10 simultaneous)
- Memory usage under load
- Database query performance

**Estimate**: 2 hours

#### SMI-798: Integration test with real GitHub API

```typescript
describe('GitHub Integration', () => {
  it('fetches and indexes a real skill repo', async () => {
    const indexer = new GitHubIndexer(db, { token: process.env.GITHUB_TOKEN })
    const result = await indexer.indexRepo('anthropics/claude-code-skill')
    expect(result.success).toBe(true)
  })
})
```

**Files**: `packages/core/tests/integration/github-live.test.ts`
**Estimate**: 2 hours
**Note**: Requires `GITHUB_TOKEN` for rate limits

**Phase 3c Total**: ~7 hours

---

### Phase 3d: Documentation & User Onboarding (P1)

**Goal**: Enable beta testers to use Skillsmith

#### SMI-799: Create root README.md

```markdown
# Skillsmith

MCP server for Claude Code skill discovery and management.

## Quick Start

\`\`\`bash
# Install
npm install -g @skillsmith/cli

# Import skills from GitHub
skillsmith import --topic claude-skill

# Start MCP server (for Claude Code)
npx @skillsmith/mcp-server
\`\`\`

## Features
- Search 500+ Claude Code skills
- One-click installation
- Security scanning
- Quality scoring
```

**Files**: `README.md`
**Estimate**: 2 hours

#### SMI-800: Create GETTING_STARTED.md

- Prerequisites (Node 18+, Docker optional)
- Installation steps
- Configuration options
- First search walkthrough
- Troubleshooting

**Files**: `docs/GETTING_STARTED.md`
**Estimate**: 2 hours

#### SMI-801: Update CLAUDE.md for users

Current CLAUDE.md is for development. Create user-facing version:
- How to add Skillsmith to Claude Code
- Available MCP tools
- Example workflows

**Files**: `.claude/CLAUDE.md` (user template)
**Estimate**: 1 hour

**Phase 3d Total**: ~5 hours

---

## 3. Implementation Order

```
Week 1: Phase 3a + 3b (Live Data)
├── Day 1: SMI-789, SMI-790, SMI-791 (Wire tools)
├── Day 2: SMI-792 (DB initialization)
├── Day 3: SMI-793 (GitHub import)
└── Day 4: SMI-794, SMI-795 (Seed data, validation)

Week 2: Phase 3c + 3d (Testing & Docs)
├── Day 1: SMI-796 (E2E tests)
├── Day 2: SMI-797, SMI-798 (Performance, integration)
├── Day 3: SMI-799, SMI-800 (README, Getting Started)
└── Day 4: SMI-801 + Beta release prep
```

**Total Estimated Effort**: ~23 hours

---

## 4. Success Criteria

### Functional Requirements

| Requirement | Metric | Target |
|-------------|--------|--------|
| Search works with live data | Query returns real skills | 100% |
| Skills can be installed | Install success rate | > 95% |
| Database populated | Skills indexed | > 100 |
| E2E tests pass | Test suite | 100% green |

### Performance Requirements

| Requirement | Metric | Target |
|-------------|--------|--------|
| Search latency | p95 response time | < 500ms |
| Import throughput | Skills per minute | > 10 |
| Memory usage | Peak during search | < 200MB |

### Quality Requirements

| Requirement | Metric | Target |
|-------------|--------|--------|
| Test coverage | Line coverage | > 80% |
| Documentation | Key workflows documented | 100% |
| Security | No high/critical vulns | 0 |

---

## 5. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| GitHub rate limiting | Import blocked | Use token, implement backoff |
| Skill metadata inconsistent | Poor search results | Add validation, fallback defaults |
| Database performance | Slow queries | Add indexes, test with 1000+ skills |
| Mock data remnants | Inconsistent behavior | Grep for "mock", add lint rule |

---

## 6. Beta Testing Plan

### Phase 1: Internal Testing (Week 1-2)
- Developer testing with live data
- Fix critical bugs
- Refine documentation

### Phase 2: Closed Beta (Week 3-4)
- 5-10 power users
- Feedback collection via GitHub issues
- Usage telemetry (opt-in)

### Phase 3: Open Beta (Week 5+)
- Public npm package
- VS Code Marketplace listing
- Community skill submissions

---

## 7. Linear Project Structure

Create new project: **Skillsmith Phase 3: Live Data**

| Issue | Title | Priority | Batch |
|-------|-------|----------|-------|
| SMI-789 | Wire search tool to SearchService | P0 | 3a |
| SMI-790 | Wire get-skill tool to SkillRepository | P0 | 3a |
| SMI-791 | Wire compare tool to SkillRepository | P0 | 3a |
| SMI-792 | Add database initialization to MCP server | P0 | 3a |
| SMI-793 | Run initial GitHub import | P0 | 3b |
| SMI-794 | Add seed data for testing | P1 | 3b |
| SMI-795 | Validate import quality | P1 | 3b |
| SMI-796 | E2E test: Search → Get → Install flow | P1 | 3c |
| SMI-797 | Performance validation | P1 | 3c |
| SMI-798 | Integration test with real GitHub API | P1 | 3c |
| SMI-799 | Create root README.md | P1 | 3d |
| SMI-800 | Create GETTING_STARTED.md | P1 | 3d |
| SMI-801 | Update CLAUDE.md for users | P2 | 3d |

---

## 8. Definition of Done

Phase 3 is complete when:

- [ ] All MCP tools query real database (no mock data)
- [ ] Database contains 100+ indexed skills
- [ ] E2E tests pass with live data
- [ ] Search latency < 500ms p95
- [ ] README and Getting Started docs published
- [ ] Beta user can install and use Skillsmith
- [ ] No critical/high security vulnerabilities

---

*Plan created: December 29, 2025*
*Next action: Create Linear issues and begin Phase 3a*
