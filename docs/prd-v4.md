# Skillsmith - Product Requirements Document v4

**Version:** 4.0
**Last Updated:** January 6, 2026
**Status:** Active - Critical Path to Live Deployment
**Owner:** Product Team
**Document Type:** Source of Truth for Community Tier Launch

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| v4.0 | January 6, 2026 | Critical path focus for live deployment; Shreyas Doshi validation strategy |
| v3.2 | December 26, 2025 | Archived - CEO decisions, behavioral research |
| v3.0 | December 26, 2025 | Claude Discovery Hub original vision |

---

## 1. Executive Summary

### Where We Are

Skillsmith has completed Phase 5A - npm packages are **published and live**:
- `@skillsmith/core@0.1.2` - Core library ✅
- `@skillsmith/mcp-server@0.1.2` - MCP server ✅
- `@skillsmith/cli@0.1.2` (alias: `sklx`) - CLI tools ✅

**The Critical Gap:** Published packages use **local seed data** (5 test skills). Users cannot access the 9,717+ skills in our database.

### What This PRD Defines

The **critical path to live deployment** for user testing with real data, using Shreyas Doshi's framework to validate assumptions before investing in paid tiers.

### Key Strategy: Validate Before Monetize

Following Shreyas Doshi's principle: **Test assumptions with the smallest investment possible.**

We will NOT build Team/Enterprise features until we validate:
1. Users install the npm package (acquisition)
2. Users find relevant skills (activation)
3. Users install discovered skills (value delivery)
4. Users return to search again (retention)

---

## 2. Problem Statement

### Current State

```
┌─────────────────────────────────────────────────────────────────┐
│  TODAY: npm packages + local seed data                          │
│                                                                 │
│  User installs @skillsmith/mcp-server                           │
│       ↓                                                         │
│  User searches for skills                                       │
│       ↓                                                         │
│  Returns 5 test skills (seed data)  ❌ Not real value           │
│                                                                 │
│  We cannot validate product-market fit with fake data!          │
└─────────────────────────────────────────────────────────────────┘
```

### Target State

```
┌─────────────────────────────────────────────────────────────────┐
│  GOAL: npm packages + live skill registry                       │
│                                                                 │
│  User installs @skillsmith/mcp-server                           │
│       ↓                                                         │
│  User searches for skills                                       │
│       ↓                                                         │
│  Returns relevant skills from 9,717+ real skills  ✅            │
│       ↓                                                         │
│  User installs skill and improves their workflow  ✅            │
│       ↓                                                         │
│  We can measure real product-market fit!                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Shreyas Doshi Framework Analysis

### 3.1 LNO Framework (Leverage, Neutral, Overhead)

**High Leverage (Do First):**
| Activity | Impact | Why High Leverage |
|----------|--------|-------------------|
| Live skill registry API | Critical | Without this, product delivers no value |
| Basic telemetry | High | Can't validate assumptions without data |
| Error messaging | High | Bad DX = no adoption |
| Documentation | High | Reduces friction to adoption |

**Neutral (Do, but don't over-invest):**
| Activity | Impact | Why Neutral |
|----------|--------|-------------|
| Website marketing page | Medium | Nice to have, but CLI users don't need it |
| VS Code extension | Medium | Can wait until CLI validated |
| Fancy UI | Low | Not needed for technical validation |

**Overhead (Minimize or Defer):**
| Activity | Impact | Why Overhead |
|----------|--------|--------------|
| Stripe integration | None yet | No revenue without users |
| Enterprise SSO | None yet | No enterprises without adoption |
| Multi-tenant architecture | None yet | Premature optimization |
| Partner program | None yet | No partners without product-market fit |

### 3.2 Pre-Mortem: Why Live Deployment Could Fail

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **API hosting costs exceed budget** | Medium | High | Start with serverless (AWS Lambda + API Gateway), scale later |
| **Rate limits hit by power users** | High | Medium | Generous free tier, cached responses |
| **Database performance under load** | Medium | High | Read replicas, aggressive caching |
| **No organic discovery** | High | Critical | GitHub README badges, npm package description |
| **Skill quality perception poor** | Medium | High | Surface quality scores prominently |
| **Users blame us for skill failures** | High | High | Clear messaging: "Skill quality varies. Check scores." |

### 3.3 High-Leverage Decisions (Irreversible or Hard to Change)

**Decision 1: API Endpoint Location**
- **Options:** skillsmith.app/api vs api.skillsmith.app vs embedded in npm package
- **Recommendation:** `api.skillsmith.app` - dedicated subdomain, can scale independently
- **Why irreversible:** All npm packages will hard-code this URL

**Decision 2: Authentication Model for API**
- **Options:** No auth (anonymous) vs API key vs OAuth
- **Recommendation:** **No auth for read operations** - minimal friction
- **Why:** We want maximum adoption; auth adds friction for no benefit at this stage

**Decision 3: Telemetry Approach**
- **Options:** No telemetry vs Opt-in vs Opt-out
- **Recommendation:** **Opt-out with clear value proposition**
- **Why:** Need data to validate; opt-out is industry standard; transparent about what we collect

---

## 4. Critical Path to Live Deployment

### 4.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    LIVE DEPLOYMENT ARCHITECTURE                  │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────────┐     ┌──────────────────────────────────┐
│    npm packages      │     │         Hosted Services           │
│    (User's Machine)  │     │         (Our Infrastructure)      │
├──────────────────────┤     ├──────────────────────────────────┤
│                      │     │                                   │
│  @skillsmith/cli     │     │   ┌────────────────────────────┐ │
│       ↓              │     │   │   API Gateway (Vercel)     │ │
│  @skillsmith/        │────▶│   │   api.skillsmith.app        │ │
│  mcp-server          │     │   └──────────────┬─────────────┘ │
│       ↓              │     │                  │               │
│  @skillsmith/core    │     │   ┌──────────────▼─────────────┐ │
│                      │     │   │   Supabase                  │ │
│                      │     │   │   - PostgreSQL (skills DB)  │ │
│                      │     │   │   - Edge Functions          │ │
│                      │     │   │   - Analytics (PostHog)     │ │
│                      │     │   └────────────────────────────┘ │
│                      │     │                                   │
└──────────────────────┘     └──────────────────────────────────┘
```

### 4.2 Minimum Viable Live Deployment (Phase 6A)

**Goal:** Get real skills into real users' hands with telemetry.

| Component | Status | Required For Launch | Notes |
|-----------|--------|---------------------|-------|
| Skill Registry API | 🔴 Not built | Yes | Core requirement |
| Supabase Database | 🔴 Not configured | Yes | Host 9,717+ skills |
| API Domain (api.skillsmith.app) | 🔴 Not configured | Yes | Stable endpoint |
| npm Package Update (v0.2.0) | 🔴 Not built | Yes | Point to live API |
| Basic Telemetry | 🔴 Not built | Yes | Validate assumptions |
| GitHub Indexer (scheduled) | 🟡 Built, not deployed | Recommended | Keep skills fresh |
| Landing Page | 🟢 Low priority | No | Users come from npm |
| Marketing Site | 🟢 Low priority | No | Defer until validated |

### 4.3 Phase 6A Issues (Critical Path)

**New Issues Required:**

| Issue | Title | Priority | Effort | Dependency |
|-------|-------|----------|--------|------------|
| SMI-NEW-1 | Deploy Supabase project for skill registry | P0 | 4h | None |
| SMI-NEW-2 | Create skill registry API endpoints | P0 | 16h | SMI-NEW-1 |
| SMI-NEW-3 | Migrate skills database to Supabase | P0 | 8h | SMI-NEW-1 |
| SMI-NEW-4 | Configure api.skillsmith.app domain | P0 | 2h | SMI-NEW-2 |
| SMI-NEW-5 | Update npm packages to use live API | P0 | 8h | SMI-NEW-4 |
| SMI-NEW-6 | Add basic telemetry (PostHog) | P1 | 8h | SMI-NEW-2 |
| SMI-NEW-7 | Deploy GitHub indexer as scheduled job | P2 | 8h | SMI-NEW-3 |
| SMI-NEW-8 | Publish v0.2.0 to npm | P0 | 2h | SMI-NEW-5 |

**Total Effort:** ~56 hours (1.5 weeks focused work)

### 4.4 API Endpoints Required

```typescript
// Minimum viable API for v0.2.0
interface SkillRegistryAPI {
  // Search skills - primary use case
  'GET /v1/skills/search': {
    query: string;
    category?: string;
    trust_tier?: 'verified' | 'community' | 'experimental';
    limit?: number;
  } => Skill[];

  // Get skill details
  'GET /v1/skills/:id': {
    id: string;
  } => Skill;

  // Get recommendations (based on project context)
  'POST /v1/skills/recommend': {
    stack: string[];
    project_type?: string;
  } => Skill[];

  // Telemetry (opt-out)
  'POST /v1/events': {
    event: 'search' | 'view' | 'install' | 'uninstall';
    skill_id?: string;
    anonymous_id: string;
  } => { ok: boolean };
}
```

---

## 5. Validation Metrics

### 5.1 Assumptions to Validate

| Assumption | How to Measure | Target | Decision Trigger |
|------------|----------------|--------|------------------|
| **A1:** Developers want skill discovery | npm downloads | 500+ in first month | If <100, pivot messaging |
| **A2:** Search returns useful results | Search → view ratio | >30% | If <10%, improve relevance |
| **A3:** Users install discovered skills | View → install ratio | >20% | If <5%, skill quality issue |
| **A4:** Users return for more | Weekly active users | >100 by month 2 | If <20, retention problem |
| **A5:** Users recommend to others | Source of discovery | >20% referral | Organic growth signal |

### 5.2 Telemetry Events

```typescript
// Events to capture (all anonymous, opt-out available)
type TelemetryEvent =
  | { event: 'search'; query: string; results_count: number }
  | { event: 'view_skill'; skill_id: string; source: 'search' | 'recommend' }
  | { event: 'install_skill'; skill_id: string }
  | { event: 'uninstall_skill'; skill_id: string; days_installed: number }
  | { event: 'recommend_request'; stack: string[] }
  | { event: 'error'; type: string; message: string };
```

### 5.3 Go/No-Go Gates

**Gate 1: 2 Weeks Post-Launch**
| Metric | Proceed | Investigate | Stop |
|--------|---------|-------------|------|
| npm downloads | >200 | 50-200 | <50 |
| Daily active users | >20 | 5-20 | <5 |
| API errors | <1% | 1-5% | >5% |

**Gate 2: 4 Weeks Post-Launch**
| Metric | Proceed to Team Tier | Continue Free | Pivot |
|--------|---------------------|---------------|-------|
| npm downloads | >1000 | 500-1000 | <500 |
| Weekly active users | >100 | 50-100 | <50 |
| Install rate | >20% | 10-20% | <10% |
| NPS (survey) | >30 | 10-30 | <10 |

---

## 6. Tech Stack for Live Deployment

### 6.1 Infrastructure Choices

| Component | Technology | Why | Monthly Cost |
|-----------|------------|-----|--------------|
| **Database** | Supabase (PostgreSQL) | Free tier generous, built-in auth later | $0-25 |
| **API** | Supabase Edge Functions | Serverless, scales automatically | $0-10 |
| **Domain** | skillsmith.app (existing) | Already owned | $0 |
| **CDN** | Cloudflare (free) | Caching, DDoS protection | $0 |
| **Telemetry** | PostHog (free tier) | Self-hostable, generous limits | $0 |
| **CI/CD** | GitHub Actions (existing) | Already configured | $0 |
| **Monitoring** | Supabase Dashboard + PostHog | Built-in | $0 |

**Total Estimated Cost:** $0-35/month (free tier focused)

### 6.2 Why Supabase

| Feature | Benefit |
|---------|---------|
| **Free tier** | 500MB database, 50K monthly active users |
| **PostgreSQL** | We already have SQLite schema, easy migration |
| **Edge Functions** | Serverless API without managing servers |
| **Built-in auth** | Can add auth later for Team tier |
| **Realtime** | Could enable live updates later |
| **PostgREST** | Auto-generates REST API from schema |

### 6.3 Migration Path

```
Current State          →  Phase 6A           →  Phase 6B (if validated)
─────────────────────────────────────────────────────────────────────────
SQLite (local)         →  Supabase           →  Supabase + Read Replicas
Local seed data (5)    →  Full import (9717) →  Continuous indexing
No telemetry           →  PostHog basic      →  Custom analytics
No auth                →  No auth            →  JWT auth for Team tier
$0/month               →  $0-35/month        →  $50-200/month
```

---

## 7. What We're NOT Building (Yet)

Per Shreyas Doshi's LNO framework, these are **Overhead** until we validate assumptions:

### Deferred to Post-Validation (Phase 6B+)

| Feature | Original Plan | Why Deferred |
|---------|---------------|--------------|
| Marketing website | SMI-1155-1160 | Users come from npm, not marketing |
| Stripe integration | SMI-1062 | No revenue until adoption proven |
| User registration | SMI-1168-1171 | Not needed for anonymous API |
| Team workspaces | SMI-1161-1167 | Enterprise feature, premature |
| License validation | SMI-1053 | Only needed for paid features |
| VS Code extension | ROADMAP | CLI validation first |
| Learning platform | PRD-V3 Phase 4 | Out of scope |

### Will Build Only If Metrics Hit Targets

| Feature | Trigger Metric | When |
|---------|----------------|------|
| Marketing website | >1000 npm downloads | After Gate 2 |
| User registration | >100 WAU requesting features | After Gate 2 |
| Team features | >10 enterprise inquiries | Q2 2026 |
| Stripe billing | Team feature demand confirmed | Q2 2026 |

---

## 8. Launch Plan

### 8.1 Pre-Launch Checklist

- [ ] Supabase project created and configured
- [ ] Skills database migrated (9,717+ skills)
- [ ] API endpoints tested and documented
- [ ] api.skillsmith.app DNS configured
- [ ] npm packages updated to v0.2.0
- [ ] Telemetry verified working
- [ ] Error handling tested
- [ ] README updated with live usage
- [ ] GitHub Discussions enabled for feedback

### 8.2 Launch Sequence

**Day 0: Soft Launch**
- Publish v0.2.0 to npm
- Test with internal team
- Monitor error rates

**Day 1-3: Limited Release**
- Announce in project README
- Post in Claude Code Discord/community
- Monitor telemetry

**Day 7: Public Announcement**
- Post on Twitter/X
- Post on Hacker News (Show HN)
- Post on Reddit (r/ClaudeAI, r/LocalLLaMA)

**Day 14: Gate 1 Review**
- Review metrics
- Decide: proceed, investigate, or pivot

### 8.3 Success Communication

If Gate 1 passes, share:
- "X developers searched for skills in week 1"
- "Y skills installed via Skillsmith"
- "Top searched categories: testing, git, documentation"

This builds social proof for organic growth.

---

## 9. Risk Mitigation

### 9.1 Technical Risks

| Risk | Mitigation |
|------|------------|
| Supabase outage | Cached responses in npm package (24h TTL) |
| API rate limits | Generous limits + local caching |
| Database size limits | Pagination, lazy loading |
| Cold start latency | Keep-alive pings, edge functions |

### 9.2 Business Risks

| Risk | Mitigation |
|------|------------|
| No adoption | Clear error messages, good docs |
| Negative feedback | GitHub Discussions for direct feedback |
| Support burden | FAQ in README, community-driven |

### 9.3 Competitive Risks

| Risk | Mitigation |
|------|------------|
| Anthropic launches marketplace | Position as community alternative |
| skillsmp.com gains traction | Differentiate on MCP integration |

---

## 10. Summary: Critical Path

```
┌─────────────────────────────────────────────────────────────────┐
│                    CRITICAL PATH TO LIVE                         │
│                                                                  │
│  Week 1: Infrastructure                                          │
│  ├── Deploy Supabase project                                     │
│  ├── Migrate skills database                                     │
│  └── Configure api.skillsmith.app                                 │
│                                                                  │
│  Week 2: Integration                                             │
│  ├── Create API endpoints                                        │
│  ├── Update npm packages                                         │
│  ├── Add telemetry                                               │
│  └── Publish v0.2.0                                              │
│                                                                  │
│  Week 3-4: Soft Launch + Gate 1                                  │
│  ├── Internal testing                                            │
│  ├── Limited release                                             │
│  ├── Monitor metrics                                             │
│  └── Gate 1 decision                                             │
│                                                                  │
│  Week 5-8: Public Launch + Gate 2                                │
│  ├── Public announcement                                         │
│  ├── Community feedback                                          │
│  ├── Iterate based on data                                       │
│  └── Gate 2 decision: proceed to paid tiers?                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 11. Decision Log

| Decision | Choice | Rationale | Date |
|----------|--------|-----------|------|
| API hosting | Supabase Edge Functions | Free tier, serverless, scales | Jan 6, 2026 |
| Database | Supabase PostgreSQL | Free tier, familiar, migration path | Jan 6, 2026 |
| Auth for API | None (anonymous reads) | Maximum adoption, no friction | Jan 6, 2026 |
| Telemetry | PostHog, opt-out | Need data, industry standard | Jan 6, 2026 |
| Marketing site | Deferred | Validate CLI adoption first | Jan 6, 2026 |
| Paid features | Deferred | Validate free tier first | Jan 6, 2026 |

---

## Appendix A: Related Documents

| Document | Location | Status |
|----------|----------|--------|
| PRD-V3 (archived) | `/docs/archive/prd-v3.md` | Archived |
| Go-to-Market Analysis | `/skillsmith/docs/strategy/go-to-market-analysis.md` | Reference |
| Roadmap 2026 | `/skillsmith/docs/strategy/ROADMAP.md` | Reference |
| Phase 6 Issues | Linear (SMI-1155 to SMI-1178) | Deprioritized |
| npm Publishing Plan | `/skillsmith/docs/publishing/npm-setup.md` | Complete |

---

## Appendix B: Shreyas Doshi Frameworks Used

### LNO Framework
- **L (Leverage):** Live API, telemetry - disproportionate impact
- **N (Neutral):** Documentation, error messages - necessary but not differentiating
- **O (Overhead):** Stripe, marketing site - premature investment

### Pre-Mortem
- Identified key failure modes before building
- Mitigations built into architecture (caching, monitoring)

### High-Leverage Decisions
- API endpoint URL: hard to change, decided early
- Auth model: affects all users, decided for simplicity
- Telemetry: affects privacy perception, decided for opt-out

---

*This PRD supersedes PRD-V3 for active development. PRD-V3 is archived for historical reference.*
