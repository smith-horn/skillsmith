# CI Workflow Reference

**Status**: Active
**Last Updated**: January 10, 2026

## Overview

SkillSmith uses GitHub Actions for continuous integration with two main workflow files:
- `ci.yml` - Core CI pipeline (lint, test, build, security)
- `e2e-tests.yml` - End-to-end test pipeline

Both workflows use Docker-based execution for consistency.

## Workflow Architecture

### Complete CI/CD Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                          PUSH / PR to main                          │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│    ci.yml     │         │ e2e-tests.yml │         │ indexer.yml   │
│               │         │               │         │               │
│ Lint, Test,   │         │ CLI & MCP     │         │ Skill Index   │
│ Build, Audit  │         │ E2E Tests     │         │ Updates       │
└───────────────┘         └───────────────┘         └───────────────┘
```

## ci.yml - Core CI Pipeline

### Job Dependency Graph

```
┌─────────────────────┐
│  package-validation │  ← First: validate package.json, lockfile
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  docker-build       │  ← Build Docker image, extract deps
└──────────┬──────────┘
           │
     ┌─────┴─────┬─────────────┬────────────┬────────────┐
     ▼           ▼             ▼            ▼            ▼
┌─────────┐ ┌─────────┐ ┌───────────┐ ┌──────────┐ ┌─────────┐
│  test   │ │  lint   │ │ typecheck │ │ security │ │ build   │
│         │ │         │ │           │ │  audit   │ │         │
│ vitest  │ │ eslint  │ │ tsc       │ │ npm      │ │ tsc     │
│ 75% cov │ │ prettier│ │ --build   │ │ audit    │ │ esbuild │
└─────────┘ └─────────┘ └───────────┘ └──────────┘ └─────────┘
```

### Jobs Detail

| Job | Purpose | Key Commands | Artifacts |
|-----|---------|--------------|-----------|
| `package-validation` | Validate package.json | `npm ls`, lockfile check | - |
| `docker-build` | Build dev image | `docker build --target dev` | Docker image, node_modules |
| `test` | Run unit tests | `npm run test:coverage` | Coverage reports |
| `lint` | Code quality | `npm run lint`, `format:check` | - |
| `typecheck` | Type validation | `npm run typecheck` | - |
| `security-audit` | Vulnerability scan | `npm audit --audit-level=high` | - |
| `build` | Compile TypeScript | `npm run build` | Build artifacts |
| `standards` | Code standards | `npm run audit:standards` | - |

## e2e-tests.yml - E2E Test Pipeline

### Job Dependency Graph

```
┌─────────────────────┐
│  docker-build       │  ← Build image, extract deps (shared)
└──────────┬──────────┘
           │
     ┌─────┴─────┬─────────────┐
     ▼           ▼             ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ cli-e2e  │ │ mcp-e2e  │ │ security │
│ tests    │ │ tests    │ │ tests    │
└────┬─────┘ └────┬─────┘ └──────────┘
     │            │
     └─────┬──────┘
           ▼
┌─────────────────────┐
│  report             │  ← Aggregate results, post to PR
└─────────────────────┘
```

### E2E Job Configuration

```yaml
mcp-e2e-tests:
  runs-on: ubuntu-latest
  timeout-minutes: 10
  needs: [docker-build]

  steps:
    - Download Docker image artifact
    - Download node_modules artifact
    - Load Docker image
    - Build TypeScript
    - Run E2E tests in Docker container
    - Upload test results
```

## Docker Strategy

### Multi-Stage Dockerfile

```dockerfile
# Stage 1: Base
FROM node:22-slim AS base

# Stage 2: Dependencies (with build tools)
FROM base AS deps
RUN apt-get install python3 make g++ git

# Stage 3: Builder (compile TypeScript)
FROM deps AS builder
RUN npm run build

# Stage 4: Dev (for CI/testing)
FROM builder AS dev
# Full environment with test tooling

# Stage 5: Production
FROM base AS prod
# Minimal production image
```

### Docker Caching

CI uses GitHub Actions cache for Docker layers:

```yaml
- uses: docker/build-push-action@v5
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

## Pre-commit/Pre-push Hooks

### Husky Configuration

```
.husky/
├── pre-commit    # TypeScript check, lint-staged
└── pre-push      # Security tests, npm audit
```

### Pre-commit Checks

```bash
# .husky/pre-commit runs:
1. Clear TypeScript build cache
2. Run TypeScript type check
3. Run lint-staged (ESLint, Prettier on staged files)
```

### Pre-push Checks

```bash
# .husky/pre-push runs:
1. Security test suite
2. npm audit (high severity)
3. Gitleaks secret scanning
```

**Note**: Pre-push hooks require Docker. If Docker isn't running, use `git push --no-verify` for formatting-only changes.

## Environment Variables

### CI Environment

| Variable | Value | Purpose |
|----------|-------|---------|
| `NODE_VERSION` | `22` | Node.js version |
| `DOCKER_BUILDKIT` | `1` | Enable BuildKit |
| `COMPOSE_DOCKER_CLI_BUILD` | `1` | Docker Compose BuildKit |
| `SKILLSMITH_E2E` | `true` | E2E test mode flag |

### Secrets

| Secret | Usage |
|--------|-------|
| `GITHUB_TOKEN` | PR comments, artifact upload |
| `NPM_TOKEN` | (optional) Private registry |

## Artifact Flow

```
docker-build job
    │
    ├── docker-image.tar.gz  ────────────►  All test jobs
    │
    └── node_modules.tar.gz  ────────────►  All test jobs (saves ~30-60s)

test jobs
    │
    └── test-results/*.xml   ────────────►  report job
```

## Timeout Configuration

| Job | Timeout | Rationale |
|-----|---------|-----------|
| `docker-build` | 10 min | Image build + deps extraction |
| `test` | 10 min | Full test suite with coverage |
| `mcp-e2e-tests` | 10 min | E2E tests with Docker overhead |
| `cli-e2e-tests` | 10 min | CLI E2E with file operations |

## Troubleshooting

### Common Issues

1. **Docker build timeout**: Check layer caching, increase timeout
2. **Lint failure**: Run `npm run format` locally before commit
3. **Type errors**: Run `npm run typecheck` locally
4. **E2E failures**: See [E2E Testing Guide](./e2e-testing-guide.md)

### Checking CI Status

```bash
# List recent runs
gh run list --limit 5

# View specific run
gh run view <run-id>

# Download artifacts
gh run download <run-id> --name <artifact-name>
```

## Related Documentation

- [E2E Testing Guide](./e2e-testing-guide.md)
- [Flakiness Patterns](./flakiness-patterns.md)
- [continue-on-error Policy](./continue-on-error-policy.md)
