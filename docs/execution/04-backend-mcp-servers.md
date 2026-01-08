# Backend & MCP Servers Implementation Plan

**Project:** Skillsmith
**Domain:** Backend & MCP Servers
**Owner:** Backend Specialist
**Date:** December 26, 2025
**Status:** Planned

---

## Executive Summary

This document provides the comprehensive implementation plan for the MCP servers and backend services, covering 23 MCP tools across 3 servers for Phases 0-2.

### Server Overview

| Server | Tools | Memory | Startup | Purpose |
|--------|-------|--------|---------|---------|
| discovery-core | 12 | 150MB | 1.5s | Search, install, recommend, audit |
| learning | 6 | 50MB | 0.5s | Learning paths, exercises, progress |
| sync | 5 | 100MB | 0.5s | Index refresh, blocklist, health |

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Server Count | 3 consolidated | Balance startup vs separation |
| API Protocol | MCP over stdio | Native Claude Code integration |
| Inter-Service | Shared filesystem | Simple, SQLite handles concurrency |
| Caching | L1 memory + L2 SQLite | Meet <200ms latency target |

---

## Phase 0: Foundation Sprint (Weeks 1-8)

### Epic MCP-001: discovery-core Server

**Description:** Implement the primary MCP server with 12 tools for skill discovery, installation, and auditing.

**Business Value:** Core functionality for all skill discovery operations.

**Dependencies:** DA-001 (Database Foundation), TA-001 (MCP Foundation)

**Definition of Done:**
- [ ] All 12 tools registered and responding
- [ ] Cold start < 1.5 seconds
- [ ] Memory usage < 150MB idle
- [ ] Search latency < 200ms (cached)

---

#### Story MCP-001-01: search() Tool Implementation

**As a** user
**I want** to search for skills by keyword
**So that** I can find skills matching my needs

**Acceptance Criteria:**
- [ ] Query returns relevant results in < 200ms
- [ ] Filters by category, trust tier, min score
- [ ] Pagination with limit/offset
- [ ] Query intent detected and refined

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| MCP-001-01-T1 | Implement search tool handler | 4h | P0 |
| MCP-001-01-T2 | Add FTS5 query builder | 4h | P0 |
| MCP-001-01-T3 | Implement filter processing | 3h | P0 |
| MCP-001-01-T4 | Add result ranking algorithm | 4h | P0 |
| MCP-001-01-T5 | Implement query caching | 3h | P1 |
| MCP-001-01-T6 | Add query intent detection | 4h | P2 |

**Code Pattern - Search Tool:**

```typescript
// src/mcp/discovery-core/tools/search.ts
import { Tool, ToolContext, ToolResult } from '../framework';

export const searchTool: Tool = {
  name: 'search',
  description: 'Search for Claude Code skills by keyword or description',

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (keywords or natural language)',
        minLength: 1,
      },
      filters: {
        type: 'object',
        properties: {
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by categories (e.g., "testing", "documentation")',
          },
          trust_tier: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['official', 'verified', 'community', 'unverified'],
            },
          },
          min_score: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
        },
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
      },
    },
    required: ['query'],
  },

  async execute(input: SearchInput, ctx: ToolContext): Promise<ToolResult> {
    const searchService = ctx.get(SearchService);
    const startTime = Date.now();

    const results = await searchService.search({
      query: input.query,
      filters: input.filters,
      limit: input.limit ?? 10,
      offset: input.offset ?? 0,
    });

    return {
      success: true,
      data: {
        results: results.skills.map(formatSkillSummary),
        total: results.total,
        has_more: results.total > (input.offset ?? 0) + results.skills.length,
        query_analysis: {
          interpreted_query: results.interpretedQuery,
          suggested_refinements: results.suggestions,
        },
      },
      metadata: {
        cached: results.fromCache,
        execution_time_ms: Date.now() - startTime,
      },
    };
  },
};
```

---

#### Story MCP-001-02: get_skill() Tool Implementation

**As a** user
**I want** to view skill details
**So that** I can evaluate before installing

**Acceptance Criteria:**
- [ ] Returns full skill metadata in < 100ms
- [ ] Includes quality score breakdown
- [ ] Shows trust tier with explanation
- [ ] Lists similar skills

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| MCP-001-02-T1 | Implement get_skill handler | 3h | P0 |
| MCP-001-02-T2 | Add quality score breakdown | 2h | P0 |
| MCP-001-02-T3 | Add trust tier explanation | 2h | P0 |
| MCP-001-02-T4 | Implement similar skills query | 3h | P1 |
| MCP-001-02-T5 | Add caching for skill details | 2h | P1 |

---

#### Story MCP-001-03: install_skill() Tool Implementation

**As a** user
**I want** to install skills with safety checks
**So that** I can add skills securely

**Acceptance Criteria:**
- [ ] Security scan runs before install
- [ ] Conflicts detected and reported
- [ ] Files copied to correct location
- [ ] Activation tips provided

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| MCP-001-03-T1 | Implement install handler | 4h | P0 |
| MCP-001-03-T2 | Add security scan integration | 4h | P0 |
| MCP-001-03-T3 | Implement conflict detection | 4h | P0 |
| MCP-001-03-T4 | Add file copy with rollback | 3h | P0 |
| MCP-001-03-T5 | Generate activation tips | 2h | P1 |
| MCP-001-03-T6 | Record install interaction | 2h | P1 |

**Code Pattern - Install Tool:**

```typescript
// src/mcp/discovery-core/tools/install.ts
export const installSkillTool: Tool = {
  name: 'install_skill',
  description: 'Install a Claude Code skill with security checks',

  inputSchema: {
    type: 'object',
    properties: {
      skill_id: {
        type: 'string',
        description: 'Unique identifier of the skill to install',
      },
      skip_conflict_check: {
        type: 'boolean',
        default: false,
      },
      skip_security_scan: {
        type: 'boolean',
        default: false,
      },
      force: {
        type: 'boolean',
        description: 'Override warnings and install anyway',
        default: false,
      },
    },
    required: ['skill_id'],
  },

  async execute(input: InstallInput, ctx: ToolContext): Promise<ToolResult> {
    const installService = ctx.get(InstallService);

    // Pre-flight checks
    const preflightResult = await installService.preflight(input.skill_id, {
      skipConflictCheck: input.skip_conflict_check,
      skipSecurityScan: input.skip_security_scan,
    });

    // Block on critical issues unless forced
    if (preflightResult.blocked && !input.force) {
      return {
        success: false,
        error: {
          code: preflightResult.blockReason,
          message: preflightResult.blockMessage,
          details: preflightResult.issues,
        },
      };
    }

    // Perform installation
    const result = await installService.install(input.skill_id);

    return {
      success: true,
      data: {
        skill_id: result.skillId,
        installed_path: result.installedPath,
        conflicts: preflightResult.conflicts,
        security_warnings: preflightResult.warnings,
        activation_tips: result.activationTips,
        suggested_hooks: result.suggestedHooks,
      },
    };
  },
};
```

---

#### Story MCP-001-04: recommend_skills() Tool Implementation

**As a** user
**I want** skill recommendations for my project
**So that** I discover relevant skills I don't know about

**Acceptance Criteria:**
- [ ] Scans codebase to detect stack
- [ ] Returns top 10 recommendations
- [ ] Explains why each is recommended
- [ ] Excludes already-installed skills

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| MCP-001-04-T1 | Implement recommend handler | 4h | P0 |
| MCP-001-04-T2 | Integrate codebase scanner | 4h | P0 |
| MCP-001-04-T3 | Add gap analysis | 4h | P0 |
| MCP-001-04-T4 | Generate recommendation explanations | 3h | P0 |
| MCP-001-04-T5 | Filter installed skills | 2h | P0 |
| MCP-001-04-T6 | Cache recommendations per directory | 2h | P1 |

---

#### Story MCP-001-05: audit_activation() Tool Implementation

**As a** user
**I want** to diagnose skill activation issues
**So that** I can fix why skills aren't working

**Acceptance Criteria:**
- [ ] Validates YAML frontmatter
- [ ] Checks trigger patterns
- [ ] Calculates character budget impact
- [ ] Generates fix suggestions

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| MCP-001-05-T1 | Implement audit handler | 4h | P0 |
| MCP-001-05-T2 | Add frontmatter validator | 4h | P0 |
| MCP-001-05-T3 | Implement trigger analyzer | 3h | P0 |
| MCP-001-05-T4 | Add budget calculator | 3h | P0 |
| MCP-001-05-T5 | Generate fix suggestions | 3h | P1 |
| MCP-001-05-T6 | Add hook generator | 4h | P2 |

---

### Epic MCP-002: learning Server

**Description:** Implement the learning MCP server with 6 tools for educational content and progress tracking.

**Business Value:** Helps users effectively learn to use new skills.

**Dependencies:** TA-001, DA-001

**Definition of Done:**
- [ ] All 6 tools registered
- [ ] Cold start < 0.5 seconds
- [ ] Progress persisted locally
- [ ] Exercises load from content

---

#### Story MCP-002-01: Learning Path Tools

**As a** user
**I want** guided learning for new skills
**So that** I can become effective quickly

**Acceptance Criteria:**
- [ ] get_path() returns skill learning path
- [ ] next_exercise() serves next step
- [ ] submit_solution() validates answers
- [ ] get_progress() shows completion

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| MCP-002-01-T1 | Implement get_path tool | 3h | P0 |
| MCP-002-01-T2 | Implement next_exercise tool | 3h | P0 |
| MCP-002-01-T3 | Implement submit_solution tool | 4h | P0 |
| MCP-002-01-T4 | Implement validate_solution tool | 4h | P0 |
| MCP-002-01-T5 | Implement get_progress tool | 2h | P0 |
| MCP-002-01-T6 | Implement get_hint tool | 3h | P1 |

---

### Epic MCP-003: sync Server

**Description:** Implement the sync MCP server with 5 tools for index updates and source health.

**Business Value:** Keeps skill index current without user intervention.

**Dependencies:** TA-001, DA-003 (Sync Infrastructure)

**Definition of Done:**
- [ ] All 5 tools registered
- [ ] Background sync starts 30s after server
- [ ] Incremental updates work
- [ ] Source health reported

---

#### Story MCP-003-01: Sync Control Tools

**As a** user
**I want** to control index sync
**So that** I can refresh data when needed

**Acceptance Criteria:**
- [ ] refresh_index() triggers sync
- [ ] get_sync_status() shows progress
- [ ] force_full_sync() rebuilds index
- [ ] get_source_health() shows source status

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| MCP-003-01-T1 | Implement refresh_index tool | 3h | P0 |
| MCP-003-01-T2 | Implement get_sync_status tool | 2h | P0 |
| MCP-003-01-T3 | Implement force_full_sync tool | 3h | P0 |
| MCP-003-01-T4 | Implement get_source_health tool | 3h | P0 |
| MCP-003-01-T5 | Implement update_blocklist tool | 3h | P0 |

---

## Phase 1: Foundation + Safety (Weeks 9-12)

### Epic MCP-004: Security Integration

**Description:** Integrate security scanning, blocklist checking, and trust tier computation into MCP tools.

**Business Value:** Protects users from malicious skills.

**Dependencies:** SEC-101 to SEC-107

**Definition of Done:**
- [ ] Static analysis runs on install
- [ ] Blocklist checked before install
- [ ] Trust tiers displayed in search
- [ ] Security warnings shown clearly

---

#### Story MCP-004-01: Pre-Install Security Pipeline

**As a** user
**I want** skills scanned before install
**So that** I'm protected from malicious content

**Acceptance Criteria:**
- [ ] Jailbreak patterns detected
- [ ] Suspicious URLs flagged
- [ ] Typosquatting checked
- [ ] Risk score calculated

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| MCP-004-01-T1 | Integrate SecurityScanner | 4h | P0 |
| MCP-004-01-T2 | Add blocklist check | 2h | P0 |
| MCP-004-01-T3 | Add typosquatting check | 3h | P0 |
| MCP-004-01-T4 | Calculate risk score | 3h | P0 |
| MCP-004-01-T5 | Format security warnings | 2h | P0 |

---

## Phase 2: Recommendations + Entry Points (Weeks 13-16)

### Epic MCP-005: Conflict Detection

**Description:** Implement skill conflict detection in install and audit tools.

**Business Value:** Prevents skill interference and helps resolve issues.

**Dependencies:** SEC-201 (Trigger Overlap Detection)

**Definition of Done:**
- [ ] Trigger overlaps detected
- [ ] Behavioral conflicts identified
- [ ] Resolution suggestions provided
- [ ] Priority config applied

---

#### Story MCP-005-01: check_conflicts() Tool

**As a** user
**I want** to check for skill conflicts
**So that** I can prevent issues before they occur

**Acceptance Criteria:**
- [ ] Detects trigger pattern overlaps
- [ ] Identifies behavioral conflicts
- [ ] Suggests priority configuration
- [ ] Works with installed and new skills

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| MCP-005-01-T1 | Implement check_conflicts tool | 4h | P0 |
| MCP-005-01-T2 | Add trigger overlap detection | 4h | P0 |
| MCP-005-01-T3 | Add behavioral conflict detection | 4h | P0 |
| MCP-005-01-T4 | Generate resolution suggestions | 3h | P1 |
| MCP-005-01-T5 | Apply priority configuration | 3h | P1 |

---

## MCP Tool Reference

### discovery-core Tools (12)

| Tool | Purpose | Phase |
|------|---------|-------|
| search | Search skills by keyword/semantic | 0 |
| get_skill | Get skill details | 0 |
| recommend_skills | Get recommendations for project | 0 |
| install_skill | Install with security checks | 0 |
| audit_activation | Diagnose activation issues | 0 |
| check_conflicts | Check for conflicts | 2 |
| analyze_codebase | Scan project tech stack | 2 |
| get_categories | List skill categories | 0 |
| get_technologies | List supported technologies | 0 |
| get_installed | List installed skills | 0 |
| uninstall_skill | Remove installed skill | 1 |
| get_quality_breakdown | Quality score details | 1 |

### learning Tools (6)

| Tool | Purpose | Phase |
|------|---------|-------|
| get_path | Get learning path for skill | 1 |
| next_exercise | Get next exercise | 1 |
| submit_solution | Submit solution for validation | 1 |
| validate_solution | Check solution correctness | 1 |
| get_progress | Get learning progress | 1 |
| get_hint | Get hint for current exercise | 1 |

### sync Tools (5)

| Tool | Purpose | Phase |
|------|---------|-------|
| refresh_index | Trigger incremental sync | 1 |
| get_sync_status | Get sync progress/status | 1 |
| force_full_sync | Force full index rebuild | 1 |
| get_source_health | Check external source status | 1 |
| update_blocklist | Refresh blocklist | 1 |

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [Backend API Architecture](../architecture/backend-api.md) | Architecture source |
| [MCP Tool Specs](./artifacts/mcp-tool-specs.md) | Tool specifications |
| [API Contracts](./artifacts/api-contracts.md) | Interface contracts |
| [Error Codes](./artifacts/error-codes.md) | Error handling |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 26, 2025 | Backend Specialist | Initial implementation plan |
