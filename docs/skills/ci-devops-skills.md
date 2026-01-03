# CI/DevOps Skills Specification

**Created**: January 3, 2026
**Status**: Proposed
**Based On**: CI Pipeline Code Review (SMI-968 through SMI-973)

---

## Overview

This document specifies five new Claude Code skills for CI/DevOps automation, identified through gap analysis of the Skillsmith skill database (13,602 skills) against real-world CI pipeline issues.

## Skills Summary

| Skill | Priority | Linear Issue | Based On |
|-------|----------|--------------|----------|
| [flaky-test-detector](#1-flaky-test-detector) | 🔴 High | SMI-978 | SMI-973 |
| [ci-doctor](#2-ci-doctor) | 🔴 High | SMI-979 | SMI-968 |
| [version-sync](#3-version-sync) | 🟡 Medium | SMI-980 | SMI-968 |
| [docker-optimizer](#4-docker-optimizer) | 🟡 Medium | SMI-981 | SMI-969 |
| [security-auditor](#5-security-auditor) | 🟡 Medium | SMI-982 | SMI-971 |

---

## 1. flaky-test-detector

### Purpose
Identify and fix timing-sensitive tests that fail intermittently in CI.

### Trigger Phrases
- "flaky test"
- "intermittent failure"
- "test sometimes fails"
- "race condition in test"
- "timing issue in test"

### Detection Patterns

```typescript
const FLAKY_PATTERNS = [
  {
    pattern: /ttl.*:\s*1\b/,
    risk: 'high',
    message: 'TTL of 1 second creates race condition at second boundaries',
    fix: 'Increase TTL to 5+ seconds or mock time with vi.useFakeTimers()',
  },
  {
    pattern: /timeout.*:\s*[1-9]0?\b/,
    risk: 'medium',
    message: 'Low timeout may cause flakes on slow CI runners',
    fix: 'Increase timeout or use vi.useFakeTimers()',
  },
  {
    pattern: /Date\.now\(\)/,
    risk: 'medium',
    message: 'Real time usage without mocking may cause timing issues',
    fix: 'Mock with vi.useFakeTimers() and vi.setSystemTime()',
  },
  {
    pattern: /Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/,
    risk: 'high',
    message: 'Second truncation combined with short TTL causes boundary races',
    fix: 'Use longer durations or mock time',
  },
  {
    pattern: /setTimeout\([^,]+,\s*\d{1,2}\)/,
    risk: 'high',
    message: 'Very short setTimeout in test may not complete on slow CI',
    fix: 'Use vi.useFakeTimers() and vi.advanceTimersByTime()',
  },
  {
    pattern: /sleep\s*\(\s*\d{1,3}\s*\)/,
    risk: 'medium',
    message: 'Short sleep may not be sufficient on slow CI runners',
    fix: 'Increase sleep duration or use event-based waiting',
  },
];
```

### Example Output

```markdown
## Flaky Test Analysis

Scanned 45 test files, found 3 potential flaky patterns.

### 🔴 High Risk

**packages/core/tests/cache.test.ts:119**
```typescript
const shortCache = new L2Cache({ ttlSeconds: 1 })
```
- Risk: Second boundary crossing between set() and has()
- Fix: Increase TTL to 5+ seconds or use `vi.useFakeTimers()`

### 🟡 Medium Risk

**packages/mcp-server/tests/search.test.ts:78**
```typescript
expect(Date.now() - start).toBeLessThan(1000)
```
- Risk: Real time comparison may fail on slow CI
- Fix: Mock time or use larger threshold
```

### Implementation Notes

1. Scan all `*.test.ts` and `*.spec.ts` files
2. Apply regex patterns with context extraction
3. Classify by risk level
4. Generate fix suggestions with code examples
5. Optionally integrate with CI logs to correlate with actual failures

---

## 2. ci-doctor

### Purpose
Diagnose and fix common CI/CD pipeline issues automatically.

### Trigger Phrases
- "CI failing"
- "workflow broken"
- "pipeline error"
- "GitHub Actions not working"
- "build failed"
- "CI not passing"

### Checks Performed

#### Version Consistency

```typescript
const VERSION_FILES = [
  { file: '.nvmrc', pattern: /^(\d+)/, name: 'nvmrc' },
  { file: 'package.json', path: 'engines.node', name: 'package.json' },
  { file: 'Dockerfile', pattern: /FROM node:(\d+)/, name: 'Dockerfile' },
  { file: '.github/workflows/*.yml', pattern: /NODE_VERSION.*['"](\d+)['"]/, name: 'CI workflow' },
  { file: 'docker-compose.yml', pattern: /image:\s*node:(\d+)/, name: 'docker-compose' },
];
```

#### Anti-Patterns

```typescript
const CI_ANTI_PATTERNS = [
  {
    pattern: /\|\|\s*true/,
    message: 'Command failure being masked with || true',
    fix: 'Use continue-on-error: true with warning annotation',
  },
  {
    pattern: /npm ci(?!.*cache)/,
    message: 'npm ci without caching configured',
    fix: 'Add actions/cache or actions/setup-node with cache',
  },
  {
    pattern: /continue-on-error:\s*true(?!.*#)/,
    message: 'Errors being suppressed without documentation',
    fix: 'Add comment explaining why errors are acceptable',
  },
  {
    pattern: /npm run build[\s\S]{0,500}npm run build/,
    message: 'Duplicate build steps detected',
    fix: 'Share build artifacts between jobs',
  },
];
```

### Example Output

```markdown
## CI Health Check

### 🔴 Critical Issues

**Node.js Version Mismatch**
| Location | Version | Status |
|----------|---------|--------|
| .nvmrc | 22 | ✅ |
| package.json | >=22.0.0 | ✅ |
| Dockerfile | 20-slim | ❌ Outdated |
| ci.yml | 20 | ❌ Outdated |

**Fix**: Update Dockerfile and ci.yml to Node 22

### 🟡 Warnings

**Security audit masking** (.github/workflows/ci.yml:248)
```yaml
npm audit --audit-level=high || true
```
Fix: Use `continue-on-error: true` with warning annotation

### ✅ Passed Checks
- Cache configuration present
- Timeout set on all jobs
- Artifacts configured correctly
```

---

## 3. version-sync

### Purpose
Keep version specifications synchronized across all configuration files.

### Trigger Phrases
- "version mismatch"
- "upgrade node"
- "sync versions"
- "update node version"
- "version drift"

### Supported Version Files

```yaml
node:
  - .nvmrc
  - package.json#engines.node
  - Dockerfile (FROM node:X)
  - .github/workflows/*.yml (NODE_VERSION, setup-node)
  - docker-compose.yml (image: node:X)
  - .tool-versions (asdf)
  - .node-version (nodenv)

typescript:
  - package.json#devDependencies.typescript
  - tsconfig.json#compilerOptions.target

python:
  - .python-version
  - pyproject.toml#python
  - Dockerfile (FROM python:X)
```

### Commands

```
version-sync check          # Show version status across files
version-sync update 22      # Update all Node files to version 22
version-sync update --dry-run  # Preview changes without applying
```

### Example Output

```markdown
## Node.js Version Status

| File | Current | Target | Action |
|------|---------|--------|--------|
| .nvmrc | 22 | 22 | ✅ No change |
| package.json | >=22.0.0 | >=22.0.0 | ✅ No change |
| Dockerfile | 20-slim | 22-slim | 📝 Will update |
| ci.yml | 20 | 22 | 📝 Will update |
| e2e-tests.yml | 22 | 22 | ✅ No change |

**2 files will be updated. Run with --apply to make changes.**
```

---

## 4. docker-optimizer

### Purpose
Analyze and optimize Dockerfiles for faster builds and smaller images.

### Trigger Phrases
- "slow docker build"
- "optimize Dockerfile"
- "layer caching"
- "reduce image size"
- "docker build taking too long"

### Optimization Checks

```typescript
const DOCKER_OPTIMIZATIONS = [
  {
    name: 'Layer order',
    check: 'COPY before npm install',
    badPattern: /COPY \. \.\s+RUN npm install/,
    fix: 'Copy package*.json first, then npm install, then copy source',
  },
  {
    name: 'Multi-stage build',
    check: 'Has build stage',
    badPattern: /^(?!.*AS build)/,
    fix: 'Separate build and runtime stages',
  },
  {
    name: 'Slim base image',
    check: 'Using slim or alpine',
    badPattern: /FROM node:\d+(?!-(slim|alpine))/,
    fix: 'Use node:X-slim for smaller images',
  },
  {
    name: 'Production dependencies',
    check: 'npm ci --production or prune',
    badPattern: /npm ci(?!.*--production|.*--only=production)/,
    fix: 'Add --production flag or npm prune after build',
  },
];
```

### Example Output

```markdown
## Dockerfile Analysis

### 🔴 Issues Found

**Inefficient layer order (lines 5-6)**
```dockerfile
COPY . .
RUN npm install
```
**Fix**: Copy package*.json first
```dockerfile
COPY package*.json ./
RUN npm install
COPY . .
```
**Impact**: ~2-3 minutes saved per build

**Missing multi-stage build**
- Current image size: ~800MB (estimated)
- With multi-stage: ~150MB (estimated)
- Reduction: 81%

### 📊 Summary
| Metric | Current | Optimized |
|--------|---------|-----------|
| Build time | ~5 min | ~2 min |
| Image size | ~800MB | ~150MB |
| Cache hit rate | Low | High |
```

---

## 5. security-auditor

### Purpose
Run structured security audits with actionable remediation plans.

### Trigger Phrases
- "npm audit"
- "security vulnerability"
- "dependency vulnerability"
- "CVE"
- "security check"

### Report Format

```markdown
## Security Audit Report

### Summary
| Severity | Count | Fixable | Action |
|----------|-------|---------|--------|
| Critical | 0 | - | - |
| High | 2 | 2 | Fix immediately |
| Medium | 5 | 3 | Fix soon |
| Low | 12 | 0 | Track |

### High Severity Issues

#### CVE-2024-12345: Prototype Pollution
- **Package**: lodash < 4.17.21
- **Fix**: 4.17.21
- **Command**: `npm update lodash`
- **Path**: direct dependency

### Transitive Dependencies

| Vulnerable | Via | Direct Dep | Status |
|------------|-----|------------|--------|
| minimist | mkdirp | webpack | Upstream fix pending |

### Remediation Plan

```bash
# Run these commands to fix auto-fixable issues:
npm update lodash
npm update glob-parent

# Manual intervention required:
# - old-dep is abandoned, replace with new-dep
```
```

### Risk Acceptance

Store accepted risks in `security-exceptions.json`:

```json
{
  "exceptions": [
    {
      "cve": "CVE-2024-99999",
      "package": "dev-only-pkg",
      "reason": "Only used in development",
      "acceptedBy": "security-team",
      "acceptedAt": "2024-01-15",
      "reviewBy": "2024-07-15"
    }
  ]
}
```

---

## Implementation Priority

1. **flaky-test-detector** - Clear gap in database, direct learnings from SMI-973
2. **ci-doctor** - Aggregates multiple patterns, high value
3. **version-sync** - Simple implementation, prevents future issues
4. **docker-optimizer** - Medium complexity, good value
5. **security-auditor** - Higher complexity, existing partial solutions

---

## Related Documents

- [CI Pipeline Code Review Retro](../retros/ci-pipeline-code-review.md)
- [Skill Gap Analysis](../retros/skill-gap-analysis-ci-devops.md)
- [ADR-002: Docker glibc Requirement](../adr/002-docker-glibc-requirement.md)
- [ADR-008: Security Hardening](../adr/008-security-hardening-phase.md)
