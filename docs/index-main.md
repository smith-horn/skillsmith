# Claude Discovery Hub - Documentation Index

> **For Claude Agents**: This is the top-level navigation for all project documentation.
> Start here to find the right document for your task.

---

## Quick Navigation

| Document | Purpose | When to Use |
|----------|---------|-------------|
| [PRD v3](./prd-v3.md) | Product requirements, phasing, success metrics | Understanding WHAT we're building |
| [Design](./design/index.md) | Personas, journeys, UX, tone of voice | Understanding HOW users experience it |
| [Technical](./technical/index.md) | Architecture, security, data, API | Understanding HOW it works |
| [GTM](./gtm/index.md) | Distribution, growth, launch plan | Understanding HOW we reach users |

---

## Document Hierarchy

```
docs/
├── index.md              # You are here
├── prd-v3.md             # Product Requirements (source of truth for WHAT)
│
├── design/               # Experience Design
│   ├── index.md          # Design navigation
│   ├── overview.md       # Design principles
│   ├── personas/         # User personas (6 detailed profiles)
│   ├── journeys/         # User journeys (4 complete flows)
│   ├── moments/          # Key moments (trust + delight)
│   ├── failure-states.md # Error handling design
│   ├── tone-of-voice.md  # System voice guidelines
│   ├── entry-points.md   # Multi-surface strategy
│   ├── progressive-disclosure.md
│   └── accessibility.md
│
├── technical/            # Technical Design
│   ├── index.md          # Technical navigation
│   ├── overview.md       # Architecture overview
│   ├── components/       # MCP servers, scanner, auditor
│   ├── security/         # Threat model, trust tiers, conflicts
│   ├── data/             # Schema, sync, caching
│   ├── scoring/          # Quality algorithm
│   ├── api/              # MCP tools, error handling
│   ├── performance.md
│   ├── testing.md
│   ├── observability.md
│   ├── technical-debt.md
│   ├── decisions.md
│   └── open-questions.md
│
├── gtm/                  # Go-To-Market Strategy
│   ├── index.md          # GTM navigation
│   ├── strategy-overview.md
│   ├── channels/         # Launch, sustainable, partnership
│   ├── funnel/           # Awareness, activation, retention
│   ├── metrics.md
│   ├── experiments.md
│   └── risks.md
│
├── research/             # Research Documents
│   ├── index.md                         # Research navigation
│   ├── skill-activation-failure-rca.md  # Why 50% of skills fail
│   ├── skill-conflicts-security.md      # Conflicts and security
│   ├── design-entry-points.md           # Multi-surface research
│   ├── quality-scoring.md               # Scoring algorithm research
│   ├── download-counts-api.md           # Data source research
│   └── telemetry-consent.md             # Privacy/consent research
│
├── reviews/              # Expert Reviews
│   ├── product_review.md       # Convergence summary
│   ├── vp_product_review.md
│   ├── vp_engineering_review.md
│   ├── growth_engineer_review.md
│   └── design_director_review.md
│
└── archive/              # OUTDATED - Do not use
    ├── index.md          # Warning for agents
    └── [archived docs]
```

---

## By Task

### Product Questions
- "What are we building?" → [PRD v3](./prd-v3.md)
- "What's in scope for Phase 1?" → [PRD v3 - Phased Roadmap](./prd-v3.md#5-phased-roadmap)
- "What are the success metrics?" → [PRD v3 - Goals](./prd-v3.md#3-goals-and-success-metrics)

### Design Questions
- "Who are our users?" → [Personas](./design/personas/index.md)
- "How does onboarding work?" → [First Discovery Journey](./design/journeys/first-discovery.md)
- "How should error messages sound?" → [Tone of Voice](./design/tone-of-voice.md)
- "What happens when search fails?" → [Failure States](./design/failure-states.md)

### Technical Questions
- "How is it architected?" → [Technical Overview](./technical/overview.md)
- "How do MCP servers work?" → [MCP Servers](./technical/components/mcp-servers.md)
- "How is security handled?" → [Security Index](./technical/security/index.md)
- "What's the scoring algorithm?" → [Scoring Algorithm](./technical/scoring/algorithm.md)

### Growth Questions
- "What's the launch plan?" → [GTM Overview](./gtm/strategy-overview.md)
- "What channels are we using?" → [Channels](./gtm/channels/index.md)
- "What metrics matter?" → [Metrics](./gtm/metrics.md)

### Research Questions
- "Why do skills fail to activate?" → [Activation RCA](./research/skill-activation-failure-rca.md)
- "What security risks exist?" → [Security Research](./research/skill-conflicts-security.md)
- "What entry points should we build?" → [Entry Points Research](./research/design-entry-points.md)
- "How does quality scoring work?" → [Quality Scoring](./research/quality-scoring.md)
- "Where do we get download counts?" → [Download Counts API](./research/download-counts-api.md)
- "How should we handle telemetry consent?" → [Telemetry Consent](./research/telemetry-consent.md)

---

## Document Status

| Area | Status | Last Updated |
|------|--------|--------------|
| PRD v3 | Complete | December 26, 2025 |
| Design | Complete | December 26, 2025 |
| Technical | Complete | December 26, 2025 |
| GTM | Complete | December 26, 2025 |
| Research | Complete | December 26, 2025 |
| Reviews | Complete | December 26, 2025 |

---

## Warning: Archived Documents

> **DO NOT USE** documents in `/docs/archive/`. They are outdated and have been superseded.
> See [Archive Index](./archive/index.md) for details.

---

*Last updated: December 26, 2025*
