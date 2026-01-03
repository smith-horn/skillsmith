# Backlog Alignment Review: Post-Phase 6 Commercialization

**Date**: January 2, 2026
**Reviewer**: Claude Code
**Issues Analyzed**: 89 (Backlog, Todo, In Progress)

---

## Executive Summary

Following Phase 6 Commercialization, a comprehensive review of the Skillsmith backlog reveals:

- **6 issues** ready to close (already completed)
- **12 issues** misaligned with commercialization strategy (need reassignment)
- **8 execution gaps** requiring new issues/phases
- **Phase 7: Enterprise Implementation** needs formal project creation

---

## Issues Ready to Close

These issues were completed during Phase 6 architecture alignment:

| Issue | Title | Action |
|-------|-------|--------|
| SMI-940 | Configure LINEAR_TEAM_ID in Varlock | ✅ Already configured |
| SMI-941 | Add security scanner exclusions | ✅ Done (commit 85e9aab) |
| SMI-944 | ADR-013: Open Core Licensing | ✅ Done |
| SMI-945 | ADR-014: Enterprise Package Architecture | ✅ Done |
| SMI-946 | Resolve audit logging architecture | ✅ Done |
| SMI-947 | Update ADR-001 packages | ✅ Done |
| SMI-948 | Update standards.md for enterprise | ✅ Done |
| SMI-949 | Define VS Code extension tier | ✅ Done |
| SMI-950 | ADR-015: Private Registry Architecture | ✅ Documented |

---

## Misaligned Issues

### 1. Phase 4 Product Strategy Issues → Tier Reassignment

These Phase 4 issues need reassignment to commercial tiers:

| Issue | Title | Current | Recommended Tier |
|-------|-------|---------|------------------|
| SMI-844 | A/B Testing Infrastructure | Phase 4 | Team tier (Phase 7+) |
| SMI-910 | A/B Testing Infrastructure | Orphan | Duplicate - Close |
| SMI-909 | Analytics Instrumentation (Epic) | Orphan | Team tier (Phase 7+) |
| SMI-839 | Implement Skill Usage Analytics | Phase 4 | Team tier feature |
| SMI-846 | Build ROI Dashboard | Phase 4 | Enterprise tier feature |
| SMI-842 | [EPIC] Proof of Value | Phase 4 | Enterprise tier (ROI reporting) |

### 2. Phase 1 Static Site Issues → Marketing Website

| Issue | Title | Recommendation |
|-------|-------|----------------|
| SMI-597 | Set up Astro static site | Repurpose for marketing/docs site |
| SMI-598 | Build skill search page | Public search (Community tier) |
| SMI-599 | Build skill detail pages | Public detail pages |

**Decision Needed**: Is Astro the right choice for commercial marketing site?

### 3. Orphaned Issues Without Project

| Issue | Title | Recommendation |
|-------|-------|----------------|
| SMI-908 | First-Impression Skills Onboarding | Move to Phase 7 (Community) |
| SMI-909 | Analytics Instrumentation | Move to Phase 7 (Team tier) |
| SMI-910 | A/B Testing Infrastructure | Duplicate of SMI-844, close |

---

## Phase 5: Release & Publishing - CRITICAL PATH

Phase 5 is blocking commercialization. Issues need immediate attention:

| Issue | Title | Priority | Blocker For |
|-------|-------|----------|-------------|
| SMI-811 | Publish @skillsmith/mcp-server to npm | P0 | All tiers |
| SMI-812 | Publish @skillsmith/cli to npm | P0 | All tiers |
| SMI-814 | Publish @skillsmith/core to npm | P0 | All tiers |
| SMI-878 | Create GitHub App (15K req/hr) | P1 | Skill import at scale |

**Recommendation**: Prioritize Phase 5 before Phase 7.

---

## Execution Gaps

### Gap 1: No Phase 7 Project

**Issue**: SMI-942 (Enterprise Package Implementation) exists but no formal Phase 7 project.

**Action**: Create "Phase 7: Enterprise Implementation" project with:
- SSO/SAML integration (10 weeks)
- RBAC implementation
- License key validation
- Enhanced audit logging
- Private registry

---

### Gap 2: No Payment/Billing Infrastructure

**Missing Issues**:
- Payment processor integration (Stripe)
- Subscription management
- License key generation
- Usage metering for AWS Marketplace
- Invoice generation

**Recommendation**: Create Phase 7b or add to Phase 7.

---

### Gap 3: No Marketing Website

**Missing Issues**:
- Landing page for skillsmith.io
- Pricing page
- Documentation site
- Blog/changelog
- Customer testimonials

**Recommendation**: Repurpose Phase 1 Astro issues or create new phase.

---

### Gap 4: No Customer Onboarding

**Missing Issues**:
- Team tier onboarding flow
- Enterprise tier onboarding flow
- License activation UX
- Admin console for enterprise
- Team member invitation

---

### Gap 5: No SLA Monitoring

**Missing Issues**:
- 99.9% uptime monitoring (Enterprise SLA)
- Incident response automation
- Status page (statuspage.io integration)
- SLA breach alerting

**Note**: SMI-935 (Monitoring) covers technical monitoring but not SLA compliance.

---

### Gap 6: No Support Infrastructure

**Missing Issues**:
- Support ticketing system
- Priority support queue (Team tier)
- Dedicated support (Enterprise tier)
- Knowledge base
- Community forum

---

### Gap 7: No Sales/GTM Infrastructure

**Missing Issues**:
- CRM integration
- Lead capture forms
- Demo environment
- Sales deck automation
- Contract/NDA templates

---

### Gap 8: No Compliance Documentation

**Missing Issues**:
- SOC 2 Type I preparation
- GDPR data processing records
- Security questionnaire responses
- Penetration testing
- Vendor security assessment forms

---

## Recommended Phase Structure

### Immediate Priority (Q1 2026)

1. **Phase 5: Release & Publishing** (4 issues) - UNBLOCK FIRST
   - npm publishing for all packages
   - GitHub App creation

2. **Phase 7: Enterprise Implementation** (NEW)
   - Move SMI-942 here
   - Add enterprise features from ENTERPRISE_PACKAGE.md
   - Target: Feb 28, 2026 (per ROADMAP.md)

### Short-term (Q1-Q2 2026)

3. **Phase 7b: Billing & Subscriptions** (NEW)
   - Payment integration
   - License management
   - Usage metering

4. **Phase 8: Marketing & Website** (NEW)
   - Repurpose Phase 1 Astro issues
   - Landing page, pricing, docs

### Medium-term (Q2-Q3 2026)

5. **Phase 9: Customer Success** (NEW)
   - Support infrastructure
   - Onboarding flows
   - Admin console

6. **Phase 10: Compliance** (NEW)
   - SOC 2 preparation
   - Security certifications

---

## Issues to Cancel/Close

| Issue | Reason |
|-------|--------|
| SMI-910 | Duplicate of SMI-844 |
| SMI-636 | Waitlist - superseded by tier model |

---

## Issues to Move to Parking Lot

Low-priority issues not aligned with Q1-Q2 2026 commercialization:

| Issue | Title | Reason |
|-------|-------|--------|
| SMI-776 | Multi-Language AST Analysis | Nice-to-have, not tier differentiator |
| SMI-775 | Full ONNX Embedding Replacement | Performance optimization, defer |
| SMI-571 | Dark mode audit | UI polish, defer |

---

## Immediate Actions Required

1. **Create Phase 7 Project** in Linear
2. **Mark SMI-940, SMI-941, SMI-944-950 as Done**
3. **Elevate Phase 5 issues to P0**
4. **Create Gap issues** for billing, website, support
5. **Close duplicates** (SMI-910, SMI-636)
6. **Reassign Phase 4 issues** to appropriate tiers

---

*Review completed: January 2, 2026*
