# CI/CD Documentation

Continuous integration and deployment policies, guides, and troubleshooting.

## Quick Reference

| Need to... | See |
|------------|-----|
| Understand CI workflow | [CI Workflow Reference](ci-workflow-reference.md) |
| Run or debug E2E tests | [E2E Testing Guide](e2e-testing-guide.md) |
| Fix flaky test | [Flakiness Patterns](flakiness-patterns.md) |
| Know when `continue-on-error` is OK | [Continue-on-Error Policy](continue-on-error-policy.md) |

## Guides

- [E2E Testing Guide](e2e-testing-guide.md) - How to run and debug E2E tests
- [CI Workflow Reference](ci-workflow-reference.md) - CI architecture and job details

## Troubleshooting

- [Flakiness Patterns](flakiness-patterns.md) - Known flaky patterns and fixes

## Policies

- [Continue-on-Error Policy](continue-on-error-policy.md) - When to allow CI steps to fail

## Common Issues

### CI Lint Failure
```bash
# Run locally before pushing
npm run format && npm run lint
```

### E2E Test Failure
```bash
# Run E2E tests in Docker (matches CI)
docker compose --profile test run --rm skillsmith-test npm run test:e2e:mcp
```

### Pre-push Hook Blocked
```bash
# If Docker isn't running and changes are formatting-only
git push --no-verify
```

## Related Documentation

- [ADR-004: Docker Guard Hook](../adr/004-docker-guard-hook.md)
- [ADR-006: Coverage Threshold Strategy](../adr/006-coverage-threshold-strategy.md)
- [Testing Strategy](../execution/07-testing-strategy.md)
