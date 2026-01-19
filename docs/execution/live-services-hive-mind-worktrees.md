# Live Services: Hive Mind Worktree Execution Plan

**Date**: January 18, 2026
**Project**: Live Services (19fbb52a-73f4-49dc-8016-5f705529302e)
**Target Date**: January 24, 2026
**Issues**: 18 backlog items (3 completed)

---

## Executive Summary

This plan orchestrates parallel execution of Live Services issues using git worktrees with hive mind coordination. Issues are grouped into 6 parallel workstreams, each in its own worktree, with a queen coordinator managing cross-stream dependencies.

---

## Workstream Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HIVE MIND QUEEN COORDINATOR                          │
│                     (Strategic - Consensus: Weighted)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ WORKTREE 1  │  │ WORKTREE 2  │  │ WORKTREE 3  │  │ WORKTREE 4  │        │
│  │ CI/Testing  │  │   Security  │  │  Database   │  │ CLI/DevOps  │        │
│  │ (3 issues)  │  │ (3 issues)  │  │ (3 issues)  │  │ (4 issues)  │        │
│  │             │  │             │  │             │  │             │        │
│  │ Worker:     │  │ Worker:     │  │ Worker:     │  │ Worker:     │        │
│  │ Tester      │  │ Security    │  │ DB          │  │ DevOps      │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐                                           │
│  │ WORKTREE 5  │  │ WORKTREE 6  │     Shared: packages/core/src/index.ts   │
│  │ API/Monitor │  │    Docs     │     Shared: package.json                  │
│  │ (2 issues)  │  │ (2 issues)  │     Shared: CHANGELOG.md                  │
│  │             │  │             │                                           │
│  │ Worker:     │  │ Worker:     │                                           │
│  │ Backend     │  │ Documenter  │                                           │
│  └─────────────┘  └─────────────┘                                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Workstream Definitions

### Workstream 1: CI/Testing (Critical Path)

| Issue | Title | Priority | Dependencies |
|-------|-------|----------|--------------|
| SMI-1582 | Add fresh install CI test for CLI releases | P0 | None |
| SMI-1583 | Add partial API response mocks to test suite | P1 | None |
| SMI-1584 | Fix E2E tests with hardcoded path detection | P1 | None |

**Branch**: `feature/live-services-ci-testing`
**Worker Type**: Tester + Coder
**Estimated Duration**: 4-6 hours

**Files Modified**:
- `.github/workflows/ci.yml`
- `packages/core/tests/fixtures/api-responses.ts` (new)
- `packages/cli/tests/e2e/*.test.ts`
- `packages/cli/tests/integration/*.test.ts`

---

### Workstream 2: Security

| Issue | Title | Priority | Dependencies |
|-------|-------|----------|--------------|
| SMI-1454 | Security scanner outputs minimal refs | Medium | None |
| SMI-1456 | Weekly automated security scan workflow | Medium | SMI-1454 |
| SMI-1457 | Create Security project for quarantine tracking | Medium | SMI-1456 |

**Branch**: `feature/live-services-security`
**Worker Type**: Security Specialist
**Estimated Duration**: 3-4 hours

**Files Modified**:
- `packages/core/src/security/scanner.ts`
- `.github/workflows/security-scan.yml` (new)
- Linear project creation (external)

---

### Workstream 3: Database

| Issue | Title | Priority | Dependencies |
|-------|-------|----------|--------------|
| SMI-1446 | Database schema version mismatch blocks imports | Medium | None |
| SMI-1448 | Create database merge tooling | Medium | SMI-1446 |
| SMI-1452 | Sync local database with Supabase production | Medium | SMI-1448 |

**Branch**: `feature/live-services-database`
**Worker Type**: Database Specialist
**Estimated Duration**: 5-7 hours

**Files Modified**:
- `packages/core/src/database/schema.ts`
- `packages/core/src/database/migration.ts`
- `packages/cli/src/commands/db-merge.ts` (new)
- `packages/cli/src/commands/db-sync.ts` (new)

---

### Workstream 4: CLI/DevOps

| Issue | Title | Priority | Dependencies |
|-------|-------|----------|--------------|
| SMI-1449 | Add sqlite3 CLI to Docker container | Low | None |
| SMI-1450 | Fix duplicate console output in import script | Low | None |
| SMI-1455 | Create CLI command for safe skill merging | Low | SMI-1448 (WS3) |
| SMI-1556 | Upgrade Supabase CLI | Low | None |

**Branch**: `feature/live-services-cli-devops`
**Worker Type**: DevOps Specialist
**Estimated Duration**: 3-4 hours

**Files Modified**:
- `Dockerfile`
- `packages/cli/src/import.ts`
- `packages/cli/src/commands/merge.ts` (new)
- `.github/workflows/*.yml`

---

### Workstream 5: API/Monitoring

| Issue | Title | Priority | Dependencies |
|-------|-------|----------|--------------|
| SMI-1447 | Add live API health verification endpoint | Medium | None |
| SMI-1453 | Add rate limit monitoring and alerting | Medium | SMI-1447 |

**Branch**: `feature/live-services-api-monitoring`
**Worker Type**: Backend Developer
**Estimated Duration**: 3-4 hours

**Files Modified**:
- `supabase/functions/health/index.ts` (new)
- `packages/core/src/monitoring/rate-limiter.ts`
- `supabase/functions/_shared/monitoring.ts` (new)

---

### Workstream 6: Documentation

| Issue | Title | Priority | Dependencies |
|-------|-------|----------|--------------|
| SMI-1451 | Document GitHub App authentication flow | Medium | None |
| SMI-1585 | Document version governance policy | P2 | None |

**Branch**: `feature/live-services-docs`
**Worker Type**: Documenter
**Estimated Duration**: 2-3 hours

**Files Modified**:
- `docs/architecture/github-app-auth.md` (new)
- `docs/architecture/versioning-policy.md` (new)
- `docs/adr/index.md`
- `CONTRIBUTING.md`

---

## Phase 0: Pre-Flight Setup

### 0.1 Create Export Stubs (Conflict Prevention)

Before creating any worktrees, add stubs to prevent merge conflicts:

```bash
# In main branch
git checkout main && git pull origin main

# Edit packages/core/src/index.ts
```

```typescript
// packages/core/src/index.ts - Add stubs BEFORE worktree creation

// Database (SMI-1446, SMI-1448, SMI-1452) - to be implemented
// export * from './database/migration.js'

// Security (SMI-1454, SMI-1456) - to be implemented
// export * from './security/scanner.js'

// Monitoring (SMI-1447, SMI-1453) - to be implemented
// export * from './monitoring/index.js'
```

```bash
# Commit stubs
git add packages/core/src/index.ts
git commit -m "chore: add export stubs for Live Services workstreams"
git push origin main
```

### 0.2 Create Worktree Directory Structure

```bash
# Create worktrees container (if not exists)
mkdir -p ../worktrees

# Create all 6 worktrees in parallel
git worktree add ../worktrees/live-svc-ci-testing -b feature/live-services-ci-testing &
git worktree add ../worktrees/live-svc-security -b feature/live-services-security &
git worktree add ../worktrees/live-svc-database -b feature/live-services-database &
git worktree add ../worktrees/live-svc-cli-devops -b feature/live-services-cli-devops &
git worktree add ../worktrees/live-svc-api-monitoring -b feature/live-services-api-monitoring &
git worktree add ../worktrees/live-svc-docs -b feature/live-services-docs &
wait

# Verify creation
git worktree list
```

### 0.3 Generate Launch Scripts

Create launch scripts for each worktree session:

```bash
# scripts/live-services/launch-ci-testing.sh
#!/bin/bash
cd "$(dirname "$0")/../../.."
cd ../worktrees/live-svc-ci-testing

git fetch origin main && git rebase origin/main

cat << 'PROMPT'
================================================================================
WORKSTREAM 1: CI/Testing (SMI-1582, SMI-1583, SMI-1584)
================================================================================

## Issues
- SMI-1582: Add fresh install CI test for CLI releases (P0)
- SMI-1583: Add partial API response mocks to test suite (P1)
- SMI-1584: Fix E2E tests with hardcoded path detection (P1)

## Key Files
- .github/workflows/ci.yml
- packages/core/tests/fixtures/api-responses.ts (new)
- packages/cli/tests/e2e/*.test.ts

## Coordination
- No cross-stream dependencies
- Use Docker: docker exec skillsmith-dev-1 npm test

## When Complete
1. Run: docker exec skillsmith-dev-1 npm run preflight
2. Commit with conventional format
3. Push and create PR
4. Notify queen coordinator
================================================================================
PROMPT

claude
```

---

## Phase 1: Hive Mind Initialization

### 1.1 Initialize Queen Coordinator

```bash
# Initialize hive mind with strategic queen
npx claude-flow hive-mind init --force

npx claude-flow hive-mind spawn "Coordinate Live Services parallel execution" \
  --name "live-services-hive" \
  --queen-type strategic \
  --max-workers 12 \
  --consensus weighted
```

### 1.2 Register Workstreams in Collective Memory

```javascript
// Store workstream definitions
mcp__claude-flow__memory_store({
  key: "live-services-workstreams",
  data: {
    workstreams: [
      { id: "ws1", name: "CI/Testing", issues: ["SMI-1582", "SMI-1583", "SMI-1584"], status: "pending" },
      { id: "ws2", name: "Security", issues: ["SMI-1454", "SMI-1456", "SMI-1457"], status: "pending" },
      { id: "ws3", name: "Database", issues: ["SMI-1446", "SMI-1448", "SMI-1452"], status: "pending" },
      { id: "ws4", name: "CLI/DevOps", issues: ["SMI-1449", "SMI-1450", "SMI-1455", "SMI-1556"], status: "pending" },
      { id: "ws5", name: "API/Monitoring", issues: ["SMI-1447", "SMI-1453"], status: "pending" },
      { id: "ws6", name: "Documentation", issues: ["SMI-1451", "SMI-1585"], status: "pending" }
    ],
    dependencies: {
      "SMI-1456": ["SMI-1454"],
      "SMI-1457": ["SMI-1456"],
      "SMI-1448": ["SMI-1446"],
      "SMI-1452": ["SMI-1448"],
      "SMI-1453": ["SMI-1447"],
      "SMI-1455": ["SMI-1448"]  // Cross-stream dependency
    },
    sharedFiles: [
      "packages/core/src/index.ts",
      "packages/core/package.json",
      "package.json",
      "CHANGELOG.md"
    ]
  },
  type: "knowledge"
});
```

---

## Phase 2: Parallel Execution

### 2.1 Launch Terminal Sessions

Open 6 terminal windows/tabs, one for each worktree:

```bash
# Terminal 1: CI/Testing
./scripts/live-services/launch-ci-testing.sh

# Terminal 2: Security
./scripts/live-services/launch-security.sh

# Terminal 3: Database
./scripts/live-services/launch-database.sh

# Terminal 4: CLI/DevOps
./scripts/live-services/launch-cli-devops.sh

# Terminal 5: API/Monitoring
./scripts/live-services/launch-api-monitoring.sh

# Terminal 6: Documentation
./scripts/live-services/launch-docs.sh
```

### 2.2 Coordination Protocol

Each worktree session follows this protocol:

```
1. START SESSION
   - Rebase from main: git fetch origin main && git rebase origin/main
   - Check shared files: git log origin/main -5 -- packages/core/src/index.ts

2. BEFORE MODIFYING SHARED FILES
   - Fetch latest: git fetch origin main
   - Check for changes: git diff origin/main -- <shared-file>
   - Rebase if changes exist

3. IMPLEMENTATION
   - Create feature-specific directories
   - Implement changes
   - Write tests
   - Uncomment YOUR export line only

4. END SESSION
   - Run preflight: docker exec skillsmith-dev-1 npm run preflight
   - Commit: git add -A && git commit -m "feat(scope): description"
   - Push: git push origin <branch>
   - Create PR
   - Update collective memory

5. NOTIFY QUEEN
   - Signal completion to coordinator
   - Report any blockers or cross-stream needs
```

---

## Phase 3: Merge Sequence

### 3.1 Merge Order (Based on Dependencies)

```
Round 1 (No Dependencies):
  ├── WS6: Documentation (SMI-1451, SMI-1585)
  ├── WS1: CI/Testing - SMI-1582 only
  └── WS2: Security - SMI-1454 only

Round 2 (After Round 1):
  ├── WS1: CI/Testing - SMI-1583, SMI-1584
  ├── WS2: Security - SMI-1456
  ├── WS3: Database - SMI-1446
  ├── WS4: CLI/DevOps - SMI-1449, SMI-1450, SMI-1556
  └── WS5: API/Monitoring - SMI-1447

Round 3 (After Round 2):
  ├── WS2: Security - SMI-1457
  ├── WS3: Database - SMI-1448
  └── WS5: API/Monitoring - SMI-1453

Round 4 (Final):
  ├── WS3: Database - SMI-1452
  └── WS4: CLI/DevOps - SMI-1455 (depends on SMI-1448)
```

### 3.2 Post-Merge Rebase Protocol

After each merge to main:

```bash
# In ALL remaining worktrees
git fetch origin main
git rebase origin/main

# If conflicts, resolve immediately:
git status  # See conflicting files
# Edit to include ALL exports
git add <resolved-files>
git rebase --continue
```

---

## Phase 4: Anticipated Blockers & Mitigation

### Blocker 1: Shared File Merge Conflicts

**Risk Level**: HIGH
**Probability**: 70% if stubs not created

**Scenario**: Multiple worktrees modify `packages/core/src/index.ts` with new exports, causing conflict cascades.

**Mitigation**:
1. **Prevention**: Create export stubs BEFORE worktrees (Phase 0.1)
2. **Detection**: Queen coordinator monitors shared file changes
3. **Recovery**: Cherry-pick approach if conflicts become unmanageable

```bash
# Cherry-pick recovery
git checkout main && git pull
git checkout -b feature/recovery-<feature>
git cherry-pick <commit1> <commit2>
# Resolve conflicts with full context
```

---

### Blocker 2: Cross-Stream Dependency Stalls

**Risk Level**: MEDIUM
**Probability**: 40%

**Scenario**: SMI-1455 (CLI merge command) blocks on SMI-1448 (database merge tooling) from different worktree.

**Mitigation**:
1. **Prevention**: Identify dependencies during planning (documented above)
2. **Detection**: Collective memory tracks workstream status
3. **Recovery**: Pause dependent work, assign to same session, or create interface contract

```javascript
// Interface contract approach
// WS3 exports interface, WS4 implements against it
interface MergeTooling {
  merge(sourceDb: string, targetDb: string): Promise<MergeResult>;
}
```

---

### Blocker 3: Docker Container State Conflicts

**Risk Level**: MEDIUM
**Probability**: 30%

**Scenario**: Multiple worktrees share same Docker container, causing test isolation issues or build conflicts.

**Mitigation**:
1. **Prevention**: Use separate container instances per worktree
2. **Detection**: Check container health before operations
3. **Recovery**: Restart container, rebuild node_modules

```bash
# Per-worktree container (if needed)
COMPOSE_PROJECT_NAME=skillsmith-ws1 docker compose --profile dev up -d

# Recovery
docker exec skillsmith-dev-1 npm rebuild better-sqlite3
docker exec skillsmith-dev-1 npm run build
```

---

### Blocker 4: Native Module Rebuild Failures

**Risk Level**: MEDIUM
**Probability**: 25%

**Scenario**: `better-sqlite3` or `onnxruntime-node` fails to rebuild after dependency changes.

**Mitigation**:
1. **Prevention**: Pin exact versions in package.json
2. **Detection**: Monitor npm install/rebuild output
3. **Recovery**: Full rebuild sequence

```bash
# Full recovery
docker exec skillsmith-dev-1 rm -rf node_modules
docker exec skillsmith-dev-1 npm install
docker exec skillsmith-dev-1 npm rebuild better-sqlite3
docker exec skillsmith-dev-1 npm rebuild onnxruntime-node
```

---

### Blocker 5: CI Pipeline Failures

**Risk Level**: LOW
**Probability**: 20%

**Scenario**: WS1 changes to CI workflow break the pipeline, blocking all other merges.

**Mitigation**:
1. **Prevention**: Test CI changes in isolated branch first
2. **Detection**: Monitor GitHub Actions status
3. **Recovery**: Revert CI changes, fix, re-push

```bash
# Revert CI changes quickly
git revert <ci-commit> --no-edit
git push origin main

# Fix in worktree, then re-merge
```

---

### Blocker 6: Linear API Rate Limiting

**Risk Level**: LOW
**Probability**: 15%

**Scenario**: Bulk issue updates hit Linear API rate limits.

**Mitigation**:
1. **Prevention**: Batch updates, use 150ms delays
2. **Detection**: Monitor for 429 responses
3. **Recovery**: Exponential backoff, manual updates

```bash
# Batch Linear updates with delay
for issue in SMI-1582 SMI-1583 SMI-1584; do
  linear issues update $issue -s "In Progress"
  sleep 0.5
done
```

---

### Blocker 7: Supabase Function Deployment Failures

**Risk Level**: LOW
**Probability**: 10%

**Scenario**: WS5 health endpoint deployment fails due to Supabase CLI version mismatch.

**Mitigation**:
1. **Prevention**: WS4 upgrades Supabase CLI first (SMI-1556)
2. **Detection**: Check `supabase functions deploy` output
3. **Recovery**: Manual deployment via dashboard

---

## Phase 5: Completion Checklist

### Per-Workstream Checklist

- [ ] All issues implemented
- [ ] Tests passing: `docker exec skillsmith-dev-1 npm test`
- [ ] Types passing: `docker exec skillsmith-dev-1 npm run typecheck`
- [ ] Lint passing: `docker exec skillsmith-dev-1 npm run lint`
- [ ] Code review completed (written to `docs/reviews/`)
- [ ] Governance audit passed: `docker exec skillsmith-dev-1 npm run audit:standards`
- [ ] PR created with conventional commit
- [ ] PR merged to main
- [ ] Linear issues marked Done

### Global Checklist

- [ ] All 6 worktrees merged
- [ ] All 15 issues marked Done in Linear
- [ ] Collective memory updated with learnings
- [ ] CHANGELOG.md updated
- [ ] Hive mind session closed
- [ ] Worktrees cleaned up

```bash
# Final cleanup
git worktree remove ../worktrees/live-svc-ci-testing
git worktree remove ../worktrees/live-svc-security
git worktree remove ../worktrees/live-svc-database
git worktree remove ../worktrees/live-svc-cli-devops
git worktree remove ../worktrees/live-svc-api-monitoring
git worktree remove ../worktrees/live-svc-docs
git worktree prune
```

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Issues Completed | 15/15 | Linear Done status |
| Parallel Efficiency | >80% | Time saved vs sequential |
| Merge Conflicts | <3 | Git conflict count |
| CI Pass Rate | 100% | GitHub Actions |
| Test Coverage | >99% | Vitest coverage |

---

## Rollback Plan

If critical failure occurs mid-execution:

```bash
# 1. Stop all worktree sessions
# 2. Identify problematic PR
# 3. Revert if already merged
git revert <merge-commit>
git push origin main

# 4. Fix in worktree
cd ../worktrees/<problematic-worktree>
# Make fixes
git add -A && git commit -m "fix: address regression"
git push origin <branch>

# 5. Re-merge with fixes
gh pr create --title "fix: address regression from <original-PR>"
```

---

## References

- [Worktree Manager Skill](/.claude/skills/worktree-manager/SKILL.md)
- [Hive Mind Execution Skill](/.claude/skills/hive-mind-execution/SKILL.md)
- [Hive Mind Advanced Skill](/.claude/skills/hive-mind-advanced/SKILL.md)
- [Live Services Project](https://linear.app/smith-horn/project/live-services)
- [ADR-012: Native Module Version Management](/docs/adr/012-native-module-version-management.md)

---

**Created**: January 18, 2026
**Author**: Claude Code
**Status**: Ready for Execution
