# CLI v0.3.1 Hotfix - Execution Waves

**Linear Issue**: [SMI-1575](https://linear.app/smith-horn/issue/SMI-1575)
**Project**: Live Services
**Created**: January 18, 2026
**Status**: Implementation

---

## Overview

| Wave | Focus | Agent Type | Issue | Priority |
|------|-------|------------|-------|----------|
| 1 | Database Migration Fix | sparc:coder | SMI-1576 | Critical |
| 2 | API Schema Fix | sparc:coder | SMI-1577 | High |
| 3 | Import Resilience | sparc:coder + sparc:tester | SMI-1578 | Medium |
| 4 | Language Detection | sparc:coder + sparc:tester | SMI-1579 | Low |

---

## Wave 1: Database Migration Fix (Critical)

**Issue**: SMI-1576 - Fix sync command database initialization
**Priority**: Urgent (P0)
**Labels**: Bug, cli, p0-critical

### Problem

The `sync` command uses `openDatabase()` which only opens existing databases. On fresh installations where `~/.skillsmith/skills.db` doesn't exist, this throws "SQLITE_ERROR: no such table: skills".

### Solution

Replace `openDatabase()` with `createDatabase()` which creates the database and initializes tables if they don't exist.

### File Changes

**File**: `packages/cli/src/commands/sync.ts`

| Line | Before | After |
|------|--------|-------|
| 21 | `import { openDatabase, ...` | `import { createDatabase, ...` |
| 47 | `const db = openDatabase(options.dbPath)` | `const db = createDatabase(options.dbPath)` |
| 134 | `const db = openDatabase(options.dbPath)` | `const db = createDatabase(options.dbPath)` |
| 229 | `const db = openDatabase(options.dbPath)` | `const db = createDatabase(options.dbPath)` |
| 309 | `const db = openDatabase(options.dbPath)` | `const db = createDatabase(options.dbPath)` |

### Verification

```bash
rm -f ~/.skillsmith/skills.db
docker exec skillsmith-dev-1 npm run build
npx @skillsmith/cli sync --dry-run
```

### Success Criteria

- [ ] Fresh install sync works without "no such table" error
- [ ] Existing databases continue to work
- [ ] Tests pass

---

## Wave 2: API Schema Fix (High)

**Issue**: SMI-1577 - Fix Zod schema for API responses
**Priority**: High (P1)
**Labels**: Bug, cli, core

### Problem

The `ApiSearchResultSchema` expects all fields to be present, but the API sometimes returns partial responses with undefined fields for `repo_url`, `tags`, `created_at`, `updated_at`, and `trust_tier`.

### Solution

Add `.optional()` modifiers and sensible defaults to handle missing fields gracefully.

### File Changes

**File**: `packages/core/src/api/client.ts`

**Lines 31-44**: Update `ApiSearchResultSchema`:

```typescript
const ApiSearchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  author: z.string().nullable(),
  repo_url: z.string().nullable().optional(),
  quality_score: z.number().nullable(),
  trust_tier: TrustTierSchema.default('unknown'),
  tags: z.array(z.string()).default([]),
  stars: z.number().nullable().optional(),
  installable: z.boolean().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})
```

### Verification

```bash
docker exec skillsmith-dev-1 npm test -- packages/core/tests/api
npx @skillsmith/cli recommend
```

### Success Criteria

- [ ] recommend command works with partial API responses
- [ ] Existing full responses still validate
- [ ] Tests pass

---

## Wave 3: Import Resilience (Medium)

**Issue**: SMI-1578 - Improve GitHub import rate limiting and error visibility
**Priority**: Medium (P2)
**Labels**: Bug, cli, integration

### Problem

The GitHub import command silently fails when hitting rate limits or API errors. The 100ms delay between API calls is insufficient to prevent rate limiting on large imports.

### Solution

1. Increase default delay from 100ms to 150ms
2. Add `SKILLSMITH_IMPORT_DELAY_MS` environment variable for configuration
3. Add warning logs for SKILL.md fetch failures in verbose mode
4. Track and report failure statistics at the end

### File Changes

**File**: `packages/cli/src/import.ts`

| Line | Change |
|------|--------|
| 296 | Change `await sleep(100)` to use configurable delay |
| 129-131 | Add verbose logging for failed SKILL.md fetches |
| 319-320 | Add detailed failure statistics |

### Verification

```bash
SKILLSMITH_IMPORT_DELAY_MS=200 npx @skillsmith/cli import --verbose --max=10
```

### Success Criteria

- [ ] Import handles rate limits gracefully
- [ ] Failures visible in verbose mode
- [ ] Statistics show failed/skipped breakdown
- [ ] Tests pass

---

## Wave 4: Language Detection (Low)

**Issue**: SMI-1579 - Add Python language detection to analyze command
**Priority**: Low (P3)
**Labels**: enhancement, cli, core

### Problem

The `analyze` command only detects JavaScript/TypeScript files. The `SUPPORTED_EXTENSIONS` constant doesn't include Python extensions (`.py`, `.pyi`), even though `LANGUAGE_EXTENSIONS` already defines them.

### Solution

Add Python extensions to the `SUPPORTED_EXTENSIONS` array for backward compatibility with code that uses this legacy constant.

### File Changes

**File**: `packages/core/src/analysis/types.ts`

**Line 21**: Update `SUPPORTED_EXTENSIONS`:

```typescript
export const SUPPORTED_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi'
]
```

### Verification

```bash
docker exec skillsmith-dev-1 npm test -- packages/core/tests/CodebaseAnalyzer.test.ts
npx @skillsmith/cli analyze /path/to/python-project
```

### Success Criteria

- [ ] analyze finds Python files
- [ ] Mixed codebases report both languages
- [ ] Tests pass

---

## Execution Order

```bash
# Wave 1: Critical fix
./claude-flow sparc run coder "Execute Wave 1: Fix sync.ts database initialization (SMI-1576)"

# Wave 2: Schema fix
./claude-flow sparc run coder "Execute Wave 2: Fix API schema validation (SMI-1577)"

# Wave 3: Import resilience (parallel agents)
./claude-flow swarm "Execute Wave 3: Import resilience" --strategy development --max-agents 2

# Wave 4: Python detection (parallel agents)
./claude-flow swarm "Execute Wave 4: Python detection" --strategy development --max-agents 2

# Final verification
docker exec skillsmith-dev-1 npm run preflight
```

---

## Rollback Plan

If issues are discovered post-deployment:

1. Revert to v0.3.0: `npm install @skillsmith/cli@0.3.0`
2. Database is forward-compatible (no migration needed)
3. Schema changes are additive (existing data unaffected)

---

## Release Notes Preview

### v0.3.1 (January 2026)

**Bug Fixes**:
- Fixed `sync` command failing on fresh installations (SMI-1576)
- Fixed `recommend` command failing with partial API responses (SMI-1577)
- Improved GitHub import rate limiting and error visibility (SMI-1578)
- Added Python file detection to `analyze` command (SMI-1579)
