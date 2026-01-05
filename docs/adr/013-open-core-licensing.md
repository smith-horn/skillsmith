# ADR-013: Open Core Licensing Model

**Status**: Accepted
**Date**: 2026-01-02
**Deciders**: Skillsmith Team

## Context

Phase 6 established an Open Core licensing model to balance community adoption with sustainable revenue generation. The model addresses the need for:

1. **Community Growth**: Enabling wide adoption through open source core functionality
2. **Revenue Sustainability**: Generating predictable revenue through commercial tiers
3. **Enterprise Requirements**: Providing advanced features (SSO, RBAC, audit logging, private registries) that enterprises require
4. **Contributor Protection**: Ensuring enterprise contributions don't inadvertently become open source

The three-tier structure was designed as follows:
- **Community Tier**: Apache-2.0 (free, open source)
- **Team Tier**: $25/user/month (commercial license)
- **Enterprise Tier**: $55/user/month (proprietary features)

See [TERMS.md](../legal/TERMS.md) for complete pricing and licensing terms.

## Decision

### 1. Core Packages Remain Apache-2.0

The following packages are licensed under Apache License 2.0 and will remain fully open source:

| Package | Purpose | License |
|---------|---------|---------|
| `@skillsmith/core` | Database, repositories, services | Apache-2.0 |
| `@skillsmith/mcp-server` | MCP tools (search, install, etc.) | Apache-2.0 |
| `@skillsmith/cli` | Command-line interface | Apache-2.0 |

These packages provide all fundamental skill discovery functionality without commercial restrictions.

### 2. Enterprise Package Is Proprietary

The `@skillsmith/enterprise` package contains proprietary code and is not open source:

| Feature | Description |
|---------|-------------|
| License Validation | JWT-based license keys with offline validation |
| SSO/SAML Integration | Okta, Azure AD, Google Workspace providers |
| Audit Logging | Compliance-ready logging with SIEM export |
| RBAC | Role-based access control with policy engine |
| Private Registry | Enterprise skill registry with sync |

See [ENTERPRISE_PACKAGE.md](../enterprise/ENTERPRISE_PACKAGE.md) for complete feature specifications.

### 3. VS Code Extension Licensing

The VS Code extension (`@skillsmith/vscode-extension`) is licensed under Apache-2.0 with the following behavior:

- Core functionality is fully open source
- Enterprise features are enabled via license key detection
- The extension checks for `@skillsmith/enterprise` availability at runtime
- No proprietary code is embedded in the extension itself

```typescript
// Enterprise feature detection pattern
const hasEnterprise = await detectEnterprisePackage();
if (hasEnterprise && await validateLicense()) {
  enableEnterpriseFeatures();
}
```

### 4. Contributor License Agreement (CLA)

A CLA is required for contributions that touch enterprise-related code:

| Contribution Type | CLA Required |
|-------------------|--------------|
| Core packages only | No |
| Enterprise integration points | Yes |
| Enterprise package | Yes |

The CLA ensures:
- Contributors grant necessary rights for commercial licensing
- Skillsmith can include contributions in proprietary builds
- Contributors retain copyright to their contributions

## Consequences

### Positive

- **Clear Revenue Model**: Tiered pricing provides predictable revenue while maintaining community access
- **Community Contribution**: Core packages remain fully open, encouraging community contributions
- **Enterprise Features Protected**: Proprietary enterprise features justify commercial pricing
- **Adoption Path**: Users can start free and upgrade as needs grow
- **Compliance Ready**: Enterprise tier includes audit logging and SSO required by regulated industries
- **Flexibility**: Apache-2.0 allows commercial use of core packages without copyleft restrictions

### Negative

- **CLA Overhead**: Contributors to enterprise integration points must sign CLA before contributions are accepted
- **Build Complexity**: Separate build pipelines needed for open source vs proprietary packages
- **Feature Boundary Maintenance**: Ongoing effort to clearly separate core vs enterprise features
- **Documentation Burden**: Must clearly communicate what features are available in each tier
- **Community Perception**: Some community members may view commercial tiers negatively

### Neutral

- Requires ongoing investment in both open source community and enterprise sales
- Enterprise customers expect support SLAs that differ from community tier
- Versioning must be coordinated across open source and proprietary packages

## Alternatives Considered

### Alternative 1: Full Open Source (AGPL or MIT)

- **Pros**: Maximum community adoption, no licensing complexity, contributor-friendly
- **Cons**: No direct revenue path, enterprise features freely available, difficult to sustain development
- **Why rejected**: Does not provide sustainable funding model for continued development

### Alternative 2: Full Proprietary

- **Pros**: Maximum control, simplified licensing, all features monetizable
- **Cons**: Limited adoption, no community contributions, higher barrier to entry
- **Why rejected**: Limits market adoption and community growth essential for ecosystem

### Alternative 3: Dual Licensing with GPL

- **Pros**: Strong copyleft encourages commercial licensing, established model
- **Cons**: GPL compatibility issues with many enterprise environments, complex for integrators
- **Why rejected**: GPL's copyleft requirements create friction for enterprise adoption and integration with other tools

### Alternative 4: Source Available (BSL/SSPL)

- **Pros**: Code visible, time-delayed open source, protects against cloud exploitation
- **Cons**: Not OSI-approved, confusing for users, limited ecosystem compatibility
- **Why rejected**: Source-available licenses create uncertainty and are not recognized as true open source

## Publishing Strategy

The open core model enables a staged publishing approach:

| Package | Registry | License | Phase |
|---------|----------|---------|-------|
| `@skillsmith/core` | Public npm | Apache-2.0 | 5A (immediate) |
| `@skillsmith/mcp-server` | Public npm | Apache-2.0 | 5A (immediate) |
| `@skillsmith/cli` | Public npm | Apache-2.0 | 5A (immediate) |
| `@skillsmith/enterprise` | Private npm | Proprietary | 7 (after gating) |

**Key Insight**: Free tier packages can be published and tested before billing infrastructure is complete. Enterprise package requires license validation (Phase 5B) and feature gating to be in place first.

## Commercialization Strategy

This ADR uses **feature bifurcation** (not usage limits):
- No rate limiting on core features
- No install/search quotas
- Feature flags in JWT payload determine tier access
- See [go-to-market-analysis.md](../strategy/go-to-market-analysis.md) for details

## References

- [TERMS.md](../legal/TERMS.md) - Complete Terms of Service with pricing tiers
- [ENTERPRISE_PACKAGE.md](../enterprise/ENTERPRISE_PACKAGE.md) - Enterprise feature specifications
- [go-to-market-analysis.md](../strategy/go-to-market-analysis.md) - Feature bifurcation strategy
- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
- [ADR-001: Monorepo Structure](./001-monorepo-structure.md)
- [Open Core Model Best Practices](https://opensource.guide/legal/)
