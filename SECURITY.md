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

### Skill Security Scanner

All skills pass through a multi-category static analysis scanner before indexing. The scanner detects:

| Category | Examples | Severity |
|----------|----------|----------|
| Jailbreak patterns | "ignore previous instructions", "bypass safety" | Critical |
| AI defence patterns (CVE-hardened) | Role injection, zero-width character obfuscation, encoded payloads | Critical |
| Privilege escalation | `sudo -S`, `chmod 777`, sudoers manipulation | Critical |
| Social engineering | "pretend to be", "roleplay as" | High |
| Prompt leaking | "show me your system instructions", "reveal your prompt" | High |
| Data exfiltration | `fetch` with query params, `WebSocket`, `sendBeacon` | High |
| Sensitive file references | `.env`, `.ssh`, `.pem`, credentials | High |
| Suspicious code patterns | `eval()`, `child_process`, `rm -rf`, pipe-to-shell | Medium |
| URL/domain analysis | External URLs checked against allowlist | Medium |

Findings are weighted by severity, category, and confidence. Documentation context (code blocks, tables) receives reduced confidence to minimize false positives.

### Trust Tiers

Skills are classified into six trust tiers that control scanner strictness and user consent requirements:

| Tier | Risk Threshold | Verification |
|------|---------------|--------------|
| Verified | 70 | Publisher identity confirmed (GitHub org) |
| Curated | 60 | Reviewed by Skillsmith team |
| Community | 40 | Automated scans pass, has license + README |
| Experimental | 25 | Beta/new, strict scanning |
| Unknown | 20 | No verification, strictest scanning |
| Local | 100 | User's own skills, no restrictions |

### Quarantine System

Skills flagged as malicious enter an authenticated quarantine workflow:

1. Immediate removal from search results
2. Installation blocked for all users
3. Authenticated review queue with role-based access control
4. Multi-approval required for MALICIOUS severity (2 independent reviewers)
5. Full audit trail of all review actions

### Installation-Time Security

Even after indexing, skills are re-checked at install time:

- **Quarantine re-check** — Status may have changed since indexing
- **Live security scan** — Content scanned with tier-appropriate thresholds
- **Content integrity** — SHA-256 hash for tamper detection on updates

### Audit Logging

All security-relevant events are logged:

- Skill indexed (scan results, source, timestamp)
- Scan findings (type, severity, sanitized content)
- Quarantine actions (quarantined/approved/rejected, reviewer identity)
- Installation events (user consent, trust tier at time)

For the full security architecture deep-dive, see [Security, Quarantine, and Safe Skill Installation](https://skillsmith.app/blog/security-quarantine-safe-installation).

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

We support the latest minor version of each package. Older minor versions are unsupported. Patch releases include security fixes.

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
