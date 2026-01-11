# Security Policy

## Reporting a Vulnerability

We take the security of Skillsmith seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**Please DO NOT file a public GitHub issue for security vulnerabilities.**

Instead, please report security issues by emailing:

**security@smithhorn.ca**

Include the following information in your report:

1. **Description** - A clear description of the vulnerability
2. **Impact** - What an attacker could achieve by exploiting this
3. **Reproduction Steps** - Step-by-step instructions to reproduce
4. **Affected Versions** - Which versions are affected
5. **Suggested Fix** - If you have one (optional)

### What to Expect

| Timeline | Action |
|----------|--------|
| **24 hours** | Acknowledgment of your report |
| **72 hours** | Initial assessment and severity classification |
| **7 days** | Status update on remediation plan |
| **90 days** | Target for fix release (critical issues faster) |

### Scope

The following are in scope for security reports:

- **Skillsmith core packages** (@skillsmith/core, @skillsmith/mcp-server, @skillsmith/cli)
- **MCP protocol implementation** vulnerabilities
- **Authentication/Authorization** bypasses
- **Injection vulnerabilities** (SQL, command, path traversal)
- **Information disclosure** of sensitive data
- **Denial of service** vulnerabilities
- **Dependency vulnerabilities** with demonstrated exploit

### Out of Scope

- Vulnerabilities in third-party dependencies without a working exploit
- Social engineering attacks
- Physical security issues
- Issues requiring unlikely user interaction
- Theoretical vulnerabilities without proof of concept

## Security Measures

### Current Protections

Skillsmith implements the following security measures:

| Protection | Implementation |
|------------|----------------|
| **Input Validation** | Zod runtime validation at all MCP boundaries |
| **Path Traversal Prevention** | Normalized path validation, blocked patterns |
| **SSRF Prevention** | URL validation, blocked internal ranges |
| **Rate Limiting** | Configurable per-endpoint rate limits |
| **SQL Injection Prevention** | Parameterized queries via better-sqlite3 |
| **Secret Detection** | Gitleaks configuration for CI/CD |
| **Dependency Auditing** | npm audit in CI pipeline |

### Security Testing

- Security-focused test suite (`npm run test:security`)
- SSRF and path traversal edge case testing
- Malicious input handling tests
- CI/CD security scanning

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x (current) | Yes |
| < 0.1.0 | No |

## Security Updates

Security updates are released as patch versions. We recommend:

1. Enable automated dependency updates (Dependabot, Renovate)
2. Subscribe to GitHub security advisories for this repository
3. Run `npm audit` regularly in your deployments

## Acknowledgments

We appreciate security researchers who help keep Skillsmith secure. With your permission, we will acknowledge your contribution in our security advisories.

## Contact

- **Security Issues**: security@smithhorn.ca
- **General Questions**: Via GitHub Issues
- **Commercial Support**: contact@smithhorn.ca
