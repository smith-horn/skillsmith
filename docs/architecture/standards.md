# Engineering Standards - Skillsmith

**Version**: 1.2
**Status**: Active
**Owner**: Skillsmith Team

---

## Executive Summary

This document establishes the engineering standards for Skillsmith. These standards are optimized for:

- **Small team efficiency** - Solo/pair development with AI assistance
- **Agentic development** - Claude Code as primary coding tool
- **Rapid MVP delivery** - Phase-based milestones
- **Long-term maintainability** - Clean architecture patterns

---

## 1. Code Quality

### 1.1 Language Standards

All code uses TypeScript with strict mode enabled.

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true
  }
}
```

**Rules:**
- No `any` types without explicit justification in comments
- Prefer `unknown` over `any` for external data
- All function parameters and return types must be typed
- Use Zod for runtime validation at MCP tool boundaries

### 1.2 Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Files (components) | PascalCase | `SkillRepository.ts` |
| Files (utilities) | camelCase | `searchService.ts` |
| Variables/Functions | camelCase | `getSkillById()` |
| Types/Interfaces | PascalCase | `interface Skill {}` |
| Constants | SCREAMING_SNAKE | `const MAX_RESULTS = 100` |
| Database columns | snake_case | `created_at` |
| Environment variables | SCREAMING_SNAKE | `GITHUB_TOKEN` |

### 1.3 File Organization

```
packages/
├── core/src/
│   ├── db/              # Database schema and migrations
│   ├── repositories/    # Data access layer
│   ├── services/        # Business logic
│   ├── cache/           # Caching layer
│   ├── embeddings/      # Vector search
│   └── security/        # Security scanning
├── mcp-server/src/
│   └── tools/           # MCP tool implementations
└── cli/src/             # CLI commands
```

**Rules:**
- Maximum **500** lines per file (split if larger)
- Co-locate tests with source files (`*.test.ts`)
- One class/service per file

### 1.4 Documentation Requirements

**Required documentation:**
- README.md for repository overview
- JSDoc for all public functions
- Inline comments for complex business logic only
- Architecture Decision Records (ADRs) for significant choices

**JSDoc template:**
```typescript
/**
 * Brief description of what the function does.
 *
 * @param paramName - Description of parameter
 * @returns Description of return value
 * @throws {SkillsmithError} When validation fails
 */
```

### 1.5 Code Review Standards

**All code requires review before merge.** Reviewers check for:

| Category | Criteria |
|----------|----------|
| Correctness | Does it work? Edge cases handled? |
| Security | No secrets, injection vulnerabilities |
| Performance | No N+1 queries, efficient algorithms |
| Style | Matches project conventions |
| Testing | Tests exist for new functionality |
| Scope | No unrelated changes |

---

## 2. Testing Standards

### 2.1 Test Coverage Requirements

| Layer | Minimum Coverage | Framework |
|-------|-----------------|-----------|
| Unit tests | 80% | Vitest |
| API/MCP tools | 90% | Vitest |
| Integration | Critical paths | Vitest |

### 2.2 Test Naming Convention

```typescript
describe('SkillRepository', () => {
  describe('create', () => {
    it('creates a skill with valid input', () => { /* ... */ });
    it('throws SkillsmithError for duplicate repo_url', () => { /* ... */ });
  });
});
```

### 2.3 Testing Culture

- **Write tests alongside code** - Not after
- **Tests run before commit** - Pre-commit hooks enforce
- **Mock external services only** - GitHub API, not internal modules
- **Fix flaky tests immediately** - They erode CI trust

---

## 3. Development Workflow

### 3.0 Docker-First Development

**All development commands run inside Docker.** This ensures:

- Consistent glibc environment for native modules (better-sqlite3, onnxruntime)
- Reproducible builds across developer machines
- Matching CI/CD environment

```bash
# Required: Start container before any development
docker compose --profile dev up -d

# All commands use docker exec
docker exec skillsmith-dev-1 npm run build
docker exec skillsmith-dev-1 npm test
docker exec skillsmith-dev-1 npm run lint
```

> **See**: [ADR-002](../adr/002-docker-glibc-requirement.md) for rationale

### 3.1 Branching Strategy

**Trunk-based development with short-lived feature branches:**

```
main (protected)
  └── feature/SMI-123-add-feature
  └── fix/SMI-456-bug-description
  └── chore/update-dependencies
```

**Rules:**
- Keep branches focused (single ticket scope)
- Squash commits on merge
- Delete branch after merge

### 3.2 Commit Message Format

```
<type>(scope): <description>

[optional body]

SMI-XXX
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

### 3.3 CI/CD Pipeline

The GitHub Actions CI pipeline runs on all PRs and pushes to main:

```
┌─────────┐  ┌───────────┐  ┌──────────────────┐  ┌────────────┐  ┌──────────┐
│  Lint   │  │ Typecheck │  │ Test (Node 18/20)│  │ Compliance │  │ Security │
└────┬────┘  └─────┬─────┘  └────────┬─────────┘  └─────┬──────┘  └────┬─────┘
     │             │                 │                  │              │
     └─────────────┴─────────────────┴──────────────────┘              │
                                     │                                 │
                               ┌─────▼─────┐                           │
                               │   Build   │ (blocked if any fail)     │
                               └───────────┘                           │
```

| Job | Checks | Blocks Build |
|-----|--------|--------------|
| Lint | ESLint, Prettier | Yes |
| Typecheck | TypeScript strict | Yes |
| Test | Unit + integration tests (Node 18 & 20) | Yes |
| Compliance | `npm run audit:standards` | Yes |
| Security | `npm audit --audit-level=high` | No (warning only) |

**Build artifacts** are uploaded for 7 days after successful builds.

### 3.4 Definition of Done

A task is complete when:

- [ ] Code implements requirements
- [ ] TypeScript compiles without errors
- [ ] Tests written and passing
- [ ] Code reviewed and approved
- [ ] Linear issue updated

---

## 4. Security Standards

### 4.1 Secrets Management

- **Never commit secrets** - Use environment variables
- **Use Varlock skill** - For secure env var management
- **GitHub tokens scoped** - Minimal permissions

### 4.2 Skill Security Scanning

Skillsmith includes security scanning for installed skills:

- Check for suspicious patterns (exfiltration, injection)
- Warn about unverified skills
- Trust tier system (verified, community, experimental)

---

## 5. Error Handling

### 5.1 Error Types

Use `SkillsmithError` from `@skillsmith/core`:

```typescript
throw new SkillsmithError(
  ErrorCodes.SKILL_NOT_FOUND,
  'Skill not found',
  { skillId }
);
```

### 5.2 MCP Error Responses

All MCP tools return structured error responses:

```typescript
{
  success: false,
  error: {
    code: 'SKILL_NOT_FOUND',
    message: 'Skill not found',
    suggestion: 'Check the skill ID or try searching'
  }
}
```

---

## Appendix: Quick Reference

### Pre-Commit Checklist

```
[ ] npm run typecheck
[ ] npm run lint
[ ] npm run test
[ ] npm run audit:standards
[ ] No console.log statements
[ ] No hardcoded secrets
[ ] Meaningful commit message
```

### PR Description Template

```markdown
## Summary
[What this PR does]

## Ticket
[SMI-XXX](Linear link)

## Changes
- Change 1
- Change 2

## Testing
- [ ] Unit tests added/updated
- [ ] Tested locally
```

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.2 | 2025-12-27 | Updated §3.3 CI/CD Pipeline with compliance gate and job diagram |
| 1.1 | 2025-12-27 | Added §3.0 Docker-First Development requirement |
| 1.0 | 2025-12-27 | Initial standards for Phase 0 completion |

---

*Based on: [Governance Claude Skill](https://github.com/wrsmith108/governance-claude-skill)*
