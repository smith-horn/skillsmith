# Hive Mind Execution Plan: Phases 5, 6, 7

**Created**: January 4, 2026
**Strategy**: Feature Bifurcation (no usage limits)
**Pricing**: Community ($0), Team ($25), Enterprise ($55)

---

## Wave Overview

| Wave | Phase | Focus | Issues | Parallel Agents |
|------|-------|-------|--------|-----------------|
| 1 | 5A | npm Publishing (Free Tier) | SMI-1048 to SMI-1052 | 3 |
| 2 | 5B | License Infrastructure | SMI-1053 to SMI-1061 | 4 |
| 3 | 6 | Linear Issue Creation | 19 new issues | 1 |
| 4 | 6 | Website Frontend | 6 issues | 4 |
| 5 | 6 | Subscription Portal | 7 issues | 4 |
| 6 | 6 | Authentication | 4 issues | 3 |
| 7 | 5C | Billing Backend | SMI-1062 to SMI-1071 | 4 |
| 8 | 7 | Enterprise Features | SMI-1042 to SMI-1047 | 4 |

---

## Wave 1: npm Publishing (Free Tier)

**Goal**: Publish free tier packages to public npm

**Parallel Execution**:
```
Agent 1 (npm-config):     SMI-1048 - Configure npm org and access tokens
Agent 2 (build-scripts):  SMI-1049 - Add prepublishOnly scripts
Agent 3 (license-fix):    SMI-1051 - Fix enterprise package license
```

**Sequential After**:
```
Agent 1 (ci-publish):     SMI-1050 - Create GitHub Actions publish workflow
Agent 2 (registry):       SMI-1052 - Configure private registry
```

**Success Criteria**:
- [ ] npm org configured with `@skillsmith` scope
- [ ] prepublishOnly scripts run typecheck, lint, test
- [ ] Enterprise package.json shows proprietary license
- [ ] GitHub Actions can publish on tag push
- [ ] Private registry configured (not published yet)

**Unlock**: Free tier users can `npm install @skillsmith/mcp-server`

---

## Wave 2: License Infrastructure

**Goal**: Implement feature gating (no usage limits)

**Parallel Execution**:
```
Agent 1 (validator):      SMI-1053 - Implement LicenseValidator class
Agent 2 (feature-flags):  SMI-1058 - Define feature flag schema for JWT
Agent 3 (middleware):     SMI-1055 - Add license middleware to MCP server
Agent 4 (cli-check):      SMI-1056 - Add license check to CLI startup
```

**Sequential After**:
```
Agent 1 (key-gen):        SMI-1054 - Create license key generation service
Agent 2 (flag-check):     SMI-1059 - Implement feature flag checking
Agent 3 (degradation):    SMI-1060 - Add graceful degradation
Agent 4 (errors):         SMI-1061 - Create license error handling
```

**Success Criteria**:
- [ ] LicenseValidator validates JWT tokens
- [ ] Feature flags: team_workspaces, private_skills, sso_saml, rbac, audit_logging
- [ ] MCP server blocks enterprise tools without license
- [ ] CLI shows license status on startup
- [ ] Graceful "upgrade to unlock" messages

---

## Wave 3: Phase 6 Linear Issues

**Goal**: Create 19 Phase 6 issues in Linear

**Single Agent Execution**:
```bash
cd ~/.claude/skills/linear/skills/linear/scripts
npx tsx create-phase6-issues.ts
```

**Output**: SMI-1072 to SMI-1090 (19 issues across 3 epics)

---

## Wave 4: Website Frontend

**Goal**: Build marketing website

**Prerequisites**: Phase 6 issues created (Wave 3)

**Parallel Execution**:
```
Agent 1 (landing):        Create landing page with value proposition
Agent 2 (pricing):        Build pricing page with tier comparison
Agent 3 (docs):           Create documentation site structure
Agent 4 (getting-started): Create "Getting Started" guide
```

**Sequential After**:
```
Agent 1 (features):       Add feature comparison table
Agent 2 (faq):            Build FAQ page
```

**Tech Stack**:
- Next.js 14 with App Router
- Tailwind CSS
- Vercel deployment

**Success Criteria**:
- [ ] Landing page live at skillsmith.io
- [ ] Pricing page shows $0 / $25 / $55 tiers
- [ ] Documentation searchable
- [ ] Getting Started guide complete

---

## Wave 5: Subscription Portal

**Goal**: Build Stripe-powered subscription system

**Parallel Execution**:
```
Agent 1 (stripe-team):    Implement Stripe Checkout for Team tier
Agent 2 (stripe-ent):     Implement Stripe Checkout for Enterprise tier
Agent 3 (dashboard):      Create account dashboard
Agent 4 (license-delivery): Build license key delivery
```

**Sequential After**:
```
Agent 1 (upgrade):        Implement upgrade/downgrade flow
Agent 2 (billing):        Create billing history and invoice download
Agent 3 (seats):          Add seat management for team admins
```

**Stripe Products**:
| Product | Monthly | Annual |
|---------|---------|--------|
| Team | $25/user (price_team_monthly) | $250/user (price_team_annual) |
| Enterprise | $55/user (price_enterprise_monthly) | $550/user (price_enterprise_annual) |

**Success Criteria**:
- [ ] Stripe Checkout working for both tiers
- [ ] License key delivered after payment
- [ ] Dashboard shows subscription status
- [ ] Upgrade/downgrade with proration

---

## Wave 6: Authentication

**Goal**: User registration, login, organization management

**Parallel Execution**:
```
Agent 1 (auth):           Implement user registration and login
Agent 2 (verify):         Add email verification flow
Agent 3 (reset):          Create password reset functionality
```

**Sequential After**:
```
Agent 1 (org):            Build organization/team management
```

**Tech Stack Options**:
- Supabase Auth (recommended)
- Auth0
- NextAuth.js

**Success Criteria**:
- [ ] Registration with email verification
- [ ] Login with session persistence
- [ ] Password reset flow
- [ ] Organization creation and member management

---

## Wave 7: Billing Backend

**Goal**: Complete Stripe integration backend

**Parallel Execution**:
```
Agent 1 (stripe):         SMI-1062 - Integrate Stripe
Agent 2 (subscription):   SMI-1063 - Create subscription API
Agent 3 (team-flow):      SMI-1064 - Team tier flow
Agent 4 (ent-flow):       SMI-1065 - Enterprise tier flow
```

**Sequential After**:
```
Agent 1 (license-gen):    SMI-1066 - License key from subscription
Agent 2 (seats):          SMI-1067 - Seat-based billing
Agent 3 (portal):         SMI-1068 - Customer billing portal
Agent 4 (invoices):       SMI-1069 - Invoice generation
Agent 5 (webhooks):       SMI-1070 - Webhook handlers
Agent 6 (marketplace):    SMI-1071 - AWS Marketplace listing
```

**Success Criteria**:
- [ ] Stripe webhooks handling all events
- [ ] License keys auto-generated on payment
- [ ] Seat-based billing working
- [ ] Customer portal accessible

---

## Wave 8: Enterprise Features

**Goal**: Implement gated enterprise functionality

**Prerequisites**: License infrastructure complete (Wave 2)

**Parallel Execution**:
```
Agent 1 (immutable):      SMI-1042 - ImmutableStore with SHA-256
Agent 2 (siem):           SMI-1044 - Splunk and Datadog exporters
Agent 3 (soc2):           SMI-1046 - SOC 2 compliance report
Agent 4 (docs):           SMI-1047 - SIEM credentials documentation
```

**Sequential After**:
```
Agent 1 (github):         SMI-1043 - GitHub import CLI
Agent 2 (benchmarks):     SMI-1045 - Performance benchmarks in CI
```

**Success Criteria**:
- [ ] ImmutableStore with hash chain verification
- [ ] SIEM exporters for Splunk and Datadog
- [ ] SOC 2 report generation
- [ ] All enterprise features gated by license

---

## Execution Commands

### Run All Waves Sequentially

```bash
# Wave 1: npm Publishing
./claude-flow sparc run orchestrator "Execute Phase 5A: npm publishing for free tier packages (SMI-1048 to SMI-1052)"

# Wave 2: License Infrastructure
./claude-flow sparc run orchestrator "Execute Phase 5B: license infrastructure and feature gating (SMI-1053 to SMI-1061)"

# Wave 3: Create Phase 6 Issues
npx tsx ~/.claude/skills/linear/skills/linear/scripts/create-phase6-issues.ts

# Wave 4: Website Frontend
./claude-flow sparc run orchestrator "Execute Phase 6 Wave 1: marketing website frontend (landing, pricing, docs, getting-started)"

# Wave 5: Subscription Portal
./claude-flow sparc run orchestrator "Execute Phase 6 Wave 2: subscription portal with Stripe (checkout, dashboard, license delivery)"

# Wave 6: Authentication
./claude-flow sparc run orchestrator "Execute Phase 6 Wave 3: authentication system (registration, login, password reset, orgs)"

# Wave 7: Billing Backend
./claude-flow sparc run orchestrator "Execute Phase 5C: billing backend with Stripe (SMI-1062 to SMI-1071)"

# Wave 8: Enterprise Features
./claude-flow sparc run orchestrator "Execute Phase 7: enterprise features with gating (SMI-1042 to SMI-1047)"
```

### Run with Hive Mind Skill

```bash
# Use the hive-mind-execution skill for each wave
# See: .claude/skills/hive-mind-execution/SKILL.md
```

---

## Dependencies

```
Wave 1 (5A: npm) ─────────────────────────────────────┐
                                                       │
Wave 2 (5B: License) ─────────────────────────────────┤
         │                                             │
         ├─── Wave 3 (Create Phase 6 Issues) ──────────┤
         │              │                              │
         │              ├─── Wave 4 (Website) ─────────┤
         │              │                              │
         │              ├─── Wave 5 (Portal) ──────────┤
         │              │                              │
         │              └─── Wave 6 (Auth) ────────────┤
         │                                             │
         └─── Wave 7 (5C: Billing) ────────────────────┤
                                                       │
                        Wave 8 (7: Enterprise) ────────┘
```

---

## Feature Bifurcation Reminder

**NO USAGE LIMITS** - This execution plan implements feature gating only:

| What We Build | What We DON'T Build |
|---------------|---------------------|
| Feature flags in JWT | Rate limiting |
| License validation | Usage quotas |
| Tier-based access | Install/search limits |
| Graceful upgrade prompts | 429 error responses |

All core features remain **unlimited** in the free tier.
