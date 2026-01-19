# Engineering Standards - Skillsmith

**Version**: 2.0
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

**Additional Checks (Phase 7a learnings):**

| Category | Criteria |
|----------|----------|
| Dynamic Imports | Type guards used, not unsafe `as` casts (§4.9) |
| Heavy Dependencies | Native modules lazily loaded (§4.10) |
| External Integration | Response interfaces explicitly typed, including nested objects |
| License Validation | Returns `null` on failure, never silent fallback (§7.1) |
| Expiration Handling | Time-sensitive features include warning thresholds |

> **Security Reviews**: For security-sensitive code (input handling, external data, file access), use the [Security Code Review Checklist](../security/checklists/code-review.md).

> **Enterprise Reviews**: For license/SSO/RBAC code, verify the License Validation Hierarchy in §7.1.

### 1.6 ESLint Configuration

ESLint rules apply uniformly across all TypeScript in the repository.

**Scope:** All `.ts` and `.tsx` files, including:
- `packages/*/src/**/*.ts`
- `scripts/**/*.ts`
- Test files (`*.test.ts`)

**Unused Variables Policy:**

```javascript
// eslint.config.js or .eslintrc.js
{
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", {
      argsIgnorePattern: "^_",      // Allow _paramName for intentionally unused
      varsIgnorePattern: "^_",      // Allow _varName for destructuring
      caughtErrorsIgnorePattern: "^_" // Allow catch (_error) or catch (_)
    }]
  }
}
```

**Patterns:**
- Prefix unused parameters with `_` (e.g., `_epicId`, `_index`)
- Empty catch blocks: use `catch` or `catch (_error)`
- Destructuring unused: `const { used, _unused } = obj`

**Scripts Directory:**

The `scripts/` directory follows the same ESLint rules as `packages/`. No separate configuration or manual `eslint-disable` comments should be required for standard patterns.

> **Reference:** See [ADR-012](../adr/012-native-module-version-management.md) for context on scripts directory standardization.

### 1.7 TypeScript Record<K,V> Exhaustiveness

When using `Record<K, V>` with union type keys, TypeScript requires **all keys** to be present. This prevents runtime errors from missing cases.

**The Problem:**

```typescript
// Given this union type
type LicenseTier = 'community' | 'team' | 'enterprise' | 'individual';

// ❌ WRONG: Missing 'individual' key - TypeScript error
const TIER_PRICING: Record<LicenseTier, string> = {
  community: '$0/month',
  team: '$25/user/month',
  enterprise: '$55/user/month',
  // Error: Property 'individual' is missing
};

// ✅ CORRECT: All keys present
const TIER_PRICING: Record<LicenseTier, string> = {
  individual: '$9.99/month',
  community: '$0/month',
  team: '$25/user/month',
  enterprise: '$55/user/month',
};
```

**When Extending Union Types:**

Adding a new variant to a union type (like adding `'individual'` to `LicenseTier`) will cause TypeScript compilation errors everywhere that union is used in a `Record`. This is intentional - it surfaces all locations requiring updates.

**Checklist when extending union types:**

- [ ] Search codebase: `grep -r "Record<UnionType" packages/`
- [ ] Update all `Record<UnionType, ...>` declarations
- [ ] Update test fixtures and mocks
- [ ] Run `npm run typecheck` to verify completeness

> **Real Example**: SMI-1372 fixed CI failures caused by adding `'individual'` to `LicenseTier` without updating `TIER_PRICING`, `TIER_DISPLAY_NAMES`, and test mocks across 4 files.

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
Resolves: SMI-XXX, SMI-YYY
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

**Issue Reference Patterns:**

| Pattern | Effect | When to Use |
|---------|--------|-------------|
| `SMI-XXX` | Links commit to issue | Always include for traceability |
| `Resolves: SMI-XXX` | **Auto-closes issue** when merged to main | Issue is fully addressed by this commit |
| `Resolves: SMI-XXX, SMI-YYY` | Auto-closes multiple issues | Single commit addresses multiple issues |
| `Fixes: SMI-XXX` | Same as Resolves (alias) | Bug fix commits |
| `Closes: SMI-XXX` | Same as Resolves (alias) | Feature completion |

> **Linear GitHub Integration**: The `Resolves:` syntax triggers Linear's auto-transition feature. When a commit containing `Resolves: SMI-XXX` lands on the default branch, Linear automatically moves the issue to "Done" state. This eliminates manual status updates and ensures issues reflect actual repository state.

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
| Security | `npm audit --audit-level=high --omit=dev` | No (warning only) |

**Build artifacts** are uploaded for 7 days after successful builds.

#### Security Audit Configuration (SMI-1276)

The security audit uses `--omit=dev` to skip devDependency vulnerabilities that don't affect production bundles.

```yaml
# .github/workflows/ci.yml
- name: Run dependency audit
  run: npm audit --audit-level=high --omit=dev
```

**Rationale:**
- DevDependencies (vercel, tsx, vitest) may have transitive vulnerabilities
- These never ship to production - only affect developer machines
- Blocking CI on devDep vulnerabilities slows development unnecessarily
- Production dependencies are still strictly audited

**When to use full audit:**
- Before major releases: `npm audit` (no --omit=dev)
- If devDeps handle user data: Evaluate case-by-case

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

### 4.9 Dynamic Import Safety (Phase 7a)

When dynamically importing optional packages, always use type guards instead of unsafe `as` casts.

**Rules:**
- Use type guards to validate module structure before use
- Handle import failures gracefully with try-catch
- Never assume imported module has expected exports

```typescript
// ❌ WRONG: Unsafe cast assumes structure
const mod = (await import(packageName)) as Record<string, unknown>;
if (mod['SomeClass']) {
  const Class = mod['SomeClass'] as new () => SomeInterface;
  return new Class();
}

// ✅ CORRECT: Type guard validates structure
function isValidModule(
  mod: unknown
): mod is { SomeClass: new () => SomeInterface } {
  return (
    typeof mod === 'object' &&
    mod !== null &&
    'SomeClass' in mod &&
    typeof (mod as Record<string, unknown>)['SomeClass'] === 'function'
  );
}

async function tryLoadModule(): Promise<SomeInterface | null> {
  try {
    const mod = await import(/* webpackIgnore: true */ packageName);
    if (isValidModule(mod)) {
      return new mod.SomeClass();
    }
    return null;
  } catch {
    // Package not installed - expected for optional dependencies
    return null;
  }
}
```

### 4.10 Third-Party Type Extraction (SMI-1275)

When external libraries use Web Crypto API types (like `CryptoKey`) that TypeScript doesn't recognize without DOM lib, extract types from library interfaces.

**Rules:**
- Don't rely on global types like `CryptoKey` unless tsconfig includes DOM lib
- Use type extraction from library-provided result types
- Test type compatibility with `npm run typecheck` after changes

```typescript
// ❌ WRONG: Bare CryptoKey not recognized without DOM lib
import * as jose from 'jose'

interface KeyPair {
  privateKey: CryptoKey  // Error: Cannot find name 'CryptoKey'
}

// ✅ CORRECT: Extract type from library's result interface
import type { GenerateKeyPairResult } from 'jose'

type JosePrivateKey = GenerateKeyPairResult['privateKey']

interface KeyPair {
  privateKey: JosePrivateKey  // Works without DOM lib
}
```

**Common packages requiring this pattern:**
- `jose` - JWT library (CryptoKey, KeyLike)
- `webcrypto` - Web Crypto polyfills
- Browser API polyfills used in Node.js

### 4.11 Lazy Loading for Heavy Dependencies (Phase 7a)

Heavy optional dependencies (ML models, native modules) must be lazily loaded to prevent startup crashes.

**Rules:**
- Never eagerly import packages with native modules at module level
- Use dynamic `import()` inside async functions
- Provide static `checkAvailability()` method for consumers
- Export types separately from runtime code

```typescript
// ❌ WRONG: Eager import crashes if native module unavailable
import { pipeline } from '@xenova/transformers';

export class EmbeddingService {
  async embed(text: string) {
    return pipeline('feature-extraction', text);
  }
}

// ✅ CORRECT: Lazy load with availability check
let transformersModule: typeof import('@xenova/transformers') | null = null;

async function loadTransformers() {
  if (!transformersModule) {
    try {
      transformersModule = await import('@xenova/transformers');
    } catch {
      return null;
    }
  }
  return transformersModule;
}

export class EmbeddingService {
  static async checkAvailability(): Promise<boolean> {
    return (await loadTransformers()) !== null;
  }

  async embed(text: string) {
    const mod = await loadTransformers();
    if (!mod) throw new Error('Transformers not available');
    return mod.pipeline('feature-extraction', text);
  }
}
```

**Packages requiring lazy loading:**
- `@xenova/transformers` (ONNX runtime, sharp)
- `better-sqlite3` (native module)
- `onnxruntime-node` (native module)

> **Reference**: See SMI-1127 fix and [ADR-009](../adr/009-embedding-service-fallback.md)

---

## 5. Mock vs Production Separation (SMI-763)

### 5.1 Mock Data Guidelines

Mock data enables development and testing without external dependencies. However, mock data must be clearly separated from production code.

**Rules:**

| Rule | Implementation |
|------|----------------|
| Mock data in fixtures only | Store in `tests/fixtures/` or `__mocks__/` |
| Environment flag control | Use `SKILLSMITH_USE_MOCK=true` for testing |
| No hardcoded mock in production | Production code paths must use real services |
| Document mock limitations | Note differences from real behavior |

### 5.2 Mock Data Patterns

**Correct: Isolate mock data with environment control**

```typescript
// services/SkillService.ts
export class SkillService {
  private useMock = process.env.SKILLSMITH_USE_MOCK === 'true';

  async getSkills(): Promise<Skill[]> {
    if (this.useMock) {
      return import('../tests/fixtures/skills.json');
    }
    return this.repository.findAll();
  }
}
```

**Correct: Mock data in test fixtures**

```typescript
// tests/fixtures/skills.ts
export const mockSkills: Skill[] = [
  { id: 'test-skill-1', name: 'Test Skill', ... },
];

// tests/SkillService.test.ts
import { mockSkills } from './fixtures/skills';

describe('SkillService', () => {
  beforeEach(() => {
    process.env.SKILLSMITH_USE_MOCK = 'true';
  });

  it('returns skills', async () => {
    const skills = await service.getSkills();
    expect(skills).toEqual(mockSkills);
  });
});
```

**Incorrect: Hardcoded mock data in production code**

```typescript
// ❌ DON'T DO THIS
const mockSkillDatabase = [
  { id: 'anthropic/commit', name: 'commit', ... },
];

export async function getSkills(): Promise<Skill[]> {
  return mockSkillDatabase; // Always returns mock!
}
```

### 5.3 Integration Test Patterns

For integration tests that need real database connections:

```typescript
// tests/integration/setup.ts
import { createTestDatabase } from '../fixtures/database';

export function setupIntegrationTest() {
  const db = createTestDatabase();

  beforeAll(async () => {
    await db.seed('./fixtures/test-data.sql');
  });

  afterAll(async () => {
    await db.close();
  });

  return db;
}
```

### 5.4 Mock/Production Verification

Add to PR review checklist:
- [ ] Mock data is isolated in test fixtures
- [ ] `SKILLSMITH_USE_MOCK` flag controls mock behavior
- [ ] Production code paths don't return hardcoded mock data
- [ ] Integration tests use real (test) database

---

## 6. Error Handling

### 6.1 Error Types

Use `SkillsmithError` from `@skillsmith/core`:

```typescript
throw new SkillsmithError(
  ErrorCodes.SKILL_NOT_FOUND,
  'Skill not found',
  { skillId }
);
```

### 6.2 MCP Error Responses

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

## 7. Enterprise Development Standards

### 7.1 License Validation

All enterprise features must gate on a valid license before execution.

**Rules:**
- Use `LicenseValidator` from `@skillsmith/enterprise` for all license checks
- Return `null` for validation failures (never silently fallback to lower tier)
- License check caching with 5-minute TTL to reduce API calls
- Never expose license keys in logs or error messages
- Include expiration warnings when license expires within 30 days

```typescript
import { LicenseValidator } from '@skillsmith/enterprise';

const validator = new LicenseValidator({ cacheTtl: 5 * 60 * 1000 });

async function enterpriseFeature(): Promise<Result> {
  const license = await validator.validate();

  // IMPORTANT: null means validation failed - don't silently degrade
  if (!license) {
    return { success: false, error: 'License validation failed' };
  }

  if (!license.valid) {
    return { success: false, error: 'Enterprise license required' };
  }

  // Check for expiration warning
  if (license.warning) {
    console.warn(license.warning); // e.g., "License expires in 15 days"
  }

  // Proceed with enterprise functionality
}
```

**License Validation Hierarchy (from Phase 7a retro):**

| Scenario | Behavior |
|----------|----------|
| No license key | Community tier (valid) |
| License key + validator unavailable | Return `null` (failed) |
| License key + validator success | Validated tier with features |
| License key + validator failure | Return `null` (failed) |

> **Security**: Never silently fallback to community tier when a license key is present. Customers expect validation feedback.

### 7.2 SSO Integration Patterns

Enterprise SSO must support multiple identity providers through a unified interface.

**Supported Protocols:**
- SAML 2.0 (Okta, Azure AD, OneLogin)
- OIDC (Google Workspace, Auth0, Keycloak)

**Implementation Requirements:**

| Requirement | Implementation |
|-------------|----------------|
| Provider-agnostic interface | Use `SSOManager` abstraction |
| Session management | Secure token storage with encryption at rest |
| Logout propagation | SLO (Single Logout) across all clients |
| Token refresh | Automatic refresh before expiration |

```typescript
interface SSOManager {
  initiateLogin(provider: SSOProvider): Promise<AuthRequest>;
  handleCallback(response: AuthResponse): Promise<Session>;
  logout(sessionId: string, propagate?: boolean): Promise<void>;
  refreshSession(sessionId: string): Promise<Session>;
}
```

### 7.3 RBAC Implementation

Role-Based Access Control ensures proper authorization across all enterprise features.

**Standard Roles:**

| Role | Permissions |
|------|-------------|
| Admin | Full access, user management, configuration |
| Manager | Team management, approval workflows, reports |
| User | Standard feature access, self-service |
| ReadOnly | View-only access, no modifications |

**Implementation Requirements:**
- Permission checking middleware for all MCP tools
- Role hierarchy with inheritance (Admin > Manager > User > ReadOnly)
- Audit all permission checks for compliance

```typescript
// Permission middleware for MCP tools
async function checkPermission(
  userId: string,
  resource: string,
  action: 'read' | 'write' | 'delete' | 'admin'
): Promise<boolean> {
  const result = await rbac.check(userId, resource, action);
  await auditLogger.log({
    type: 'permission_check',
    userId,
    resource,
    action,
    result: result.allowed,
    timestamp: new Date().toISOString()
  });
  return result.allowed;
}
```

### 7.4 Audit Logging (Enterprise)

Enterprise audit extends core `AuditLogger` with compliance-focused features.

**Requirements for SOC 2 Compliance:**
- Structured events with consistent schema
- SIEM export support (Splunk, CloudWatch, Datadog)
- 90-day default retention with configurable policy
- Immutable log storage (append-only)

**Audit Event Schema:**

```typescript
interface EnterpriseAuditEvent {
  id: string;                    // UUID
  timestamp: string;             // ISO 8601
  actor: {
    userId: string;
    email: string;
    role: string;
    ipAddress: string;
  };
  action: string;                // e.g., 'skill.install', 'user.create'
  resource: {
    type: string;
    id: string;
    name?: string;
  };
  result: 'success' | 'failure';
  metadata: Record<string, unknown>;
  tenantId: string;              // Required for multi-tenant
}
```

**SIEM Export Configuration:**

```typescript
const auditConfig = {
  retention: { days: 90, policy: 'delete' },
  export: {
    enabled: true,
    destination: 'splunk', // or 'cloudwatch', 'datadog'
    batchSize: 100,
    flushInterval: 60000   // 1 minute
  },
  immutable: true
};
```

### 7.5 Multi-Tenant Data Isolation

Strict tenant isolation prevents data leakage between enterprise customers.

**Mandatory Requirements:**

| Requirement | Implementation |
|-------------|----------------|
| Tenant ID in all queries | Repository-level enforcement |
| Cross-tenant prevention | Query middleware validation |
| Tenant-scoped caching | Cache keys include tenant ID |
| Export boundaries | Data export respects tenant isolation |

```typescript
// Repository base class enforces tenant isolation
abstract class TenantScopedRepository<T> {
  constructor(private tenantId: string) {}

  protected addTenantScope(query: Query): Query {
    return query.where('tenant_id', '=', this.tenantId);
  }

  async findById(id: string): Promise<T | null> {
    const result = await this.db
      .select()
      .from(this.table)
      .where('id', '=', id)
      .where('tenant_id', '=', this.tenantId)  // Always enforced
      .first();
    return result;
  }
}
```

**Cache Key Pattern:**

```typescript
// ❌ WRONG: No tenant isolation
const cacheKey = `skill:${skillId}`;

// ✅ CORRECT: Tenant-scoped cache
const cacheKey = `tenant:${tenantId}:skill:${skillId}`;
```

### 7.6 Private Registry Security

Private skill registries require enhanced security controls.

**Security Requirements:**

| Requirement | Implementation |
|-------------|----------------|
| TLS required | Reject non-HTTPS connections |
| Token authentication | Bearer tokens with rotation policy |
| Skill signature verification | Ed25519 signatures on all packages |
| Air-gapped mode | Offline validation with cached keys |

```typescript
interface PrivateRegistryConfig {
  url: string;                    // Must be HTTPS
  auth: {
    type: 'bearer';
    token: string;
    rotationDays: number;         // Recommended: 90
  };
  verification: {
    enabled: true;
    publicKeys: string[];         // Ed25519 public keys
    allowUnsigned: false;
  };
  airgapped?: {
    enabled: boolean;
    keyCache: string;             // Path to cached verification keys
    offlineValidation: boolean;
  };
}
```

**Signature Verification:**

```typescript
import { verify } from '@skillsmith/enterprise/crypto';

async function verifySkillPackage(
  packagePath: string,
  signature: string,
  publicKey: string
): Promise<boolean> {
  const content = await fs.readFile(packagePath);
  const hash = createHash('sha256').update(content).digest();
  return verify(hash, signature, publicKey);
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

## 8. Astro Script Patterns (SMI-1596)

Astro pages can include client-side JavaScript using `<script>` tags. Understanding the different script types and how to pass data from server to client is essential for building interactive pages.

### 8.1 Module Scripts vs Inline Scripts

**Module Scripts** (default): Scripts with `import` statements are processed by Vite and bundled.

```astro
<!-- Module script - bundled by Vite, supports imports -->
<script>
  import { createClient } from '@supabase/supabase-js'

  const supabase = createClient(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.PUBLIC_SUPABASE_ANON_KEY
  )

  document.addEventListener('DOMContentLoaded', async () => {
    const { data } = await supabase.from('profiles').select('*')
    console.log(data)
  })
</script>
```

**Inline Scripts**: Scripts with `is:inline` directive are not processed and appear as-is in HTML.

```astro
<!-- Inline script - rendered as-is, no bundling -->
<script is:inline>
  // Cannot use imports here
  console.log('Page loaded')
</script>
```

### 8.2 Passing Server Data to Client Scripts

**Using `define:vars`** (for inline scripts only):

```astro
---
const serverData = {
  userId: user.id,
  tier: user.tier,
}
---

<!-- define:vars injects server values as script variables -->
<script define:vars={{ serverData }}>
  console.log('User ID:', serverData.userId)
  // Note: define:vars makes this an inline script
</script>
```

**Using data attributes** (for module scripts):

```astro
---
const tier = user.tier
---

<div id="subscription-data" data-tier={tier}></div>

<script>
  // Read from data attributes in module scripts
  const dataEl = document.getElementById('subscription-data') as HTMLDivElement
  const tier = dataEl?.dataset.tier || 'community'
</script>
```

**Using `import.meta.env`** (for environment variables):

```astro
<script>
  // Only PUBLIC_ prefixed env vars are available in client scripts
  const apiUrl = import.meta.env.PUBLIC_SUPABASE_URL
  const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY

  // ❌ WRONG: Non-public env vars are undefined in client
  const secretKey = import.meta.env.STRIPE_SECRET_KEY // undefined
</script>
```

### 8.3 Correct vs Incorrect Patterns

| Pattern | Correct | Incorrect |
|---------|---------|-----------|
| Environment variables | `import.meta.env.PUBLIC_*` | `process.env.*` |
| DOM type assertions | `as HTMLDivElement` | `as any` or no type |
| Module imports | Inside `<script>` tag | Outside or with `is:inline` |
| Server data to client | `define:vars` or data attributes | Direct variable reference |
| Async initialization | Inside `DOMContentLoaded` | At module top level |

**Common Mistakes:**

```astro
---
// Server-side code
const secretApiKey = import.meta.env.STRIPE_SECRET_KEY
const user = await getUser()
---

<!-- ❌ WRONG: Trying to use server variables in client script -->
<script>
  console.log(user.id) // Error: user is not defined
  console.log(secretApiKey) // Error: secretApiKey is not defined
</script>

<!-- ✅ CORRECT: Pass through define:vars or data attributes -->
<div id="user-data" data-user-id={user.id}></div>
<script>
  const userId = document.getElementById('user-data')?.dataset.userId
</script>
```

**⚠️ CRITICAL: `import.meta` is NOT available in `define:vars` scripts (SMI-1607)**

Scripts using `define:vars` become inline scripts (not ES modules), so `import.meta` syntax will cause a runtime error:

```astro
<!-- ❌ WRONG: import.meta in define:vars script causes runtime error -->
<script define:vars={{ skillId: id }}>
  // This FAILS: "Cannot use 'import.meta' outside a module"
  if (import.meta.env?.DEV) console.error('Debug:', error);
</script>

<!-- ✅ CORRECT: Don't use import.meta in define:vars scripts -->
<script define:vars={{ skillId: id }}>
  // Either remove dev-only logging entirely, or use a different check
  // The script runs in the browser where import.meta.env is undefined anyway
</script>

<!-- ✅ CORRECT: Use import.meta only in module scripts (no define:vars) -->
<script>
  // This works because it's a module script
  const isDev = import.meta.env?.DEV;
</script>
```

| Script Type | `import.meta` Works? | Reason |
|-------------|---------------------|--------|
| `<script>` with imports | ✅ Yes | Processed as ES module by Vite |
| `<script define:vars>` | ❌ No | Becomes inline script, not a module |
| `<script is:inline>` | ❌ No | Inline script, not a module |

### 8.4 Script Loading Behavior

| Attribute | Behavior |
|-----------|----------|
| (none) | Module script, deferred by default |
| `is:inline` | Rendered as-is, no bundling |
| `define:vars` | Inline script with injected variables |
| `type="module"` | Explicit module (redundant in Astro) |

**Performance Considerations:**

- Module scripts are deduped and bundled for production
- Inline scripts appear in every page that uses them
- Use module scripts for reusable logic, inline for page-specific one-offs
- Wrap DOM manipulation in `DOMContentLoaded` to ensure elements exist

> **Reference**: See [Astro Scripts and Event Handling](https://docs.astro.build/en/guides/client-side-scripts/) for official documentation.

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 2.1 | 2026-01-19 | Added §8.3 `import.meta` warning for `define:vars` scripts (SMI-1607) |
| 2.0 | 2026-01-18 | Added §8 Astro Script Patterns (SMI-1596) |
| 1.9 | 2026-01-11 | Added §1.7 TypeScript Record<K,V> Exhaustiveness, enhanced §3.2 with Linear auto-close patterns (SMI-1372) |
| 1.8 | 2026-01-09 | Added §4.10 Third-Party Type Extraction (SMI-1275), §3.3 Security Audit Configuration (SMI-1276) |
| 1.7 | 2026-01-04 | Added §4.9 Dynamic Import Safety, §4.10 Lazy Loading, updated §1.5 Code Review, enhanced §7.1 License Validation (Phase 7a retro) |
| 1.6 | 2026-01-02 | Added §7 Enterprise Development Standards |
| 1.5.1 | 2025-12-29 | Added §5 Mock vs Production Separation (SMI-763) |
| 1.5 | 2025-12-29 | Added §1.5 Schema review criteria, Security Documentation appendix, cross-links to security checklist |
| 1.4 | 2025-12-27 | Added §4.3-4.8 Security Standards (input validation, prototype pollution, subprocess security, temp files, concurrency, crypto) from Phase 2b TDD |
| 1.3 | 2025-12-28 | Added §3.5-3.7 Session Management, Incremental Verification, Linear Integration (from Phase 2a retro) |
| 1.2 | 2025-12-27 | Updated §3.3 CI/CD Pipeline with compliance gate and job diagram |
| 1.1 | 2025-12-27 | Added §3.0 Docker-First Development requirement |
| 1.0 | 2025-12-27 | Initial standards for Phase 0 completion |

---

*Based on: [Governance Claude Skill](https://github.com/wrsmith108/governance-claude-skill)*
