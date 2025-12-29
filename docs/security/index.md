# Security Standards - Skillsmith

**Version**: 1.0
**Status**: Active
**Owner**: Security Specialist
**Last Updated**: 2025-12-29

---

## Overview

This document is the **authoritative source of truth** for security standards in Skillsmith. It consolidates security patterns, checklists, and references for consistent security practices.

---

## Quick Reference

| Topic | Location |
|-------|----------|
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

**Implemented in**: `RawUrlSourceAdapter.ts` (SMI-721)

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

  // Check for private IP ranges
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
}
```

#### Future Work

- SMI-729: Add IPv6 private range detection

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

### 3.2 Schema (Planned)

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

### 4.2 Running Security Tests

```bash
# Run all security tests
docker exec skillsmith-dev-1 npm test -- --grep "security"

# Run SSRF tests specifically
docker exec skillsmith-dev-1 npm test -- RawUrlSourceAdapter.security.test.ts

# Run SecurityScanner tests
docker exec skillsmith-dev-1 npm test -- SecurityScanner.test.ts
```

---

## 5. Code Review Security Checklist

See: [checklists/code-review.md](checklists/code-review.md)

### Quick Checklist

- [ ] **Input Validation**: All external input validated
- [ ] **SSRF**: URLs validated before fetch
- [ ] **Path Traversal**: File paths validated within root
- [ ] **Injection**: No string interpolation in SQL/shell
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

---

## 7. Tracking Issues

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-725 | Add security scanning to CI | P1 |
| SMI-726 | Standardize adapter validation | P2 |
| SMI-729 | Add IPv6 SSRF protection | P2 |
| SMI-732 | Add input sanitization library | P2 |
| SMI-733 | Add structured audit logging | P2 |
| SMI-734 | Create security source of truth | P1 |
| SMI-735 | Create security review checklist | P1 |

---

*This document is the authoritative source for security standards. For questions, contact the Security Specialist.*
