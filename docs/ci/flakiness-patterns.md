# CI Flakiness Patterns

**Status**: Active
**Last Updated**: January 10, 2026

## Overview

This document catalogs known flaky test patterns in the SkillSmith CI pipeline, their root causes, and prevention strategies.

## What is Flakiness?

A "flaky" test is one that:
- Passes sometimes and fails other times with the same code
- Fails in CI but passes locally (or vice versa)
- Depends on timing, external services, or environment state

## Known Flaky Patterns

### Pattern 1: Formatting Divergence

**Symptom**:
```
[warn] packages/cli/src/commands/recommend.ts
[warn] Code style issues found in 2 files.
```

**Root Cause**:
- Developer commits without running pre-commit hooks
- Different Prettier versions between local and CI
- Editor auto-save with different formatting rules

**Prevention**:
```bash
# Always run format before committing
npm run format

# Use pre-commit hook (enabled by default)
# .husky/pre-commit runs: lint-staged
```

**Detection**:
```bash
# Check if formatting would change anything
npm run format:check
```

---

### Pattern 2: Trust Tier Test Failures

**Symptom**:
```
AssertionError: expected ['verified', 'community', ...] to include 'experimental'
```

**Root Cause**:
- Test database not seeded with all trust tier types
- SEED_SKILLS missing a tier variant
- Recommendation algorithm filtering out certain tiers

**Prevention**:
- Ensure SEED_SKILLS includes all 4 tiers: `verified`, `community`, `experimental`, `unknown`
- Add explicit tier coverage tests

**Example Fix**:
```typescript
// Ensure experimental tier in fixtures
const SEED_SKILLS = [
  { id: 'test/verified', trustTier: 'verified' },
  { id: 'test/community', trustTier: 'community' },
  { id: 'test/experimental', trustTier: 'experimental' }, // Required!
  { id: 'test/unknown', trustTier: 'unknown' },
]
```

---

### Pattern 3: Docker Build Timeouts

**Symptom**:
```
Error: The operation was canceled.
```

**Root Cause**:
- Large dependency changes (new native modules)
- GitHub Actions cache miss
- Network issues during npm install

**Prevention**:
- Increase timeout for docker-build job
- Use layer caching effectively
- Extract node_modules as separate artifact

**Configuration**:
```yaml
docker-build:
  timeout-minutes: 15  # Increased from 10
  steps:
    - uses: docker/build-push-action@v5
      with:
        cache-from: type=gha
        cache-to: type=gha,mode=max
```

---

### Pattern 4: Native Module Compilation

**Symptom**:
```
Error: better-sqlite3 was compiled against a different Node.js version
```

**Root Cause**:
- Docker image built with different Node version
- node_modules artifact from mismatched environment
- glibc vs musl differences (Alpine vs Debian)

**Prevention**:
- Always use Docker for local testing: `docker compose --profile test`
- Ensure consistent Node version across all stages
- Use `docker-entrypoint.sh` to validate native modules

**Detection**:
```bash
# Validate native modules before running tests
node -e "require('better-sqlite3')"
```

---

### Pattern 5: Pre-push Hook Failures

**Symptom**:
```
Security checks FAILED - Push blocked
failed to connect to the docker API
```

**Root Cause**:
- Docker daemon not running locally
- Pre-push hooks require Docker for security tests

**Workaround** (for formatting-only changes):
```bash
# Bypass hooks for trivial changes (use carefully)
git push --no-verify
```

**Prevention**:
- Start Docker before pushing
- Consider making Docker-dependent checks optional locally

---

### Pattern 6: Rate Limiting in Tests

**Symptom**:
```
Test timeout: suggest tool took too long
```

**Root Cause**:
- Rate limiting in suggest tool (by design)
- Multiple rapid requests in test suite

**Prevention**:
```typescript
// Add unique session IDs to avoid rate limiting
const context = createToolContext({
  sessionId: `test-${Date.now()}-${Math.random()}`
})
```

---

### Pattern 7: File System Race Conditions

**Symptom**:
```
ENOENT: no such file or directory
```

**Root Cause**:
- Test cleanup running before async operations complete
- Parallel tests writing to same directory

**Prevention**:
```typescript
// Use unique test directories
const TEST_DIR = join(tmpdir(), `skillsmith-e2e-${process.pid}`)

// Ensure cleanup waits for all operations
afterAll(async () => {
  await new Promise(resolve => setTimeout(resolve, 100))
  rmSync(TEST_DIR, { recursive: true, force: true })
})
```

---

## Investigation Checklist

When you encounter a flaky test:

1. **Check if it's a known pattern** - Review this document
2. **Download test artifacts**:
   ```bash
   gh run download <run-id> --name mcp-e2e-results
   cat results/mcp-results.json | jq '.testResults[] | select(.status == "failed")'
   ```
3. **Check recent changes**:
   ```bash
   git log --oneline -10
   git diff HEAD~5 -- packages/mcp-server/tests/
   ```
4. **Run locally in Docker**:
   ```bash
   docker compose --profile test run --rm skillsmith-test npm run test:e2e:mcp
   ```
5. **Check CI environment**:
   - Compare Node versions
   - Check Docker image cache status
   - Review timing in CI logs

## Metrics

Track flakiness over time:

| Date | Pattern | Test | Resolution |
|------|---------|------|------------|
| 2026-01-10 | Formatting | CI Lint | npm run format |
| 2026-01-10 | Trust Tier | recommend.e2e | SEED_SKILLS fix |

## Prevention Best Practices

1. **Run tests locally before pushing**
   ```bash
   npm run test && npm run test:e2e
   ```

2. **Use Docker for E2E tests**
   ```bash
   docker compose --profile test run --rm skillsmith-test npm run test:e2e:mcp
   ```

3. **Enable pre-commit hooks**
   ```bash
   npm run prepare  # Sets up Husky
   ```

4. **Review CI logs immediately on failure**
   - Don't just re-run hoping it passes
   - Investigate root cause

5. **Add flaky tests to quarantine if needed**
   ```typescript
   it.skip('flaky test under investigation', () => {
     // TODO: Fix in SMI-XXXX
   })
   ```

## Related Documentation

- [E2E Testing Guide](./e2e-testing-guide.md)
- [CI Workflow Reference](./ci-workflow-reference.md)
- [continue-on-error Policy](./continue-on-error-policy.md)
