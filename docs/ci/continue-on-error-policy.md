# continue-on-error Policy

**Status**: Active
**Issue**: SMI-993

## What `continue-on-error` Does

The `continue-on-error: true` setting allows a GitHub Actions step or job to fail without stopping the workflow. When a step fails with this setting:

- The step is marked as failed (red X)
- The workflow continues to subsequent steps
- The overall job can still succeed
- The step outcome is accessible via `steps.<id>.outcome`

## When to Use

### 1. npm audit (Warnings Should Not Block CI)

Use `continue-on-error` with explicit result checking to warn but still enforce thresholds:

```yaml
# From skillsmith/.github/workflows/ci.yml
- name: Run dependency audit in Docker
  continue-on-error: true
  id: audit
  run: |
    docker run --rm \
      -v ${{ github.workspace }}:/app \
      skillsmith-ci:${{ github.sha }} \
      npm audit --audit-level=high

- name: Check audit result
  if: steps.audit.outcome == 'failure'
  run: |
    echo "::warning::npm audit found high-severity vulnerabilities."

- name: Fail on high-severity vulnerabilities
  if: steps.audit.outcome == 'failure'
  run: |
    echo "::error::npm audit found high-severity vulnerabilities."
    exit 1
```

**Why**: This pattern allows the audit output to be captured and displayed before failing, providing better error messages.

### 2. Optional Quality Checks (Coverage Reporting)

When coverage is for visibility but thresholds are validated elsewhere:

```yaml
# From skillsmith/.github/workflows/ci.yml
- name: Run security tests with coverage
  # Coverage thresholds are for full suite, not security-only tests
  # Security tests already passed above; this is for coverage reporting
  continue-on-error: true
  run: |
    npm run test:coverage -- packages/core/tests/security/
```

**Why**: Security tests pass in a previous step. Coverage reporting is supplementary.

### 3. External Resource Acquisition

When cloning optional repositories or fetching external data:

```yaml
# From skillsmith/.github/workflows/e2e-tests.yml
- name: Clone test repository
  run: |
    git clone https://github.com/wrsmith108/021-school-platform.git /tmp/test-repo
  continue-on-error: true
```

**Why**: External repositories may be temporarily unavailable. Tests can still run with fallback data.

### 4. Artifact Downloads (May Not Exist)

When downloading artifacts that may not have been created:

```yaml
# From skillsmith/.github/workflows/e2e-tests.yml
- name: Download CLI results
  uses: actions/download-artifact@v4
  with:
    name: cli-e2e-results
    path: test-results/cli
  continue-on-error: true
```

**Why**: In report-generation jobs, some test phases may have been skipped or failed. Reports should still be generated for whatever succeeded.

### 5. External Service Integrations

When integrating with external services (Linear, Slack, etc.):

```yaml
# From skillsmith/.github/workflows/e2e-tests.yml
- name: Create Linear issues for failures
  if: failure()
  continue-on-error: true
  run: npm run test:e2e:create-issues
  env:
    LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
```

**Why**: External service failures should not block workflow completion or hide test results.

## When NOT to Use

### 1. Core Build Steps

Never use on critical build steps:

```yaml
# WRONG - Build failure should stop the workflow
- name: Build project
  continue-on-error: true  # DON'T DO THIS
  run: npm run build
```

### 2. Test Execution

Never hide test failures:

```yaml
# WRONG - Test failures must block merging
- name: Run tests
  continue-on-error: true  # DON'T DO THIS
  run: npm test
```

### 3. Security-Critical Checks

Never on checks that protect production:

```yaml
# WRONG - Security tests must pass
- name: Run security tests
  continue-on-error: true  # DON'T DO THIS
  run: npm test -- packages/core/tests/security/
```

### 4. Dependency Installation

Never on package installation:

```yaml
# WRONG - Missing dependencies will cause confusing failures later
- name: Install dependencies
  continue-on-error: true  # DON'T DO THIS
  run: npm ci
```

## Best Practices

### 1. Always Add a Comment Explaining Why

```yaml
- name: Generate coverage report
  # Coverage report is for visibility; actual thresholds enforced in test job
  continue-on-error: true
```

### 2. Use Step IDs for Conditional Logic

When you need to react to failures:

```yaml
- name: Optional check
  id: optional_check
  continue-on-error: true
  run: ./optional-script.sh

- name: Log warning if check failed
  if: steps.optional_check.outcome == 'failure'
  run: echo "::warning::Optional check failed"
```

### 3. Prefer `if: always()` for Cleanup

For steps that must run regardless of previous failures:

```yaml
- name: Upload artifacts
  if: always()  # Better than continue-on-error for cleanup
  uses: actions/upload-artifact@v4
```

### 4. Document in Workflow Comments

Add header comments for jobs with multiple `continue-on-error` steps:

```yaml
# Reporting job: Uses continue-on-error because:
# - Artifact downloads may not exist if earlier jobs were skipped
# - External integrations (Linear) should not block report generation
report-results:
  name: Generate Reports
  if: always()
```

## Decision Matrix

| Scenario | continue-on-error | Rationale |
|----------|-------------------|-----------|
| npm audit | Yes (with explicit fail) | Capture output before failing |
| Coverage reporting | Yes | Informational only |
| External repo clone | Yes | External resource may be unavailable |
| Artifact download | Yes | Artifact may not exist |
| External service call | Yes | Should not block CI |
| Build | No | Critical path |
| Tests | No | Must pass to merge |
| Security tests | No | Protects production |
| Lint/typecheck | No | Code quality gate |
| Dependency install | No | Required for all steps |

## Related Files

- [CI Workflow](../../skillsmith/.github/workflows/ci.yml)
- [E2E Tests Workflow](../../skillsmith/.github/workflows/e2e-tests.yml)
