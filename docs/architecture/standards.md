# Engineering Standards - Skillsmith

**Version**: 1.5
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
| Security | No secrets, injection vulnerabilities ([security checklist](../security/checklists/code-review.md)) |
| Performance | No N+1 queries, efficient algorithms |
| Style | Matches project conventions |
| Testing | Tests exist for new functionality |
| Schema | Database changes follow [schema.ts](../../packages/core/src/db/schema.ts) patterns |
| Scope | No unrelated changes |

> **Security Reviews**: For security-sensitive code (input handling, external data, file access), use the [Security Code Review Checklist](../security/checklists/code-review.md).

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
docker exec skillsmith-dev-1 npm run typecheck
```

> **See**: [ADR-002](../adr/002-docker-glibc-requirement.md) for rationale

#### Docker Configuration Requirements

| Requirement | Check | Fix |
|-------------|-------|-----|
| docker-compose.yml exists | `ls docker-compose.yml` | Create from template |
| Container name is `skillsmith-dev-1` | Check docker-compose.yml | Update `container_name` |
| Dev profile configured | Look for `profiles: [dev]` | Add to service |
| Volume mount `.:/app` | Check volumes section | Add volume mapping |
| Container running | `docker ps \| grep skillsmith` | `docker compose --profile dev up -d` |

#### Script Compliance

All scripts (.sh, prompt .md files) that run npm commands **must** use Docker:

```bash
# ✅ CORRECT
docker exec skillsmith-dev-1 npm run typecheck
docker exec skillsmith-dev-1 npm test

# ❌ WRONG - runs locally, may fail on native modules
npm run typecheck
npm test
```

The compliance check (`npm run audit:standards`) verifies this automatically.

#### Verification Commands

```bash
# Check Docker is configured correctly
docker compose config

# Verify container is running
docker ps | grep skillsmith-dev-1

# Run compliance audit (includes Docker checks)
docker exec skillsmith-dev-1 npm run audit:standards
```

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

### 3.5 Session Management (SMI-638, SMI-641)

**Checkpoint progress to claude-flow memory** to enable recovery from session stalls.

```bash
# At start of work session
npx claude-flow@alpha hooks pre-task --description "Starting SMI-XXX"

# After each file completion
npx claude-flow@alpha hooks post-edit --file "path/to/file.ts" \
  --memory-key "session/smi-xxx/files"

# At end of session
npx claude-flow@alpha hooks post-task --task-id "smi-xxx"
```

**Rules:**
- Store session ID in memory at work start
- Checkpoint after each major file creation
- Enable session restore via `hooks session-restore`

### 3.6 Incremental Verification (SMI-639)

**Run typecheck after each new file**, not just at completion.

```bash
# After creating a new .ts file
npm run typecheck

# If errors, fix before proceeding
# Don't accumulate errors for end-of-task fixing
```

**Rules:**
- Typecheck after each new TypeScript file
- Run tests after each test file creation
- Address errors immediately, not at end

### 3.7 Linear Integration (SMI-640)

**Update Linear issues during development**, not just at completion.

| Event | Linear Action |
|-------|---------------|
| Starting work | Move issue to "In Progress" |
| Major milestone | Add comment with progress |
| Blocked | Add blocker comment |
| Completion | Move to "Done" + summary comment |

**Automation via hooks:**
```bash
# Move issue to In Progress when starting
npx claude-flow@alpha hooks notify --message "Starting SMI-XXX"

# Add progress comment
npx claude-flow@alpha hooks notify --message "Completed: SkillParser.ts"
```

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

### 4.3 Input Validation (Added from Phase 2b)

**All user input must be validated before use:**

| Input Type | Validation Pattern | Example |
|------------|-------------------|---------|
| Table names | `/^[a-zA-Z_][a-zA-Z0-9_]*$/` | Prevent SQL injection |
| File paths | No `..`, null bytes, shell chars | Prevent path traversal |
| JSON data | Schema validation (Zod) | Prevent prototype pollution |
| Shell args | Array-based, never interpolate | Prevent command injection |

**SQL Injection Prevention:**
```typescript
// ❌ NEVER: String interpolation in SQL
this.db.exec(`CREATE TABLE ${userInput}`)

// ✅ ALWAYS: Validate table names
private validateTableName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error('Invalid table name');
  }
  return name;
}
```

**Command Injection Prevention:**
```typescript
// ❌ NEVER: exec with string interpolation
exec(`npx some-cmd --data '${userInput}'`)

// ✅ ALWAYS: execFile with array args
execFile('npx', ['some-cmd', '--file', tempFile])
```

### 4.4 Prototype Pollution Prevention

**Validate JSON before parsing:**
```typescript
// Check for dangerous keys before JSON.parse
const POLLUTION_PATTERN = /"(__proto__|prototype|constructor)"\s*:/gi;
if (POLLUTION_PATTERN.test(json)) {
  throw new Error('Prototype pollution attempt detected');
}

// Or use schema validation
import { z } from 'zod';
const schema = z.object({ /* ... */ });
const data = schema.parse(JSON.parse(json));
```

### 4.5 Subprocess Security

**Rules for spawning subprocesses:**

| Rule | Implementation |
|------|----------------|
| Minimal env vars | Only pass `PATH`, not `process.env` |
| No shell | Set `shell: false` in spawn options |
| Timeouts | Use `AbortController` with 30s limit |
| Cleanup | Track processes, kill on exit |

```typescript
// Secure subprocess spawning
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);

try {
  await execFile('cmd', args, {
    env: { PATH: process.env.PATH },
    shell: false,
    signal: controller.signal
  });
} finally {
  clearTimeout(timeout);
}
```

### 4.6 Secure Temp File Handling

```typescript
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Create unique temp directory
const dir = await mkdtemp(join(tmpdir(), 'skillsmith-'));
const file = join(dir, 'data.json');

// Write with restricted permissions (owner only)
await writeFile(file, content, { mode: 0o600 });

// Always cleanup in finally block
try {
  // use file
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

### 4.7 Concurrency Safety

**Prevent race conditions with mutex:**
```typescript
import { Mutex } from 'async-mutex';

class SafeService {
  private mutex = new Mutex();

  async criticalOperation(): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      // Protected operation
    } finally {
      release();
    }
  }
}
```

**Detect circular dependencies:**
```typescript
// DFS-based cycle detection for task dependencies
private detectCycle(taskId: string, deps: string[]): void {
  const visited = new Set<string>();
  const path = new Set<string>();

  const hasCycle = (id: string): boolean => {
    if (path.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    path.add(id);
    // Check dependencies recursively
    path.delete(id);
    return false;
  };

  for (const dep of deps) {
    if (hasCycle(dep)) throw new Error('Circular dependency');
  }
}
```

### 4.8 Cryptographic Standards

```typescript
import { randomUUID, createHash } from 'crypto';

// ❌ NEVER: Math.random() for IDs
const id = `item-${Math.random()}`;

// ✅ ALWAYS: crypto.randomUUID()
const id = `item-${randomUUID()}`;

// For content hashing
const hash = createHash('sha256').update(content).digest('hex');
```

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

### Security Documentation

| Document | Purpose |
|----------|---------|
| [Security Standards Index](../security/index.md) | Authoritative security source of truth |
| [Security Code Review Checklist](../security/checklists/code-review.md) | PR review security checklist |
| [Database Schema](../../packages/core/src/db/schema.ts) | Data model reference |

### Pre-Commit Checklist

```
[ ] npm run typecheck
[ ] npm run lint
[ ] npm run test
[ ] npm run audit:standards
[ ] No console.log statements
[ ] No hardcoded secrets
[ ] Meaningful commit message
[ ] Security checklist reviewed (if applicable)
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
| 1.5 | 2025-12-29 | Added §1.5 Schema review criteria, Security Documentation appendix, cross-links to security checklist |
| 1.4 | 2025-12-27 | Added §4.3-4.8 Security Standards (input validation, prototype pollution, subprocess security, temp files, concurrency, crypto) from Phase 2b TDD |
| 1.3 | 2025-12-28 | Added §3.5-3.7 Session Management, Incremental Verification, Linear Integration (from Phase 2a retro) |
| 1.2 | 2025-12-27 | Updated §3.3 CI/CD Pipeline with compliance gate and job diagram |
| 1.1 | 2025-12-27 | Added §3.0 Docker-First Development requirement |
| 1.0 | 2025-12-27 | Initial standards for Phase 0 completion |

---

*Based on: [Governance Claude Skill](https://github.com/wrsmith108/governance-claude-skill)*
