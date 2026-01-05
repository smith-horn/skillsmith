# Skillsmith Go-to-Market Analysis

**Date**: January 4, 2026
**Status**: Draft for Review
**Author**: Strategy Review
**Revision**: 2.0 - Feature Bifurcation Model

---

## Executive Summary

This document analyzes Skillsmith's commercialization strategy using the Shreyas Doshi product framework, comparing against Docker and Hugging Face reference models.

**Key Strategy: Feature Bifurcation (Not Usage Limits)**

Unlike usage-based models that throttle activity, Skillsmith uses a **feature bifurcation** approach:
- **Community tier**: Full access to all core features, unlimited usage, forever free
- **Team tier**: Collaboration and team features
- **Enterprise tier**: Security, compliance, and governance features

This mirrors the Docker model (core engine free, tooling paid) rather than the Hugging Face model (usage credits).

---

## Part 1: Shreyas Doshi Framework Analysis

### 1.1 LNO Framework (Leverage, Neutral, Overhead)

**High Leverage Activities for Skillsmith:**
| Activity | Leverage | Why |
|----------|----------|-----|
| npm package quality | High | First impression, drives adoption |
| Free tier completeness | High | No "gotcha" limits builds trust |
| Enterprise feature depth | High | SSO/audit/RBAC drive enterprise deals |
| Documentation | High | Reduces support burden |
| Community building | Medium | Network effects |
| Custom integrations | Low | One-off work, doesn't scale |

**Recommendation**: Focus on making the free tier genuinely complete and useful, while building deep enterprise value.

### 1.2 Pre-Mortem: Why Skillsmith Commercialization Could Fail

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Free tier "good enough" for enterprises | Medium | Critical | Enterprise features (SSO, RBAC, audit) are genuinely required by regulated industries |
| No technical enforcement of paid features | High | High | Implement feature gating via license validation |
| Enterprise sales cycle too long | Medium | High | Product-led growth with self-serve Team tier |
| Open source fork | Low | Medium | Apache-2.0 allows forks; proprietary enterprise is the moat |
| Developers resist recommending paid tier | Medium | Medium | Keep free tier unlimited; only charge for enterprise needs |

### 1.3 High-Leverage Decisions

**Decision 1: Monetization Model**
- **Option A**: Usage limits (like Hugging Face) - Free up to X calls/month
- **Option B**: Feature bifurcation (like Docker) - Core free, features paid
- **Recommendation**: **Option B** - Feature bifurcation is clearer and avoids friction

**Decision 2: What Triggers Payment**
- Individual developer need: Never (Community tier is complete)
- Team collaboration need: Team tier ($25/user/month)
- Enterprise compliance need: Enterprise tier ($55/user/month)
- **Recommendation**: Payment only triggered by organizational requirements, not individual usage

**Decision 3: Enforcement Mechanism**
- Features behind license validation (JWT-based per ADR-014)
- No rate limiting or usage quotas
- Clear feature boundaries, not artificial restrictions
- **Recommendation**: Technical enforcement via feature flags in license JWT

---

## Part 2: Reference Model Comparison

### 2.1 Docker Model (Feature-Based)

| Aspect | Docker | Skillsmith Proposed | Alignment |
|--------|--------|---------------------|-----------|
| Free tier definition | Docker Engine: unlimited | Core packages: unlimited | Aligned |
| What's paid | Docker Desktop for companies | Team/Enterprise features | Aligned |
| Enforcement | Company size threshold | License key for features | Different (technical vs legal) |
| Community perception | Positive (engine stays free) | Expected positive | Target |

**Docker Lessons Applied:**
- Keep the core engine (skill discovery, install) completely free
- Monetize the enterprise wrapper (SSO, RBAC, audit)
- No usage limits that frustrate developers
- Enterprise features justify themselves (compliance requirements)

### 2.2 Hugging Face Model (Usage-Based)

| Aspect | Hugging Face | Skillsmith Decision | Why Different |
|--------|--------------|---------------------|---------------|
| Free tier | Limited inference credits | Unlimited core usage | Avoid friction |
| Enforcement | Rate limits, 429 errors | Feature gating only | Better DX |
| Upgrade trigger | Credit exhaustion | Feature need | Organic, not forced |
| Community perception | Positive (generous free) | Target positive | No limits = trust |

**Hugging Face Lessons NOT Applied:**
- Usage-based pricing creates friction with individual developers
- Rate limits frustrate power users and create negative sentiment
- Credit exhaustion feels punitive rather than value-driven

### 2.3 Skillsmith Model: Feature Bifurcation

```
+------------------------------------------------------------------+
|                    SKILLSMITH TIER MODEL                          |
|                   Feature Bifurcation Approach                    |
+------------------------------------------------------------------+
|  COMMUNITY (Free)     |  TEAM ($25/user)    |  ENTERPRISE ($55)  |
+------------------------------------------------------------------+
|  UNLIMITED:           |  Everything free +  |  Everything Team + |
|                       |                     |                    |
|  * Skill search       |  * Team workspaces  |  * SSO/SAML        |
|  * Skill install      |  * Private skills   |  * RBAC            |
|  * Recommendations    |  * Usage analytics  |  * Audit logging   |
|  * CLI tools          |  * Priority support |  * SIEM export     |
|  * VS Code extension  |  * Skill sharing    |  * Compliance rpts |
|  * MCP server         |  * Team management  |  * Private registry|
|  * Local database     |                     |  * Dedicated SLA   |
|                       |                     |                    |
|  NO LIMITS:           |  NO LIMITS:         |  NO LIMITS:        |
|  * Unlimited installs |  * Unlimited usage  |  * Unlimited usage |
|  * Unlimited searches |  * Unlimited users* |  * Unlimited seats*|
|  * Unlimited usage    |  * Unlimited skills |  * Unlimited logs  |
|                       |  (* per license)    |  (* per license)   |
+------------------------------------------------------------------+
```

---

## Part 3: Feature Boundaries

### 3.1 Community Tier - Free Forever (Apache-2.0)

**What's Included (Complete Feature Set):**

| Category | Features | Limit |
|----------|----------|-------|
| **Discovery** | Skill search, recommendations, comparison | Unlimited |
| **Installation** | Install, uninstall, update skills | Unlimited |
| **CLI** | All CLI commands, MCP server | Unlimited |
| **VS Code** | Core extension features | Unlimited |
| **Database** | Local SQLite, embeddings | Unlimited |
| **Support** | GitHub Issues, community forum | Best effort |

**Design Principle**: A solo developer should never need to pay. The Community tier is genuinely complete for individual use.

### 3.2 Team Tier - $25/user/month

**What Unlocks (Collaboration Features):**

| Feature | Description | Why Paid |
|---------|-------------|----------|
| Team workspaces | Shared skill configurations | Multi-user coordination |
| Private skills | Internal-only skill sharing | Secure hosting required |
| Usage analytics | Team-wide skill adoption metrics | Data storage + processing |
| Priority support | 24-hour email response | Human time |
| Skill sharing | Share skills across team | Sync infrastructure |
| Team management | Add/remove team members | Identity management |

**Upgrade Trigger**: "I want to share skills with my team" or "My company wants visibility into skill usage"

### 3.3 Enterprise Tier - $55/user/month

**What Unlocks (Security & Compliance Features):**

| Feature | Description | Why Paid |
|---------|-------------|----------|
| SSO/SAML | Okta, Azure AD, Google Workspace | Provider integration fees |
| RBAC | Role-based access control | Complex policy engine |
| Audit logging | SOC 2-ready event logging | Retention + storage |
| SIEM export | Splunk, Datadog, CloudWatch | API costs |
| Compliance reports | SOC 2, GDPR mapping | Report generation |
| Private registry | Self-hosted skill registry | Dedicated infrastructure |
| Dedicated SLA | 4-hour response, 99.9% uptime | Dedicated support |

**Upgrade Trigger**: "My security team requires SSO" or "We need audit logs for compliance" or "We need to control who can publish skills"

---

## Part 4: Discovery Path to Paid Tier

### 4.1 Natural Discovery (Not Forced)

Unlike usage-limit models that force upgrades through quotas, Skillsmith surfaces paid features when they're genuinely needed:

**Moment 1: Team Feature Accessed**
```
+----------------------------------------------------------+
|  Team Feature: Private Skills                             |
|                                                           |
|  Private skills let you:                                  |
|  * Share skills within your organization only             |
|  * Keep proprietary workflows secure                      |
|  * Manage skill access by team                            |
|                                                           |
|  Available with Team tier ($25/user/month)                |
|                                                           |
|  Your current usage: Unlimited (not affected)             |
|                                                           |
|  [Learn More]  [Start Free Trial]                         |
+----------------------------------------------------------+
```

**Moment 2: Enterprise Feature Accessed**
```
+----------------------------------------------------------+
|  Enterprise Feature: Audit Logging                        |
|                                                           |
|  Audit logging provides:                                  |
|  * Complete skill operation history                       |
|  * Compliance-ready export (SOC 2, GDPR)                  |
|  * SIEM integration (Splunk, Datadog, CloudWatch)         |
|                                                           |
|  Required for regulated industries and security-conscious |
|  organizations.                                           |
|                                                           |
|  Available with Enterprise tier ($55/user/month)          |
|                                                           |
|  [Learn More]  [Contact Sales]                            |
+----------------------------------------------------------+
```

### 4.2 CLI Discovery

```bash
$ skillsmith config set-sso --provider okta
Error: SSO configuration requires Enterprise tier.

SSO/SAML features include:
  * Okta, Azure AD, Google Workspace integration
  * Automatic user provisioning
  * Single logout support

Your core Skillsmith features remain fully functional.
To enable SSO: https://skillsmith.io/enterprise

$ skillsmith skill publish --visibility organization
Error: Organization-visible skills require Team tier.

Private skill features include:
  * Internal skill sharing
  * Team-only visibility
  * Skill access control

Public skills remain free to publish.
To enable: https://skillsmith.io/team
```

### 4.3 Website Discovery

**Pricing Page Structure:**

```
+------------------------------------------------------------------+
|                       SKILLSMITH PRICING                          |
|            Feature Bifurcation: Pay for what you need             |
+------------------------------------------------------------------+
|                                                                   |
|    COMMUNITY            TEAM                ENTERPRISE            |
|    $0/forever           $25/user/mo         $55/user/mo           |
|    ───────────────────────────────────────────────────────────    |
|                                                                   |
|    For:                 For:                For:                  |
|    * Individuals        * Startups          * Enterprises         |
|    * Open source        * Growing teams     * Regulated orgs      |
|    * Learning           * Collaboration     * Security-first      |
|                                                                   |
|    Includes:            Everything free +   Everything Team +     |
|    * Unlimited search   * Team workspaces   * SSO/SAML            |
|    * Unlimited install  * Private skills    * RBAC                |
|    * Full CLI           * Analytics         * Audit logging       |
|    * VS Code ext        * Priority support  * SIEM export         |
|                                                                   |
|    [Get Started]        [Start Free Trial]  [Contact Sales]       |
|                                                                   |
|    ───────────────────────────────────────────────────────────    |
|                                                                   |
|    FAQ: Do I need to pay?                                         |
|                                                                   |
|    No, if you're an individual developer.                         |
|    Yes, if your company needs team collaboration.                 |
|    Yes, if your company requires SSO/audit/compliance.            |
|                                                                   |
+------------------------------------------------------------------+
```

---

## Part 5: Technical Implementation

### 5.1 Feature Gating Architecture

```typescript
// No usage limits, only feature flags
interface License {
  tier: 'community' | 'team' | 'enterprise';
  features: FeatureFlag[];
  // No usage quotas!
}

type FeatureFlag =
  | 'team_workspaces'
  | 'private_skills'
  | 'usage_analytics'
  | 'priority_support'
  | 'sso_saml'
  | 'rbac'
  | 'audit_logging'
  | 'siem_export'
  | 'compliance_reports'
  | 'private_registry';

// Feature check middleware (not rate limit check)
function requireFeature(feature: FeatureFlag) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const license = await getLicense(req.user);

    if (!license.hasFeature(feature)) {
      return res.status(403).json({
        error: 'FEATURE_NOT_AVAILABLE',
        feature,
        requiredTier: getRequiredTier(feature),
        currentTier: license.tier,
        // Core features still work!
        coreFeatures: 'All core features remain fully functional',
        upgradeUrl: `https://skillsmith.io/${getRequiredTier(feature)}`
      });
    }

    next();
  };
}

// Feature-to-tier mapping
const FEATURE_TIERS: Record<FeatureFlag, Tier[]> = {
  'team_workspaces': ['team', 'enterprise'],
  'private_skills': ['team', 'enterprise'],
  'usage_analytics': ['team', 'enterprise'],
  'priority_support': ['team', 'enterprise'],
  'sso_saml': ['enterprise'],
  'rbac': ['enterprise'],
  'audit_logging': ['enterprise'],
  'siem_export': ['enterprise'],
  'compliance_reports': ['enterprise'],
  'private_registry': ['enterprise'],
};
```

### 5.2 No Rate Limiting

```typescript
// What we DON'T do (usage limits)
// ❌ const MAX_INSTALLS_PER_MONTH = 100;
// ❌ const MAX_SEARCHES_PER_DAY = 500;
// ❌ async function checkUsageQuota() { ... }

// What we DO (feature gating)
// ✅ Core operations have no limits
async function searchSkills(query: string): Promise<Skill[]> {
  // No quota check - unlimited searches
  return await skillRepository.search(query);
}

async function installSkill(id: string): Promise<void> {
  // No quota check - unlimited installs
  await skillInstaller.install(id);
}

// ✅ Only check features for gated functionality
async function configureSSO(config: SSOConfig): Promise<void> {
  await requireFeature('sso_saml');  // Feature gate
  await ssoManager.configure(config);
}
```

---

## Part 6: Comparison Summary

| Aspect | Docker | Hugging Face | Skillsmith |
|--------|--------|--------------|------------|
| **Free tier** | Engine unlimited | Usage credits | Core unlimited |
| **Limits** | Company size (legal) | Rate limits (technical) | None |
| **Enforcement** | Honor system | 429 errors | Feature gates |
| **Upgrade trigger** | Company size | Credit exhaustion | Feature need |
| **Developer experience** | Excellent | Good (limits frustrate) | Excellent |
| **Enterprise gate** | Legal agreement | Technical | Technical |
| **Community perception** | Positive | Mixed | Target: Positive |

---

## Part 7: Paid Services Required for Operation

### 7.1 Third-Party Services

| Service | Purpose | Cost Model | Required Tier |
|---------|---------|------------|---------------|
| **Stripe** | Payment processing | 2.9% + $0.30/txn | Team+ |
| **AWS/GCP** | Cloud infrastructure | Usage-based | All (hosting) |
| **SendGrid** | Email delivery | Per email | All |
| **Okta/Auth0** | SSO provider | Per MAU | Enterprise |
| **Splunk/Datadog** | SIEM integration | Per GB | Enterprise |

### 7.2 Infrastructure by Tier

| Component | Community | Team | Enterprise |
|-----------|-----------|------|------------|
| npm registry | Public npm | Public npm | Private option |
| Database | User's machine | Shared multi-tenant | Dedicated |
| Compute | User's machine | Shared API | Dedicated |
| Support | Community | Email (24hr SLA) | Dedicated (4hr SLA) |

---

## Part 8: Implementation Roadmap

### 8.1 Phase 5A: npm Publishing - FREE TIER (Week 1)
**Publish free tier packages to public npm immediately**
- Configure npm org and access tokens (SMI-1048)
- Add prepublishOnly scripts (SMI-1049)
- Create GitHub Actions publish workflow (SMI-1050)
- Fix enterprise package license (SMI-1051)

**After Phase 5A**: Free tier users can `npm install @skillsmith/mcp-server`

### 8.2 Phase 5B: License Infrastructure (Week 2-3)
- Implement LicenseValidator class per ADR-014 (SMI-1053)
- Define feature flag schema for JWT payload (SMI-1058)
- Implement feature flag checking in enterprise tools (SMI-1059)
- Add license middleware to MCP server (SMI-1055)

### 8.3 Phase 6: Website & Subscription Portal (Week 3-5)
**Marketing website + Stripe-powered subscription portal**

| Epic | Issues | Description |
|------|--------|-------------|
| Marketing Website | 6 | Landing page, pricing, docs, feature comparison, FAQ |
| Subscription Portal | 7 | Stripe Checkout, dashboard, license delivery, seat mgmt |
| Authentication | 4 | Registration, login, password reset, org management |

**Tech Stack**: Next.js + Tailwind + Stripe + Supabase + Vercel

### 8.4 Phase 5C: Billing Backend (Week 4-5)
- Integrate Stripe for payment processing (SMI-1062)
- Create subscription management API (SMI-1063)
- Build license key generation from subscription (SMI-1066)
- Add webhook handlers for subscription events (SMI-1070)

### 8.5 Phase 7: Enterprise Features (Week 6-8)
- Implement ImmutableStore with SHA-256 hash chains (SMI-1042)
- Complete Splunk and Datadog SIEM exporters (SMI-1044)
- Generate SOC 2 compliance report (SMI-1046)

### 8.6 Design Principles

1. **No artificial limits** - Core features are unlimited
2. **Value-driven upgrades** - Only pay for features you need
3. **Developer-first** - Individual developers never pay
4. **Enterprise-justified** - Paid features serve real enterprise needs
5. **Clear boundaries** - Easy to understand what's in each tier

---

## Part 9: Key Differentiators

### 9.1 Why Feature Bifurcation Works

| Benefit | Explanation |
|---------|-------------|
| **Trust** | Developers recommend tools that won't surprise their company with bills |
| **Adoption** | No friction in free tier = faster spread within organizations |
| **Natural upsell** | Teams that need features will pay; no quotas needed |
| **Clear value** | SSO, RBAC, audit are obviously enterprise needs |
| **No resentment** | Developers don't hit walls while working |

### 9.2 Why NOT Usage Limits

| Problem | With Usage Limits | With Feature Bifurcation |
|---------|-------------------|--------------------------|
| Power users | Hit limits, frustrated | Use freely, become advocates |
| Recommendations | Hesitate to recommend | Freely recommend |
| CI/CD usage | Quickly hit limits | No concern |
| Experimentation | Constrained | Encouraged |
| Upgrade path | Forced (quota hit) | Organic (feature need) |

---

## Appendix A: Shreyas Doshi Frameworks Referenced

### A.1 LNO Framework
- **L (Leverage)**: Work that disproportionately impacts outcomes
- **N (Neutral)**: Work that must be done but doesn't differentiate
- **O (Overhead)**: Work that should be minimized or eliminated

### A.2 Pre-Mortem
- Imagine the project failed; identify why
- Address highest-likelihood, highest-impact risks first

### A.3 High-Leverage Decisions
- Decisions that compound over time
- Focus energy on decisions that are hard to reverse

---

## Appendix B: Sources

- [Docker Pricing](https://www.docker.com/pricing/)
- [Docker Desktop License](https://docs.docker.com/subscription/desktop-license/)
- [Hugging Face Pricing](https://huggingface.co/pricing)
- [Shreyas Doshi on LNO Framework](https://twitter.com/shreyas)
- [Open Core Business Model](https://en.wikipedia.org/wiki/Open-core_model)
- [ADR-013: Open Core Licensing](../adr/013-open-core-licensing.md)
- [ADR-014: License Validation](../adr/014-license-validation.md)
- [Enterprise Package Specification](../enterprise/ENTERPRISE_PACKAGE.md)
