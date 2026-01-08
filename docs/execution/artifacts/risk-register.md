# Implementation Risk Register

**Document Type:** Implementation Artifact
**Version:** 1.0
**Date:** December 26, 2025
**Owner:** Engineering Lead
**Status:** Active - Review Weekly

---

## Table of Contents

1. [Overview](#1-overview)
2. [Risk Scoring Framework](#2-risk-scoring-framework)
3. [Critical Risks](#3-critical-risks)
4. [High Risks](#4-high-risks)
5. [Medium Risks](#5-medium-risks)
6. [Risk by Domain](#6-risk-by-domain)
7. [Risk Monitoring](#7-risk-monitoring)
8. [Risk Response Procedures](#8-risk-response-procedures)
9. [Risk History](#9-risk-history)

---

## 1. Overview

### Purpose

This risk register tracks implementation risks for Skillsmith across all phases. It is the single source of truth for risk identification, assessment, and mitigation tracking.

### Scope

| In Scope | Out of Scope |
|----------|--------------|
| Technical implementation risks | Business model risks |
| Security vulnerabilities | Market adoption risks |
| Infrastructure failures | Competitive risks |
| Delivery/schedule risks | Legal/regulatory risks |
| Integration risks | Partnership risks |

*Note: Business and GTM risks are tracked in `/docs/gtm/risks.md`*

### Risk Categories

| Category | Code | Owner |
|----------|------|-------|
| Technical Architecture | TA | Engineering Lead |
| Data Architecture | DA | Data Architect |
| Security | SEC | Security Specialist |
| Infrastructure | INFRA | DevOps Specialist |
| Backend/MCP | MCP | Backend Specialist |
| Frontend/IDE | FE | Frontend Specialist |
| Quality/Testing | QA | QA Specialist |
| Delivery/Schedule | DEL | Development Manager |

---

## 2. Risk Scoring Framework

### Probability Scale

| Level | Score | Definition | Indicators |
|-------|-------|------------|------------|
| Very Low | 1 | <10% chance | No history, unlikely scenario |
| Low | 2 | 10-30% chance | Rare occurrence, strong controls |
| Medium | 3 | 30-60% chance | Has happened before, partial controls |
| High | 4 | 60-90% chance | Common occurrence, weak controls |
| Very High | 5 | >90% chance | Expected to occur, no controls |

### Impact Scale

| Level | Score | Schedule | Cost | Quality | Security |
|-------|-------|----------|------|---------|----------|
| Very Low | 1 | <1 day | <$100 | Minor bug | Cosmetic |
| Low | 2 | 1-3 days | $100-$1K | Usability issue | Minor data |
| Medium | 3 | 1-2 weeks | $1K-$10K | Feature degraded | User data exposed |
| High | 4 | 2-4 weeks | $10K-$50K | Feature unusable | System compromise |
| Critical | 5 | >1 month | >$50K | System unusable | Full breach |

### Risk Score Matrix

```
                    IMPACT
              1    2    3    4    5
         +---+----+----+----+----+----+
       5 | 5 | 10 | 15 | 20 | 25 |  ← Very High
         +---+----+----+----+----+----+
       4 | 4 |  8 | 12 | 16 | 20 |  ← High
 PROB  +---+----+----+----+----+----+
       3 | 3 |  6 |  9 | 12 | 15 |  ← Medium
         +---+----+----+----+----+----+
       2 | 2 |  4 |  6 |  8 | 10 |  ← Low
         +---+----+----+----+----+----+
       1 | 1 |  2 |  3 |  4 |  5 |  ← Very Low
         +---+----+----+----+----+----+

Score 1-4:   ACCEPT   - Monitor only
Score 5-9:   MITIGATE - Active mitigation plan
Score 10-15: ESCALATE - Weekly leadership review
Score 16-25: CRITICAL - Immediate action required
```

---

## 3. Critical Risks (Score 16-25)

### RISK-001: MCP SDK Breaking Changes

| Field | Value |
|-------|-------|
| **ID** | RISK-001 |
| **Category** | Technical Architecture (TA) |
| **Description** | Anthropic releases MCP SDK update with breaking changes that require significant refactoring |
| **Probability** | Medium (3) |
| **Impact** | Critical (5) |
| **Score** | **15** |
| **Status** | ACTIVE |
| **Owner** | Engineering Lead |
| **Affected Epics** | TA-001, MCP-001, MCP-002, MCP-003 |

**Root Cause:**
- MCP is a new protocol, still evolving
- No stability guarantees from Anthropic
- Heavy dependency on MCP for all functionality

**Impact Analysis:**
- All 23 MCP tools would need updates
- Potential API contract changes
- User migration complexity

**Mitigation Plan:**

| # | Mitigation | Status | Reduces To |
|---|------------|--------|------------|
| 1 | Pin MCP SDK version in package.json | Complete | - |
| 2 | Create abstraction layer over MCP SDK | Planned | Score 10 |
| 3 | Monitor MCP SDK releases and changelogs | Ongoing | - |
| 4 | Maintain relationship with Anthropic DevRel | Planned | - |
| 5 | Document internal migration runbook | Not Started | - |

**Early Warning Indicators:**
- MCP SDK release notes mention deprecations
- Anthropic blog announces protocol changes
- Community reports compatibility issues

**Contingency Plan:**
- If breaking change announced: Allocate 2 sprints for migration
- If no abstraction layer: Double migration time estimate

---

### RISK-002: GitHub API Rate Limiting

| Field | Value |
|-------|-------|
| **ID** | RISK-002 |
| **Category** | Data Architecture (DA) |
| **Description** | GitHub API rate limits prevent timely index updates, causing stale skill data |
| **Probability** | High (4) |
| **Impact** | High (4) |
| **Score** | **16** |
| **Status** | ACTIVE |
| **Owner** | Backend Specialist |
| **Affected Epics** | DA-003, INFRA-003, PROD-101 |

**Root Cause:**
- GitHub REST API: 5,000 requests/hour (authenticated)
- GitHub Search API: 30 requests/minute
- 50K+ skills require significant API calls
- Multiple sources of skill updates

**Impact Analysis:**
- Index becomes stale (>24 hours behind)
- New skills not discoverable
- Quality scores outdated
- User trust eroded

**Mitigation Plan:**

| # | Mitigation | Status | Reduces To |
|---|------------|--------|------------|
| 1 | Token rotation (3+ GitHub PATs) | Planned | Score 12 |
| 2 | Use GitHub Events API for incremental updates | Planned | Score 9 |
| 3 | Aggressive caching (24-hour TTL) | Planned | - |
| 4 | Conditional requests (If-Modified-Since) | Planned | - |
| 5 | GraphQL API for batch queries | Not Started | Score 8 |

**Early Warning Indicators:**
- Rate limit headers show <20% remaining
- Sync jobs failing with 403 responses
- Index freshness >24 hours

**Contingency Plan:**
- If rate limited: Switch to cached-only mode
- If persistent: Request GitHub API quota increase
- If denied: Reduce sync frequency to weekly

---

### RISK-003: Security Scanner False Positives

| Field | Value |
|-------|-------|
| **ID** | RISK-003 |
| **Category** | Security (SEC) |
| **Description** | Security scanner incorrectly flags legitimate skills as malicious, blocking valid installations |
| **Probability** | High (4) |
| **Impact** | High (4) |
| **Score** | **16** |
| **Status** | ACTIVE |
| **Owner** | Security Specialist |
| **Affected Epics** | SEC-101, SEC-102, SEC-103, SEC-107, PROD-107 |

**Root Cause:**
- Pattern-based detection is inherently noisy
- Natural language instructions overlap with jailbreak patterns
- URL patterns may match legitimate educational content
- Skill ecosystem lacks standardization

**Impact Analysis:**
- Users frustrated by blocked legitimate skills
- Trust in security system eroded
- Support burden increases
- Skill authors discouraged from contributing

**Mitigation Plan:**

| # | Mitigation | Status | Reduces To |
|---|------------|--------|------------|
| 1 | Tunable sensitivity thresholds | Planned | Score 12 |
| 2 | Manual override with warning | Planned | Score 10 |
| 3 | Appeal process for flagged skills | Planned | - |
| 4 | Verified author bypass for trusted sources | Planned | Score 8 |
| 5 | Continuous pattern refinement based on feedback | Ongoing | - |

**Early Warning Indicators:**
- False positive rate >5% in testing
- User complaints about blocked skills
- Popular skills incorrectly flagged

**Contingency Plan:**
- If FP rate >10%: Reduce to warning-only mode
- If >20%: Disable scanner pending retuning
- If persists: Consider ML-based approach

---

## 4. High Risks (Score 10-15)

### RISK-004: Scraper Breakage

| Field | Value |
|-------|-------|
| **ID** | RISK-004 |
| **Category** | Infrastructure (INFRA) |
| **Description** | Aggregator sites (SkillsMP, claude-plugins.dev, mcp.so) change structure, breaking scrapers |
| **Probability** | High (4) |
| **Impact** | Medium (3) |
| **Score** | **12** |
| **Status** | ACTIVE |
| **Owner** | Backend Specialist |
| **Affected Epics** | DA-003, INFRA-003 |

**Mitigation Plan:**

| # | Mitigation | Status |
|---|------------|--------|
| 1 | Multiple independent sources (redundancy) | Planned |
| 2 | Graceful degradation (continue with working sources) | Planned |
| 3 | Source health monitoring with alerts | Planned |
| 4 | Reach out to aggregator maintainers for API access | Not Started |

**Contingency:** GitHub remains primary source; aggregators are supplementary.

---

### RISK-005: SQLite Performance at Scale

| Field | Value |
|-------|-------|
| **ID** | RISK-005 |
| **Category** | Data Architecture (DA) |
| **Description** | SQLite performance degrades with 50K+ skills and complex queries |
| **Probability** | Low (2) |
| **Impact** | Critical (5) |
| **Score** | **10** |
| **Status** | MONITORING |
| **Owner** | Data Architect |
| **Affected Epics** | DA-001, DA-002, TA-002 |

**Mitigation Plan:**

| # | Mitigation | Status |
|---|------------|--------|
| 1 | Benchmark with 100K skills before Phase 1 | Planned |
| 2 | Optimize indexes and query plans | Planned |
| 3 | FTS5 tuning for search performance | Planned |
| 4 | Memory-mapped I/O (PRAGMA mmap_size) | Planned |

**Contingency:** If SQLite fails at scale, evaluate better-sqlite3 alternatives or PostgreSQL.

---

### RISK-006: Cold Start Performance

| Field | Value |
|-------|-------|
| **ID** | RISK-006 |
| **Category** | Technical Architecture (TA) |
| **Description** | MCP server cold start exceeds 5-second budget, degrading UX |
| **Probability** | Medium (3) |
| **Impact** | High (4) |
| **Score** | **12** |
| **Status** | ACTIVE |
| **Owner** | Engineering Lead |
| **Affected Epics** | TA-001, MCP-001 |

**Mitigation Plan:**

| # | Mitigation | Status |
|---|------------|--------|
| 1 | Lazy loading for embeddings | Planned |
| 2 | Parallel initialization | Planned |
| 3 | Startup profiling and optimization | Planned |
| 4 | Pre-warm option for power users | Not Started |

---

### RISK-007: Native Module Build Failures

| Field | Value |
|-------|-------|
| **ID** | RISK-007 |
| **Category** | Infrastructure (INFRA) |
| **Description** | better-sqlite3 native module fails to build on some platforms |
| **Probability** | Medium (3) |
| **Impact** | High (4) |
| **Score** | **12** |
| **Status** | ACTIVE |
| **Owner** | DevOps Specialist |
| **Affected Epics** | INFRA-001 |

**Mitigation Plan:**

| # | Mitigation | Status |
|---|------------|--------|
| 1 | Pre-built binaries for common platforms | Planned |
| 2 | Pure JS fallback (sql.js) | Planned |
| 3 | Docker-based installation option | Not Started |
| 4 | Clear error messages with troubleshooting | Planned |

---

### RISK-008: Embedding Model Size

| Field | Value |
|-------|-------|
| **ID** | RISK-008 |
| **Category** | Data Architecture (DA) |
| **Description** | Embedding model or embeddings.bin too large for npm package |
| **Probability** | Medium (3) |
| **Impact** | Medium (3) |
| **Score** | **9** |
| **Status** | MONITORING |
| **Owner** | Data Architect |
| **Affected Epics** | DA-005, INFRA-001 |

**Mitigation Plan:**

| # | Mitigation | Status |
|---|------------|--------|
| 1 | Use quantized model (all-MiniLM-L6-v2-q4) | Planned |
| 2 | Lazy download embeddings on first semantic search | Planned |
| 3 | CDN-hosted embeddings with local cache | Planned |

---

## 5. Medium Risks (Score 5-9)

### RISK-009: Index Sync Conflicts

| Field | Value |
|-------|-------|
| **ID** | RISK-009 |
| **Category** | Data Architecture (DA) |
| **Score** | **6** |
| **Owner** | Data Architect |

**Description:** Concurrent index syncs cause data corruption or inconsistency.

**Mitigation:** SQLite WAL mode, sync locking, atomic updates.

---

### RISK-010: VS Code Marketplace Rejection

| Field | Value |
|-------|-------|
| **ID** | RISK-010 |
| **Category** | Frontend (FE) |
| **Score** | **6** |
| **Owner** | Frontend Specialist |

**Description:** VS Code extension rejected from marketplace due to policy violation.

**Mitigation:** Review marketplace guidelines early, submit for pre-review.

---

### RISK-011: Telemetry Privacy Backlash

| Field | Value |
|-------|-------|
| **ID** | RISK-011 |
| **Category** | Security (SEC) |
| **Score** | **9** |
| **Owner** | Security Specialist |

**Description:** Users perceive telemetry as invasive despite opt-out design.

**Mitigation:** Clear privacy notice, transparent data collection, easy opt-out.

---

### RISK-012: Test Coverage Gaps

| Field | Value |
|-------|-------|
| **ID** | RISK-012 |
| **Category** | Quality (QA) |
| **Score** | **6** |
| **Owner** | QA Specialist |

**Description:** Critical code paths untested, leading to production bugs.

**Mitigation:** Coverage thresholds in CI, code review checklist, mutation testing.

---

### RISK-013: Dependency Vulnerabilities

| Field | Value |
|-------|-------|
| **ID** | RISK-013 |
| **Category** | Security (SEC) |
| **Score** | **8** |
| **Owner** | Security Specialist |

**Description:** npm dependencies have known vulnerabilities.

**Mitigation:** Dependabot, npm audit in CI, minimal dependencies.

---

### RISK-014: Documentation Drift

| Field | Value |
|-------|-------|
| **ID** | RISK-014 |
| **Category** | Delivery (DEL) |
| **Score** | **6** |
| **Owner** | Development Manager |

**Description:** Implementation diverges from documented architecture.

**Mitigation:** Architecture decision records, PR checklist, periodic audits.

---

## 6. Risk by Domain

### Technical Architecture Risks

| ID | Risk | Score | Status |
|----|------|-------|--------|
| RISK-001 | MCP SDK Breaking Changes | 15 | Active |
| RISK-006 | Cold Start Performance | 12 | Active |

### Data Architecture Risks

| ID | Risk | Score | Status |
|----|------|-------|--------|
| RISK-002 | GitHub API Rate Limiting | 16 | Active |
| RISK-005 | SQLite Performance at Scale | 10 | Monitoring |
| RISK-008 | Embedding Model Size | 9 | Monitoring |
| RISK-009 | Index Sync Conflicts | 6 | Monitoring |

### Security Risks

| ID | Risk | Score | Status |
|----|------|-------|--------|
| RISK-003 | Security Scanner False Positives | 16 | Active |
| RISK-011 | Telemetry Privacy Backlash | 9 | Monitoring |
| RISK-013 | Dependency Vulnerabilities | 8 | Monitoring |

### Infrastructure Risks

| ID | Risk | Score | Status |
|----|------|-------|--------|
| RISK-004 | Scraper Breakage | 12 | Active |
| RISK-007 | Native Module Build Failures | 12 | Active |

### Frontend Risks

| ID | Risk | Score | Status |
|----|------|-------|--------|
| RISK-010 | VS Code Marketplace Rejection | 6 | Monitoring |

### Quality Risks

| ID | Risk | Score | Status |
|----|------|-------|--------|
| RISK-012 | Test Coverage Gaps | 6 | Monitoring |

### Delivery Risks

| ID | Risk | Score | Status |
|----|------|-------|--------|
| RISK-014 | Documentation Drift | 6 | Monitoring |

---

## 7. Risk Monitoring

### Weekly Risk Review Checklist

```markdown
## Risk Review - Week of [DATE]

### Critical/High Risks (Score >= 10)
- [ ] RISK-001: MCP SDK - Check for new releases
- [ ] RISK-002: GitHub API - Check rate limit usage
- [ ] RISK-003: Security Scanner - Review false positive reports
- [ ] RISK-004: Scrapers - Check source health dashboard
- [ ] RISK-006: Cold Start - Review startup metrics
- [ ] RISK-007: Native Modules - Check build failure reports

### New Risks Identified
- [ ] [List any new risks discovered this week]

### Risk Score Changes
- [ ] [List any risks with changed probability/impact]

### Mitigation Progress
- [ ] [Update status of in-progress mitigations]

### Escalations Required
- [ ] [List any risks requiring leadership attention]
```

### Monitoring Dashboard Metrics

| Metric | Source | Threshold | Alert |
|--------|--------|-----------|-------|
| MCP SDK Version | npm registry | New major version | Slack #dev |
| GitHub API Rate | Sync logs | <20% remaining | PagerDuty |
| Security FP Rate | User feedback | >5% | Slack #security |
| Scraper Success | Health check | <80% success | Slack #backend |
| Cold Start Time | Startup logs | >5 seconds | Slack #dev |
| Build Failures | CI logs | >3% of installs | Slack #devops |

---

## 8. Risk Response Procedures

### Risk Materialization Playbook

#### Level 1: Score 1-9 (Low/Medium)

1. **Document** the occurrence in this register
2. **Assess** if score needs updating
3. **Continue** normal operations
4. **Review** at next weekly meeting

#### Level 2: Score 10-15 (High)

1. **Alert** risk owner immediately
2. **Convene** impacted team within 4 hours
3. **Activate** contingency plan if available
4. **Update** stakeholders daily
5. **Document** learnings after resolution

#### Level 3: Score 16-25 (Critical)

1. **Alert** Engineering Lead and PM immediately
2. **Convene** war room within 1 hour
3. **Halt** affected deployments
4. **Activate** contingency plan
5. **Communicate** to stakeholders every 4 hours
6. **Post-mortem** within 48 hours of resolution

### Escalation Matrix

| Score | Escalate To | Response Time |
|-------|-------------|---------------|
| 16-25 | Engineering Lead + PM | 1 hour |
| 10-15 | Domain Owner | 4 hours |
| 5-9 | Team Lead | 24 hours |
| 1-4 | Self-manage | Weekly review |

---

## 9. Risk History

### Closed Risks

| ID | Risk | Closed Date | Resolution |
|----|------|-------------|------------|
| - | - | - | No closed risks yet |

### Risk Trend

```
Phase 0 Start: 14 risks identified
├── Critical: 0
├── High: 3
├── Medium: 8
└── Low: 3

[Update after each phase gate]
```

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [GTM Risks](/docs/gtm/risks.md) | Business/market risks |
| [Dependency Map](./dependency-map.md) | Risk cascade analysis |
| [Milestones & Sprints](../09-milestones-sprints.md) | Phase risk summary |
| [Security Implementation](../06-security.md) | Security risk details |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 26, 2025 | Engineering Lead | Initial risk register |

---

*This document should be reviewed weekly and updated when:*
- *New risks are identified*
- *Risk scores change*
- *Mitigations are completed*
- *Risks materialize*

*Next Review: [First Monday of implementation]*
