## Summary

[Brief description of what this PR does]

## Ticket

[SMI-XXX](https://linear.app/skillsmith/issue/SMI-XXX)

## Changes

- [ ] Change 1
- [ ] Change 2

## Checklist

### Code Quality
- [ ] TypeScript compiles without errors (`npm run typecheck`)
- [ ] Linting passes (`npm run lint`)
- [ ] Tests added/updated and passing (`npm test`)
- [ ] No `console.log` statements in production code

### Security
- [ ] No hardcoded secrets or credentials
- [ ] Input validation added for user-provided data
- [ ] Security checklist reviewed (if applicable)

### Mock Data Review (SMI-763)
- [ ] **No mock data in production code paths**
- [ ] Mock data isolated in test fixtures (`tests/fixtures/`)
- [ ] Environment flag (`SKILLSMITH_USE_MOCK`) controls mock vs real data
- [ ] Real service integrations work correctly when mock mode disabled

### Documentation
- [ ] JSDoc added for new public functions
- [ ] README/CLAUDE.md updated if needed
- [ ] ADR created for significant architectural decisions

## Testing

Describe how this was tested:

- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual testing (describe steps)

### E2E Tests (Required for MCP/Install changes)
- [ ] E2E tests pass locally: `docker exec skillsmith-dev-1 npm run test:e2e:mcp`
- [ ] No environment-specific paths (use runtime functions like `getBackupsDir()` instead of module-level constants)

## Screenshots (if applicable)

[Add screenshots for UI changes]
