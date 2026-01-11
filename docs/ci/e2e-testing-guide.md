# E2E Testing Guide

**Status**: Active
**Last Updated**: January 10, 2026

## Overview

SkillSmith uses End-to-End (E2E) tests to validate the complete flow of MCP tools and CLI commands in a real environment. E2E tests run in Docker containers to ensure consistency across local development and CI.

## Architecture

### Test Structure

```
packages/
├── mcp-server/tests/e2e/     # MCP tool E2E tests
│   ├── compare.e2e.test.ts   # skill_compare tool
│   ├── install-flow.e2e.test.ts
│   ├── recommend.e2e.test.ts # skill_recommend tool
│   ├── skill-flow.e2e.test.ts
│   └── suggest.e2e.test.ts   # skill_suggest tool
├── cli/tests/e2e/            # CLI E2E tests
│   └── *.e2e.test.ts
```

### Key Components

| Component | Purpose |
|-----------|---------|
| `vitest-e2e.config.ts` | E2E-specific Vitest configuration |
| `SEED_SKILLS` | Test fixtures for database seeding |
| `ToolContext` | MCP context with test database |
| `HardcodedDetector` | Validates no hardcoded values in responses |

## Running E2E Tests Locally

### Prerequisites

- Node.js 22+
- Docker (for production-like environment)
- npm dependencies installed

### Quick Start

```bash
# Run all E2E tests
npm run test:e2e

# Run MCP E2E tests only
npm run test:e2e:mcp

# Run CLI E2E tests only
npm run test:e2e:cli

# Run in watch mode
npm run test:e2e -- --watch
```

### Running in Docker (Recommended)

E2E tests should be run in Docker to match CI environment:

```bash
# Build the dev Docker image
docker compose --profile dev build

# Run E2E tests in Docker
docker compose --profile test run --rm skillsmith-test npm run test:e2e:mcp
```

## How E2E Tests Work in CI

### Workflow: `.github/workflows/e2e-tests.yml`

```
┌─────────────────────────────────────────────────────────────┐
│                      docker-build                            │
│  - Build Docker image (dev target)                          │
│  - Extract node_modules (pre-compiled)                      │
│  - Upload artifacts for parallel jobs                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  CLI E2E Tests  │ │  MCP E2E Tests  │ │ Security Tests  │
│                 │ │                 │ │                 │
│ - Download image│ │ - Download image│ │ - npm audit     │
│ - Run tests     │ │ - Run tests     │ │ - gitleaks      │
│ - Upload results│ │ - Upload results│ │                 │
└────────┬────────┘ └────────┬────────┘ └─────────────────┘
         │                   │
         └─────────┬─────────┘
                   ▼
         ┌─────────────────┐
         │  Report Phase   │
         │                 │
         │ - Aggregate     │
         │ - Post to PR    │
         │ - Create issues │
         └─────────────────┘
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SKILLSMITH_E2E` | Flag indicating E2E mode | `true` in CI |
| `NODE_VERSION` | Node.js version | `22` |
| `DOCKER_BUILDKIT` | Enable BuildKit | `1` |

## Test Database & Fixtures

### SEED_SKILLS

E2E tests use a predefined set of skills for consistency:

```typescript
const SEED_SKILLS = [
  {
    id: 'anthropic/commit',
    trustTier: 'verified',
    qualityScore: 0.95,
    // ...
  },
  {
    id: 'community/jest-helper',
    trustTier: 'community',
    // ...
  },
  {
    id: 'experimental/ai-debug',
    trustTier: 'experimental',  // Important: experimental tier coverage
    // ...
  },
]
```

### Trust Tier Coverage

Tests validate all trust tiers are handled:

| Tier | Coverage | Test File |
|------|----------|-----------|
| `verified` | ✅ | recommend.e2e.test.ts |
| `community` | ✅ | recommend.e2e.test.ts |
| `experimental` | ✅ | recommend.e2e.test.ts |
| `unknown` | ✅ | validation fallback |

## Common Failure Patterns

### 1. Trust Tier Assertion Failures

**Symptom**:
```
AssertionError: expected [...] to include 'experimental'
```

**Cause**: SEED_SKILLS missing a tier, or database not seeded properly.

**Fix**: Ensure SEED_SKILLS includes all 4 trust tiers.

### 2. Hardcoded Path Detection

**Symptom**:
```
Found hardcoded value: /Users/username/...
```

**Cause**: Code contains hardcoded paths instead of dynamic resolution.

**Fix**: Use `os.homedir()` or environment variables.

### 3. Timing-Related Failures

**Symptom**: Test passes locally but fails in CI intermittently.

**Cause**: Race conditions or external service delays.

**Fix**: Add appropriate timeouts and retry logic.

## Debugging E2E Failures

### 1. Get Test Results Artifact

```bash
# Download test results from failed run
gh run download <run-id> --name mcp-e2e-results --dir ./results

# View JSON results
cat results/mcp-results.json | jq '.testResults[] | select(.status == "failed")'
```

### 2. Run Specific Test Locally

```bash
# Run only the failing test file
npm run test:e2e:mcp -- recommend.e2e.test.ts

# Run with verbose output
npm run test:e2e:mcp -- --reporter=verbose
```

### 3. Check Docker Environment

```bash
# Ensure Docker image matches CI
docker compose --profile test run --rm skillsmith-test node -v
```

## Best Practices

1. **Always seed test database** - Use SEED_SKILLS with all tier types
2. **Test for hardcoded values** - Use HardcodedDetector utility
3. **Run in Docker locally** - Matches CI environment exactly
4. **Check CI logs first** - Download artifacts for detailed results
5. **Validate trust tier coverage** - All 4 tiers should be tested

## Related Documentation

- [CI Workflow Reference](./ci-workflow-reference.md)
- [Flakiness Patterns](./flakiness-patterns.md)
- [continue-on-error Policy](./continue-on-error-policy.md)
- [Testing Strategy](../execution/07-testing-strategy.md)
