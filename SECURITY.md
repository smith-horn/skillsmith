# Security Policy

## Reporting a Vulnerability

We take the security of Skillsmith seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**Please DO NOT file a public GitHub issue for security vulnerabilities.**

Instead, please report security issues by emailing:

**<security@skillsmith.app>**

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

- **Skillsmith packages** (@skillsmith/core, @skillsmith/mcp-server, @skillsmith/cli, @smith-horn/enterprise)
- **MCP protocol implementation** vulnerabilities
- **Authentication/Authorization** bypasses (API keys, Supabase JWT)
- **Injection vulnerabilities** (SQL, command, path traversal)
- **Information disclosure** of sensitive data
- **Denial of service** vulnerabilities
- **Supabase Edge Functions** security issues
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
| **Command Injection Prevention** | `execFileSync` with array args; no shell string interpolation |
| **Secret Management** | Varlock for secret injection; never exposed in terminal output |
| **Encrypted Documentation** | git-crypt for sensitive docs, configs, and Supabase functions |
| **Secret Detection** | Gitleaks configuration for CI/CD |
| **Dependency Auditing** | npm audit in CI pipeline |
| **ReDoS Prevention** | User-supplied regex capped at 200 characters |

### Security Testing

- Security-focused test suite in core package (`packages/core`: `npm run test:security`)
- SSRF and path traversal edge case testing
- Malicious input handling tests
- CI/CD security scanning (pre-push hook with 4-phase checks)
- Standards audit (`npm run audit:standards`)

## Supported Versions

| Package | Current Version | Supported |
|---------|----------------|-----------|
| @skillsmith/core | 0.4.x | Yes |
| @skillsmith/mcp-server | 0.3.x | Yes |
| @skillsmith/cli | 0.3.x | Yes |
| @smith-horn/enterprise | 0.1.x | Yes |
| All packages < current minor | No |

We support the latest minor version of each package. Patch releases include security fixes.

## Security Updates

Security updates are released as patch versions. We recommend:

1. Enable automated dependency updates (Dependabot, Renovate)
2. Subscribe to GitHub security advisories for this repository
3. Run `npm audit` regularly in your deployments

## Acknowledgments

We appreciate security researchers who help keep Skillsmith secure. With your permission, we will acknowledge your contribution in our security advisories.

## Contact

- **Security Issues**: <security@skillsmith.app>
- **General Questions**: [GitHub Issues](https://github.com/smith-horn/skillsmith/issues)
- **Commercial Support**: <support@skillsmith.app>
