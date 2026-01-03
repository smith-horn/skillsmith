# Skill Gap Analysis: CI/DevOps

**Date**: January 3, 2026
**Context**: Post CI Pipeline Code Review (SMI-968 through SMI-973)
**Database**: 13,602 skills indexed from GitHub + claude-plugins.dev

---

## Problem Statement Tested

```
I'm working on a GitHub Actions CI/CD pipeline and experiencing several issues:
1. Flaky tests that fail intermittently due to timing issues
2. Node.js version inconsistencies between local development, Docker, and CI
3. Slow CI runs because dependencies are installed multiple times
4. Security audit warnings being masked instead of properly handled
5. Docker image builds taking too long without proper layer caching
```

---

## Gap Analysis Results

### Skills Available (Partial Coverage)

| Need | Available Skills | Gap Level |
|------|-----------------|-----------|
| GitHub Actions Workflow | General MCP skills (not specialized) | 🟡 Medium |
| Node.js Version Sync | claude-code-system-prompts | 🟡 Medium |
| Docker Optimization | General Docker skills | 🟡 Medium |
| npm Security Audit | hexstrike-ai, system-prompts | 🟡 Medium |
| CI Cache Optimization | MCP docs (not actionable) | 🟡 Medium |
| ADR Management | claude-flow | 🟢 Good |

### Clear Gap Identified

| Need | Available Skills | Gap Level |
|------|-----------------|-----------|
| **Flaky Test Detection** | **NONE** | 🔴 Critical |

---

## New Skill Recommendations

Based on the CI pipeline code review work and gap analysis, the following skills should be built:

### 1. `ci-doctor` (Priority: HIGH)

**Description**: Diagnose and fix common CI/CD pipeline issues automatically.

**Trigger Phrases**:
- "CI failing"
- "workflow broken"
- "pipeline error"
- "GitHub Actions not working"
- "build failed"

**Capabilities**:
1. Detect Node.js version mismatches across Dockerfile, CI workflows, nvmrc, package.json
2. Identify missing/inefficient caching configurations
3. Analyze workflow file for common anti-patterns
4. Check for security audit masking (`|| true` patterns)
5. Validate Docker base image consistency

**Implementation Approach**:
```typescript
// Core detection patterns
const versionFiles = [
  { file: 'Dockerfile', pattern: /FROM node:(\d+)/ },
  { file: '.nvmrc', pattern: /^(\d+)/ },
  { file: 'package.json', pattern: /"engines".*"node".*">=?(\d+)/ },
  { file: '.github/workflows/*.yml', pattern: /NODE_VERSION.*['"](\d+)['"]/ },
];

// Anti-patterns to flag
const antiPatterns = [
  { pattern: /\|\|\s*true/, message: 'Command failure being masked' },
  { pattern: /npm ci(?!.*cache)/, message: 'npm ci without caching' },
  { pattern: /continue-on-error:\s*true/, message: 'Errors being suppressed' },
];
```

**Value Proposition**: Would have immediately caught the Node.js version mismatch (SMI-968) that caused CI inconsistencies.

---

### 2. `flaky-test-detector` (Priority: HIGH)

**Description**: Identify and fix timing-sensitive tests that fail intermittently.

**Trigger Phrases**:
- "flaky test"
- "intermittent failure"
- "test sometimes fails"
- "race condition in test"
- "timing issue"

**Capabilities**:
1. Scan test files for timing-sensitive patterns:
   - Short TTLs (`ttlSeconds: 1`, `timeout: 100`)
   - `Date.now()` without mocking
   - `setTimeout`/`setInterval` in tests
   - `sleep()` or `wait()` calls
2. Analyze CI logs for tests that pass/fail inconsistently
3. Suggest fixes (mock time, increase buffers, use test utilities)

**Detection Patterns**:
```typescript
const flakyPatterns = [
  { pattern: /ttl.*:\s*1\b/, risk: 'high', message: 'TTL of 1 second - boundary crossing risk' },
  { pattern: /timeout.*:\s*[1-9]0?\b/, risk: 'medium', message: 'Low timeout may cause flakes' },
  { pattern: /Date\.now\(\)/, risk: 'medium', message: 'Real time usage - consider mocking' },
  { pattern: /setTimeout.*\d{1,3}\)/, risk: 'high', message: 'Short timeout in test' },
  { pattern: /Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/, risk: 'high', message: 'Second truncation - boundary risk' },
];
```

**Value Proposition**: Would have immediately identified the SMI-973 flaky test root cause (1-second TTL with second truncation).

---

### 3. `version-sync` (Priority: MEDIUM)

**Description**: Keep version specifications synchronized across all configuration files.

**Trigger Phrases**:
- "version mismatch"
- "upgrade node"
- "sync versions"
- "update node version"

**Capabilities**:
1. Scan all version-defining files in project
2. Detect inconsistencies and report them
3. Offer to update all files to match a specified version
4. Update related ADRs with version change documentation

**Files to Track**:
```yaml
version_files:
  - .nvmrc
  - package.json (engines.node)
  - Dockerfile (FROM node:X)
  - .github/workflows/*.yml (NODE_VERSION, setup-node version)
  - docker-compose.yml (image: node:X)
  - .tool-versions (asdf)
  - .node-version (nodenv)
```

**Value Proposition**: Single command to upgrade Node.js across entire project, preventing the drift that caused SMI-968.

---

### 4. `docker-optimizer` (Priority: MEDIUM)

**Description**: Analyze and optimize Dockerfile for faster builds.

**Trigger Phrases**:
- "slow docker build"
- "optimize Dockerfile"
- "layer caching"
- "reduce image size"

**Capabilities**:
1. Analyze layer ordering for caching efficiency
2. Detect opportunities for multi-stage builds
3. Identify large layers that could be split
4. Suggest .dockerignore improvements
5. Calculate potential size/time savings

**Optimization Checks**:
```yaml
checks:
  - name: "Copy package files before npm install"
    pattern: "COPY .* .\n.*npm install"
    suggestion: "Copy package*.json first, then npm install, then copy source"

  - name: "Use multi-stage build"
    condition: "No 'AS build' in Dockerfile"
    suggestion: "Separate build and runtime stages"

  - name: "Install dev dependencies separately"
    pattern: "npm ci(?!.*--production)"
    suggestion: "Use --production or prune after build"
```

---

### 5. `security-auditor` (Priority: MEDIUM)

**Description**: Structured npm security audit with remediation tracking.

**Trigger Phrases**:
- "npm audit"
- "security vulnerability"
- "dependency vulnerability"
- "CVE"

**Capabilities**:
1. Run `npm audit` and parse JSON output
2. Categorize by severity and fix availability
3. Generate remediation plan with commands
4. Track which vulnerabilities are transitive vs direct
5. Create Linear issues for unfixed vulnerabilities
6. Document accepted risks in security-exceptions.json

**Output Format**:
```markdown
## Security Audit Report

### Critical (0) | High (2) | Medium (5) | Low (12)

### Fixable Issues
| Package | Severity | Fix Available | Command |
|---------|----------|---------------|---------|
| lodash | High | 4.17.21 | `npm update lodash` |

### Transitive Dependencies (Cannot Fix Directly)
| Package | Via | Severity | Status |
|---------|-----|----------|--------|
| minimist | mkdirp | Medium | Waiting on upstream |
```

---

## Implementation Priority Matrix

| Skill | Priority | Effort | Impact | ROI |
|-------|----------|--------|--------|-----|
| `flaky-test-detector` | 🔴 High | Medium | High | ⭐⭐⭐⭐ |
| `ci-doctor` | 🔴 High | Medium | High | ⭐⭐⭐⭐ |
| `version-sync` | 🟡 Medium | Low | Medium | ⭐⭐⭐ |
| `docker-optimizer` | 🟡 Medium | Medium | Medium | ⭐⭐⭐ |
| `security-auditor` | 🟡 Medium | High | Medium | ⭐⭐ |

---

## Recommendation

**Build `flaky-test-detector` first** because:
1. Clear gap in existing skill database (no competition)
2. Direct learnings from SMI-973 provide implementation patterns
3. High value - flaky tests are a universal pain point
4. Can be built quickly with pattern-matching approach

**Build `ci-doctor` second** because:
1. Aggregates multiple checks into one diagnostic tool
2. Direct learnings from SMI-968, SMI-969, SMI-971 provide patterns
3. GitHub Actions is the dominant CI platform for Claude Code users

---

## Next Steps

1. Create Linear epic for "CI/DevOps Skills" with sub-issues for each skill
2. Prototype `flaky-test-detector` using patterns from SMI-973
3. Test prototype on Skillsmith codebase as dogfooding
4. Add to Skillsmith skill database once validated

---

*Analysis generated from CI Pipeline Code Review retrospective.*
