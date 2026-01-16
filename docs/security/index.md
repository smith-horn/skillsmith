# Security Standards - Skillsmith

**Version**: 1.0
**Status**: Active
**Owner**: Security Specialist
**Last Updated**: 2025-12-29

---

## Overview

> **Looking for user-focused security guidance?** See the [Skill Security Guide](./skill-security-guide.md) for information about trust tiers, safety when installing skills, and how Skillsmith protects you.

This document is the **authoritative source of truth** for security standards in Skillsmith. It consolidates security patterns, checklists, and references for consistent security practices.

---

## Quick Reference

| Topic | Location |
|-------|----------|
| **Skill Security Guide** | [skill-security-guide.md](./skill-security-guide.md) (user-facing) |
| Security Standards | [standards.md §4](../architecture/standards.md#4-security-standards) |
| Code Review Checklist | [checklists/code-review.md](checklists/code-review.md) |
| SSRF Prevention | [§2.1 SSRF Prevention](#21-ssrf-prevention) |
| Path Traversal Prevention | [§2.2 Path Traversal Prevention](#22-path-traversal-prevention) |
| Input Validation | [standards.md §4.3](../architecture/standards.md#43-input-validation-added-from-phase-2b) |
| Audit Logging | [§3 Audit Logging](#3-audit-logging) |

---

## 1. Security Architecture

### 1.1 Defense in Depth

Skillsmith implements security at multiple layers:

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Tool Boundary                        │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Input Validation (Zod)                  │    │
│  │  ┌───────────────────────────────────────────────┐  │    │
│  │  │           Source Adapters                      │  │    │
│  │  │  ┌─────────────────────────────────────────┐  │  │    │
│  │  │  │  SSRF Prevention  │  Path Traversal    │  │  │    │
│  │  │  └─────────────────────────────────────────┘  │  │    │
│  │  │  ┌─────────────────────────────────────────┐  │  │    │
│  │  │  │          Rate Limiting                  │  │  │    │
│  │  │  └─────────────────────────────────────────┘  │  │    │
│  │  └───────────────────────────────────────────────┘  │    │
│  │  ┌───────────────────────────────────────────────┐  │    │
│  │  │        Security Scanner (Skills)              │  │    │
│  │  └───────────────────────────────────────────────┘  │    │
│  │  ┌───────────────────────────────────────────────┐  │    │
│  │  │           Database Layer                       │  │    │
│  │  │  (Parameterized queries, schema validation)   │  │    │
│  │  └───────────────────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Trust Tiers

Skills are classified by trust level:

| Tier | Description | Allowed Operations |
|------|-------------|-------------------|
| `verified` | Anthropic/official skills | All operations |
| `community` | Community-reviewed skills | Standard operations |
| `experimental` | Unreviewed skills | Limited, sandboxed |
| `unknown` | New/unclassified | Read-only, warnings |

---

## 2. Security Patterns

### 2.1 SSRF Prevention

**Implemented in**: `RawUrlSourceAdapter.ts` (SMI-721, SMI-729)

Server-Side Request Forgery (SSRF) is prevented by blocking requests to internal networks.

#### Blocked Ranges (IPv4)

| Range | Description |
|-------|-------------|
| `10.0.0.0/8` | Private network |
| `172.16.0.0/12` | Private network |
| `192.168.0.0/16` | Private network |
| `127.0.0.0/8` | Localhost |
| `169.254.0.0/16` | Link-local |
| `0.0.0.0/8` | Current network |

#### Blocked Ranges (IPv6)

| Range | Description |
|-------|-------------|
| `::1` | Loopback (localhost) |
| `fe80::/10` | Link-local addresses |
| `fc00::/7` | Unique local addresses (ULA) |
| `ff00::/8` | Multicast addresses |
| `::ffff:0:0/96` | IPv4-mapped IPv6 addresses |

#### Blocked Hostnames

- `localhost`
- `::1` (IPv6 localhost)
- `0.0.0.0`

#### Implementation Pattern

```typescript
private validateUrl(url: string): void {
  const parsed = new URL(url);

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Invalid protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (['localhost', '::1', '0.0.0.0'].includes(hostname)) {
    throw new Error(`Access to localhost blocked: ${hostname}`);
  }

  // Check for IPv4 private ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 10 ||                          // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) ||          // 192.168.0.0/16
      a === 127 ||                          // 127.0.0.0/8
      (a === 169 && b === 254) ||          // 169.254.0.0/16
      a === 0                               // 0.0.0.0/8
    ) {
      throw new Error(`Access to private network blocked: ${hostname}`);
    }
  }

  // Check for IPv6 addresses (SMI-729)
  if (hostname.includes(':')) {
    this.validateIPv6(hostname);
  }
}

private validateIPv6(hostname: string): void {
  const normalized = hostname.toLowerCase();

  // Block link-local (fe80::/10)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb')) {
    throw new Error(`Access to IPv6 link-local address blocked: ${hostname}`);
  }

  // Block unique local addresses (fc00::/7)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    throw new Error(`Access to IPv6 unique local address blocked: ${hostname}`);
  }

  // Block multicast (ff00::/8)
  if (normalized.startsWith('ff')) {
    throw new Error(`Access to IPv6 multicast address blocked: ${hostname}`);
  }

  // Block IPv4-mapped IPv6 (::ffff:0:0/96)
  if (normalized.includes('::ffff:')) {
    throw new Error(`Access to IPv4-mapped IPv6 address blocked: ${hostname}`);
  }
}
```

#### Key Points

- Both IPv4 and IPv6 private ranges are blocked
- IPv4-mapped IPv6 addresses are detected and validated
- Case-insensitive matching for IPv6 addresses
- Defense in depth: protocol, hostname, and IP range checks

### 2.2 Path Traversal Prevention

**Implemented in**: `LocalFilesystemAdapter.ts` (SMI-720)

Path traversal attacks are prevented by validating that resolved paths remain within the allowed root directory.

#### Implementation Pattern

```typescript
private resolveSkillPath(location: SourceLocation): string {
  let resolvedPath: string;

  // Resolve path based on location type
  if (location.path?.startsWith('/')) {
    resolvedPath = location.path;
  } else if (location.path) {
    resolvedPath = join(this.rootDir, location.path);
  } else {
    // ... other resolution logic
  }

  // Normalize and validate containment
  const normalizedPath = resolve(resolvedPath);
  const normalizedRoot = resolve(this.rootDir);

  if (!normalizedPath.startsWith(normalizedRoot + '/') &&
      normalizedPath !== normalizedRoot) {
    throw new Error(`Path traversal detected: ${location.path}`);
  }

  return normalizedPath;
}
```

#### Key Points

- Always use `path.resolve()` to normalize paths
- Check that normalized path starts with root + separator
- Handle edge case where path equals root exactly
- Reject paths with `..` before resolution (defense in depth)

### 2.3 RegExp Injection Prevention

**Implemented in**: `LocalFilesystemAdapter.ts` (SMI-722)

User-provided patterns used in RegExp can cause ReDoS or injection attacks.

#### Implementation Pattern

```typescript
private isExcluded(name: string): boolean {
  return this.excludePatterns.some((pattern) => {
    // Exact match
    if (name === pattern) return true;

    // Prefix match
    if (name.startsWith(pattern)) return true;

    // Regex match with error handling
    try {
      return new RegExp(pattern).test(name);
    } catch {
      // Invalid regex - fall back to safe includes check
      return name.includes(pattern);
    }
  });
}
```

### 2.4 Content Security Policy (CSP)

**Implemented in**: `packages/mcp-server/src/middleware/csp.ts`, `packages/vscode-extension/src/utils/csp.ts` (SMI-731)

Content Security Policy headers prevent XSS and injection attacks by controlling which resources can be loaded.

#### MCP Server CSP

While the MCP server currently uses stdio transport, CSP utilities are provided for future HTTP transport scenarios.

**Default Policy**:

```typescript
{
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'https:'],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'upgrade-insecure-requests': true,
  'block-all-mixed-content': true
}
```

**Strict Policy (Production)**:

```typescript
{
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'upgrade-insecure-requests': true,
  'block-all-mixed-content': true
}
```

#### VS Code Extension CSP

Webviews use nonce-based CSP to prevent inline script execution.

**Skill Detail Webview Policy**:

```
default-src 'none';
script-src 'nonce-{nonce}';
style-src 'unsafe-inline';
img-src https: data: vscode-resource:;
connect-src 'none';
object-src 'none';
frame-src 'none';
form-action 'none'
```

#### Implementation Pattern

```typescript
// Generate cryptographically secure nonce
const nonce = generateCspNonce()

// Build CSP header with nonce
const csp = getSkillDetailCsp(nonce)

// Use nonce in HTML
;<meta http-equiv="Content-Security-Policy" content="${csp}">
  <script nonce="${nonce}">
    {
      // Only scripts with matching nonce can execute
    }
  </script>
```

#### Security Requirements

| Requirement                       | Status | Notes                                |
| --------------------------------- | ------ | ------------------------------------ |
| No `'unsafe-eval'` in production  | ✅     | Blocked in STRICT_CSP_DIRECTIVES     |
| No `'unsafe-inline'` without nonce | ✅     | All scripts use nonce-based CSP      |
| Block all object/embed elements   | ✅     | `object-src 'none'`                  |
| Block all frames                  | ✅     | `frame-src 'none'`, `frame-ancestors 'none'` |
| HTTPS upgrade                     | ✅     | `upgrade-insecure-requests` enabled  |
| No mixed content                  | ✅     | `block-all-mixed-content` enabled    |

### 2.5 Known Parsing Quirks

**Added**: Phase 2f (SMI-780, SMI-782)

These edge cases were discovered during security testing and should be considered when implementing URL or path validation.

#### IPv6 URL Hostname Brackets

Node.js `URL` class returns IPv6 hostnames **with brackets**:

```typescript
const url = new URL('http://[::1]:3000/path')
console.log(url.hostname)  // "[::1]" - NOT "::1"
```

**Fix**: Strip brackets before comparison:

```typescript
let hostname = parsed.hostname.toLowerCase()
if (hostname.startsWith('[') && hostname.endsWith(']')) {
  hostname = hostname.slice(1, -1)  // "[::1]" → "::1"
}
```

**Why it matters**: Without stripping, `hostname === '::1'` returns `false`, bypassing localhost SSRF checks.

#### Path Resolution Working Directory

`path.resolve()` without a base resolves relative to **current working directory**, not the intended root:

```typescript
// ❌ WRONG: Resolves relative to CWD
const normalizedPath = resolve(userPath)  // If CWD is /home/user, "../etc" → /home/etc

// ✅ CORRECT: Resolves relative to intended root
const normalizedPath = resolve(rootDir, userPath)  // rootDir + userPath
```

**Why it matters**: Attackers can escape the intended root directory if `resolve()` uses CWD instead of the security boundary.

#### Pattern Matching Fallback

Simple string patterns should not be treated as regex:

```typescript
// ❌ WRONG: Treats all patterns as regex
return new RegExp(pattern).test(value)  // "node_modules" matches "anode_modules"

// ✅ CORRECT: Only use regex for patterns with special chars
const isLikelyRegex = /[\\^$.*+?()[\]{}|]/.test(pattern)
if (!isLikelyRegex) {
  return value.startsWith(pattern)  // Prefix match only
}
return new RegExp(pattern).test(value)
```

**Why it matters**: Regex `.` matches any character, so `node_modules` would match `node-modules` or `nodeXmodules`.

---

## 3. Audit Logging

**Tracking Issue**: SMI-733

### 3.1 Events to Log

| Event Type | Data Captured |
|------------|--------------|
| URL Fetch | timestamp, url, status, duration, user_agent |
| File Access | timestamp, path, operation, result |
| Skill Install | timestamp, skill_id, source, trust_tier |
| Security Scan | timestamp, skill_id, findings, risk_score |

### 3.2 Schema

**Implemented in**: `packages/core/src/db/schema.ts` (SMI-733)

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT,  -- user, system, adapter
  resource TEXT,  -- URL, path, skill_id
  action TEXT,  -- fetch, read, install, scan
  result TEXT,  -- success, blocked, error
  metadata TEXT,  -- JSON with additional context
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource);
CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_logs(result);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor);
```

---

## 4. Security Testing

### 4.1 Test Files

| File | Coverage |
|------|----------|
| `RawUrlSourceAdapter.security.test.ts` | SSRF prevention |
| `SecurityScanner.test.ts` | Skill content scanning |
| `CacheSecurity.test.ts` | Cache security |
| `SessionManager.security.test.ts` | Session security |
| `security/ContinuousSecurity.test.ts` | Integration tests |
| `middleware/__tests__/csp.test.ts` | MCP server CSP utilities |
| `utils/__tests__/csp.test.ts` | VS Code extension CSP |

### 4.2 Running Security Tests

```bash
# Run all security tests
docker exec skillsmith-dev-1 npm test -- --grep "security"

# Run SSRF tests specifically
docker exec skillsmith-dev-1 npm test -- RawUrlSourceAdapter.security.test.ts

# Run SecurityScanner tests
docker exec skillsmith-dev-1 npm test -- SecurityScanner.test.ts

# Run CSP tests
docker exec skillsmith-dev-1 npm test -- csp.test.ts
```

### 4.3 Pre-Push Security Hook

**Implemented in**: SMI-727

Automated security checks run before every push to prevent security vulnerabilities from reaching production.

#### Checks Performed

1. **Security Test Suite**: Runs all tests in `packages/core/tests/security/`
2. **Dependency Audit**: Runs `npm audit --audit-level=high` to detect vulnerable dependencies
3. **Hardcoded Secrets Detection**: Scans for common secret patterns in code

#### Detected Secret Patterns

| Pattern Type | Examples |
|--------------|----------|
| API Keys | `api_key`, `secret_key`, `access_token`, `auth_token` |
| AWS Credentials | `AKIA...`, `aws_secret_access_key` |
| Passwords | `password=`, `passwd=` |
| Linear API | `LINEAR_API_KEY="lin_api_..."` |
| GitHub Tokens | `ghp_...`, `ghs_...` |
| Private Keys | `-----BEGIN ... PRIVATE KEY-----` |

#### Usage

```bash
# Normal push - runs checks automatically
git push origin main

# Bypass hook (NOT RECOMMENDED)
git push --no-verify origin main

# Run security checks manually
bash scripts/pre-push-check.sh
```

#### Files

- `.husky/pre-push` - Git hook that triggers security checks
- `scripts/pre-push-check.sh` - Security validation script

#### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All security checks passed |
| 1 | Security issues detected (push blocked) |

---

## 5. Code Review Security Checklist

See: [checklists/code-review.md](checklists/code-review.md)

### Quick Checklist

- [ ] **Input Validation**: All external input validated
- [ ] **SSRF**: URLs validated before fetch
- [ ] **Path Traversal**: File paths validated within root
- [ ] **Injection**: No string interpolation in SQL/shell
- [ ] **CSP**: Webviews use nonce-based CSP, no unsafe-eval/unsafe-inline
- [ ] **Secrets**: No hardcoded credentials
- [ ] **Schema**: Changes follow schema.ts patterns
- [ ] **Tests**: Security tests added for new features

---

## 6. Related Documentation

### Architecture Decision Records

| ADR | Topic |
|-----|-------|
| [ADR-002](../adr/002-docker-glibc-requirement.md) | Docker requirement |
| [ADR-007](../adr/007-rate-limiting-consolidation.md) | Rate limiting (planned) |

### Standards

| Document | Section |
|----------|---------|
| [standards.md](../architecture/standards.md) | §4 Security Standards |

### Retrospectives

| Retro | Security Topics |
|-------|-----------------|
| [phase-2b-tdd-security.md](../retros/phase-2b-tdd-security.md) | Initial security patterns |
| [phase-2d-security-fixes.md](../retros/phase-2d-security-fixes.md) | SMI-720 to SMI-724 |

### Source Files

| File | Security Feature |
|------|-----------------|
| `packages/core/src/sources/RawUrlSourceAdapter.ts` | SSRF prevention |
| `packages/core/src/sources/LocalFilesystemAdapter.ts` | Path traversal prevention |
| `packages/core/src/security/SecurityScanner.ts` | Skill content scanning |
| `packages/core/src/db/schema.ts` | Database schema |
| `packages/mcp-server/src/middleware/csp.ts` | CSP utilities for MCP server |
| `packages/vscode-extension/src/utils/csp.ts` | CSP utilities for webviews |
| `packages/vscode-extension/src/views/SkillDetailPanel.ts` | Webview CSP implementation |

---

## 7. Rate Limiting

**Implemented in**: SMI-730, SMI-1013

Rate limiting protects against abuse and DoS attacks using a token bucket algorithm.

### Configuration Presets

| Preset | Max Tokens | Refill Rate | Use Case |
|--------|------------|-------------|----------|
| `strict` | 10 | 1/sec | High-value endpoints |
| `standard` | 100 | 10/sec | Normal API usage |
| `relaxed` | 1000 | 100/sec | Batch operations |
| `burst` | 50 | 5/sec | Occasional high load |

### Implementation

```typescript
import { createRateLimiter, RATE_LIMIT_PRESETS } from '@skillsmith/core/security/RateLimiter'

const limiter = createRateLimiter(RATE_LIMIT_PRESETS.standard)
const result = limiter.consume('user-123')

if (!result.allowed) {
  throw new Error('Rate limit exceeded')
}
```

### Fail Mode Configuration

| Mode | Behavior | Use Case |
|------|----------|----------|
| `open` (default) | Allow requests on storage errors | General API endpoints |
| `closed` | Deny requests on storage errors | High-security endpoints |

```typescript
// High-security endpoint with fail-closed
const strictLimiter = createRateLimiter({
  ...RATE_LIMIT_PRESETS.strict,  // Already includes failMode: 'closed'
})
```

### Memory Bounds (SMI-1013)

**Added**: Wave 3 Security Hardening (2026-01-03)

The rate limiter enforces strict memory bounds to prevent resource exhaustion attacks:

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_UNIQUE_KEYS` | 10,000 | Maximum unique keys for queues and metrics |
| `METRICS_TTL_MS` | 1 hour (3,600,000ms) | Time-to-live for stale metrics entries |
| Cleanup Interval | 5 minutes | Periodic cleanup of stale metrics |

#### Memory Protection Mechanisms

1. **Metrics Eviction**: When `MAX_UNIQUE_KEYS` is reached, the oldest metrics entry (by `lastUpdated`) is evicted before adding a new key.

2. **Queue Bounds**: New queues are rejected with `RateLimitQueueFullError` when the limit is reached.

3. **TTL-Based Cleanup**: Metrics older than `METRICS_TTL_MS` are automatically removed every 5 minutes.

4. **Empty Queue Cleanup**: Empty queues are deleted during queue processing to prevent memory leaks.

#### Concurrency Safety (SMI-1013)

| Mechanism | Purpose |
|-----------|---------|
| `isProcessingQueues` flag | Prevents concurrent queue processing |
| UUID request IDs | Prevents timestamp collision in queued requests |
| ID-based removal | Queue requests removed by ID, not position |

### Request Queuing (SMI-1013)

When rate limited, requests can optionally queue and wait for tokens:

```typescript
const limiter = new RateLimiter({
  ...RATE_LIMIT_PRESETS.standard,
  enableQueue: true,
  queueTimeoutMs: 30000,  // Wait up to 30s
  maxQueueSize: 100,      // Max 100 waiting requests per key
})

// Will wait for token or throw RateLimitQueueTimeoutError
const result = await limiter.waitForToken('adapter:github')
if (result.queued) {
  console.log(`Waited ${result.queueWaitMs}ms in queue`)
}
```

### Metrics Monitoring

```typescript
// Get metrics for monitoring
const metrics = limiter.getMetrics('user-123')
console.log(`Allowed: ${metrics.allowed}, Blocked: ${metrics.blocked}`)

// Reset metrics
limiter.resetMetrics('user-123')

// Callback on limit exceeded
const limiter = createRateLimiter({
  ...RATE_LIMIT_PRESETS.standard,
  onLimitExceeded: (key, metrics) => {
    alerting.notify(`Rate limit exceeded for ${key}`)
  }
})
```

---

## 8. Input Sanitization

**Implemented in**: SMI-732

Input sanitization prevents XSS, injection, and other input-based attacks.

### Available Functions

| Function | Purpose | Use Case |
|----------|---------|----------|
| `sanitizeHtml()` | Strip HTML/scripts | User-provided descriptions |
| `sanitizePath()` | Remove path traversal | File system operations |
| `sanitizeFilename()` | Safe filenames | User uploads |
| `sanitizeUrl()` | URL validation | External links |
| `sanitizeForLog()` | Log-safe strings | Audit logging |

### Known Limitations

- **ReDoS risk**: Complex regex patterns may be vulnerable with very long inputs
- Recommendation: Add input length limits before sanitization

---

## 9. Code Review Results

**Reviewed**: 2025-12-29
**Sprint**: SMI-725 to SMI-737

### Overall Assessment: APPROVED ✅

| Category | Rating | Notes |
|----------|--------|-------|
| Security Patterns | Excellent | Comprehensive SSRF, path traversal coverage |
| Code Quality | Very Good | TypeScript best practices followed |
| Test Coverage | Excellent | 100% method coverage on security utilities |
| Documentation | Good | JSDoc comments on all public APIs |

### Minor Issues Identified

1. **ReDoS in HTML sanitization** - Script tag regex uses nested quantifiers
2. **Fail-open rate limiting** - Consider fail-closed option for critical endpoints
3. **Pre-push efficiency** - Script runs tests twice unnecessarily

### Recommendations

- Add input length limits to sanitization functions
- Add rate limit metrics for monitoring
- Optimize pre-push script to single test run

---

## 10. Tracking Issues

| Issue | Title | Priority | Status |
|-------|-------|----------|--------|
| SMI-725 | Add security scanning to CI | P1 | ✅ Done |
| SMI-726 | Standardize adapter validation | P2 | ✅ Done |
| SMI-727 | Implement pre-push security hook | P1 | ✅ Done |
| SMI-728 | Consolidate logger usage | P3 | ✅ Done |
| SMI-729 | Add IPv6 SSRF protection | P2 | ✅ Done |
| SMI-730 | Consolidate rate limiting | P3 | ✅ Done |
| SMI-731 | Add Content Security Policy headers | P1 | ✅ Done |
| SMI-732 | Add input sanitization library | P2 | ✅ Done |
| SMI-733 | Add structured audit logging | P2 | ✅ Done |
| SMI-734 | Create security source of truth | P1 | ✅ Done |
| SMI-735 | Create security review checklist | P1 | ✅ Done |
| SMI-737 | Create ADR-007 rate limiting | P3 | ✅ Done |

---

*This document is the authoritative source for security standards. For questions, contact the Security Specialist.*

*Last Code Review: 2025-12-29 | Reviewer: Claude Opus 4.5*
