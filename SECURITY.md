# Security Policy

## Reporting a Vulnerability

We take the security of Skillsmith seriously. If you discover a security vulnerability, please report it responsibly through one of the following channels.

**Please DO NOT file a public GitHub issue for security vulnerabilities.**

### How to Report

1. **Email**: Send a detailed report to **security@skillsmith.app**
2. **GitHub Security Advisories**: Use [GitHub's private vulnerability reporting](https://github.com/smith-horn/skillsmith/security/advisories/new) to submit a confidential advisory

### What to Include in a Report

- **Description** -- A clear description of the vulnerability and the affected component
- **Reproduction Steps** -- Step-by-step instructions to reproduce the issue
- **Impact** -- What an attacker could achieve by exploiting this vulnerability
- **Affected Versions** -- Which versions are affected, if known
- **Suggested Fix** -- If you have a recommendation for remediation (optional)

### Response Timeline

| Timeline | Action |
|----------|--------|
| **48 hours** | Initial acknowledgment of your report |
| **Severity-dependent** | Development and release of a fix (critical issues prioritized) |
| **Coordinated disclosure** | Public disclosure after a fix is available, coordinated with the reporter |

We follow coordinated disclosure practices. We ask that you refrain from publicly disclosing the vulnerability until we have had a reasonable opportunity to address it and notify affected users.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| < 1.0 | No |

We recommend always running the latest version to benefit from the most recent security patches.

## Security Measures

Skillsmith implements the following security practices to protect the codebase and its users:

| Measure | Description |
|---------|-------------|
| **Code Review** | All changes require peer review before merging |
| **Automated Secret Scanning** | Gitleaks and GitHub secret scanning detect leaked credentials in CI |
| **Dependabot** | Automated dependency updates for known vulnerabilities |
| **Regular Audits** | npm audit runs in CI; periodic manual security reviews |
| **Input Validation** | Zod runtime validation at all MCP boundaries |
| **Parameterized Queries** | SQL injection prevention via parameterized queries |
| **Path Traversal Prevention** | Normalized path validation with blocked traversal patterns |
| **SSRF Prevention** | URL validation with blocked internal network ranges |
| **Rate Limiting** | Configurable per-endpoint rate limits |
| **CodeQL Analysis** | Automated static analysis via GitHub CodeQL on every PR |

## Bug Bounty Program

Not currently offered. We appreciate responsible disclosure and will acknowledge security researchers who help keep Skillsmith secure (with your permission) in our security advisories.

## Contact

- **Security Issues**: security@skillsmith.app
- **General Questions**: Via GitHub Issues
