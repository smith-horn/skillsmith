# Phase 6 Architecture Review

**Date**: January 2, 2026
**Status**: Complete
**Linear Issues Created**: SMI-940 through SMI-950

---

## Executive Summary

Following Phase 6 Commercialization, a comprehensive review of architecture and implementation documentation identified **7 inconsistencies** and **4 required ADRs** between the new commercial model and existing architectural decisions.

---

## Inconsistencies Identified

### 1. Package Structure Mismatch (Critical)

**ADR-001** documents 3 packages:
```
packages/
├── core/        # @skillsmith/core
├── mcp-server/  # @skillsmith/mcp-server
└── cli/         # @skillsmith/cli
```

**Actual structure** contains 4 packages:
```
packages/
├── core/
├── mcp-server/
├── cli/
└── vscode-extension/  # NOT IN ADR-001
```

**Phase 6 planning** adds a 5th:
```
packages/
└── enterprise/  # @skillsmith/enterprise (proprietary)
```

**Impact**: ADR-001 is outdated and needs amendment.
**Issue**: SMI-947

---

### 2. Audit Logging Overlap (Medium)

Audit logging is defined in two places with potential conflict:

| Source | Package | Features |
|--------|---------|----------|
| ADR-008 | @skillsmith/core | SQLite logging, basic events |
| ENTERPRISE_PACKAGE.md | @skillsmith/enterprise | SIEM export, compliance formatting |

**Decision Needed**: Which features are community vs enterprise?
**Issue**: SMI-946

---

### 3. Standards.md Missing Enterprise Patterns (Medium)

`standards.md` v1.5 does not address:
- SSO/SAML integration patterns
- RBAC implementation guidelines
- License key validation
- Private registry security
- Multi-tenant data isolation

**Impact**: Enterprise development lacks formal standards.
**Issue**: SMI-948

---

### 4. VS Code Extension Commercial Tier Undefined (Low)

The VS Code extension exists but is not addressed in:
- ROADMAP.md (no mention)
- TERMS.md (tier assignment unclear)
- ENTERPRISE_PACKAGE.md (no integration section)

**Decision Needed**: Which tier includes VS Code extension?
**Issue**: SMI-949

---

## Required ADRs

### ADR-013: Open Core Licensing Model

**Context**: Phase 6 established Apache-2.0 community + proprietary enterprise model without formal ADR.

**Scope**:
- Package licensing boundaries
- Contribution policy (CLA requirements)
- Feature flag strategy
- Revenue model validation

**Issue**: SMI-944

---

### ADR-014: Enterprise Package Architecture

**Context**: @skillsmith/enterprise adds proprietary code to open source monorepo.

**Scope**:
- Package integration with core
- Build/release separation
- Feature detection mechanism
- Dependency management

**Issue**: SMI-945

---

### ADR-015: Private Registry Architecture

**Context**: Enterprise tier includes private registry for air-gapped deployments.

**Scope**:
- Registry protocol selection
- Authentication mechanism
- Sync strategy
- Integration with SkillRepository

**Issue**: SMI-950

---

## Additional Issues Created

### Phase 6 Challenges (from retrospective)

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-940 | Configure LINEAR_TEAM_ID in Varlock | P2 |
| SMI-941 | Add security scanner exclusions | P2 |
| SMI-942 | Phase 7: Enterprise Package Implementation | P3 |
| SMI-943 | Review pricing model based on market feedback | P3 |

### Architecture Review

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-944 | ADR-013: Open Core Licensing Model | P1 |
| SMI-945 | ADR-014: Enterprise Package Architecture | P1 |
| SMI-946 | Resolve audit logging architecture overlap | P2 |
| SMI-947 | Update ADR-001 to include all current packages | P2 |
| SMI-948 | Update standards.md for enterprise development | P2 |
| SMI-949 | Define VS Code extension commercial tier | P3 |
| SMI-950 | ADR-015: Private Registry Architecture | P3 |

---

## Recommendations

### Immediate (Before Phase 7)

1. **Create ADR-013** (Open Core Licensing) - Formalizes business model
2. **Create ADR-014** (Enterprise Package) - Enables implementation
3. **Update ADR-001** - Reflects actual package structure

### Short-term (Q1 2026)

4. **Update standards.md** - Add enterprise development section
5. **Resolve audit logging** - Define community vs enterprise scope
6. **Define VS Code tier** - Clarify extension licensing

### Medium-term (Q2 2026)

7. **Create ADR-015** (Private Registry) - Required for enterprise air-gap support

---

## Document Cross-References

| Document | Status | Commercialization Alignment |
|----------|--------|----------------------------|
| ADR-001 (Monorepo) | Outdated | Missing vscode-extension, enterprise |
| ADR-008 (Security) | Current | Audit overlap with enterprise |
| standards.md | Partial | Missing enterprise patterns |
| TERMS.md | Current | Defines all tiers |
| ROADMAP.md | Current | Aligns with enterprise timeline |
| ENTERPRISE_PACKAGE.md | Current | Detailed implementation spec |
| PRIVACY.md | Current | GDPR/CCPA compliant |

---

## Conclusion

Phase 6 Commercialization introduced significant architectural changes that require formal documentation. The 11 Linear issues created (SMI-940 through SMI-950) address both immediate challenges and architectural alignment.

**Priority order**:
1. ADR-013, ADR-014 (P1) - Foundation for enterprise development
2. SMI-946, SMI-947, SMI-948 (P2) - Documentation alignment
3. SMI-949, SMI-950 (P3) - Secondary architectural decisions

---

*Review completed: January 2, 2026*
