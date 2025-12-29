# Security Code Review Checklist

**Version**: 1.0
**Last Updated**: 2025-12-29

Use this checklist during code reviews to ensure consistent security evaluation.

---

## Quick Checklist

Copy this into your PR review:

```markdown
## Security Review

- [ ] Input validation for all external data
- [ ] SSRF prevention for URL fetches
- [ ] Path traversal prevention for file access
- [ ] No SQL/shell injection vulnerabilities
- [ ] No hardcoded secrets or credentials
- [ ] Schema changes follow patterns in schema.ts
- [ ] Security tests added for new features
- [ ] No sensitive data in logs
```

---

## Detailed Checklist

### 1. Input Validation

#### External Data Sources

- [ ] **MCP Tool Inputs**: Validated with Zod schemas
- [ ] **User Strings**: Length limits, character validation
- [ ] **File Paths**: No `..`, null bytes, or shell characters
- [ ] **URLs**: Protocol validation, host validation
- [ ] **JSON Data**: Schema validated, prototype pollution checked

#### Validation Patterns

```typescript
// ✅ CORRECT: Zod schema validation
import { z } from 'zod';
const schema = z.object({
  query: z.string().max(1000),
  limit: z.number().min(1).max(100).default(10)
});
const input = schema.parse(rawInput);

// ❌ WRONG: No validation
const query = rawInput.query;
```

**Reference**: [standards.md §4.3](../../architecture/standards.md#43-input-validation-added-from-phase-2b)

---

### 2. SSRF Prevention

#### URL Fetch Operations

- [ ] URLs validated before any fetch operation
- [ ] Private IP ranges blocked (10.x, 172.16-31.x, 192.168.x)
- [ ] Localhost variants blocked (127.x, localhost, ::1)
- [ ] Only http/https protocols allowed
- [ ] Cloud metadata endpoints blocked (169.254.169.254)

#### Review Questions

1. Does the code fetch URLs from user input?
2. Are all fetched URLs validated with `validateUrl()`?
3. Can an attacker control any part of the URL?

**Reference**: [security/index.md §2.1](../index.md#21-ssrf-prevention)

---

### 3. Path Traversal Prevention

#### File Access Operations

- [ ] Paths resolved with `path.resolve()` before use
- [ ] Resolved paths validated within allowed root directory
- [ ] No direct use of user-provided paths without validation
- [ ] Symlink handling explicitly configured

#### Review Questions

1. Does the code read/write files based on user input?
2. Is the path validated to stay within rootDir?
3. Can `..` sequences escape the intended directory?

**Reference**: [security/index.md §2.2](../index.md#22-path-traversal-prevention)

---

### 4. Injection Prevention

#### SQL Injection

- [ ] All SQL uses parameterized queries (prepared statements)
- [ ] Table/column names from user input are validated
- [ ] No string interpolation in SQL statements

```typescript
// ✅ CORRECT: Parameterized query
db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);

// ❌ WRONG: String interpolation
db.exec(`SELECT * FROM skills WHERE id = '${skillId}'`);
```

#### Command Injection

- [ ] Shell commands use `execFile` with array arguments
- [ ] No `shell: true` option in spawn/exec
- [ ] User input never interpolated into command strings

```typescript
// ✅ CORRECT: execFile with array args
execFile('git', ['clone', repoUrl], { shell: false });

// ❌ WRONG: exec with string interpolation
exec(`git clone ${repoUrl}`);
```

#### RegExp Injection

- [ ] User input in RegExp wrapped in try/catch
- [ ] Fallback to safe string operations on regex failure

**Reference**: [standards.md §4.3](../../architecture/standards.md#43-input-validation-added-from-phase-2b)

---

### 5. Secrets and Credentials

- [ ] No hardcoded API keys, tokens, or passwords
- [ ] Secrets loaded from environment variables
- [ ] `.env` files not committed to repository
- [ ] No secrets in log output or error messages

#### Review Questions

1. Does the code handle any secrets or API keys?
2. Are secrets loaded from environment variables only?
3. Could any log statement expose secrets?

---

### 6. Database Schema

When reviewing changes to `packages/core/src/db/schema.ts`:

- [ ] New tables have appropriate indexes
- [ ] Foreign keys use `ON DELETE` clauses
- [ ] Text fields have appropriate constraints
- [ ] Numeric fields have range checks
- [ ] Migration handles existing data

#### Schema Reference

**Current Tables**:
- `skills` - Main skill storage
- `skills_fts` - Full-text search index
- `sources` - Skill sources
- `categories` - Skill categories
- `skill_categories` - Junction table
- `cache` - Query cache
- `schema_version` - Migration tracking

**Reference**: [schema.ts](../../../packages/core/src/db/schema.ts)

---

### 7. Security Testing

- [ ] Security tests added for new security-sensitive code
- [ ] Existing security tests still pass
- [ ] Edge cases covered (empty input, malformed data)
- [ ] Error paths tested

#### Security Test Locations

| Feature | Test File |
|---------|-----------|
| SSRF Prevention | `RawUrlSourceAdapter.security.test.ts` |
| Skill Scanning | `SecurityScanner.test.ts` |
| Cache Security | `CacheSecurity.test.ts` |
| Session Security | `SessionManager.security.test.ts` |

---

### 8. Logging and Monitoring

- [ ] No sensitive data in log output
- [ ] Security-relevant events logged for audit
- [ ] Error messages don't expose internal details
- [ ] Logger uses `createLogger()` utility

```typescript
// ✅ CORRECT: Logger utility
import { createLogger } from '../utils/logger.js';
const log = createLogger('MyAdapter');
log.warn('Validation failed', { field: 'url' });

// ❌ WRONG: console.warn with sensitive data
console.warn('Failed to validate URL:', url);
```

---

### 9. Dependencies

- [ ] No new dependencies with known vulnerabilities
- [ ] Dependencies from trusted sources
- [ ] Minimal dependency footprint
- [ ] Run `npm audit` after adding dependencies

---

## Review Decision Matrix

| Finding | Severity | Action |
|---------|----------|--------|
| Hardcoded secret | Critical | Block merge, rotate secret |
| SQL injection | Critical | Block merge |
| SSRF vulnerability | High | Block merge |
| Path traversal | High | Block merge |
| Missing input validation | Medium | Request changes |
| Missing security tests | Medium | Request changes |
| Inconsistent logging | Low | Suggest improvement |

---

## Related Documents

- [Security Standards Index](../index.md)
- [Engineering Standards §4](../../architecture/standards.md#4-security-standards)
- [Phase 2d Security Retrospective](../../retros/phase-2d-security-fixes.md)

---

*Use this checklist consistently. Security is everyone's responsibility.*
