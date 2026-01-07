# @skillsmith/enterprise

Enterprise features for Skillsmith skill discovery platform.

## Overview

The enterprise package provides security, compliance, and team collaboration features for organizations requiring advanced controls.

## Features

### Enterprise Tier ($55/user/month)

| Feature | Description |
|---------|-------------|
| **SSO/SAML** | Integrate with Okta, Azure AD, Google Workspace |
| **RBAC** | Role-based access control for skill management |
| **Audit Logging** | SOC 2-ready event capture with immutable storage |
| **SIEM Export** | Stream events to Splunk, Datadog, CloudWatch |
| **Compliance Reports** | SOC 2 and GDPR mapping documentation |
| **Private Registry** | Self-hosted skill registry option |
| **Dedicated SLA** | 4-hour response, 99.9% uptime guarantee |

### Team Tier ($25/user/month)

| Feature | Description |
|---------|-------------|
| **Workspaces** | Shared skill configurations |
| **Private Skills** | Internal-only skill sharing |
| **Usage Analytics** | Team-wide adoption metrics |
| **Priority Support** | 24-hour email response |

## Installation

This package is distributed via GitHub Packages (private registry).

### Authentication

```bash
# Configure npm for GitHub Packages
npm login --registry=https://npm.pkg.github.com --scope=@skillsmith

# Or add to ~/.npmrc
@skillsmith:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

### Install

```bash
npm install @skillsmith/enterprise
```

## Usage

```typescript
import { LicenseValidator, AuditLogger } from '@skillsmith/enterprise';

// Validate license
const validator = new LicenseValidator();
const license = await validator.validate(licenseKey);

if (license.tier === 'enterprise') {
  // Enable enterprise features
  const logger = new AuditLogger(sinkConfig);
  await logger.log({ action: 'skill.install', ... });
}
```

## Testing

### Integration Tests

The enterprise package includes comprehensive integration tests for license validation with real RS256 JWT verification:

```bash
# Run integration tests
npm test -- packages/enterprise/tests/integration/

# Run all enterprise tests
npm test -- packages/enterprise/
```

**Test Coverage:**
- Valid token validation (all tiers)
- Expired/not-yet-valid token rejection
- Invalid signature detection
- Issuer/audience validation
- Missing/invalid claims handling
- Public key caching and rotation
- Concurrent validation

### Test Utilities

Test utilities are available in `tests/fixtures/license-test-utils.ts` for creating test JWT tokens:

```typescript
import {
  generateTestKeyPair,
  createTestLicenseToken,
  createExpiredToken,
  createWrongSignatureToken,
} from '@skillsmith/enterprise/tests/fixtures/license-test-utils';

// Generate RSA key pair for testing
const { publicKey, privateKey } = await generateTestKeyPair();

// Create valid test token
const token = await createTestLicenseToken(privateKey, {
  tier: 'enterprise',
  features: ['sso_saml', 'audit_logging'],
});

// Create expired token for error testing
const expiredToken = await createExpiredToken(privateKey);
```

## License

This software is proprietary. See [LICENSE.md](./LICENSE.md) for terms.

A valid Skillsmith Enterprise or Team subscription is required.

## Support

- **Enterprise Support**: enterprise@skillsmith.dev
- **Documentation**: https://skillsmith.dev/docs/enterprise
- **Feature Requests**: https://github.com/smith-horn-group/skillsmith/issues

## Related Packages

- [@skillsmith/core](https://www.npmjs.com/package/@skillsmith/core) - Core functionality (Apache-2.0)
- [@skillsmith/mcp-server](https://www.npmjs.com/package/@skillsmith/mcp-server) - MCP server (Apache-2.0)
- [@skillsmith/cli](https://www.npmjs.com/package/@skillsmith/cli) - CLI tools (Apache-2.0)
